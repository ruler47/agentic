import { LlmClient } from "../llm/client.js";
import {
  MemoryScopeFilter,
  normalizeMemoryConfidence,
  normalizeMemoryScope,
  normalizeMemorySensitivity,
  normalizeMemoryStatus,
  SkillMemoryStore,
} from "../memory/skillMemory.js";
import { evaluateMemoryPolicy, MemoryPolicyDecision } from "../memory/memoryPolicy.js";
import { ToolRegistry } from "../tools/registry.js";
import { shouldUseWebSearch } from "../tools/webSearchTool.js";
import {
  AgentArtifact,
  AgentEvent,
  AgentEventSink,
  ArtifactRequirement,
  AgentRunResult,
  ArtifactCreateInput,
  ReviewResult,
  SkillMemoryEntry,
  Subtask,
  TaskComplexity,
  WorkerResult,
} from "../types.js";
import { asksForChart } from "../artifacts/chartArtifact.js";
import {
  artifactMatchesRequirement,
  inspectArtifactRequirement,
} from "../artifacts/artifactRequirementQuality.js";
import { inspectBrowserScreenshotEvidence } from "../artifacts/semanticArtifactQuality.js";
import { isChartToolData } from "../tools/chartGenerateTool.js";
import { isBrowserOperateData } from "../tools/browserOperateTool.js";
import { isMarketTimeseriesData } from "../tools/marketTimeseriesTool.js";
import { ToolBuildRequest, ToolBuildRequestInput } from "../tools/toolBuildRequestStore.js";
import { Tool } from "../tools/tool.js";
import { extractJson } from "../utils/json.js";
import {
  classifyPrompt,
  coordinatorSystemPrompt,
  learningPrompt,
  planPrompt,
  reviewerSystemPrompt,
  synthesizePrompt,
  workerSystemPrompt,
} from "./prompts.js";
import { selectModelTier } from "./modelTier.js";

type PlanResponse = {
  subtasks: Subtask[];
};

type LearningResponse = {
  shouldStore: boolean;
  title?: string;
  tags?: string[];
  summary?: string;
  reusableProcedure?: string;
  scope?: unknown;
  status?: unknown;
  confidence?: unknown;
  sensitivity?: unknown;
  evidence?: unknown;
};

type RunOptions = {
  onEvent?: AgentEventSink;
  inputArtifacts?: AgentArtifact[];
  runId?: string;
  instanceId?: string;
  requesterUserId?: string;
  threadId?: string;
  threadContext?: {
    summary: string;
    acceptedFacts: string[];
    rejectedAttempts: string[];
    openQuestions: string[];
    relevantArtifactIds: string[];
  };
  memoryScopes?: MemoryScopeFilter[];
  allowSensitiveMemory?: boolean;
  allowPrivateMemory?: boolean;
  saveArtifact?: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>;
  requestToolBuild?: (request: ToolBuildRequestInput) => Promise<ToolBuildRequest>;
  now?: Date;
  timeZone?: string;
};

type AgentEventEmitter = (event: AgentEventDraft) => Promise<void>;

type AgentEventDraft = Omit<AgentEvent, "id" | "timestamp" | "spanId"> & {
  spanId?: string;
};

type ReviewedWorkerResult = {
  workerResult: WorkerResult;
  review: ReviewResult;
  attempts: WorkerResult[];
  reviews: ReviewResult[];
};

type ExecutionPlan = {
  subtasks: Subtask[];
  levels: Subtask[][];
  warnings: string[];
};

type CollectedToolEvidence = {
  text: string;
  evidence: string[];
  artifacts: AgentArtifact[];
};

const promptBudget = {
  taskContextChars: 8_000,
  memoryEntryChars: 1_200,
  memoryEvidenceChars: 800,
  toolEvidenceChars: 7_000,
  dependencyContextChars: 6_000,
  workerUserPromptChars: 16_000,
  reviewWorkerOutputChars: 8_000,
  synthesisWorkerOutputChars: 14_000,
  learningWorkerOutputChars: 10_000,
};

export class UniversalAgent {
  constructor(
    private readonly llm: LlmClient,
    private readonly skillMemory: SkillMemoryStore,
    private readonly tools = new ToolRegistry(),
  ) {}

  async run(task: string, options: RunOptions = {}): Promise<AgentRunResult> {
    const emit = createEmitter(options.onEvent);
    const runSpanId = createSpanId("run");
    const memorySpanId = createSpanId("memory");
    const classificationSpanId = createSpanId("classification");
    const runStartedAt = options.now ?? new Date();
    const artifacts: AgentArtifact[] = [...(options.inputArtifacts ?? [])];

    await emit({
      spanId: runSpanId,
      type: "run-started",
      actor: "coordinator",
      activity: "coordination",
      status: "started",
      title: "Coordinator run",
      detail: task,
      startedAt: runStartedAt.toISOString(),
    });

    if (artifacts.length > 0) {
      await emit({
        spanId: createSpanId("artifacts-input"),
        parentSpanId: runSpanId,
        type: "artifacts-received",
        actor: "coordinator",
        activity: "coordination",
        status: "completed",
        title: `${artifacts.length} input artifact${artifacts.length === 1 ? "" : "s"} received`,
        detail: artifacts.map((artifact) => `${artifact.filename} (${artifact.mimeType})`).join("\n"),
        startedAt: runStartedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 0,
        payload: { artifacts },
      });
    }

    const taskContext = appendRuntimeContext(
      appendThreadContext(appendArtifactContext(task, artifacts), options.threadContext),
      runStartedAt,
      options.timeZone,
    );
    const memoryStartedAt = new Date();
    const memoryCandidates = await this.skillMemory.search(taskContext, 12, { visibleScopes: options.memoryScopes });
    const { memories, blocked } = filterMemoriesForRuntime(memoryCandidates, options);
    await emit({
      spanId: memorySpanId,
      parentSpanId: runSpanId,
      type: "memory-search-completed",
      actor: "coordinator",
      activity: "memory",
      status: "completed",
      title: "Skill memory searched",
      detail: [
        `${memories.length} relevant memories found`,
        blocked.length > 0 ? `${blocked.length} blocked by memory policy` : undefined,
      ]
        .filter(Boolean)
        .join("; "),
      startedAt: memoryStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(memoryStartedAt),
      payload: memories,
    });

    const classificationStartedAt = new Date();
    const classificationTier = selectModelTier("classification");
    const complexity = await this.classify(taskContext, memories, classificationTier);
    await emit({
      spanId: classificationSpanId,
      parentSpanId: runSpanId,
      type: "classification-completed",
      actor: "coordinator",
      activity: "llm",
      status: "completed",
      title: `Task classified as ${complexity.mode}`,
      detail: complexity.reason,
      startedAt: classificationStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(classificationStartedAt),
      payload: { ...complexity, modelTier: classificationTier },
    });

    if (complexity.mode === "direct") {
      const generatedArtifact = await this.createRequestedArtifact(
        taskContext,
        [],
        emit,
        runSpanId,
        options.saveArtifact,
        options.requestToolBuild,
      );
      if (generatedArtifact) {
        artifacts.push(generatedArtifact);
      }

      const synthesisSpanId = createSpanId("synthesis");
      const synthesisStartedAt = new Date();
      const synthesisTier = selectModelTier("synthesis", complexity);
      await emit({
        spanId: synthesisSpanId,
        parentSpanId: runSpanId,
        type: "synthesis-started",
        actor: "synthesizer",
        activity: "synthesis",
        status: "started",
        title: "Direct answer synthesis started",
        startedAt: synthesisStartedAt.toISOString(),
        payload: { modelTier: synthesisTier },
      });
      const rawFinalAnswer = await this.llm.complete([
      { role: "system", content: coordinatorSystemPrompt },
      {
        role: "user",
        content: synthesizePrompt(
          limitText(taskContext, promptBudget.taskContextChars),
          complexity,
          [],
          [],
          compactMemoriesForPrompt(memories),
          artifacts,
        ),
      },
      ], { modelTier: synthesisTier });
      const finalAnswer = withArtifactLinks(rawFinalAnswer, artifacts);
      await emit({
        spanId: synthesisSpanId,
        parentSpanId: runSpanId,
        type: "synthesis-completed",
        actor: "synthesizer",
        activity: "llm",
        status: "completed",
        title: "Direct answer synthesized",
        startedAt: synthesisStartedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: elapsedMs(synthesisStartedAt),
        payload: { finalAnswer, modelTier: synthesisTier },
      });

      const learningStartedAt = new Date();
      const learningTier = selectModelTier("learning", complexity);
      const learnedSkill = await this.learn(taskContext, finalAnswer, [], learningTier, options);
      await emit({
        spanId: createSpanId("learning"),
        parentSpanId: runSpanId,
        type: "learning-completed",
        actor: "coordinator",
        activity: "memory",
        status: "completed",
        title: learnedSkill ? "Reusable skill stored" : "No reusable skill stored",
        startedAt: learningStartedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: elapsedMs(learningStartedAt),
        payload: { learnedSkill, modelTier: learningTier },
      });

      await emit({
        spanId: runSpanId,
        type: "run-completed",
        actor: "coordinator",
        activity: "coordination",
        status: "completed",
        title: "Coordinator run",
        startedAt: runStartedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: elapsedMs(runStartedAt),
        payload: { finalAnswer, artifacts },
      });

      return {
        finalAnswer,
        complexity,
        subtasks: [],
        workerResults: [],
        reviews: [],
        artifacts,
        learnedSkill,
      };
    }

    const planningSpanId = createSpanId("planning");
    const planningStartedAt = new Date();
    const planningTier = selectModelTier("planning", complexity);
    const rawSubtasks = await this.plan(taskContext, complexity, memories, planningTier);
    const executionPlan = createExecutionPlan(rawSubtasks);
    const subtasks = executionPlan.subtasks;
    await emit({
      spanId: planningSpanId,
      parentSpanId: runSpanId,
      type: "planning-completed",
      actor: "planner",
      activity: "planning",
      status: "completed",
      title: `${subtasks.length} subtasks planned`,
      detail: executionPlan.warnings.length > 0 ? executionPlan.warnings.join("\n") : undefined,
      startedAt: planningStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(planningStartedAt),
      payload: {
        subtasks,
        executionLevels: executionPlan.levels.map((level) => level.map((subtask) => subtask.id)),
        dependencyWarnings: executionPlan.warnings,
        modelTier: planningTier,
      },
    });

    const reviewedWorkerResults = await this.executeSubtaskDag(
      taskContext,
      complexity,
      executionPlan,
      memories,
      emit,
      planningSpanId,
      options.saveArtifact,
      options.requestToolBuild,
    );
    const workerResults = reviewedWorkerResults.map((result) => result.workerResult);
    const reviews = reviewedWorkerResults.flatMap((result) => result.reviews);
    pushUniqueArtifacts(artifacts, getApprovedArtifacts(reviewedWorkerResults));
    const generatedArtifact = await this.createRequestedArtifact(
      taskContext,
      workerResults,
      emit,
      runSpanId,
      options.saveArtifact,
      options.requestToolBuild,
    );
    if (generatedArtifact) {
      artifacts.push(generatedArtifact);
    }
    const synthesisSpanId = createSpanId("synthesis");
    const synthesisStartedAt = new Date();
    const synthesisTier = selectModelTier("synthesis", complexity);
    await emit({
      spanId: synthesisSpanId,
      parentSpanId: runSpanId,
      type: "synthesis-started",
      actor: "synthesizer",
      activity: "synthesis",
      status: "started",
      title: "Final synthesis started",
      startedAt: synthesisStartedAt.toISOString(),
      payload: { modelTier: synthesisTier },
    });
    const rawFinalAnswer = await this.llm.complete([
      { role: "system", content: coordinatorSystemPrompt },
      {
        role: "user",
        content: synthesizePrompt(
          limitText(taskContext, promptBudget.taskContextChars),
          complexity,
          compactWorkerResultsForPrompt(workerResults, promptBudget.synthesisWorkerOutputChars),
          reviews,
          compactMemoriesForPrompt(memories),
          artifacts,
        ),
      },
    ], { modelTier: synthesisTier });
    const finalAnswer = withArtifactLinks(rawFinalAnswer, artifacts);
    await emit({
      spanId: synthesisSpanId,
      parentSpanId: runSpanId,
      type: "synthesis-completed",
      actor: "synthesizer",
      activity: "llm",
      status: "completed",
      title: "Final answer synthesized",
      startedAt: synthesisStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(synthesisStartedAt),
      payload: { finalAnswer, modelTier: synthesisTier },
    });

    const learningStartedAt = new Date();
    const learningTier = selectModelTier("learning", complexity);
    const learnedSkill = await this.learn(taskContext, finalAnswer, workerResults, learningTier, options);
    await emit({
      spanId: createSpanId("learning"),
      parentSpanId: runSpanId,
      type: "learning-completed",
      actor: "coordinator",
      activity: "memory",
      status: "completed",
      title: learnedSkill ? "Reusable skill stored" : "No reusable skill stored",
      startedAt: learningStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(learningStartedAt),
      payload: { learnedSkill, modelTier: learningTier },
    });

    await emit({
      spanId: runSpanId,
      type: "run-completed",
      actor: "coordinator",
      activity: "coordination",
      status: "completed",
      title: "Coordinator run",
      startedAt: runStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(runStartedAt),
      payload: { finalAnswer, artifacts },
    });

    return {
      finalAnswer,
      complexity,
      subtasks,
      workerResults,
      reviews,
      artifacts,
      learnedSkill,
    };
  }

