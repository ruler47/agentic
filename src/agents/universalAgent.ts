import { LlmClient } from "../llm/client.js";
import type { GroupProfileRecord } from "../instance/groupProfileStore.js";
import type { UserRecord } from "../instance/userStore.js";
import {
  MemoryScopeFilter,
  normalizeMemoryConfidence,
  normalizeMemoryScope,
  normalizeMemorySensitivity,
  normalizeMemoryStatus,
  SkillMemoryStore,
} from "../memory/skillMemory.js";
import { evaluateMemoryPolicy, MemoryPolicyDecision } from "../memory/memoryPolicy.js";
import { reviewMemoryProposal } from "../memory/memoryProposalReview.js";
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
import {
  mergeArtifactQualityMetadata,
  semanticArtifactQualityMetadata,
  toolArtifactQualityMetadata,
} from "../artifacts/artifactQualityMetadata.js";
import { inspectBrowserScreenshotEvidence } from "../artifacts/semanticArtifactQuality.js";
import { isChartToolData } from "../tools/chartGenerateTool.js";
import { isBrowserOperateData } from "../tools/browserOperateTool.js";
import { isMarketTimeseriesData } from "../tools/marketTimeseriesTool.js";
import { ToolBuildRequest, ToolBuildRequestInput } from "../tools/toolBuildRequestStore.js";
import {
  ToolImprovementCoordinator,
  ToolImprovementRequest,
  ToolImprovementResult,
} from "../tools/toolImprovementCoordinator.js";
import { ToolReworkWaitRecord } from "../runs/toolReworkWaitStore.js";
import {
  EvidenceLedgerStore,
  RunRetrospectiveStore,
  WorkLedgerStore,
} from "../work-ledger/types.js";
import { searchQueryWorkKey, toolCallWorkKey } from "../work-ledger/workKey.js";
import { RuntimeLedgerCoordinator } from "../work-ledger/runtimeLedgerCoordinator.js";
import { Tool, ToolExecutionContext, ToolInput, ToolResult } from "../tools/tool.js";

type AgentImproveToolFn = (request: ToolImprovementRequest) => Promise<ToolImprovementResult>;
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
import {
  buildReviewSelfCheck,
  buildWorkerSelfCheck,
  completeCallFrame,
  createReviewerCallFrame,
  createWorkerCallFrame,
} from "./callFrame.js";

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
    relevantArtifacts?: AgentArtifact[];
  };
  instanceContext?: {
    groupProfile?: GroupProfileRecord;
    requesterUser?: UserRecord;
  };
  memoryScopes?: MemoryScopeFilter[];
  allowSensitiveMemory?: boolean;
  allowPrivateMemory?: boolean;
  saveArtifact?: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>;
  requestToolBuild?: (request: ToolBuildRequestInput) => Promise<ToolBuildRequest>;
  toolImprovementCoordinator?: ToolImprovementCoordinator;
  toolExecutionContext?: Partial<Omit<ToolExecutionContext, "toolName" | "now">>;
  workLedgerStore?: WorkLedgerStore;
  evidenceLedgerStore?: EvidenceLedgerStore;
  runRetrospectiveStore?: RunRetrospectiveStore;
  now?: Date;
  timeZone?: string;
};