  private async classify(
    task: string,
    memories: SkillMemoryEntry[],
    modelTier: ReturnType<typeof selectModelTier>,
  ): Promise<TaskComplexity> {
    const promptTask = limitText(task, promptBudget.taskContextChars);
    const promptMemories = compactMemoriesForPrompt(memories);
    const output = await this.llm.complete([
      { role: "system", content: coordinatorSystemPrompt },
      { role: "user", content: classifyPrompt(promptTask, promptMemories) },
    ], { modelTier });

    return extractJson<TaskComplexity>(output);
  }

  private async plan(
    task: string,
    complexity: TaskComplexity,
    memories: SkillMemoryEntry[],
    modelTier: ReturnType<typeof selectModelTier>,
  ): Promise<Subtask[]> {
    const promptTask = limitText(task, promptBudget.taskContextChars);
    const promptMemories = compactMemoriesForPrompt(memories);
    const output = await this.llm.complete([
      { role: "system", content: coordinatorSystemPrompt },
      { role: "user", content: planPrompt(promptTask, complexity, promptMemories) },
    ], { modelTier });

    return extractJson<PlanResponse>(output).subtasks;
  }

  private async executeSubtaskDag(
    originalTask: string,
    complexity: TaskComplexity,
    executionPlan: ExecutionPlan,
    memories: SkillMemoryEntry[],
    emit: AgentEventEmitter,
    planningSpanId: string,
    saveArtifact?: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>,
    requestToolBuild?: (request: ToolBuildRequestInput) => Promise<ToolBuildRequest>,
  ): Promise<ReviewedWorkerResult[]> {
    const completedResults = new Map<string, ReviewedWorkerResult>();
    const orderedResults: ReviewedWorkerResult[] = [];

    for (const level of executionPlan.levels) {
      const levelResults = await Promise.all(
        level.map((subtask) => {
          const dependencyResults = (subtask.dependsOn ?? [])
            .map((id) => completedResults.get(id))
            .filter((result): result is ReviewedWorkerResult => Boolean(result));
          const dependencySpanIds = dependencyResults
            .map((result) => result.workerResult.traceSpanId)
            .filter((spanId): spanId is string => Boolean(spanId));
          const dependencyContext = formatDependencyContext(dependencyResults);
          const dependencyArtifacts = dependencyResults.flatMap((result) => result.workerResult.artifacts ?? []);
          const parentSpanId = dependencySpanIds.at(-1) ?? planningSpanId;

          return this.runWorkerAndRequestReview(
            originalTask,
            complexity,
            subtask,
            memories,
            emit,
            parentSpanId,
            dependencyContext,
            dependencySpanIds,
            dependencyArtifacts,
            saveArtifact,
            requestToolBuild,
          );
        }),
      );

      for (const result of levelResults) {
        completedResults.set(result.workerResult.subtask.id, result);
        orderedResults.push(result);
      }
    }

    return orderedResults;
  }

  private async runWorker(
    originalTask: string,
    complexity: TaskComplexity,
    subtask: Subtask,
    memories: SkillMemoryEntry[],
    emit: AgentEventEmitter,
    parentSpanId: string,
    dependencyContext?: string,
    dependencySpanIds: string[] = [],
    dependencyArtifacts: AgentArtifact[] = [],
    revisionInstructions?: string,
    saveArtifact?: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>,
    requestToolBuild?: (request: ToolBuildRequestInput) => Promise<ToolBuildRequest>,
  ): Promise<WorkerResult> {
    const isRevision = Boolean(revisionInstructions);
    const modelTier = selectModelTier("worker", complexity, subtask);
    const spanId = createSpanId(isRevision ? `worker-revision-${subtask.id}` : `worker-${subtask.id}`);
    const startedAt = new Date();
    await emit({
      spanId,
      parentSpanId,
      type: "worker-started",
      actor: `worker:${subtask.role}`,
      activity: "worker",
      status: "started",
      title: isRevision ? `Worker revision: ${subtask.title}` : `Worker: ${subtask.title}`,
      detail: revisionInstructions ?? subtask.role,
      startedAt: startedAt.toISOString(),
      payload: { subtask, modelTier, dependencySpanIds },
    });

    let collectedEvidence: CollectedToolEvidence | undefined;
    let output = "";
    try {
      collectedEvidence = await this.collectToolEvidence(
        originalTask,
        subtask,
        emit,
        spanId,
        dependencyContext,
        dependencyArtifacts,
        saveArtifact,
        requestToolBuild,
      );

      output = await this.llm.complete([
        { role: "system", content: workerSystemPrompt(subtask, compactMemoriesForPrompt(memories)) },
        {
          role: "user",
          content: buildWorkerUserPrompt(originalTask, collectedEvidence.text, dependencyContext, revisionInstructions),
        },
      ], { modelTier });
    } catch (error) {
      await emit({
        spanId,
        parentSpanId,
        type: "worker-failed",
        actor: `worker:${subtask.role}`,
        activity: "worker",
        status: "failed",
        title: isRevision ? `Worker revision failed: ${subtask.title}` : `Worker failed: ${subtask.title}`,
        detail: formatErrorMessage(error),
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: elapsedMs(startedAt),
        payload: {
          subtask,
          modelTier,
          dependencySpanIds,
          error: formatErrorMessage(error),
          evidencePreview: collectedEvidence ? limitText(collectedEvidence.text, 2000) : undefined,
        },
      });
      throw error;
    }

    await emit({
      spanId,
      parentSpanId,
      type: "worker-completed",
      actor: `worker:${subtask.role}`,
      activity: "llm",
      status: "completed",
      title: isRevision ? `Worker revision: ${subtask.title}` : `Worker: ${subtask.title}`,
      detail: output,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(startedAt),
      payload: {
        subtask,
        output,
        modelTier,
        dependencySpanIds,
        artifacts: collectedEvidence.artifacts,
      },
    });

    return {
      subtask,
      output,
      toolEvidence: collectedEvidence.evidence,
      artifacts: collectedEvidence.artifacts,
      traceSpanId: spanId,
      modelTier,
    };
  }

  private async collectToolEvidence(
    originalTask: string,
    subtask: Subtask,
    emit: AgentEventEmitter,
    parentSpanId: string,
    dependencyContext?: string,
    dependencyArtifacts: AgentArtifact[] = [],
    saveArtifact?: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>,
    requestToolBuild?: (request: ToolBuildRequestInput) => Promise<ToolBuildRequest>,
  ): Promise<CollectedToolEvidence> {
    const evidence: string[] = [];
    const artifacts: AgentArtifact[] = [];
    const webSearch = this.tools.get("web.search");
    const toolNeedText = `${originalTask}\n${subtask.title}\n${subtask.role}\n${subtask.prompt}\n${subtask.expectedOutput}\n${subtask.reviewCriteria.join("\n")}`;

    if (webSearch && shouldCollectWebSearch(subtask, toolNeedText, dependencyContext)) {
      evidence.push(await this.runWebSearch(webSearch, subtask, emit, parentSpanId));
    }

    const marketTool = this.tools.findByCapability("market-timeseries")[0];
    if (marketTool && shouldCollectMarketTimeseries(subtask, toolNeedText)) {
      const marketEvidence = await this.runMarketTimeseries(
        marketTool,
        toolNeedText,
        emit,
        parentSpanId,
        saveArtifact,
      );
      evidence.push(...marketEvidence.evidence);
      artifacts.push(...marketEvidence.artifacts);
    }

    const declaredToolEvidence = await this.collectDeclaredToolInputs(
      subtask,
      evidence,
      emit,
      parentSpanId,
      saveArtifact,
    );
    evidence.push(...declaredToolEvidence.evidence);
    artifacts.push(...declaredToolEvidence.artifacts);

    for (const requirement of subtask.requiredArtifacts ?? []) {
      if (requirement.required === false) continue;

      const alreadyCreatedArtifact = artifacts.find((artifact) => artifactMatchesRequirement(artifact, requirement));
      if (alreadyCreatedArtifact) {
        evidence.push(
          `Current subtask artifact satisfies ${requirement.kind}: ${alreadyCreatedArtifact.filename}\n${alreadyCreatedArtifact.url}`,
        );
        continue;
      }

      const inheritedArtifact = dependencyArtifacts.find((artifact) => artifactMatchesRequirement(artifact, requirement));
      if (inheritedArtifact) {
        artifacts.push(inheritedArtifact);
        evidence.push(
          `Existing dependency artifact satisfies ${requirement.kind}: ${inheritedArtifact.filename}\n${inheritedArtifact.url}`,
        );
        continue;
      }

      const artifact = await this.createSubtaskArtifact(
        requirement,
        originalTask,
        subtask,
        evidence,
        emit,
        parentSpanId,
        dependencyContext,
        saveArtifact,
        requestToolBuild,
      );

      if (artifact) {
        artifacts.push(artifact);
        evidence.push(`Created artifact for ${requirement.kind}: ${artifact.filename}\n${artifact.url}`);
      }
    }

    if (evidence.length === 0) {
      return {
        text: "No external tool evidence was collected for this subtask.",
        evidence: [],
        artifacts: [],
      };
    }

    return {
      text: `External tool evidence collected for this subtask:\n${summarizeEvidenceList(evidence, promptBudget.toolEvidenceChars)}`,
      evidence: evidence.map((item) => limitText(item, promptBudget.toolEvidenceChars)),
      artifacts,
    };
  }

  private async runWebSearch(
    webSearch: Tool,
    subtask: Subtask,
    emit: AgentEventEmitter,
    parentSpanId: string,
  ): Promise<string> {
    const spanId = createSpanId(`tool-${webSearch.name}`);
    const startedAt = new Date();
    const queries = buildSearchQueries(subtask);
    const query = queries.join(" | ");

    await emit({
      spanId,
      parentSpanId,
      type: "tool-started",
      actor: webSearch.name,
      activity: "tool",
      status: "started",
      title: `Tool: ${webSearch.name}`,
      detail: query,
      startedAt: startedAt.toISOString(),
      payload: { tool: webSearch.name, query },
    });

    const results = await Promise.all(queries.map((candidate) => webSearch.run({ query: candidate, limit: 5 })));
    const result = mergeToolResults(results);
    await emit({
      spanId,
      parentSpanId,
      type: "tool-completed",
      actor: webSearch.name,
      activity: "tool",
      status: result.ok ? "completed" : "failed",
      title: `Tool: ${webSearch.name}`,
      detail: result.content,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(startedAt),
      payload: result,
    });

    return result.ok
      ? `External tool evidence from ${webSearch.name}:\n${limitText(result.content, promptBudget.toolEvidenceChars)}`
      : `External tool ${webSearch.name} failed:\n${limitText(result.content, 3000)}`;
  }

  private async runMarketTimeseries(
    marketTool: Tool,
    text: string,
    emit: AgentEventEmitter,
    parentSpanId: string,
    saveArtifact?: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>,
  ): Promise<CollectedToolEvidence> {
    const evidence: string[] = [];
    const artifacts: AgentArtifact[] = [];
    const requests = inferMarketTimeseriesRequests(text);

    for (const request of requests) {
      const spanId = createSpanId(`tool-${marketTool.name}`);
      const startedAt = new Date();
      await emit({
        spanId,
        parentSpanId,
        type: "tool-started",
        actor: marketTool.name,
        activity: "tool",
        status: "started",
        title: `Tool: ${marketTool.name}`,
        detail: `${request.symbol}/${request.vsCurrency} for ${request.days} day(s)`,
        startedAt: startedAt.toISOString(),
        payload: { tool: marketTool.name, input: request },
      });

      const result = await marketTool.run(request);
      await emit({
        spanId,
        parentSpanId,
        type: "tool-completed",
        actor: marketTool.name,
        activity: "tool",
        status: result.ok ? "completed" : "failed",
        title: `Tool: ${marketTool.name}`,
        detail: result.content,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: elapsedMs(startedAt),
        payload: sanitizeToolPayload(result),
      });

      const savedArtifacts: AgentArtifact[] = [];
      if (result.ok && saveArtifact && isMarketTimeseriesData(result.data)) {
        const artifactStartedAt = new Date();
        const artifact = await saveArtifact(result.data.artifact);
        savedArtifacts.push(artifact);
        await emit({
          spanId: createSpanId("artifact-market-data"),
          parentSpanId: spanId,
          type: "artifact-created",
          actor: "artifact:data",
          activity: "tool",
          status: "completed",
          title: "Market data artifact generated",
          detail: `${artifact.filename}\n${artifact.url}`,
          startedAt: artifactStartedAt.toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: elapsedMs(artifactStartedAt),
          payload: { artifact },
        });
      }

      artifacts.push(...savedArtifacts);
      evidence.push(formatDeclaredToolEvidence(marketTool.name, result, savedArtifacts));
    }

    return {
      text: evidence.length > 0 ? evidence.join("\n\n") : "No market time-series evidence was collected.",
      evidence,
      artifacts,
    };
  }

  private async collectDeclaredToolInputs(
    subtask: Subtask,
    priorEvidence: string[],
    emit: AgentEventEmitter,
    parentSpanId: string,
    saveArtifact?: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>,
  ): Promise<CollectedToolEvidence> {
    const entries = Object.entries(subtask.toolInputs ?? {}).filter(([toolName]) => toolName !== "web.search");
    const evidence: string[] = [];
    const artifacts: AgentArtifact[] = [];

    for (const [toolName, input] of entries) {
      const tool = this.tools.get(toolName) ?? this.tools.findByCapability(toolName)[0];
      if (!tool) {
        evidence.push(`Declared tool ${toolName} is not registered.`);
        continue;
      }
      const runnableInput = improveDeclaredToolInput(tool.name, input, subtask, priorEvidence);

      const spanId = createSpanId(`tool-${tool.name}`);
      const startedAt = new Date();
      await emit({
        spanId,
        parentSpanId,
        type: "tool-started",
        actor: tool.name,
        activity: "tool",
        status: "started",
        title: `Tool: ${tool.name}`,
        detail: summarizeToolInput(runnableInput),
        startedAt: startedAt.toISOString(),
        payload: { tool: tool.name, input: sanitizeToolPayload(runnableInput) },
      });

      const result = await tool.run(isRecord(runnableInput) ? runnableInput : {});
      await emit({
        spanId,
        parentSpanId,
        type: "tool-completed",
        actor: tool.name,
        activity: "tool",
        status: result.ok ? "completed" : "failed",
        title: `Tool: ${tool.name}`,
        detail: result.content,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: elapsedMs(startedAt),
        payload: sanitizeToolPayload(result),
      });

      const savedArtifacts: AgentArtifact[] = [];
      if (saveArtifact && isBrowserOperateData(result.data)) {
        for (const artifactInput of result.data.screenshots) {
          const artifactStartedAt = new Date();
          const artifactQa = inspectBrowserScreenshotEvidence({
            artifact: artifactInput,
            task: `${subtask.title}\n${subtask.prompt}\n${subtask.expectedOutput}`,
            browser: result.data,
            toolContent: result.content,
          });
          if (!artifactQa.ok) {
            evidence.push(`Rejected screenshot artifact ${artifactInput.filename}: ${artifactQa.reason}`);
            await emit({
              spanId: createSpanId("artifact-rejected"),
              parentSpanId: spanId,
              type: "artifact-created",
              actor: "artifact:browser",
              activity: "tool",
              status: "failed",
              title: "Browser artifact rejected by semantic QA",
              detail: `${artifactInput.filename}\n${artifactQa.reason}`,
              startedAt: artifactStartedAt.toISOString(),
              completedAt: new Date().toISOString(),
              durationMs: elapsedMs(artifactStartedAt),
              payload: { artifact: sanitizeArtifactInput(artifactInput), artifactQa },
            });
            continue;
          }
          const artifact = await saveArtifact(artifactInput);
          savedArtifacts.push(artifact);
          await emit({
            spanId: createSpanId("artifact"),
            parentSpanId: spanId,
            type: "artifact-created",
            actor: "artifact:browser",
            activity: "tool",
            status: "completed",
            title: "Browser artifact generated",
            detail: `${artifact.filename}\n${artifact.url}`,
            startedAt: artifactStartedAt.toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: elapsedMs(artifactStartedAt),
            payload: { artifact },
          });
        }
      }

      artifacts.push(...savedArtifacts);
      evidence.push(formatDeclaredToolEvidence(tool.name, result, savedArtifacts));
    }

    return {
      text: evidence.length > 0 ? evidence.join("\n\n") : "No declared tool inputs were executed.",
      evidence,
      artifacts,
    };
  }