type BaseToolExecutionContext = Partial<Omit<ToolExecutionContext, "toolName" | "now">>;

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
  /**
   * Per-run RuntimeLedgerCoordinator instances keyed by `runId`. Stored on the agent
   * instance so deeply nested helpers (`runWebSearch`, `runArtifactTool`, …) can
   * recover the coordinator from `toolExecutionContext.runId` without threading it
   * through every signature. Concurrent runs are safe because each call writes its
   * own `runId` slot and clears it in a try/finally; runs without a `runId` (CLI /
   * test fixtures without HTTP wiring) simply skip the ledger.
   */
  private readonly runScopedLedgers = new Map<string, RuntimeLedgerCoordinator>();

  constructor(
    private readonly llm: LlmClient,
    private readonly skillMemory: SkillMemoryStore,
    private readonly tools = new ToolRegistry(),
  ) {}

  private resolveLedgerFromContext(
    toolExecutionContext: BaseToolExecutionContext | undefined,
  ): RuntimeLedgerCoordinator | undefined {
    const runId = toolExecutionContext?.runId;
    if (typeof runId !== "string" || runId === "") return undefined;
    return this.runScopedLedgers.get(runId);
  }

  private async finalizeRunLedger(
    ledger: RuntimeLedgerCoordinator | undefined,
    runOutcome: "completed" | "failed" | "cancelled" | "waiting_tool_rework",
    runId: string | undefined,
    parentSpanId: string,
  ): Promise<void> {
    try {
      if (ledger) {
        await ledger.writeRetrospective(runOutcome, parentSpanId);
      }
    } finally {
      if (runId) this.runScopedLedgers.delete(runId);
    }
  }

  async run(task: string, options: RunOptions = {}): Promise<AgentRunResult> {
    const emit = createEmitter(options.onEvent);
    const runSpanId = createSpanId("run");
    const memorySpanId = createSpanId("memory");
    const classificationSpanId = createSpanId("classification");
    const runStartedAt = options.now ?? new Date();
    const artifacts: AgentArtifact[] = [...(options.inputArtifacts ?? [])];
    const toolExecutionContext = buildToolExecutionContext(options);
    // Optional Work / Evidence / Run-Retrospective runtime adapter. When no stores are
    // wired up the coordinator short-circuits every method, so this slice is purely
    // additive for existing CLI / fake-LLM flows.
    const ledger = (options.workLedgerStore || options.evidenceLedgerStore || options.runRetrospectiveStore)
      ? new RuntimeLedgerCoordinator({
          workLedgerStore: options.workLedgerStore,
          evidenceLedgerStore: options.evidenceLedgerStore,
          runRetrospectiveStore: options.runRetrospectiveStore,
          runId: options.runId,
          threadId: options.threadId,
          instanceId: options.instanceId,
          emit,
        })
      : undefined;
    if (ledger && options.runId) {
      this.runScopedLedgers.set(options.runId, ledger);
    }
    const pendingToolImprovements: ToolReworkWaitRecord[] = [];
    const improveTool: AgentImproveToolFn | undefined = options.toolImprovementCoordinator
      ? async (request) => {
          const result = await options.toolImprovementCoordinator!.requestImprovement({
            ...request,
            runId: request.runId ?? options.runId,
          });
          if (result.status === "waiting" && result.wait) {
            pendingToolImprovements.push(result.wait);
          }
          return result;
        }
      : undefined;
    const appendPendingImprovements = (answer: string): string => {
      if (pendingToolImprovements.length === 0) return answer;
      const lines = pendingToolImprovements.map((wait) =>
        `- ${wait.id}: build ${wait.buildRequestId ?? "(unknown)"}, ` +
          `tool ${wait.toolName ?? "(unknown)"} [status: ${wait.status}]`,
      );
      return `${answer}\n\n---\n` +
        `Note: this run is waiting for tool improvements and cannot be fully retried yet. ` +
        `Operator (or the future recursive retry engine in Phase 2) can mark these waits ready ` +
        `for retry once the new tool versions are promoted.\n\n` +
        `Pending tool rework waits:\n${lines.join("\n")}`;
    };

    try {
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
      appendInstanceContext(
        appendThreadContext(appendArtifactContext(task, artifacts), options.threadContext),
        options.instanceContext,
      ),
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
    let complexity = await this.classify(taskContext, memories, classificationTier);
    if (complexity.mode === "direct" && hasActionableApiToolRequest(taskContext, this.tools.list())) {
      complexity = {
        ...complexity,
        mode: "delegated",
        reason: `${complexity.reason} Registered API tool execution is required.`,
      };
    }
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
        improveTool,
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
      const finalAnswer = appendPendingImprovements(withArtifactLinks(rawFinalAnswer, artifacts));
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

      await this.finalizeRunLedger(ledger, "completed", options.runId, runSpanId);
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
      improveTool,
      toolExecutionContext,
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
      improveTool,
      toolExecutionContext,
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
    const finalAnswer = appendPendingImprovements(withArtifactLinks(rawFinalAnswer, artifacts));
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

    await this.finalizeRunLedger(ledger, "completed", options.runId, runSpanId);
    return {
      finalAnswer,
      complexity,
      subtasks,
      workerResults,
      reviews,
      artifacts,
      learnedSkill,
    };
    } catch (error) {
      ledger?.trackWhatFailed(`Run failed: ${formatErrorMessage(error)}`);
      await ledger?.markUnfinishedWorkFailed(limitText(formatErrorMessage(error), 600));
      await this.finalizeRunLedger(ledger, "failed", options.runId, runSpanId);
      throw error;
    }
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
    improveTool?: AgentImproveToolFn,
    toolExecutionContext?: BaseToolExecutionContext,
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
            improveTool,
            toolExecutionContext,
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
    improveTool?: AgentImproveToolFn,
    toolExecutionContext?: BaseToolExecutionContext,
  ): Promise<WorkerResult> {
    const isRevision = Boolean(revisionInstructions);
    const modelTier = selectModelTier("worker", complexity, subtask);
    const spanId = createSpanId(isRevision ? `worker-revision-${subtask.id}` : `worker-${subtask.id}`);
    const startedAt = new Date();
    const actor = `worker:${subtask.role}`;
    const callFrame = createWorkerCallFrame({
      runId: toolExecutionContext?.runId,
      spanId,
      parentSpanId,
      subtask,
      actor,
      modelTier,
      startedAt: startedAt.toISOString(),
      dependencySpanIds,
      revisionOfFrameId: isRevision ? `frame_${parentSpanId}` : undefined,
    });
    await emit({
      spanId,
      parentSpanId,
      type: "worker-started",
      actor,
      activity: "worker",
      status: "started",
      title: isRevision ? `Worker revision: ${subtask.title}` : `Worker: ${subtask.title}`,
      detail: revisionInstructions ?? subtask.role,
      startedAt: startedAt.toISOString(),
      payload: { subtask, modelTier, dependencySpanIds, callFrame },
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
        improveTool,
        toolExecutionContext,
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
        actor,
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
          callFrame: completeCallFrame(callFrame, {
            status: "failed",
            completedAt: new Date().toISOString(),
            outputSummary: formatErrorMessage(error),
          }),
        },
      });
      throw error;
    }

    const workerResult: WorkerResult = {
      subtask,
      output,
      toolEvidence: collectedEvidence.evidence,
      artifacts: collectedEvidence.artifacts,
      traceSpanId: spanId,
      modelTier,
    };
    const selfCheckStartedAt = new Date();
    const selfCheck = buildWorkerSelfCheck(workerResult, selfCheckStartedAt);
    await emit({
      spanId: createSpanId(`self-check-${subtask.id}`),
      parentSpanId: spanId,
      type: "agent-self-check-completed",
      actor,
      activity: "agent",
      status: selfCheck.readyToReturn ? "completed" : "failed",
      title: `Self-check: ${subtask.title}`,
      detail: selfCheck.readyToReturn
        ? "Ready to return."
        : `Needs repair before return: ${selfCheck.warnings.join("; ")}`,
      startedAt: selfCheckStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(selfCheckStartedAt),
      payload: { callFrame, selfCheck },
    });

    const completedAt = new Date().toISOString();
    await emit({
      spanId,
      parentSpanId,
      type: "worker-completed",
      actor,
      activity: "llm",
      status: "completed",
      title: isRevision ? `Worker revision: ${subtask.title}` : `Worker: ${subtask.title}`,
      detail: output,
      startedAt: startedAt.toISOString(),
      completedAt,
      durationMs: elapsedMs(startedAt),
      payload: {
        subtask,
        output,
        modelTier,
        dependencySpanIds,
        artifacts: collectedEvidence.artifacts,
        callFrame: completeCallFrame(callFrame, {
          status: "completed",
          completedAt,
          outputSummary: limitText(output, 800),
        }),
        selfCheck,
      },
    });

    return workerResult;
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
    improveTool?: AgentImproveToolFn,
    toolExecutionContext?: BaseToolExecutionContext,
  ): Promise<CollectedToolEvidence> {
    const evidence: string[] = [];
    const artifacts: AgentArtifact[] = [];
    const webSearch = this.tools.get("web.search");
    const toolNeedText = `${originalTask}\n${subtask.title}\n${subtask.role}\n${subtask.prompt}\n${subtask.expectedOutput}\n${subtask.reviewCriteria.join("\n")}`;

    if (webSearch && shouldCollectWebSearch(subtask, toolNeedText, dependencyContext)) {
      evidence.push(await this.runWebSearch(webSearch, subtask, toolNeedText, emit, parentSpanId, toolExecutionContext));
    }

    const browserDiscoveryEvidence = await this.collectBrowserDiscoveryEvidence(
      subtask,
      toolNeedText,
      [dependencyContext, ...evidence].filter((item): item is string => Boolean(item)),
      emit,
      parentSpanId,
      saveArtifact,
      toolExecutionContext,
    );
    evidence.push(...browserDiscoveryEvidence.evidence);
    artifacts.push(...browserDiscoveryEvidence.artifacts);

    const marketTool = this.tools.findByCapability("market-timeseries")[0];
    if (marketTool && shouldCollectMarketTimeseries(subtask, toolNeedText)) {
      const marketEvidence = await this.runMarketTimeseries(
        marketTool,
        toolNeedText,
        emit,
        parentSpanId,
        saveArtifact,
        toolExecutionContext,
      );
      evidence.push(...marketEvidence.evidence);
      artifacts.push(...marketEvidence.artifacts);
    }

    const apiEvidence = await this.collectApiToolEvidence(
      subtask,
      toolNeedText,
      emit,
      parentSpanId,
      toolExecutionContext,
    );
    evidence.push(...apiEvidence.evidence);
    artifacts.push(...apiEvidence.artifacts);

    const declaredToolEvidence = await this.collectDeclaredToolInputs(
      subtask,
      [dependencyContext, ...evidence].filter((item): item is string => Boolean(item)),
      emit,
      parentSpanId,
      saveArtifact,
      toolExecutionContext,
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
        improveTool,
        toolExecutionContext,
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
    contextText: string,
    emit: AgentEventEmitter,
    parentSpanId: string,
    toolExecutionContext?: BaseToolExecutionContext,
  ): Promise<string> {
    const spanId = createSpanId(`tool-${webSearch.name}`);
    const startedAt = new Date();
    const queries = buildSearchQueries(subtask, contextText);
    const query = queries.join(" | ");

    // Work Ledger claim: a sibling subtask in the same run/thread that asks for the
    // same merged query string can reuse our completed evidence instead of issuing
    // another search round-trip. Reuse never silently skips required work — if the
    // existing item has no evidence to anchor on, the agent still proceeds.
    const ledger = this.resolveLedgerFromContext(toolExecutionContext);
    const claim = await ledger?.claim(
      {
        kind: "search",
        workKey: searchQueryWorkKey({
          query,
          provider: webSearch.name,
        }),
        title: `Web search: ${query.slice(0, 96)}`,
        ownerSpanId: spanId,
        inputSummary: limitText(query, 600),
        metadata: { tool: webSearch.name, role: subtask.role },
      },
      parentSpanId,
    );
    if (claim?.decision.status === "reuse_completed" && claim.item.outputSummary) {
      ledger?.trackWhatWorked(`Reused web search evidence for "${query.slice(0, 80)}"`);
      return `External tool evidence from ${webSearch.name} (reused via Work Ledger ${claim.item.id}):\n${limitText(claim.item.outputSummary, promptBudget.toolEvidenceChars)}`;
    }

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
      payload: { tool: webSearch.name, query, workItemId: claim?.item.id },
    });

    const results = await Promise.all(
      queries.map((candidate) =>
        this.executeTool(webSearch, { query: candidate, limit: 5 }, toolExecutionContext, {
          spanId,
          parentSpanId,
          capability: "web-search",
          caller: `worker:${subtask.role}`,
        }),
      ),
    );
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

    if (claim) {
      if (result.ok) {
        await ledger?.markCompleted(claim.item.id, {
          outputSummary: limitText(result.content, 4_000),
        });
        ledger?.trackWhatWorked(`Web search returned evidence for "${query.slice(0, 80)}"`);
        await ledger?.recordEvidence(
          {
            kind: "search_result",
            title: `Web search: ${query.slice(0, 96)}`,
            summary: limitText(result.content, 600),
            contentPreview: limitText(result.content, 2_000),
            provider: webSearch.name,
            toolName: webSearch.name,
            workItemId: claim.item.id,
            qaStatus: "unchecked",
            metadata: { query, role: subtask.role },
          },
          parentSpanId,
        );
      } else {
        await ledger?.markFailed(claim.item.id, limitText(result.content, 600));
        ledger?.trackWhatFailed(`Web search failed for "${query.slice(0, 80)}"`);
        ledger?.trackWeakTool(webSearch.name);
        await ledger?.recordEvidence(
          {
            kind: "limitation",
            title: `Web search failed: ${query.slice(0, 96)}`,
            summary: limitText(result.content, 600),
            provider: webSearch.name,
            toolName: webSearch.name,
            workItemId: claim.item.id,
            qaStatus: "failed",
            limitations: ["External web search returned a non-OK tool result."],
            metadata: { query, role: subtask.role },
          },
          parentSpanId,
        );
      }
    }

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
    toolExecutionContext?: BaseToolExecutionContext,
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

      const result = await this.executeTool(marketTool, request, toolExecutionContext, {
        spanId,
        parentSpanId,
        capability: "market-timeseries",
        caller: "worker",
      });
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
        const artifact = await saveArtifact({
          ...result.data.artifact,
          quality: mergeArtifactQualityMetadata(
            result.data.artifact.quality,
            toolArtifactQualityMetadata({
              capability: "market-timeseries",
              toolName: marketTool.name,
              ok: result.data.points.length > 0,
              reason: `${result.data.points.length} normalized point(s) returned for ${result.data.symbol}/${result.data.vsCurrency}.`,
            }),
          ),
        });
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

  private async collectApiToolEvidence(
    subtask: Subtask,
    text: string,
    emit: AgentEventEmitter,
    parentSpanId: string,
    toolExecutionContext?: BaseToolExecutionContext,
  ): Promise<CollectedToolEvidence> {
    const evidence: string[] = [];
    const artifacts: AgentArtifact[] = [];
    const declaredToolNames = new Set(Object.keys(subtask.toolInputs ?? {}));
    const apiTools = this.tools
      .findByCapability("api-http-json")
      .filter((tool) => !declaredToolNames.has(tool.name));

    for (const tool of apiTools) {
      const input = inferApiToolInput(tool, text);
      if (!input) continue;

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
        detail: summarizeToolInput(input),
        startedAt: startedAt.toISOString(),
        payload: { tool: tool.name, input: sanitizeToolPayload(input) },
      });

      const result = await this.executeTool(tool, input, toolExecutionContext, {
        spanId,
        parentSpanId,
        capability: tool.capabilities[0] ?? "api-http-json",
        caller: `worker:${subtask.role}`,
      });
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

      evidence.push(formatDeclaredToolEvidence(tool.name, result, []));
    }

    return {
      text: evidence.length > 0 ? evidence.join("\n\n") : "No API tool evidence was collected.",
      evidence,
      artifacts,
    };
  }

  private async collectBrowserDiscoveryEvidence(
    subtask: Subtask,
    text: string,
    priorEvidence: string[],
    emit: AgentEventEmitter,
    parentSpanId: string,
    saveArtifact?: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>,
    toolExecutionContext?: BaseToolExecutionContext,
  ): Promise<CollectedToolEvidence> {
    const alreadyDeclared = Object.keys(subtask.toolInputs ?? {}).some((toolName) => {
      const normalized = toolName.toLowerCase();
      return normalized === "browser.operate" || normalized === "browser-operate";
    });
    if (alreadyDeclared || !shouldCollectBrowserDiscovery(subtask, text)) {
      return { text: "No browser discovery evidence was needed.", evidence: [], artifacts: [] };
    }

    if (!(this.tools.get("browser.operate") ?? this.tools.findByCapability("browser-operate")[0])) {
      return { text: "No browser discovery tool is registered.", evidence: [], artifacts: [] };
    }

    const urls = selectBestUrlsForArtifact(priorEvidence.join("\n\n"), requiresMultipleSources(subtask) ? 3 : 2);
    if (urls.length === 0) return { text: "No browser discovery URLs were available.", evidence: [], artifacts: [] };

    const syntheticSubtask: Subtask = {
      ...subtask,
      toolInputs: {
        "browser.operate": {
          defaultTimeoutMs: 12000,
          commands: urls.flatMap((url, index) => {
            const label = `discovery-${index + 1}-${safeLabel(normalizedHost(url))}`;
            return [
              { type: "navigate", url },
              { type: "dismissDialogs" },
              { type: "extractText", label, maxLength: 9000 },
              { type: "extractLinks", label: `${label}-links`, limit: 50 },
              { type: "screenshot", label, fullPage: true },
            ];
          }),
        },
      },
    };

    return this.collectDeclaredToolInputs(
      syntheticSubtask,
      priorEvidence,
      emit,
      parentSpanId,
      saveArtifact,
      toolExecutionContext,
    );
  }

  private async collectDeclaredToolInputs(
    subtask: Subtask,
    priorEvidence: string[],
    emit: AgentEventEmitter,
    parentSpanId: string,
    saveArtifact?: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>,
    toolExecutionContext?: BaseToolExecutionContext,
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
      if (tool.name === "browser.operate" && hasInvalidBrowserNavigation(runnableInput)) {
        evidence.push(
          `Declared browser.operate input was skipped because it contains a placeholder or invalid navigation URL. Use real http(s) source URLs from previous evidence before running browser automation.`,
        );
        continue;
      }

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

      const result = await this.executeTool(
        tool,
        isRecord(runnableInput) ? runnableInput : {},
        toolExecutionContext,
        {
          spanId,
          parentSpanId,
          capability: toolName,
          caller: `worker:${subtask.role}`,
        },
      );
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
            const artifactRejectedSpanId = createSpanId("artifact-rejected");
            await emit({
              spanId: artifactRejectedSpanId,
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
            if (artifactQa.decision === "blocked_or_loader") {
              await this.recordExternalArtifactBlocker(
                {
                  tool,
                  capability: "browser-screenshot",
                  artifactQa,
                  artifact: artifactInput,
                  task: `${subtask.title}\n${subtask.prompt}\n${subtask.expectedOutput}`,
                },
                emit,
                artifactRejectedSpanId,
              );
            }
            continue;
          }
          const artifact = await saveArtifact({
            ...artifactInput,
            quality: mergeArtifactQualityMetadata(
              artifactInput.quality,
              semanticArtifactQualityMetadata(artifactQa),
            ),
          });
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
    improveTool?: AgentImproveToolFn,
    toolExecutionContext?: BaseToolExecutionContext,
  ): Promise<AgentArtifact | undefined> {
    if (!saveArtifact) return undefined;

    if (requirement.kind === "screenshot" || requirement.capability === "browser-screenshot") {
      return this.createScreenshotArtifact(
        [dependencyContext, evidence.join("\n\n"), subtask.prompt, originalTask].filter(Boolean).join("\n\n"),
        emit,
        parentSpanId,
        saveArtifact,
        requestToolBuild,
        improveTool,
        toolExecutionContext,
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
        improveTool,
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
        toolExecutionContext,
        requestToolBuild,
        improveTool,
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
      improveTool,
    );
    const generatedTool = this.tools.findByCapability(requirement.capability)[0];
    if (!generatedTool) return undefined;

    return this.runArtifactTool(
      generatedTool,
      {
        title: subtask.title,
        task: originalTask,
        context: [dependencyContext, subtask.prompt, evidence.join("\n\n")].filter(Boolean).join("\n\n"),
        filename: `${safeArtifactSlug(subtask.title)}.${requirement.kind === "document" ? "pdf" : "artifact"}`,
      },
      requirement.capability,
      requirement.description,
      emit,
      parentSpanId,
      saveArtifact,
      isGenericArtifactToolData,
      genericArtifactDataToCreateInput,
      `artifact:${requirement.kind}`,
      `${capitalize(requirement.kind)} artifact generated`,
      toolExecutionContext,
      requestToolBuild,
      improveTool,
    );
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
    improveTool?: AgentImproveToolFn,
    toolExecutionContext?: BaseToolExecutionContext,
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
      improveTool,
      toolExecutionContext,
    );
    const review = await this.review(
      complexity,
      workerResult,
      emit,
      workerResult.traceSpanId ?? parentSpanId,
      toolExecutionContext?.runId,
    );

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
      improveTool,
      toolExecutionContext,
    );
    const revisedReview = await this.review(
      complexity,
      revisedWorkerResult,
      emit,
      revisedWorkerResult.traceSpanId ?? workerResult.traceSpanId ?? parentSpanId,
      toolExecutionContext?.runId,
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
    improveTool?: AgentImproveToolFn,
    toolExecutionContext?: BaseToolExecutionContext,
  ): Promise<AgentArtifact | undefined> {
    if (!saveArtifact) return undefined;

    if (asksForScreenshot(task)) {
      if (workerResults.some((result) => result.artifacts?.some((artifact) => artifact.mimeType === "image/png"))) {
        return undefined;
      }
      return this.createScreenshotArtifact(task, emit, parentSpanId, saveArtifact, requestToolBuild, improveTool, toolExecutionContext);
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
        improveTool,
      );
      const generatedChartTool = this.tools.findByCapability("chart-generation")[0];
      if (!generatedChartTool) return undefined;
      return this.createRequestedArtifact(
        task,
        workerResults,
        emit,
        parentSpanId,
        saveArtifact,
        requestToolBuild,
        improveTool,
        toolExecutionContext,
      );
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
      toolExecutionContext,
      requestToolBuild,
      improveTool,
    );
  }

  private async createScreenshotArtifact(
    context: string,
    emit: AgentEventEmitter,
    parentSpanId: string,
    saveArtifact: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>,
    requestToolBuild?: (request: ToolBuildRequestInput) => Promise<ToolBuildRequest>,
    improveTool?: AgentImproveToolFn,
    toolExecutionContext?: BaseToolExecutionContext,
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
        improveTool,
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
      improveTool,
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
        toolExecutionContext,
        requestToolBuild,
        improveTool,
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
      toolExecutionContext,
      requestToolBuild,
      improveTool,
    );
  }

  private async ensureToolCapability(
    capability: string,
    buildRequest: ToolBuildRequestInput,
    emit: AgentEventEmitter,
    parentSpanId: string,
    requestToolBuild?: (request: ToolBuildRequestInput) => Promise<ToolBuildRequest>,
    improveTool?: AgentImproveToolFn,
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
        improveTool,
      );
      tool = this.tools.findByCapability(capability)[0];
    }

    return tool;
  }

  private async executeTool(
    tool: Tool,
    input: ToolInput,
    baseContext: BaseToolExecutionContext | undefined,
    spanContext: {
      spanId: string;
      parentSpanId?: string;
      capability?: string;
      caller?: string;
    },
  ): Promise<ToolResult> {
    return this.tools.execute(tool, input, {
      ...(baseContext ?? {}),
      ...spanContext,
      now: new Date(),
    });
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
    toolExecutionContext?: BaseToolExecutionContext,
    requestToolBuild?: (request: ToolBuildRequestInput) => Promise<ToolBuildRequest>,
    improveTool?: AgentImproveToolFn,
    reworkRetryKeys = new Set<string>(),
  ): Promise<AgentArtifact | undefined> {
    const spanId = createSpanId(`tool-${tool.name}`);
    const startedAt = new Date();
    // Work Ledger claim covers the reusable artifact-tool contract: same tool name +
    // same input payload + same capability ⇒ same workKey. Reuse here is conservative:
    // we never substitute a cached artifact for a real one because the agent still
    // needs the AgentArtifact record returned by saveArtifact. Instead we annotate the
    // span/payload with the existing work item id and proceed; the dedupe value comes
    // from the retrospective draft tagging duplicated work signals.
    const ledger = this.resolveLedgerFromContext(toolExecutionContext);
    const ledgerKind = capability === "browser-screenshot" ? "screenshot" : "artifact_generation";
    const claim = await ledger?.claim(
      {
        kind: ledgerKind,
        workKey: toolCallWorkKey(tool.name, { capability, ...input }),
        title: `${artifactTitle} via ${tool.name}`,
        ownerSpanId: spanId,
        inputSummary: limitText(detail, 600),
        metadata: { capability, tool: tool.name },
      },
      parentSpanId,
    );

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
      payload: { tool: tool.name, capability, workItemId: claim?.item.id },
    });

    const toolResult = await this.executeTool(tool, input, toolExecutionContext, {
      spanId,
      parentSpanId,
      capability,
      caller: "artifact",
    });
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
      if (claim) {
        await ledger?.markFailed(claim.item.id, limitText(toolResult.content, 600));
        ledger?.trackWhatFailed(`${artifactTitle} failed via ${tool.name}`);
        ledger?.trackWeakTool(tool.name);
        await ledger?.recordEvidence(
          {
            kind: "limitation",
            title: `${artifactTitle} failed: ${tool.name}`,
            summary: limitText(toolResult.content, 600),
            toolName: tool.name,
            workItemId: claim.item.id,
            qaStatus: "failed",
            limitations: [`${tool.name} returned an unusable ${artifactTitle.toLowerCase()} payload.`],
            metadata: { capability, role: "artifact" },
          },
          parentSpanId,
        );
      }
      const buildRequest = await this.handleInsufficientToolCapability(
        {
          tool,
          capability,
          reason: `Tool ${tool.name} could not produce a valid ${artifactTitle}: ${toolResult.content}`,
          detail,
          input,
          output: toolResult,
          sourceSpanId: spanId,
        },
        emit,
        parentSpanId,
        requestToolBuild,
        improveTool,
      );
      const replacementTool = this.findReworkedTool(tool, capability, reworkRetryKeys);
      if (buildRequest && replacementTool) {
        reworkRetryKeys.add(toolIdentity(tool));
        return this.retryArtifactToolAfterRework(
          replacementTool,
          input,
          capability,
          detail,
          emit,
          parentSpanId,
          saveArtifact,
          isData,
          toArtifact,
          artifactActor,
          artifactTitle,
          toolExecutionContext,
          requestToolBuild,
          improveTool,
          reworkRetryKeys,
        );
      }
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
    let artifactInput = toArtifact(toolResult.data);
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
        if (artifactQa.decision === "blocked_or_loader") {
          if (claim) {
            await ledger?.markFailed(claim.item.id, limitText(artifactQa.reason, 400));
            ledger?.trackWhatFailed(`${artifactTitle} blocked by external page (${tool.name})`);
            await ledger?.recordEvidence(
              {
                kind: "limitation",
                title: `${artifactTitle} blocked by external page`,
                summary: limitText(artifactQa.reason, 400),
                toolName: tool.name,
                workItemId: claim.item.id,
                qaStatus: "blocked",
                limitations: [
                  "External page presented a CAPTCHA / loader / login wall and could not be screenshot.",
                ],
                metadata: { capability, decision: artifactQa.decision },
              },
              parentSpanId,
            );
          }
          await this.recordExternalArtifactBlocker(
            {
              tool,
              capability,
              artifactQa,
              artifact: artifactInput,
              task: detail,
            },
            emit,
            artifactSpanId,
          );
          return undefined;
        }
        if (claim) {
          await ledger?.markFailed(claim.item.id, limitText(artifactQa.reason, 400));
          ledger?.trackWhatFailed(`${artifactTitle} rejected by semantic QA (${tool.name})`);
          ledger?.trackWeakTool(tool.name);
          await ledger?.recordEvidence(
            {
              kind: "limitation",
              title: `${artifactTitle} rejected by semantic QA`,
              summary: limitText(artifactQa.reason, 400),
              toolName: tool.name,
              workItemId: claim.item.id,
              qaStatus: "failed",
              limitations: [`Artifact failed semantic QA: ${artifactQa.reason}`],
              metadata: { capability, decision: artifactQa.decision },
            },
            parentSpanId,
          );
        }
        const buildRequest = await this.handleInsufficientToolCapability(
          {
            tool,
            capability,
            reason: `Tool ${tool.name} returned an artifact that failed semantic QA: ${artifactQa.reason}`,
            detail,
            input,
            output: toolResult,
            sourceSpanId: spanId,
          },
          emit,
          artifactSpanId,
          requestToolBuild,
          improveTool,
        );
        const replacementTool = this.findReworkedTool(tool, capability, reworkRetryKeys);
        if (buildRequest && replacementTool) {
          reworkRetryKeys.add(toolIdentity(tool));
          return this.retryArtifactToolAfterRework(
            replacementTool,
            input,
            capability,
            detail,
            emit,
            parentSpanId,
            saveArtifact,
            isData,
            toArtifact,
            artifactActor,
            artifactTitle,
            toolExecutionContext,
            requestToolBuild,
            improveTool,
            reworkRetryKeys,
          );
        }
        return undefined;
      }
      artifactInput = {
        ...artifactInput,
        quality: mergeArtifactQualityMetadata(artifactInput.quality, semanticArtifactQualityMetadata(artifactQa)),
      };
    } else {
      artifactInput = {
        ...artifactInput,
        quality: mergeArtifactQualityMetadata(
          artifactInput.quality,
          toolArtifactQualityMetadata({
            capability,
            toolName: tool.name,
            ok: true,
            reason: "Tool returned a valid artifact payload.",
          }),
        ),
      };
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
    if (claim) {
      await ledger?.markCompleted(claim.item.id, {
        outputSummary: `${artifactTitle} produced by ${tool.name}: ${artifact.filename}`,
      });
      ledger?.trackWhatWorked(`${artifactTitle} produced via ${tool.name}`);
      const evidenceKind = capability === "browser-screenshot" ? "screenshot" : "artifact";
      await ledger?.recordEvidence(
        {
          kind: evidenceKind,
          title: `${artifactTitle}: ${artifact.filename}`,
          summary: limitText(artifact.url, 400),
          toolName: tool.name,
          workItemId: claim.item.id,
          artifactId: artifact.id,
          qaStatus: "passed",
          metadata: { capability, mimeType: artifact.mimeType, filename: artifact.filename },
        },
        parentSpanId,
      );
    }

    return artifact;
  }

  private async recordExternalArtifactBlocker(
    input: {
      tool: Tool;
      capability: string;
      artifactQa: ReturnType<typeof inspectBrowserScreenshotEvidence>;
      artifact: ArtifactCreateInput;
      task?: string;
    },
    emit: AgentEventEmitter,
    parentSpanId: string,
  ): Promise<void> {
    const startedAt = new Date();
    const blockerMemory = await this.storeExternalArtifactBlockerMemory(input);
    await emit({
      spanId: createSpanId(`artifact-blocker-${input.capability}`),
      parentSpanId,
      type: "learning-completed",
      actor: "artifact:qa",
      activity: "tool",
      status: "completed",
      title: "External artifact blocker detected",
      detail: [
        input.artifact.filename,
        input.artifactQa.reason,
        input.artifactQa.blockerSignals.length
          ? `Blocker signals: ${input.artifactQa.blockerSignals.join(", ")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(startedAt),
      payload: {
        tool: input.tool.name,
        version: input.tool.version,
        capability: input.capability,
        artifact: sanitizeArtifactInput(input.artifact),
        artifactQa: input.artifactQa,
        limitationType: "external-blocker",
        blockerMemory,
      },
    });
  }

  private async storeExternalArtifactBlockerMemory(input: {
    tool: Tool;
    capability: string;
    artifactQa: ReturnType<typeof inspectBrowserScreenshotEvidence>;
    artifact: ArtifactCreateInput;
    task?: string;
  }): Promise<SkillMemoryEntry | undefined> {
    const sourceText = [
      input.task,
      input.artifact.filename,
      input.artifact.description,
      input.artifactQa.reason,
      input.artifactQa.blockerSignals.join(" "),
    ]
      .filter(Boolean)
      .join("\n");
    const host = extractHttpUrls(sourceText).map(normalizedHost).find(Boolean);
    const limitationTarget = host ?? input.tool.name;
    const title = `External proof blocker: ${limitationTarget}`;
    const evidence = uniqueStrings([
      `Tool: ${input.tool.name}${input.tool.version ? `@${input.tool.version}` : ""}`,
      `Capability: ${input.capability}`,
      `Artifact: ${input.artifact.filename}`,
      `QA decision: ${input.artifactQa.decision}`,
      `QA reason: ${input.artifactQa.reason}`,
      input.artifactQa.blockerSignals.length
        ? `Blocker signals: ${input.artifactQa.blockerSignals.join(", ")}`
        : "",
      host ? `Host: ${host}` : "",
    ]).filter(Boolean);

    const existing = (await this.skillMemory.list({ includeArchived: true, limit: 500 })).find(
      (entry) => normalizeMemoryStatus(entry.status) !== "archived" && entry.title === title,
    );

    if (existing) {
      if (!this.skillMemory.update) return existing;
      return this.skillMemory.update(existing.id, {
        summary: `Browser proof for ${limitationTarget} recently failed semantic artifact QA because the provider returned a blocker or loader page instead of task evidence.`,
        reusableProcedure: externalBlockerProcedure(limitationTarget),
        tags: uniqueStrings([...(existing.tags ?? []), "external-blocker", "artifact-qa", input.capability, host ?? "unknown-host"]),
        confidence: Math.max(normalizeMemoryConfidence(existing.confidence), 0.9),
        evidence: uniqueStrings([...(existing.evidence ?? []), ...evidence]).slice(-20),
      });
    }

    return this.skillMemory.add({
      title,
      tags: uniqueStrings(["external-blocker", "artifact-qa", input.capability, host ?? "unknown-host"]),
      summary: `Browser proof for ${limitationTarget} failed semantic artifact QA because the provider returned a blocker or loader page instead of task evidence.`,
      reusableProcedure: externalBlockerProcedure(limitationTarget),
      scope: "global",
      status: "accepted",
      confidence: 0.9,
      sensitivity: "normal",
      evidence,
    });
  }

  private findReworkedTool(tool: Tool, capability: string, reworkRetryKeys: Set<string>): Tool | undefined {
    const failedToolKey = toolIdentity(tool);
    const sameNameTool = this.tools.get(tool.name);
    if (sameNameTool && toolIdentity(sameNameTool) !== failedToolKey && !reworkRetryKeys.has(toolIdentity(sameNameTool))) {
      return sameNameTool;
    }

    return this.tools
      .findByCapability(capability)
      .find(
        (candidate) =>
          candidate.name.startsWith("generated.") &&
          toolIdentity(candidate) !== failedToolKey &&
          !reworkRetryKeys.has(toolIdentity(candidate)),
      );
  }

  private async retryArtifactToolAfterRework<TData>(
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
    toolExecutionContext: BaseToolExecutionContext | undefined,
    requestToolBuild: ((request: ToolBuildRequestInput) => Promise<ToolBuildRequest>) | undefined,
    improveTool: AgentImproveToolFn | undefined,
    reworkRetryKeys: Set<string>,
  ): Promise<AgentArtifact | undefined> {
    const retryStartedAt = new Date();
    await emit({
      spanId: createSpanId(`tool-retry-${capability}`),
      parentSpanId,
      type: "tool-build-requested",
      actor: "tool-builder",
      activity: "tool",
      status: "completed",
      title: `Retrying with reworked tool: ${tool.name}`,
      detail: `${tool.name}${tool.version ? `@${tool.version}` : ""}`,
      startedAt: retryStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(retryStartedAt),
      payload: { tool: tool.name, version: tool.version, capability },
    });

    return this.runArtifactTool(
      tool,
      input,
      capability,
      detail,
      emit,
      parentSpanId,
      saveArtifact,
      isData,
      toArtifact,
      artifactActor,
      artifactTitle,
      toolExecutionContext,
      requestToolBuild,
      improveTool,
      reworkRetryKeys,
    );
  }

  private async handleMissingToolCapability(
    request: ToolBuildRequestInput,
    emit: AgentEventEmitter,
    parentSpanId: string,
    requestToolBuild?: (request: ToolBuildRequestInput) => Promise<ToolBuildRequest>,
    improveTool?: AgentImproveToolFn,
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

    if (improveTool) {
      const result = await this.dispatchAgentToolImprovement(
        {
          source: "agent_runtime",
          spanId: request.sourceSpanId,
          title: `Missing tool capability: ${request.capability}`,
          contextBundle: {
            taskPrompt: request.taskSummary,
            outputSummary: request.reason,
            error: `Tool capability ${request.capability} was missing in the registry.`,
          },
          buildRequestInput: request,
        },
        `tool-build-${request.capability}`,
        `Tool build requested: ${request.capability}`,
        emit,
        parentSpanId,
        improveTool,
      );
      if (result?.buildRequest) return result.buildRequest;
    }

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

  private async handleInsufficientToolCapability(
    issue: {
      tool: Tool;
      capability: string;
      reason: string;
      detail: string;
      input: ToolInput;
      output: ToolResult;
      sourceSpanId: string;
    },
    emit: AgentEventEmitter,
    parentSpanId: string,
    requestToolBuild?: (request: ToolBuildRequestInput) => Promise<ToolBuildRequest>,
    improveTool?: AgentImproveToolFn,
  ): Promise<ToolBuildRequest | undefined> {
    if (!requestToolBuild && !improveTool) return undefined;

    const startedAt = new Date();
    const isGenerated = issue.tool.name.startsWith("generated.");
    const request: ToolBuildRequestInput = {
      capability: issue.capability,
      displayName: `${issue.tool.displayName ?? issue.tool.name} improvement`,
      reason: [
        issue.reason,
        `Current tool: ${issue.tool.name}${issue.tool.version ? `@${issue.tool.version}` : ""}.`,
        `Task/tool context: ${issue.detail}`,
        `Input summary: ${summarizeToolInput(issue.input)}`,
        `Output summary: ${issue.output.content}`,
      ].join("\n\n"),
      sourceSpanId: issue.sourceSpanId,
      taskSummary: issue.detail.slice(0, 1200),
      desiredToolName: isGenerated ? issue.tool.name : undefined,
      replacesToolName: isGenerated ? issue.tool.name : undefined,
      replacesVersion: isGenerated && issue.tool.version ? issue.tool.version : undefined,
      feedback: issue.reason,
      requiredInputs: Object.keys(issue.input).slice(0, 8),
      requiredOutputs: ["content", "data", "artifact"],
      qaCriteria: [
        "Reproduce the observed insufficient-tool behavior from the source span context.",
        "Keep the tool reusable and capability-oriented; do not hard-code the original task.",
        "Add tests for the previous failure plus a successful corrected behavior.",
        "Register a new version only after QA and runtime activation pass.",
      ],
    };

    if (improveTool) {
      const result = await this.dispatchAgentToolImprovement(
        {
          source: "agent_runtime",
          spanId: issue.sourceSpanId,
          toolName: issue.tool.name,
          toolVersion: issue.tool.version,
          title: `Insufficient tool: ${issue.tool.name}`,
          contextBundle: {
            taskPrompt: issue.detail.slice(0, 1200),
            inputSummary: summarizeToolInput(issue.input),
            outputSummary: issue.output.content,
            error: issue.reason,
          },
          buildRequestInput: request,
        },
        `tool-rework-${issue.capability}`,
        `Tool rework requested: ${issue.tool.name}`,
        emit,
        parentSpanId,
        improveTool,
        { sourceTool: issue.tool.name, sourceToolVersion: issue.tool.version },
      );
      if (result?.buildRequest) return result.buildRequest;
    }

    if (!requestToolBuild) return undefined;
    const buildRequest = await requestToolBuild(request);
    await emit({
      spanId: createSpanId(`tool-rework-${issue.capability}`),
      parentSpanId,
      type: "tool-build-requested",
      actor: "tool-builder",
      activity: "tool",
      status: "completed",
      title: `Tool rework requested: ${issue.tool.name}`,
      detail: `${buildRequest.contract.toolName}\n${buildRequest.contract.modulePath}\n${buildRequest.contract.testPath}`,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(startedAt),
      payload: { request: buildRequest, sourceTool: issue.tool.name, sourceToolVersion: issue.tool.version },
    });

    return buildRequest;
  }

  private async dispatchAgentToolImprovement(
    request: ToolImprovementRequest,
    buildSpanPrefix: string,
    buildTitle: string,
    emit: AgentEventEmitter,
    parentSpanId: string,
    improveTool: AgentImproveToolFn,
    extraPayload: Record<string, unknown> = {},
  ): Promise<ToolImprovementResult | undefined> {
    const startedAt = new Date();
    const result = await improveTool(request);
    if (result.status === "failed_to_request") {
      await emit({
        spanId: createSpanId(`${buildSpanPrefix}-failed`),
        parentSpanId,
        type: "tool-build-requested",
        actor: "tool-builder",
        activity: "tool",
        status: "failed",
        title: `Tool improvement request failed: ${request.title ?? "unknown"}`,
        detail: result.error ?? "Coordinator could not create the tool rework request.",
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: elapsedMs(startedAt),
        payload: { errorCode: result.errorCode, error: result.error, ...extraPayload },
      });
      return result;
    }

    if (result.buildRequest) {
      await emit({
        spanId: createSpanId(buildSpanPrefix),
        parentSpanId,
        type: "tool-build-requested",
        actor: "tool-builder",
        activity: "tool",
        status: "completed",
        title: buildTitle,
        detail: `${result.buildRequest.contract.toolName}\n${result.buildRequest.contract.modulePath}\n${result.buildRequest.contract.testPath}`,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: elapsedMs(startedAt),
        payload: {
          request: result.buildRequest,
          investigationId: result.investigation?.id,
          waitId: result.wait?.id,
          agentDriven: true,
          ...extraPayload,
        },
      });
    }

    if (result.wait) {
      const waitOpenedAt = new Date();
      await emit({
        spanId: createSpanId(`tool-rework-wait-${result.wait.id}`),
        parentSpanId,
        type: "tool-rework-wait-opened",
        actor: "coordinator",
        activity: "tool",
        status: "completed",
        title: `Tool rework wait opened: ${result.wait.id}`,
        detail:
          `Run ${result.wait.runId} is waiting for tool improvement triggered by investigation ` +
          `${result.investigation?.id ?? "(unknown)"}; build ${result.buildRequest?.id ?? "(unknown)"}.`,
        startedAt: waitOpenedAt.toISOString(),
        completedAt: waitOpenedAt.toISOString(),
        durationMs: 0,
        payload: {
          wait: result.wait,
          investigationId: result.investigation?.id,
          buildRequestId: result.buildRequest?.id,
          agentDriven: true,
          ...extraPayload,
        },
      });
    }

    return result;
  }

  private async review(
    complexity: TaskComplexity,
    workerResult: WorkerResult,
    emit: AgentEventEmitter,
    parentSpanId: string,
    runId?: string,
  ): Promise<ReviewResult> {
    const spanId = createSpanId(`review-${workerResult.subtask.id}`);
    const startedAt = new Date();
    const modelTier = selectModelTier("review", complexity, workerResult.subtask);
    const callFrame = createReviewerCallFrame({
      runId,
      spanId,
      parentSpanId,
      workerResult,
      modelTier,
      startedAt: startedAt.toISOString(),
    });
    await emit({
      spanId,
      parentSpanId,
      type: "review-started",
      actor: "reviewer",
      activity: "review",
      status: "started",
      title: `Review: ${workerResult.subtask.title}`,
      startedAt: startedAt.toISOString(),
      payload: { workerResult, modelTier, callFrame },
    });

    const deterministicReview = hardGateReview(workerResult);
    if (deterministicReview) {
      const selfCheckStartedAt = new Date();
      const selfCheck = buildReviewSelfCheck(deterministicReview, workerResult, spanId, selfCheckStartedAt);
      await emit({
        spanId: createSpanId(`self-check-review-${workerResult.subtask.id}`),
        parentSpanId: spanId,
        type: "agent-self-check-completed",
        actor: "reviewer",
        activity: "agent",
        status: selfCheck.readyToReturn ? "completed" : "failed",
        title: `Self-check: Review ${workerResult.subtask.title}`,
        detail: selfCheck.readyToReturn ? "Ready to return." : selfCheck.warnings.join("; "),
        startedAt: selfCheckStartedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: elapsedMs(selfCheckStartedAt),
        payload: { callFrame, selfCheck },
      });
      const completedAt = new Date().toISOString();
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
        completedAt,
        durationMs: elapsedMs(startedAt),
        payload: {
          ...deterministicReview,
          modelTier,
          deterministic: true,
          callFrame: completeCallFrame(callFrame, {
            status: "completed",
            completedAt,
            outputSummary: `${deterministicReview.verdict}: ${deterministicReview.notes}`,
          }),
          selfCheck,
        },
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
        payload: {
          workerResult: compactWorkerResultForPrompt(workerResult, 2000),
          modelTier,
          error: formatErrorMessage(error),
          callFrame: completeCallFrame(callFrame, {
            status: "failed",
            completedAt: new Date().toISOString(),
            outputSummary: formatErrorMessage(error),
          }),
        },
      });
      throw error;
    }
    const selfCheckStartedAt = new Date();
    const selfCheck = buildReviewSelfCheck(review, workerResult, spanId, selfCheckStartedAt);
    await emit({
      spanId: createSpanId(`self-check-review-${workerResult.subtask.id}`),
      parentSpanId: spanId,
      type: "agent-self-check-completed",
      actor: "reviewer",
      activity: "agent",
      status: selfCheck.readyToReturn ? "completed" : "failed",
      title: `Self-check: Review ${workerResult.subtask.title}`,
      detail: selfCheck.readyToReturn ? "Ready to return." : selfCheck.warnings.join("; "),
      startedAt: selfCheckStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(selfCheckStartedAt),
      payload: { callFrame, selfCheck },
    });
    const completedAt = new Date().toISOString();
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
      completedAt,
      durationMs: elapsedMs(startedAt),
      payload: {
        ...review,
        modelTier,
        callFrame: completeCallFrame(callFrame, {
          status: "completed",
          completedAt,
          outputSummary: `${review.verdict}: ${review.notes}`,
        }),
        selfCheck,
      },
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
    const evidence = normalizeLearningEvidence(learning.evidence, task, finalAnswer, workerResults);
    const scopeId = resolveMemoryScopeId(memoryScope, options);
    const preliminaryStatus = memoryScope === "global" && sensitivity === "normal" ? requestedStatus : "proposed";
    const proposalReview = reviewMemoryProposal({
      id: "memory-specialist-candidate",
      title: learning.title,
      tags: learning.tags ?? [],
      summary: learning.summary,
      reusableProcedure: learning.reusableProcedure,
      scope: memoryScope,
      scopeId,
      status: preliminaryStatus,
      confidence: normalizeMemoryConfidence(learning.confidence),
      sensitivity,
      sourceRunId: options.runId,
      sourceThreadId: options.threadId,
      evidence,
      createdAt: new Date().toISOString(),
    });
    const status = proposalReview.status === "ready" ? preliminaryStatus : "proposed";

    return this.skillMemory.add({
      title: learning.title,
      tags: learning.tags ?? [],
      summary: learning.summary,
      reusableProcedure: learning.reusableProcedure,
      scope: memoryScope,
      scopeId,
      status,
      confidence: normalizeMemoryConfidence(learning.confidence),
      sensitivity,
      sourceRunId: options.runId,
      sourceThreadId: options.threadId,
      evidence,
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
    relevantArtifacts?: AgentArtifact[];
  },
): string {
  if (!threadContext) return task;

  const lines = [
    "Conversation thread context:",
    `Summary: ${threadContext.summary || "No prior summary."}`,
    listContext("Accepted facts", threadContext.acceptedFacts),
    listContext("Rejected or failed attempts", threadContext.rejectedAttempts),
    listContext("Open questions", threadContext.openQuestions),
    formatThreadArtifacts(threadContext.relevantArtifacts),
    listContext("Relevant artifact IDs", threadContext.relevantArtifactIds),
  ].filter(Boolean);

  return `${task}

${lines.join("\n")}`;
}

function appendInstanceContext(
  task: string,
  instanceContext?: {
    groupProfile?: GroupProfileRecord;
    requesterUser?: UserRecord;
  },
): string {
  if (!instanceContext?.groupProfile && !instanceContext?.requesterUser) return task;

  const lines: string[] = ["Instance and requester context:"];
  const profile = instanceContext.groupProfile;
  if (profile) {
    lines.push(`Group profile: ${profile.name} (${profile.instanceId})`);
    if (profile.description.trim()) lines.push(`Group description: ${profile.description.trim()}`);
    const preferences = formatPreferenceContext(profile.preferences);
    if (preferences) {
      lines.push(`Group preferences and stable facts:\n${preferences}`);
    }
  }

  const user = instanceContext.requesterUser;
  if (user) {
    lines.push(`Requester: ${user.displayName} (${user.id})`);
    lines.push(`Requester roles: ${(user.roles?.length ? user.roles : [user.role]).join(", ")}`);
    const identities = (user.identities ?? [])
      .filter((identity) => identity.allowStatus === "allowed")
      .map((identity) => `${identity.provider}:${identity.providerUserId}`);
    if (identities.length > 0) lines.push(`Allowed requester channel identities: ${identities.join(", ")}`);
  }

  lines.push(
    "Use this context as default task context when the user omits stable details such as city, locale, language, or household/company preferences. Ask a clarification only when the profile is absent, conflicting, stale, or insufficient for the requested action.",
  );

  return `${task}

${lines.join("\n")}`;
}

function formatPreferenceContext(preferences: Record<string, unknown>): string | undefined {
  const entries = Object.entries(preferences).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (entries.length === 0) return undefined;
  return entries
    .slice(0, 24)
    .map(([key, value]) => `- ${key}: ${formatPreferenceValue(value)}`)
    .join("\n");
}

function formatPreferenceValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(formatPreferenceValue).join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function listContext(title: string, values: string[]): string | undefined {
  if (values.length === 0) return undefined;
  return `${title}:\n${values.map((value) => `- ${value}`).join("\n")}`;
}

function formatThreadArtifacts(artifacts: AgentArtifact[] | undefined): string | undefined {
  if (!artifacts || artifacts.length === 0) return undefined;

  return `Reusable thread artifacts:
${artifacts
  .map((artifact) => {
    const preview = artifact.contentPreview ? `\n  content preview:\n${indent(artifact.contentPreview)}` : "";
    const quality = artifact.quality?.status ? ` quality=${artifact.quality.status}` : "";
    return `- ${artifact.filename} (${artifact.mimeType}, ${artifact.kind}) ${artifact.url}${quality}${preview}`;
  })
  .join("\n")}
Use these artifacts as prior evidence when they satisfy the follow-up request. Do not reacquire the same data unless it is stale, missing, or insufficient.`;
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

function shouldCollectBrowserDiscovery(subtask: Subtask, text: string): boolean {
  const requestedTools = (subtask.requiredTools ?? []).map((tool) => tool.toLowerCase());
  if (requestedTools.some((tool) => ["browser-operate", "browser.operate", "dom-extraction"].includes(tool))) {
    return true;
  }
  const isDiscovery =
    /(find|search|identify|discover|collect|candidate|profile|directory|listing|catalog|doctor|clinic|specialist|ticket|flight|найди|поиск|подбери|кандидат|профил|каталог|справочник|листинг|врач|клиник|специалист|билет|рейс)/i.test(
      text,
    );
  const needsInteractiveSources =
    /(directory|profile|listing|catalog|portal|booking|provider|hospital|staff|doctolib|jameda|onedoc|google flights|skyscanner|kayak|каталог|профил|портал|бронир|клиник|госпитал|персонал|расписан)/i.test(
      text,
    );
  return isDiscovery && needsInteractiveSources;
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

function hasActionableApiToolRequest(text: string, tools: Tool[]): boolean {
  return tools.some((tool) => inferApiToolInput(tool, text));
}

function inferApiToolInput(tool: Tool, text: string): ToolInput | undefined {
  if (!tool.capabilities.includes("api-http-json")) return undefined;
  const descriptor = `${tool.name} ${tool.displayName ?? ""} ${tool.description} ${tool.capabilities.join(" ")}`;
  const isAmlTool = /(?:aml|anti[-\s]?money|risk|score|скор|риск|санкц|gl[-\s]?aml|global\s+ledger)/i.test(descriptor);
  const asksForAml = /(?:aml|anti[-\s]?money|risk|score|скор|риск|санкц|провер|чек|адрес|address|transaction|tx)/i.test(text);
  if (!isAmlTool || !asksForAml) return undefined;

  const transactionHash = text.match(/\b0x[a-fA-F0-9]{64}\b/)?.[0];
  const address = transactionHash ? undefined : text.match(/\b0x[a-fA-F0-9]{40}\b/)?.[0];
  if (!transactionHash && !address) return undefined;

  const network = inferApiNetwork(text);
  const input: ToolInput = {
    network,
    operation: transactionHash ? "transaction-risk-score" : "address-risk-score",
  };
  if (transactionHash) input.transactionHash = transactionHash;
  if (address) input.address = address;
  const secretHandle = tool.requiredSecretHandles?.[0];
  if (secretHandle) input.secretHandle = secretHandle;
  return input;
}

function inferApiNetwork(text: string): string {
  if (/\b(?:btc|bitcoin)\b|биткоин/i.test(text)) return "bitcoin";
  if (/\b(?:tron|trx)\b|трон/i.test(text)) return "tron";
  if (/\b(?:bnb|bsc|binance)\b/i.test(text)) return "bnb";
  if (/\b(?:avax|avalanche)\b/i.test(text)) return "avax";
  if (/\b(?:eth|ether|ethereum)\b|эфир/i.test(text)) return "ethereum";
  return "ethereum";
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
  const explicitDays =
    text.match(/(?:last|past|за|последн(?:ие|их|ий|юю)?)\s*(\d{1,4})\s*(?:day|days|дн(?:я|ей|и|ь)?)/i) ??
    text.match(/(\d{1,4})\s*(?:day|days|дн(?:я|ей|и|ь)?)/i);
  if (explicitDays?.[1]) return clampMarketDays(Number(explicitDays[1]));

  const explicitMonths =
    text.match(/(?:last|past|за|последн(?:ие|их|ий|юю)?)\s*(\d{1,3})\s*(?:month|months|мес(?:яц|яца|яцев)?)/i) ??
    text.match(/(\d{1,3})\s*(?:month|months|мес(?:яц|яца|яцев)?)/i);
  if (explicitMonths?.[1]) return clampMarketDays(Number(explicitMonths[1]) * 30);

  if (/пол\s*года|half\s*(?:a\s*)?year|6\s*months|six\s*months/i.test(text)) return 180;
  if (/год|year|12\s*months/i.test(text)) return 365;
  if (/лет[оа]|summer/i.test(text)) return 120;
  if (/месяц|month|30\s*days/i.test(text)) return 30;
  if (/недел|week|7\s*days/i.test(text)) return 7;
  return 30;
}

function clampMarketDays(days: number): number {
  if (!Number.isFinite(days)) return 30;
  return Math.max(1, Math.min(3650, Math.round(days)));
}

function buildSearchQueries(subtask: Subtask, contextText = ""): string[] {
  const promptLines = subtask.prompt
    .split(/\n+/)
    .map((line) => line.replace(/^[-*\d.\s:]+/, "").trim())
    .filter(Boolean);
  const leadLine = promptLines.find((line) => /search|find|найди|искать|research/i.test(line)) ?? promptLines[0] ?? "";
  const sourceHints = promptLines
    .filter((line) => /google flights|skyscanner|kayak|momondo|booking|source|источник|ссылка/i.test(line))
    .join(" ");
  const contextHints = buildContextSearchHints(`${contextText}\n${subtask.title}\n${subtask.prompt}`);
  const raw = `${subtask.title} ${leadLine} ${sourceHints} ${contextHints}`;

  const primary = cleanSearchQuery(raw);
  const queries = [primary];
  if (contextHints && /doctor|clinic|specialist|allerg|immunolog|врач|клиник|специалист|аллерг|иммунолог/i.test(raw)) {
    queries.push(
      cleanSearchQuery(
        `${subtask.title} ${leadLine} ${contextHints} doctor directory hospital staff Doctolib Jameda OneDoc`,
      ),
    );
  }
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

function buildContextSearchHints(text: string): string {
  const hints: string[] = [];
  const candidates: Array<[RegExp, string]> = [
    [/\bschengen\b|шенген/i, "Schengen Europe"],
    [/\beurope\b|европ/i, "Europe"],
    [/\bspain\b|испан/i, "Spain"],
    [/\bmadrid\b|мадрид/i, "Madrid"],
    [/\bgermany\b|герман|немец/i, "Germany"],
    [/\bfrance\b|франц/i, "France"],
    [/\bswitzerland\b|swiss|швейцар/i, "Switzerland"],
    [/\baustria\b|австри/i, "Austria"],
    [/\bitaly\b|итал/i, "Italy"],
    [/\bportugal\b|португал/i, "Portugal"],
    [/\bukrainian\b|украин/i, "Ukrainian"],
    [/\brussian\b|русск/i, "Russian"],
    [/\benglish\b|англий/i, "English"],
  ];
  for (const [pattern, hint] of candidates) {
    if (pattern.test(text)) hints.push(hint);
  }
  return [...new Set(hints)].join(" ");
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

  const dataText = formatToolDataEvidence(result.data);
  return limitText(`Declared tool evidence from ${toolName}:\n${result.content}${dataText}${artifactText}`, promptBudget.toolEvidenceChars);
}

function formatToolDataEvidence(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const record = data as Record<string, unknown>;
  const lines: string[] = [];
  if (record.provider !== undefined) lines.push(`provider: ${String(record.provider)}`);
  if (record.status !== undefined) lines.push(`httpStatus: ${String(record.status)}`);
  if (record.url !== undefined) lines.push(`url: ${String(record.url)}`);
  if (record.score !== undefined) lines.push(`score: ${String(record.score)}`);
  if (Array.isArray(record.sources) && record.sources.length > 0) {
    const sourceText = record.sources
      .slice(0, 12)
      .map((source) => {
        if (!source || typeof source !== "object") return undefined;
        const item = source as Record<string, unknown>;
        const name = typeof item.name === "string" ? item.name : undefined;
        if (!name) return undefined;
        const share = item.share === undefined ? "" : ` (${String(item.share)}%)`;
        return `${name}${share}`;
      })
      .filter(Boolean)
      .join(", ");
    if (sourceText) lines.push(`sources: ${sourceText}`);
  }
  if (lines.length === 0) return "";
  return `\nStructured tool data:\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

function improveDeclaredToolInput(
  toolName: string,
  input: unknown,
  subtask: Subtask,
  priorEvidence: string[],
): unknown {
  if (toolName !== "browser.operate" || !isRecord(input)) return input;
  const commands = Array.isArray(input.commands) ? input.commands : [];
  const hasPlaceholderNavigation = commands.some(isPlaceholderNavigateCommand);
  const hasBrittleInteraction = commands.some(isBrittleBrowserInteractionCommand);
  if (!hasPlaceholderNavigation && !hasBrittleInteraction) return input;

  const evidenceUrls = selectBestUrlsForArtifact(
    priorEvidence.join("\n\n"),
    requiresMultipleSources(subtask) ? 3 : 1,
  );
  if (evidenceUrls.length === 0) return input;
  const firstNavigationUrl = commands.find(isNavigateCommand)?.url;
  if (
    firstNavigationUrl &&
    !isPlaceholderNavigateCommand({ type: "navigate", url: firstNavigationUrl }) &&
    !isGenericBrowserSearchUrl(firstNavigationUrl)
  ) {
    return input;
  }

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

function hasInvalidBrowserNavigation(input: unknown): boolean {
  if (!isRecord(input)) return false;
  const commands = Array.isArray(input.commands) ? input.commands : [];
  return commands.some(isPlaceholderNavigateCommand);
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

function isPlaceholderNavigateCommand(command: unknown): boolean {
  if (!isNavigateCommand(command)) return false;
  const url = command.url.trim();
  if (
    /(?:URL_FROM_|PLACEHOLDER|REPLACE_WITH|PREVIOUS_STEP|SOURCE_URL|DIRECTORY_URL|PROFILE_URL|<url>|example\.com)/i.test(
      url,
    )
  ) {
    return true;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol !== "http:" && parsed.protocol !== "https:";
  } catch {
    return true;
  }
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
    if (/(doctolib|doctoralia|jameda|onedoc|topdoctors|sanego|miodottore)/.test(host)) return 90;
    if (/(find-?a-?doctor|doctor|doctors|clinician|specialist|provider|appointment|booking|aerzte|arzt|medecin|especialista|allergolog|immunolog)/.test(path)) {
      return 70;
    }
    if (/(hospital|clinic|medical|health|gesundheit|hopital|spital)/.test(host)) return 45;
    return 0;
  } catch {
    return 0;
  }
}

function isLowValueProofUrl(url: string): boolean {
  return /example\.com|placeholder|localhost|127\.0\.0\.1|facebook\.com|reddit\.com|quora\.com|github\.com|medlineplus\.gov|ahd\.com|\.pdf(?:$|[?#])|faa\.gov|easa\.europa\.eu|aclanthology\.org|stanford\.edu|baymard\.com|codalab\.org|nlp\.biu\.ac\.il/i.test(
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

  if (containsUnsatisfiedDiscoveryFailure(workerResult)) {
    return {
      subtaskId: workerResult.subtask.id,
      verdict: "needs_revision",
      notes:
        "The subtask expected discovery or candidate evidence, but the worker only reported that nothing useful was found. Retry with an alternative source/tool strategy, or return a precise external blocker with evidence.",
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

function containsUnsatisfiedDiscoveryFailure(workerResult: WorkerResult): boolean {
  const subtaskText = [
    workerResult.subtask.title,
    workerResult.subtask.prompt,
    workerResult.subtask.expectedOutput,
    ...(workerResult.subtask.reviewCriteria ?? []),
  ].join("\n");
  const expectsDiscovery =
    /(find|search|identify|discover|collect|candidate|source|lookup|recommend|rank|compare|list|doctor|clinic|specialist|profile|price|ticket|flight|найди|поиск|подбери|кандидат|источник|список|рекоменд|сравн|врач|клиник|специалист|билет|рейс|цена)/i.test(
      subtaskText,
    );
  if (!expectsDiscovery) return false;
  const output = workerResult.output;
  const emptyDiscovery =
    /(no candidates|no suitable candidates|no results|nothing useful|nothing found|could not find|unable to find|failed to find|insufficient data|empty result|search returned no|не наш[её]л|не удалось найти|нет кандидатов|нет результатов|ничего не найдено|не обнаружено|данных недостаточно)/i.test(
      output,
    );
  if (!emptyDiscovery) return false;
  const hasRecoveryEvidence =
    /(retried|alternative source|second source|direct url|browser\.operate|tool evidence|artifact URL|external blocker|access denied|login wall|blocked by|provider returned|повтор|альтернатив|другой источник|прямая ссылка|артефакт|внешн(?:ий|яя) блокер|доступ запрещ|заблокирован)/i.test(
      output,
    ) || (workerResult.toolEvidence?.length ?? 0) >= 2;
  return !hasRecoveryEvidence;
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

function buildToolExecutionContext(options: RunOptions): BaseToolExecutionContext {
  const context: BaseToolExecutionContext = {
    ...(options.toolExecutionContext ?? {}),
    instanceId: options.toolExecutionContext?.instanceId ?? options.instanceId,
    requesterUserId: options.toolExecutionContext?.requesterUserId ?? options.requesterUserId,
    threadId: options.toolExecutionContext?.threadId ?? options.threadId,
    runId: options.toolExecutionContext?.runId ?? options.runId,
  };

  if (!context.artifacts && options.saveArtifact) {
    context.artifacts = {
      saveGenerated: options.saveArtifact,
    };
  }

  return context;
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

type GenericArtifactToolData = {
  artifact: {
    filename: string;
    mimeType: string;
    contentBase64?: string;
    content?: string;
    description?: string;
  };
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

function isGenericArtifactToolData(data: unknown): data is GenericArtifactToolData {
  if (!data || typeof data !== "object") return false;
  const artifact = (data as { artifact?: unknown }).artifact;
  if (!artifact || typeof artifact !== "object") return false;

  const candidate = artifact as Partial<GenericArtifactToolData["artifact"]>;
  return (
    typeof candidate.filename === "string" &&
    typeof candidate.mimeType === "string" &&
    ((typeof candidate.contentBase64 === "string" && candidate.contentBase64.length > 0) ||
      typeof candidate.content === "string")
  );
}

function genericArtifactDataToCreateInput(data: GenericArtifactToolData): ArtifactCreateInput {
  return {
    filename: data.artifact.filename,
    mimeType: data.artifact.mimeType,
    content: data.artifact.contentBase64
      ? Buffer.from(data.artifact.contentBase64, "base64")
      : data.artifact.content ?? "",
    description: data.artifact.description,
  };
}

function safeArtifactSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/giu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "artifact";
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function toolIdentity(tool: Tool): string {
  return `${tool.name}@${tool.version ?? "unknown"}`;
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

function externalBlockerProcedure(target: string): string {
  return [
    `When browser proof from ${target} returns a loader, login wall, verification page, or other provider blocker, do not treat that as proof of the user task.`,
    "Do not request a tool rebuild solely from this signal: the tool executed, but the external provider did not expose useful evidence.",
    "Try a different public source or evidence strategy when available; otherwise report the external limitation clearly and attach only diagnostic evidence if it helps explain the blocker.",
  ].join(" ");
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