  private async createSubtaskArtifact(
    requirement: ArtifactRequirement,
    originalTask: string,
    subtask: Subtask,
    evidence: string[],
    emit: AgentEventEmitter,
    parentSpanId: string,
    dependencyContext?: string,
    saveArtifact?: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>,
    requestToolBuild?: (request: ToolBuildRequestInput) => Promise<ToolBuildRequest>,
  ): Promise<AgentArtifact | undefined> {
    if (!saveArtifact) return undefined;

    if (requirement.kind === "screenshot" || requirement.capability === "browser-screenshot") {
      return this.createScreenshotArtifact(
        [dependencyContext, evidence.join("\n\n"), subtask.prompt, originalTask].filter(Boolean).join("\n\n"),
        emit,
        parentSpanId,
        saveArtifact,
        requestToolBuild,
      );
    }

    if (requirement.kind === "chart" || requirement.capability === "chart-generation") {
      const chartTool = await this.ensureToolCapability(
        "chart-generation",
        {
          capability: "chart-generation",
          reason: `Subtask "${subtask.title}" requires a chart artifact, but no registered TypeScript tool provides chart-generation.`,
          sourceSpanId: parentSpanId,
          taskSummary: `${originalTask}\n\n${subtask.prompt}`.slice(0, 1200),
          requiredInputs: ["task", "text"],
          requiredOutputs: ["artifact", "points"],
        },
        emit,
        parentSpanId,
        requestToolBuild,
      );
      if (!chartTool) return undefined;

      return this.runArtifactTool(
        chartTool,
        { task: originalTask, text: [originalTask, subtask.prompt, evidence.join("\n\n")].join("\n\n") },
        "chart-generation",
        requirement.description,
        emit,
        parentSpanId,
        saveArtifact,
        isChartToolData,
        (data) => data.artifact,
        "artifact:chart",
        "Chart artifact generated",
      );
    }

    await this.handleMissingToolCapability(
      {
        capability: requirement.capability,
        reason: `Subtask "${subtask.title}" requires a ${requirement.kind} artifact, but no artifact executor is registered for ${requirement.capability}.`,
        sourceSpanId: parentSpanId,
        taskSummary: `${originalTask}\n\n${subtask.prompt}`.slice(0, 1200),
        requiredInputs: ["task", "context"],
        requiredOutputs: ["artifact"],
      },
      emit,
      parentSpanId,
      requestToolBuild,
    );
    return undefined;
  }

  private async runWorkerAndRequestReview(
    originalTask: string,
    complexity: TaskComplexity,
    subtask: Subtask,
    memories: SkillMemoryEntry[],
    emit: AgentEventEmitter,
    parentSpanId: string,
    dependencyContext?: string,
    dependencySpanIds: string[] = [],
    dependencyArtifacts: AgentArtifact[] = [],
    saveArtifact?: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>,
    requestToolBuild?: (request: ToolBuildRequestInput) => Promise<ToolBuildRequest>,
  ): Promise<ReviewedWorkerResult> {
    const workerResult = await this.runWorker(
      originalTask,
      complexity,
      subtask,
      memories,
      emit,
      parentSpanId,
      dependencyContext,
      dependencySpanIds,
      dependencyArtifacts,
      undefined,
      saveArtifact,
      requestToolBuild,
    );
    const review = await this.review(complexity, workerResult, emit, workerResult.traceSpanId ?? parentSpanId);

    if (review.verdict === "pass") {
      return { workerResult, review, attempts: [workerResult], reviews: [review] };
    }

    const revisedWorkerResult = await this.runWorker(
      originalTask,
      complexity,
      subtask,
      memories,
      emit,
      workerResult.traceSpanId ?? parentSpanId,
      dependencyContext,
      dependencySpanIds,
      dependencyArtifacts,
      review.notes,
      saveArtifact,
      requestToolBuild,
    );
    const revisedReview = await this.review(
      complexity,
      revisedWorkerResult,
      emit,
      revisedWorkerResult.traceSpanId ?? workerResult.traceSpanId ?? parentSpanId,
    );

    return {
      workerResult: revisedWorkerResult,
      review: revisedReview,
      attempts: [workerResult, revisedWorkerResult],
      reviews: [review, revisedReview],
    };
  }

  private async createRequestedArtifact(
    task: string,
    workerResults: WorkerResult[],
    emit: AgentEventEmitter,
    parentSpanId: string,
    saveArtifact?: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>,
    requestToolBuild?: (request: ToolBuildRequestInput) => Promise<ToolBuildRequest>,
  ): Promise<AgentArtifact | undefined> {
    if (!saveArtifact) return undefined;

    if (asksForScreenshot(task)) {
      if (workerResults.some((result) => result.artifacts?.some((artifact) => artifact.mimeType === "image/png"))) {
        return undefined;
      }
      return this.createScreenshotArtifact(task, emit, parentSpanId, saveArtifact, requestToolBuild);
    }

    if (!asksForChart(task)) return undefined;

    const chartTool = this.tools.findByCapability("chart-generation")[0];
    if (!chartTool) {
      await this.handleMissingToolCapability(
        {
          capability: "chart-generation",
          reason: "A chart artifact was requested, but no registered TypeScript tool provides chart-generation.",
          sourceSpanId: parentSpanId,
          taskSummary: task.slice(0, 1200),
          requiredInputs: ["task", "text"],
          requiredOutputs: ["artifact", "points"],
          qaCriteria: [
            "Creates a downloadable chart artifact for arbitrary time-series input.",
            "Rejects missing or invalid series data with a structured failure result.",
            "Includes tests for arbitrary non-domain-specific series names.",
            "Manual smoke check verifies the artifact URL renders in the web UI.",
          ],
        },
        emit,
        parentSpanId,
        requestToolBuild,
      );
      const generatedChartTool = this.tools.findByCapability("chart-generation")[0];
      if (!generatedChartTool) return undefined;
      return this.createRequestedArtifact(task, workerResults, emit, parentSpanId, saveArtifact);
    }

    return this.runArtifactTool(
      chartTool,
      { task, text: [task, ...workerResults.map((result) => result.output)].join("\n\n") },
      "chart-generation",
      "Generate chart artifact from collected task context and worker outputs.",
      emit,
      parentSpanId,
      saveArtifact,
      isChartToolData,
      (data) => data.artifact,
      "artifact:chart",
      "Chart artifact generated",
    );
  }

  private async createScreenshotArtifact(
    context: string,
    emit: AgentEventEmitter,
    parentSpanId: string,
    saveArtifact: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>,
    requestToolBuild?: (request: ToolBuildRequestInput) => Promise<ToolBuildRequest>,
  ): Promise<AgentArtifact | undefined> {
    const url = selectBestUrlForArtifact(context);
    if (!url) {
      await this.handleMissingToolCapability(
        {
          capability: "browser-screenshot",
          reason: "A browser screenshot was requested, but no http(s) source URL was available in the task, dependencies, or tool evidence.",
          sourceSpanId: parentSpanId,
          taskSummary: context.slice(0, 1200),
          requiredInputs: ["url"],
          requiredOutputs: ["artifact"],
        },
        emit,
        parentSpanId,
        requestToolBuild,
      );
      return undefined;
    }

    const screenshotTool = await this.ensureToolCapability(
      "browser-screenshot",
      {
        capability: "browser-screenshot",
        reason: "A screenshot artifact was requested, but no registered TypeScript tool provides browser-screenshot.",
        sourceSpanId: parentSpanId,
        taskSummary: context.slice(0, 1200),
        requiredInputs: ["url"],
        requiredOutputs: ["artifact"],
        qaCriteria: [
          "Creates a downloadable PNG screenshot artifact for arbitrary http(s) URLs.",
          "Rejects missing or invalid URLs with a structured failure result.",
          "Includes tests for invalid input and a local-page screenshot smoke check.",
          "Manual smoke check verifies the artifact URL renders in the web UI.",
        ],
      },
      emit,
      parentSpanId,
      requestToolBuild,
    );
    if (!screenshotTool) return undefined;

    if (screenshotTool.name === "browser.operate") {
      return this.runArtifactTool(
        screenshotTool,
        {
          url,
          fullPage: true,
          label: "proof",
        },
        "browser-screenshot",
        `Capture browser screenshot for ${url}.`,
        emit,
        parentSpanId,
        saveArtifact,
        isBrowserOperateData,
        (data) => {
          const artifact = data.screenshots[0];
          if (!artifact) {
            throw new Error("browser.operate did not return a screenshot artifact.");
          }
          return artifact;
        },
        "artifact:screenshot",
        "Screenshot artifact generated",
      );
    }

    return this.runArtifactTool(
      screenshotTool,
      { url, fullPage: true },
      "browser-screenshot",
      `Capture browser screenshot for ${url}.`,
      emit,
      parentSpanId,
      saveArtifact,
      isScreenshotToolData,
      (data) => ({
        filename: data.artifact.filename,
        mimeType: data.artifact.mimeType,
        content: Buffer.from(data.artifact.contentBase64, "base64"),
        description: data.artifact.description,
      }),
      "artifact:screenshot",
      "Screenshot artifact generated",
    );
  }

  private async ensureToolCapability(
    capability: string,
    buildRequest: ToolBuildRequestInput,
    emit: AgentEventEmitter,
    parentSpanId: string,
    requestToolBuild?: (request: ToolBuildRequestInput) => Promise<ToolBuildRequest>,
  ): Promise<Tool | undefined> {
    let tool = this.tools.findByCapability(capability)[0];
    if (!tool) {
      await this.handleMissingToolCapability(
        {
          ...buildRequest,
          capability,
        },
        emit,
        parentSpanId,
        requestToolBuild,
      );
      tool = this.tools.findByCapability(capability)[0];
    }

    return tool;
  }

  private async runArtifactTool<TData>(
    tool: Tool,
    input: Record<string, unknown>,
    capability: string,
    detail: string,
    emit: AgentEventEmitter,
    parentSpanId: string,
    saveArtifact: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>,
    isData: (data: unknown) => data is TData,
    toArtifact: (data: TData) => ArtifactCreateInput,
    artifactActor: string,
    artifactTitle: string,
  ): Promise<AgentArtifact | undefined> {
    const spanId = createSpanId(`tool-${tool.name}`);
    const startedAt = new Date();
    await emit({
      spanId,
      parentSpanId,
      type: "tool-started",
      actor: tool.name,
      activity: "tool",
      status: "started",
      title: `Tool: ${tool.name}`,
      detail,
      startedAt: startedAt.toISOString(),
      payload: { tool: tool.name, capability },
    });

    const toolResult = await tool.run(input);
    if (!toolResult.ok || !isData(toolResult.data)) {
      await emit({
        spanId,
        parentSpanId,
        type: "tool-completed",
        actor: tool.name,
        activity: "tool",
        status: "failed",
        title: `Tool: ${tool.name}`,
        detail: toolResult.content,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: elapsedMs(startedAt),
        payload: sanitizeToolPayload(toolResult),
      });
      return undefined;
    }

    await emit({
      spanId,
      parentSpanId,
      type: "tool-completed",
      actor: tool.name,
      activity: "tool",
      status: "completed",
      title: `Tool: ${tool.name}`,
      detail: toolResult.content,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(startedAt),
      payload: sanitizeToolPayload(toolResult),
    });

    const artifactStartedAt = new Date();
    const artifactSpanId = createSpanId("artifact");
    const artifactInput = toArtifact(toolResult.data);
    if (capability === "browser-screenshot") {
      const artifactQa = inspectBrowserScreenshotEvidence({
        artifact: artifactInput,
        task: detail,
        browser: isBrowserOperateData(toolResult.data) ? toolResult.data : undefined,
        toolContent: toolResult.content,
      });
      if (!artifactQa.ok) {
        await emit({
          spanId: artifactSpanId,
          parentSpanId: spanId,
          type: "artifact-created",
          actor: artifactActor,
          activity: "tool",
          status: "failed",
          title: `${artifactTitle} rejected by semantic QA`,
          detail: `${artifactInput.filename}\n${artifactQa.reason}`,
          startedAt: artifactStartedAt.toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: elapsedMs(artifactStartedAt),
          payload: { artifact: sanitizeArtifactInput(artifactInput), artifactQa },
        });
        return undefined;
      }
    }
    const artifact = await saveArtifact(artifactInput);
    await emit({
      spanId: artifactSpanId,
      parentSpanId: spanId,
      type: "artifact-created",
      actor: artifactActor,
      activity: "tool",
      status: "completed",
      title: artifactTitle,
      detail: `${artifact.filename}\n${artifact.url}`,
      startedAt: artifactStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(artifactStartedAt),
      payload: { artifact },
    });

    return artifact;
  }

  private async handleMissingToolCapability(
    request: ToolBuildRequestInput,
    emit: AgentEventEmitter,
    parentSpanId: string,
    requestToolBuild?: (request: ToolBuildRequestInput) => Promise<ToolBuildRequest>,
  ): Promise<ToolBuildRequest | undefined> {
    const missingStartedAt = new Date();
    await emit({
      spanId: createSpanId(`tool-missing-${request.capability}`),
      parentSpanId,
      type: "tool-missing",
      actor: "tool-registry",
      activity: "tool",
      status: "failed",
      title: `Missing tool capability: ${request.capability}`,
      detail: request.reason,
      startedAt: missingStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(missingStartedAt),
      payload: request,
    });

    if (!requestToolBuild) return undefined;

    const buildStartedAt = new Date();
    const buildRequest = await requestToolBuild(request);
    await emit({
      spanId: createSpanId(`tool-build-${request.capability}`),
      parentSpanId,
      type: "tool-build-requested",
      actor: "tool-builder",
      activity: "tool",
      status: "completed",
      title: `Tool build requested: ${request.capability}`,
      detail: `${buildRequest.contract.toolName}\n${buildRequest.contract.modulePath}\n${buildRequest.contract.testPath}`,
      startedAt: buildStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(buildStartedAt),
      payload: { request: buildRequest },
    });

    return buildRequest;
  }

  private async review(
    complexity: TaskComplexity,
    workerResult: WorkerResult,
    emit: AgentEventEmitter,
    parentSpanId: string,
  ): Promise<ReviewResult> {
    const spanId = createSpanId(`review-${workerResult.subtask.id}`);
    const startedAt = new Date();
    const modelTier = selectModelTier("review", complexity, workerResult.subtask);
    await emit({
      spanId,
      parentSpanId,
      type: "review-started",
      actor: "reviewer",
      activity: "review",
      status: "started",
      title: `Review: ${workerResult.subtask.title}`,
      startedAt: startedAt.toISOString(),
      payload: { workerResult, modelTier },
    });

    const deterministicReview = hardGateReview(workerResult);
    if (deterministicReview) {
      await emit({
        spanId,
        parentSpanId,
        type: "review-completed",
        actor: "reviewer",
        activity: "review",
        status: "failed",
        title: `Review: ${workerResult.subtask.title}`,
        detail: `${deterministicReview.verdict}: ${deterministicReview.notes}`,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: elapsedMs(startedAt),
        payload: { ...deterministicReview, modelTier, deterministic: true },
      });
      return deterministicReview;
    }

    let review: ReviewResult;
    try {
      const output = await this.llm.complete([
        { role: "system", content: reviewerSystemPrompt(compactWorkerResultForPrompt(workerResult, promptBudget.reviewWorkerOutputChars)) },
        { role: "user", content: "Review the worker result now." },
      ], { modelTier });
      review = extractJson<ReviewResult>(output);
    } catch (error) {
      await emit({
        spanId,
        parentSpanId,
        type: "review-failed",
        actor: "reviewer",
        activity: "review",
        status: "failed",
        title: `Review failed: ${workerResult.subtask.title}`,
        detail: formatErrorMessage(error),
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: elapsedMs(startedAt),
        payload: { workerResult: compactWorkerResultForPrompt(workerResult, 2000), modelTier, error: formatErrorMessage(error) },
      });
      throw error;
    }
    await emit({
      spanId,
      parentSpanId,
      type: "review-completed",
      actor: "reviewer",
      activity: "llm",
      status: review.verdict === "pass" ? "completed" : "failed",
      title: `Review: ${workerResult.subtask.title}`,
      detail: `${review.verdict}: ${review.notes}`,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(startedAt),
      payload: { ...review, modelTier },
    });

    return review;
  }

  private async learn(
    task: string,
    finalAnswer: string,
    workerResults: WorkerResult[],
    modelTier: ReturnType<typeof selectModelTier>,
    options: RunOptions,
  ): Promise<SkillMemoryEntry | undefined> {
    const output = await this.llm.complete([
      { role: "system", content: "You extract compact reusable operational knowledge." },
      {
        role: "user",
        content: learningPrompt(
          limitText(task, promptBudget.taskContextChars),
          limitText(finalAnswer, 8_000),
          compactWorkerResultsForPrompt(workerResults, promptBudget.learningWorkerOutputChars),
        ),
      },
    ], { modelTier });
    const learning = extractJson<LearningResponse>(output);

    if (!learning.shouldStore || !learning.title || !learning.summary || !learning.reusableProcedure) {
      return undefined;
    }

    const memoryScope = normalizeMemoryScope(learning.scope);
    const sensitivity = normalizeMemorySensitivity(learning.sensitivity);
    const requestedStatus = normalizeMemoryStatus(learning.status);
    const status = memoryScope === "global" && sensitivity === "normal" ? requestedStatus : "proposed";

    return this.skillMemory.add({
      title: learning.title,
      tags: learning.tags ?? [],
      summary: learning.summary,
      reusableProcedure: learning.reusableProcedure,
      scope: memoryScope,
      scopeId: resolveMemoryScopeId(memoryScope, options),
      status,
      confidence: normalizeMemoryConfidence(learning.confidence),
      sensitivity,
      sourceRunId: options.runId,
      sourceThreadId: options.threadId,
      evidence: normalizeLearningEvidence(learning.evidence, task, finalAnswer, workerResults),
    });
  }
}

function resolveMemoryScopeId(scope: SkillMemoryEntry["scope"], options: RunOptions): string | undefined {
  if (scope === "group") return options.instanceId ?? "group-local";
  if (scope === "user") return options.requesterUserId ?? "user-admin";
  if (scope === "thread") return options.threadId;
  if (scope === "run") return options.runId;
  return undefined;
}

function normalizeLearningEvidence(
  evidence: unknown,
  task: string,
  finalAnswer: string,
  workerResults: WorkerResult[],
): string[] {
  const explicit = Array.isArray(evidence)
    ? evidence.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const generated = [
    `Task: ${limitText(task, 600)}`,
    `Final answer: ${limitText(finalAnswer, 600)}`,
    ...workerResults.slice(0, 3).map((result) => `Worker ${result.subtask.id}: ${limitText(result.output, 500)}`),
  ];
  return [...explicit, ...generated].map((item) => limitText(item, promptBudget.memoryEvidenceChars)).slice(0, 8);
}

function createExecutionPlan(rawSubtasks: Subtask[]): ExecutionPlan {
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  const uniqueSubtasks = rawSubtasks.map(normalizeSubtask).filter((subtask) => {
    if (!subtask.id || seenIds.has(subtask.id)) {
      warnings.push(`Dropped duplicate or empty subtask id: ${subtask.id || "<empty>"}`);
      return false;
    }
    seenIds.add(subtask.id);
    return true;
  });
  const knownIds = new Set(uniqueSubtasks.map((subtask) => subtask.id));
  const subtasks = uniqueSubtasks.map((subtask) => {
    const dependsOn = [...new Set(subtask.dependsOn ?? [])].filter((dependencyId) => {
      if (dependencyId === subtask.id) {
        warnings.push(`Dropped self-dependency on ${subtask.id}.`);
        return false;
      }
      if (!knownIds.has(dependencyId)) {
        warnings.push(`Dropped missing dependency ${dependencyId} from ${subtask.id}.`);
        return false;
      }
      return true;
    });

    return dependsOn.length > 0 ? { ...subtask, dependsOn } : { ...subtask, dependsOn: [] };
  });
  const remaining = new Map(subtasks.map((subtask) => [subtask.id, subtask]));
  const completed = new Set<string>();
  const levels: Subtask[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((subtask) =>
      (subtask.dependsOn ?? []).every((dependencyId) => completed.has(dependencyId)),
    );

    if (ready.length === 0) {
      const cycleBreakers = [...remaining.values()];
      warnings.push(
        `Dependency cycle detected across: ${cycleBreakers.map((subtask) => subtask.id).join(", ")}. Running them in one fallback level.`,
      );
      levels.push(cycleBreakers.map((subtask) => ({ ...subtask, dependsOn: [] })));
      break;
    }

    levels.push(ready);
    for (const subtask of ready) {
      remaining.delete(subtask.id);
      completed.add(subtask.id);
    }
  }

  return { subtasks, levels, warnings };
}

function normalizeSubtask(subtask: Subtask): Subtask {
  const text = [
    subtask.title,
    subtask.role,
    subtask.prompt,
    subtask.expectedOutput,
    ...(subtask.reviewCriteria ?? []),
  ].join("\n");
  const requiredTools = new Set((subtask.requiredTools ?? []).map((tool) => tool.trim()).filter(Boolean));
  const requiredArtifacts = [...(subtask.requiredArtifacts ?? [])];

  if (shouldUseWebSearch(text)) {
    requiredTools.add("web-search");
  }

  if (asksForScreenshot(text) && !requiredArtifacts.some((artifact) => artifact.kind === "screenshot")) {
    requiredTools.add("browser-screenshot");
    requiredArtifacts.push({
      kind: "screenshot",
      capability: "browser-screenshot",
      description: "Real screenshot artifact required by the subtask.",
      required: true,
    });
  }

  if (asksForChart(text) && !requiredArtifacts.some((artifact) => artifact.kind === "chart")) {
    requiredTools.add("chart-generation");
    requiredArtifacts.push({
      kind: "chart",
      capability: "chart-generation",
      description: "Real chart artifact required by the subtask.",
      required: true,
    });
  }

  if (shouldCollectMarketTimeseries(subtask, text)) {
    requiredTools.add("market-timeseries");
    if (!requiredArtifacts.some((artifact) => artifact.kind === "data" && artifact.capability === "market-timeseries")) {
      requiredArtifacts.push({
        kind: "data",
        capability: "market-timeseries",
        description: "Structured market time-series dataset required by the subtask.",
        required: false,
      });
    }
  }

  return {
    ...subtask,
    reviewCriteria: subtask.reviewCriteria ?? [],
    requiredTools: [...requiredTools],
    requiredArtifacts,
  };
}

function formatDependencyContext(dependencyResults: ReviewedWorkerResult[]): string | undefined {
  if (dependencyResults.length === 0) return undefined;

  return limitText(`Dependency results from earlier reviewed agents:
${dependencyResults
  .map(
    (result) => `
- ${result.workerResult.subtask.id}: ${result.workerResult.subtask.title}
  review: ${result.review.verdict} - ${result.review.notes}
  artifacts:
${indent(formatWorkerArtifacts(result.workerResult.artifacts))}
  worker output:
${indent(result.workerResult.output)}`,
  )
  .join("\n")}`, promptBudget.dependencyContextChars);
}

function formatWorkerArtifacts(artifacts: AgentArtifact[] | undefined): string {
  if (!artifacts || artifacts.length === 0) return "No artifacts.";

  return artifacts
    .map((artifact) => `- ${artifact.filename} (${artifact.mimeType}) ${artifact.url}`)
    .join("\n");
}

function buildWorkerUserPrompt(
  originalTask: string,
  toolEvidence: string,
  dependencyContext?: string,
  revisionInstructions?: string,
): string {
  return joinPromptSections(
    [
      ["Original user task for context", limitText(originalTask, promptBudget.taskContextChars)],
      ["External tool evidence", limitText(toolEvidence, promptBudget.toolEvidenceChars)],
      [
        "Runtime rule",
        "Available tools have already been executed and their evidence is above. Do not emit tool-call syntax, hidden browser commands, or pretend to navigate/click. Use only the evidence and artifact URLs you were given.",
      ],
      dependencyContext ? ["Dependency context", limitText(dependencyContext, promptBudget.dependencyContextChars)] : undefined,
      [
        "Instruction",
        revisionInstructions
          ? `Revise your previous work using these review notes:\n${limitText(revisionInstructions, 3_000)}`
          : "Execute only your assigned subtask.",
      ],
    ],
    promptBudget.workerUserPromptChars,
  );
}

function joinPromptSections(
  sections: Array<[string, string] | undefined>,
  maxChars: number,
): string {
  const rendered = sections
    .filter((section): section is [string, string] => Boolean(section))
    .map(([title, content]) => `${title}:\n${content.trim()}`)
    .join("\n\n");

  return limitText(rendered, maxChars);
}

function compactMemoriesForPrompt(memories: SkillMemoryEntry[]): SkillMemoryEntry[] {
  return memories.map((memory) => ({
    ...memory,
    summary: limitText(memory.summary, promptBudget.memoryEntryChars),
    reusableProcedure: limitText(memory.reusableProcedure, promptBudget.memoryEntryChars),
    evidence: (memory.evidence ?? []).slice(0, 4).map((item) => limitText(item, promptBudget.memoryEvidenceChars)),
  }));
}

function filterMemoriesForRuntime(
  candidates: SkillMemoryEntry[],
  options: RunOptions,
): { memories: SkillMemoryEntry[]; blocked: Array<{ memory: SkillMemoryEntry; decision: MemoryPolicyDecision }> } {
  if (!options.memoryScopes?.length) {
    return { memories: candidates.slice(0, 5), blocked: [] };
  }

  const allowed: SkillMemoryEntry[] = [];
  const blocked: Array<{ memory: SkillMemoryEntry; decision: MemoryPolicyDecision }> = [];

  for (const memory of candidates) {
    const decision = evaluateMemoryPolicy(memory, {
      visibleScopes: options.memoryScopes,
      requesterUserId: options.requesterUserId,
      allowSensitive: options.allowSensitiveMemory,
      allowPrivate: options.allowPrivateMemory,
    });

    if (decision.status === "allowed") {
      allowed.push(memory);
    } else {
      blocked.push({ memory, decision });
    }
  }

  return { memories: allowed.slice(0, 5), blocked };
}

function compactWorkerResultsForPrompt(workerResults: WorkerResult[], maxTotalOutputChars: number): WorkerResult[] {
  const perWorkerBudget = Math.max(1_500, Math.floor(maxTotalOutputChars / Math.max(1, workerResults.length)));
  return workerResults.map((workerResult) => compactWorkerResultForPrompt(workerResult, perWorkerBudget));
}

function compactWorkerResultForPrompt(workerResult: WorkerResult, outputBudget: number): WorkerResult {
  return {
    ...workerResult,
    output: limitText(workerResult.output, outputBudget),
    toolEvidence: workerResult.toolEvidence?.slice(0, 6).map((item) => limitText(item, 1_500)),
    artifacts: workerResult.artifacts?.map((artifact) => ({
      ...artifact,
      contentPreview: artifact.contentPreview ? limitText(artifact.contentPreview, 1_000) : undefined,
    })),
  };
}

function summarizeEvidenceList(evidence: string[], maxChars: number): string {
  if (evidence.length === 0) return "";
  const perItemBudget = Math.max(800, Math.floor(maxChars / evidence.length));
  return evidence.map((item) => limitText(item, perItemBudget)).join("\n\n");
}

function limitText(text: string | undefined, maxChars: number): string {
  const value = text ?? "";
  if (value.length <= maxChars) return value;
  if (maxChars <= 32) return value.slice(0, maxChars);

  const headChars = Math.floor(maxChars * 0.72);
  const tailChars = Math.max(0, maxChars - headChars - 80);
  const head = value.slice(0, headChars).trimEnd();
  const tail = tailChars > 0 ? value.slice(-tailChars).trimStart() : "";
  const omitted = value.length - head.length - tail.length;
  return `${head}\n\n[...truncated ${omitted} characters to fit model context...]\n\n${tail}`.trim();
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createEmitter(sink?: AgentEventSink): AgentEventEmitter {
  return async (event) => {
    if (!sink) return;

    const enriched: AgentEvent = {
      ...event,
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      spanId: event.spanId ?? createSpanId(event.type),
      timestamp: new Date().toISOString(),
    };

    await sink(enriched);
  };
}

function createSpanId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function elapsedMs(startedAt: Date): number {
  return Date.now() - startedAt.getTime();
}

function appendArtifactContext(task: string, artifacts: AgentArtifact[]): string {
  if (artifacts.length === 0) return task;

  return `${task}

Attached input artifacts:
${artifacts
  .map((artifact) => {
    const preview = artifact.contentPreview
      ? `\n  content preview:\n${indent(artifact.contentPreview)}`
      : "";
    return `- ${artifact.filename} (${artifact.mimeType}) ${artifact.url}${preview}`;
  })
  .join("\n")}`;
}

function appendThreadContext(
  task: string,
  threadContext?: {
    summary: string;
    acceptedFacts: string[];
    rejectedAttempts: string[];
    openQuestions: string[];
    relevantArtifactIds: string[];
  },
): string {
  if (!threadContext) return task;

  const lines = [
    "Conversation thread context:",
    `Summary: ${threadContext.summary || "No prior summary."}`,
    listContext("Accepted facts", threadContext.acceptedFacts),
    listContext("Rejected or failed attempts", threadContext.rejectedAttempts),
    listContext("Open questions", threadContext.openQuestions),
    listContext("Relevant artifact IDs", threadContext.relevantArtifactIds),
  ].filter(Boolean);

  return `${task}

${lines.join("\n")}`;
}

function listContext(title: string, values: string[]): string | undefined {
  if (values.length === 0) return undefined;
  return `${title}:\n${values.map((value) => `- ${value}`).join("\n")}`;
}

function appendRuntimeContext(task: string, now: Date, timeZone = process.env.AGENT_TIME_ZONE ?? process.env.TZ ?? "Europe/Madrid"): string {
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const localDateTime = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);

  return `${task}

Runtime context:
- Current date: ${localDate}
- Current local date/time: ${localDateTime}
- Time zone: ${timeZone}
- ISO timestamp: ${now.toISOString()}

Rules for temporal reasoning:
- Treat dates before ${localDate} as past dates.
- Treat dates after ${localDate} as future dates.
- Never recommend checking in a month/year that is already in the past.`;
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function withArtifactLinks(finalAnswer: string, artifacts: AgentArtifact[]): string {
  const normalizedAnswer = normalizeArtifactUrls(finalAnswer, artifacts);
  const outputArtifacts = artifacts.filter((artifact) => artifact.kind === "output");
  const missingLinks = outputArtifacts.filter((artifact) => !normalizedAnswer.includes(artifact.url));
  if (missingLinks.length === 0) return normalizedAnswer;

  return `${normalizedAnswer.trim()}

Файлы ответа:
${missingLinks.map((artifact) => `- ${artifact.filename}: ${artifact.url}`).join("\n")}`;
}

function normalizeArtifactUrls(finalAnswer: string, artifacts: AgentArtifact[]): string {
  let normalized = finalAnswer;
  for (const artifact of artifacts) {
    if (!artifact.url.startsWith("/")) continue;
    const fakeHostedUrl = new RegExp(
      `https?:\\/\\/api\\.runs\\.example\\.com${escapeRegExp(artifact.url)}(?=$|[\\s)\\]}.,])`,
      "g",
    );
    normalized = normalized.replace(fakeHostedUrl, artifact.url);
  }
  return normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pushUniqueArtifacts(target: AgentArtifact[], incoming: AgentArtifact[]): void {
  const seen = new Set(target.map((artifact) => artifact.id || artifact.url));
  for (const artifact of incoming) {
    const key = artifact.id || artifact.url;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(artifact);
  }
}

function getApprovedArtifacts(results: ReviewedWorkerResult[]): AgentArtifact[] {
  return results
    .filter((result) => result.review.verdict === "pass")
    .flatMap((result) => result.workerResult.artifacts ?? [])
    .filter((artifact) => !isClearlyIrrelevantArtifact(artifact));
}

function asksForScreenshot(task: string): boolean {
  return /screenshot|screen\s*capture|capture\s+page|скриншот|скрин|снимок\s+экрана|заскрин|зафиксируй\s+экран/i.test(
    task,
  );
}

function shouldCollectWebSearch(subtask: Subtask, text: string, dependencyContext?: string): boolean {
  const requiredTools = subtask.requiredTools ?? [];
  const isDependentSynthesisOrReview =
    Boolean(dependencyContext) &&
    (subtask.dependsOn?.length ?? 0) > 0 &&
    /(analyst|reviewer|synthesizer|audit|quality)/i.test(`${subtask.role} ${subtask.title}`) &&
    /using|provided|dependency|review|synthesize|audit|анализ|проверь|используя/i.test(text);
  const explicitlyCollectsNewExternalData = /perform\s+(?:a\s+)?(?:real-time\s+)?(?:web\s+)?search|collect\s+(?:new\s+)?(?:web\s+)?data|use\s+at\s+least|check\s+(?:external|current)|найди\s+(?:нов|актуаль)|искать\s+(?:нов|актуаль)/i.test(
    text,
  );
  if (isDependentSynthesisOrReview && !explicitlyCollectsNewExternalData) return false;

  return (
    shouldUseWebSearch(text) ||
    requiredTools.some((tool) =>
      ["web.search", "web-search", "research", "current-information"].includes(tool.toLowerCase()),
    )
  );
}

function shouldCollectMarketTimeseries(subtask: Subtask, text: string): boolean {
  const requestedTools = (subtask.requiredTools ?? []).map((tool) => tool.toLowerCase());
  return (
    requestedTools.some((tool) => ["market-timeseries", "crypto-timeseries", "structured-market-data"].includes(tool)) ||
    (/(?:price|market|timeseries|time-series|ohlcv|chart|graph|trend|курс|цена|рынок|график|тренд|динамик)/i.test(
      text,
    ) &&
      inferMarketSymbols(text).length > 0)
  );
}

function inferMarketTimeseriesRequests(text: string): Array<{ symbol: string; vsCurrency: string; days: number }> {
  const days = inferMarketDays(text);
  const vsCurrency = /\beur\b|евро/i.test(text) ? "eur" : "usd";
  return inferMarketSymbols(text)
    .slice(0, 3)
    .map((symbol) => ({ symbol, vsCurrency, days }));
}

function inferMarketSymbols(text: string): string[] {
  const candidates: Array<[RegExp, string]> = [
    [/\b(?:btc|bitcoin)\b|биткоин/i, "BTC"],
    [/\b(?:eth|ether|ethereum)\b|эфир/i, "ETH"],
    [/\b(?:sol|solana)\b|солан/i, "SOL"],
    [/\bbnb\b/i, "BNB"],
    [/\bxrp\b/i, "XRP"],
    [/\bada\b|cardano/i, "ADA"],
    [/\bdoge\b|dogecoin/i, "DOGE"],
    [/\bavax\b|avalanche/i, "AVAX"],
    [/\bdot\b|polkadot/i, "DOT"],
    [/\bton\b/i, "TON"],
  ];
  const symbols = candidates.filter(([pattern]) => pattern.test(text)).map(([, symbol]) => symbol);
  return [...new Set(symbols)];
}

function inferMarketDays(text: string): number {
  if (/пол\s*года|half\s*(?:a\s*)?year|6\s*months|six\s*months/i.test(text)) return 180;
  if (/год|year|12\s*months/i.test(text)) return 365;
  if (/лет[оа]|summer/i.test(text)) return 120;
  if (/месяц|month|30\s*days/i.test(text)) return 30;
  if (/недел|week|7\s*days/i.test(text)) return 7;
  return 30;
}

function buildSearchQueries(subtask: Subtask): string[] {
  const promptLines = subtask.prompt
    .split(/\n+/)
    .map((line) => line.replace(/^[-*\d.\s:]+/, "").trim())
    .filter(Boolean);
  const leadLine = promptLines.find((line) => /search|find|найди|искать|research/i.test(line)) ?? promptLines[0] ?? "";
  const sourceHints = promptLines
    .filter((line) => /google flights|skyscanner|kayak|momondo|booking|source|источник|ссылка/i.test(line))
    .join(" ");
  const raw = `${subtask.title} ${leadLine} ${sourceHints}`;

  const primary = cleanSearchQuery(raw);
  const queries = [primary];
  const iataCodes = [...new Set(subtask.prompt.match(/\b[A-Z]{3}\b/g) ?? [])];
  if (iataCodes.length >= 2) {
    queries.push(cleanSearchQuery(`${iataCodes.slice(0, 3).join(" ")} flights Google Flights Skyscanner Kayak`));
  }
  const routeMatch = subtask.prompt.match(/from\s+([A-Za-zА-Яа-яÁÉÍÓÚáéíóúñü\s-]+).*?\bto\s+([A-Za-zА-Яа-яÁÉÍÓÚáéíóúñü\s-]+)/i);
  if (routeMatch) {
    queries.push(cleanSearchQuery(`${routeMatch[1]} to ${routeMatch[2]} flights Google Flights Skyscanner Kayak`));
  }

  return [...new Set(queries.filter(Boolean))].slice(0, 3);
}

function cleanSearchQuery(value: string): string {
  return value
    .replace(/[`*_#>]/g, " ")
    .replace(/\bIMPORTANT\b:?/gi, " ")
    .replace(/\bmust\b|\byou\b|\busing\b|\bextract\b|\bprovide\b|\bcapture\b/gi, " ")
    .replace(/[^\p{L}\p{N}\s().,-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function mergeToolResults(results: Awaited<ReturnType<Tool["run"]>>[]): Awaited<ReturnType<Tool["run"]>> {
  const ok = results.some((result) => result.ok);
  const lines: string[] = [];
  const seenUrls = new Set<string>();
  const data: unknown[] = [];

  for (const result of results) {
    if (Array.isArray(result.data)) {
      for (const item of result.data) {
        const url = typeof item === "object" && item && "url" in item ? String((item as { url?: unknown }).url) : "";
        if (url && seenUrls.has(url)) continue;
        if (url) seenUrls.add(url);
        data.push(item);
      }
    }
    if (result.content) lines.push(result.content);
  }

  return {
    ok,
    content: lines.join("\n\n").slice(0, 8000),
    data,
  };
}

function formatDeclaredToolEvidence(
  toolName: string,
  result: Awaited<ReturnType<Tool["run"]>>,
  artifacts: AgentArtifact[],
): string {
  const artifactText =
    artifacts.length > 0
      ? `\nSaved artifacts:\n${artifacts.map((artifact) => `- ${artifact.filename}: ${artifact.url}`).join("\n")}`
      : "";

  if (isBrowserOperateData(result.data)) {
    const extractedText = result.data.extractedText
      .map((item) => `\n[${item.label}]\n${item.text.slice(0, 2500)}`)
      .join("\n");
    return limitText(`Declared tool evidence from ${toolName}:\n${result.content}${artifactText}${extractedText}`, promptBudget.toolEvidenceChars);
  }

  return limitText(`Declared tool evidence from ${toolName}:\n${result.content}${artifactText}`, promptBudget.toolEvidenceChars);
}

function improveDeclaredToolInput(
  toolName: string,
  input: unknown,
  subtask: Subtask,
  priorEvidence: string[],
): unknown {
  if (toolName !== "browser.operate" || !isRecord(input)) return input;
  const commands = Array.isArray(input.commands) ? input.commands : [];
  if (!commands.some(isBrittleBrowserInteractionCommand)) return input;

  const evidenceUrls = selectBestUrlsForArtifact(
    priorEvidence.join("\n\n"),
    requiresMultipleSources(subtask) ? 3 : 1,
  );
  if (evidenceUrls.length === 0) return input;
  const firstNavigationUrl = commands.find(isNavigateCommand)?.url;
  if (firstNavigationUrl && !isGenericBrowserSearchUrl(firstNavigationUrl)) return input;

  return {
    ...input,
    commands: evidenceUrls.flatMap((url, index) => {
      const label = `source-${index + 1}-${safeLabel(new URL(url).hostname)}`;
      return [
        { type: "navigate", url },
        { type: "dismissDialogs" },
        { type: "extractText", label, maxLength: 9000 },
        { type: "extractLinks", label: `${label}-links`, limit: 40 },
        { type: "screenshot", label, fullPage: true },
      ];
    }),
  };
}

function requiresMultipleSources(subtask: Subtask): boolean {
  return /(?:at least|minimum|минимум)\s*(?:2|two|two-three|2-3)|2\s*-\s*3|нескольк.*источник|different aggregators|разн.*агрегатор/i.test(
    [subtask.prompt, subtask.expectedOutput, ...(subtask.reviewCriteria ?? [])].join("\n"),
  );
}

function isBrittleBrowserInteractionCommand(command: unknown): boolean {
  if (!isRecord(command)) return false;
  const type = command.type;
  if (type !== "fill" && type !== "type" && type !== "click") return false;
  const selector = typeof command.selector === "string" ? command.selector : "";
  return (
    selector === "" ||
    /\[aria-label=['"][^'"]+['"]\]|:has-text\(|placeholder|input\[/.test(selector)
  );
}

function isNavigateCommand(command: unknown): command is { type: "navigate"; url: string } {
  return isRecord(command) && command.type === "navigate" && typeof command.url === "string";
}

function isGenericBrowserSearchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const path = parsed.pathname.toLowerCase().replace(/\/+$/, "");
    if (/google\.[a-z.]+$/.test(host) && (path === "/flights" || path === "/travel/flights")) return true;
    return /(skyscanner|kayak|momondo|kiwi|expedia|trip\.com)/.test(host) && (path === "" || path === "/" || path === "/flights");
  } catch {
    return false;
  }
}

function safeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "proof";
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "No structured input.";
  const commands = (input as { commands?: unknown }).commands;
  if (Array.isArray(commands)) {
    return `${commands.length} browser command(s): ${commands
      .map((command) =>
        command && typeof command === "object" && "type" in command
          ? String((command as { type?: unknown }).type)
          : "unknown",
      )
      .join(", ")}`;
  }

  return JSON.stringify(sanitizeToolPayload(input)).slice(0, 1000);
}

function selectBestUrlForArtifact(text: string): string | undefined {
  return selectBestUrlsForArtifact(text, 1)[0];
}

function selectBestUrlsForArtifact(text: string, limit: number): string[] {
  const urls = extractHttpUrls(text);
  if (urls.length === 0) return [];
  const sourceUrls = urls.filter((url) => !isLowValueProofUrl(url));
  const ranked = sourceUrls
    .map((url) => ({ url, score: scoreArtifactUrl(url) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const selected: string[] = [];
  const seenHosts = new Set<string>();

  for (const item of ranked) {
    const host = normalizedHost(item.url);
    if (seenHosts.has(host)) continue;
    seenHosts.add(host);
    selected.push(item.url);
    if (selected.length >= limit) return selected;
  }

  for (const url of sourceUrls) {
    if (selected.includes(url)) continue;
    selected.push(url);
    if (selected.length >= limit) return selected;
  }

  return selected.length > 0 ? selected : urls.slice(0, limit);
}

function normalizedHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url;
  }
}

function scoreArtifactUrl(url: string): number {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (/google\.[a-z.]+$/.test(host) && path.includes("/travel/flights")) return 120;
    if (host.includes("skyscanner") && /routes|flights/.test(path)) return 110;
    if (host.includes("kayak") && /flight|route/.test(path)) return 105;
    if (/(momondo|kiwi|expedia|trip\.com|aviasales)/.test(host) && /flight|route/.test(path)) return 95;
    if (/(pegasus|turkishairlines|ryanair|easyjet|vueling|lufthansa)/.test(host)) return 85;
    return 0;
  } catch {
    return 0;
  }
}

function isLowValueProofUrl(url: string): boolean {
  return /example\.com|placeholder|localhost|127\.0\.0\.1|facebook\.com|reddit\.com|quora\.com|\.pdf(?:$|[?#])|faa\.gov|easa\.europa\.eu|aclanthology\.org|stanford\.edu|baymard\.com|codalab\.org|nlp\.biu\.ac\.il/i.test(
    url,
  );
}

function extractHttpUrls(text: string): string[] {
  const matches = text.matchAll(/https?:\/\/[^\s"'<>),\]]+/gi);
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of matches) {
    const url = match[0].replace(/[.;:!?]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function hardGateReview(workerResult: WorkerResult): ReviewResult | undefined {
  if (containsUnexecutedToolCall(workerResult.output)) {
    return {
      subtaskId: workerResult.subtask.id,
      verdict: "needs_revision",
      notes:
        "Output contains unexecuted tool-call or browser-command syntax. The worker must answer from actual runtime tool evidence and artifact URLs only.",
    };
  }

  const missingArtifacts = (workerResult.subtask.requiredArtifacts ?? []).filter(
    (requirement) =>
      requirement.required !== false &&
      !workerResult.artifacts?.some((artifact) => artifactMatchesRequirement(artifact, requirement)),
  );

  if (missingArtifacts.length > 0) {
    return {
      subtaskId: workerResult.subtask.id,
      verdict: "needs_revision",
      notes: `Missing required real artifact(s): ${missingArtifacts
        .map((requirement) => `${requirement.kind}/${requirement.capability}`)
        .join(", ")}. The worker must produce actual saved artifact URLs before this can pass.`,
    };
  }

  const irrelevantArtifacts = (workerResult.subtask.requiredArtifacts ?? [])
    .filter((requirement) => requirement.required !== false)
    .flatMap((requirement) =>
      (workerResult.artifacts ?? []).filter(
        (artifact) => artifactMatchesRequirement(artifact, requirement) && isClearlyIrrelevantArtifact(artifact),
      ),
    );
  if (irrelevantArtifacts.length > 0) {
    return {
      subtaskId: workerResult.subtask.id,
      verdict: "needs_revision",
      notes: `Required proof artifact is not relevant to the subtask source: ${irrelevantArtifacts
        .map((artifact) => artifact.filename)
        .join(", ")}. Use a relevant source page or report that no valid proof artifact could be produced.`,
    };
  }

  if (containsWeakArtifactEvidence(workerResult.output)) {
    return {
      subtaskId: workerResult.subtask.id,
      verdict: "needs_revision",
      notes:
        "Output describes weak or unusable browser/artifact evidence, such as a blank page, loader, login wall, blocker, or unrelated proof. Retry with stronger evidence or report that useful proof cannot be produced.",
    };
  }

  if (containsPlaceholderProof(workerResult.output)) {
    return {
      subtaskId: workerResult.subtask.id,
      verdict: "needs_revision",
      notes: "Output contains placeholder or fake proof links. Replace them with real source URLs and saved artifact URLs.",
    };
  }

  const weakTypedArtifacts = (workerResult.subtask.requiredArtifacts ?? [])
    .filter((requirement) => requirement.required !== false)
    .flatMap((requirement) =>
      (workerResult.artifacts ?? [])
        .filter((artifact) => artifactMatchesRequirement(artifact, requirement))
        .map((artifact) => ({ artifact, requirement, report: inspectArtifactRequirement(artifact, requirement) }))
        .filter(({ report }) => !report.ok),
    );

  if (weakTypedArtifacts.length > 0) {
    return {
      subtaskId: workerResult.subtask.id,
      verdict: "needs_revision",
      notes: `Required artifact failed typed QA: ${weakTypedArtifacts
        .map(({ artifact, report }) => `${artifact.filename}: ${report.reason}`)
        .join("; ")}. Regenerate the artifact or report that a useful artifact cannot be produced.`,
    };
  }

  return undefined;
}

function isClearlyIrrelevantArtifact(artifact: AgentArtifact): boolean {
  const haystack = `${artifact.filename}\n${artifact.description ?? ""}\n${artifact.url}`;
  return isLowValueProofUrl(haystack);
}

function containsPlaceholderProof(text: string): boolean {
  return /https?:\/\/(?:www\.)?example\.com|placeholder|fake-|screenshot-capture\.placeholder|dummy|todo-url/i.test(text);
}

function containsWeakArtifactEvidence(text: string): boolean {
  const hasArtifactContext = /screenshot|скриншот|artifact|артефакт|browser|браузер|proof|доказатель/i.test(text);
  const hasWeakEvidence =
    /blank page|empty page|white page|black page|loading screen|loader|spinner|still loading|login wall|sign in|access denied|forbidden|blocked|bot check|robot check|verify real visitors|captcha|challenge|unrelated page|no useful content|нет полезн|пустая страниц|страниц[аы] загруз|только загруз|экран загруз|не удалось.*скриншот|защит[аы] от бот/i.test(
      text,
    );
  return hasArtifactContext && hasWeakEvidence;
}

function containsUnexecutedToolCall(text: string): boolean {
  return /<\|?tool_call|tool_code|browser:navigate|browser\.navigate|call:browser|```tool/i.test(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type ScreenshotToolData = {
  artifact: {
    filename: string;
    mimeType: string;
    contentBase64: string;
    description?: string;
  };
  url?: string;
};

function isScreenshotToolData(data: unknown): data is ScreenshotToolData {
  if (!data || typeof data !== "object") return false;
  const artifact = (data as { artifact?: unknown }).artifact;
  if (!artifact || typeof artifact !== "object") return false;

  const candidate = artifact as Partial<ScreenshotToolData["artifact"]>;
  return (
    typeof candidate.filename === "string" &&
    candidate.mimeType === "image/png" &&
    typeof candidate.contentBase64 === "string" &&
    candidate.contentBase64.length > 0
  );
}

function sanitizeToolPayload(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return `[buffer:${value.byteLength}]`;
  if (Array.isArray(value)) return value.map(sanitizeToolPayload);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      key.toLowerCase().includes("base64") && typeof item === "string"
        ? `[base64:${item.length}]`
        : sanitizeToolPayload(item),
    ]),
  );
}

function sanitizeArtifactInput(input: ArtifactCreateInput) {
  const sizeBytes = Buffer.isBuffer(input.content) ? input.content.byteLength : Buffer.byteLength(input.content);
  return {
    filename: input.filename,
    mimeType: input.mimeType,
    description: input.description,
    sizeBytes,
  };
}
