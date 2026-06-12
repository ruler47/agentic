import { LlmClient } from "../llm/client.js";
import { runLLMWithResearch } from "./researchDelegate.js";
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
import {
  BUILTIN_EVIDENCE_PATTERNS,
  isGenericLandingUrl,
  scoreUrlAgainstPatterns,
} from "../tools/builtinEvidencePatterns.js";
import { loadEvidencePatternsFromMemory } from "../memory/evidencePatternMemory.js";
import { EvidencePattern } from "../tools/tool.js";
import { rankDiscoveryUrls } from "./discoveryUrlRanker.js";
import {
  expandSearchQueriesByIntent,
  extractIntentSourceHints,
  inferTaskIntents,
  isDiscoveryText,
  wantsInteractiveSource,
} from "./intentInference.js";
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
import { isBrowserOperateData, type BrowserOperateData } from "../tools/browserOperateTool.js";
import { isMarketTimeseriesData } from "../tools/marketTimeseriesTool.js";
import {
  EvidenceKind,
  EvidenceLedgerStore,
  RunRetrospectiveStore,
  WorkLedgerKind,
  WorkLedgerStore,
} from "../work-ledger/types.js";
import { compactWorkKey, searchQueryWorkKey, toolCallWorkKey } from "../work-ledger/workKey.js";
import { RuntimeLedgerCoordinator } from "../work-ledger/runtimeLedgerCoordinator.js";
import { Tool, ToolExecutionContext, ToolInput, ToolResult } from "../tools/tool.js";
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
import { decideAgentStrategy } from "./agentStrategy.js";
import type { AgentStrategyDecision } from "./agentStrategy.js";
import {
  buildAgentInvocationReturnCheck,
  createCouncilInvocations,
  createRootAgentInvocation,
  summarizeAgentInvocation,
} from "./agentInvocation.js";
import type { AgentInvocation } from "./agentInvocation.js";
import {
  buildRecursiveAgentLoopPlan,
  RecursiveAgentLoopPlan,
} from "./recursiveAgentLoop.js";
import { runRecursiveAgentExecutor } from "./recursiveAgentExecutor.js";

type AgentImproveToolFn = (request: ToolImprovementRequest) => Promise<ToolImprovementResult>;

type PlanResponse = {
  subtasks: Subtask[];
};

type ToolBuildRequestInput = {
  capability: string;
  displayName?: string;
  reason: string;
  sourceSpanId?: string;
  taskSummary?: string;
  desiredToolName?: string;
  replacesToolName?: string;
  replacesVersion?: string;
  feedback?: string;
  requiredInputs?: string[];
  requiredOutputs?: string[];
  qaCriteria?: string[];
};

type ToolBuildRequest = {
  id: string;
  contract: {
    toolName: string;
    modulePath?: string;
    testPath?: string;
  };
};

type ToolImprovementRequest = {
  source?: string;
  spanId?: string;
  toolName?: string;
  toolVersion?: string;
  title?: string;
  contextBundle?: Record<string, unknown>;
  buildRequestInput?: ToolBuildRequestInput;
};

type ToolImprovementResult = {
  status: "failed_to_request" | "requested" | "waiting" | "completed" | "failed";
  error?: string;
  errorCode?: string;
  buildRequest?: ToolBuildRequest;
  investigation?: { id?: string };
  wait?: { id: string; runId?: string; buildRequestId?: string; toolName?: string; status?: string };
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
  toolExecutionContext?: Partial<Omit<ToolExecutionContext, "toolName" | "now">>;
  workLedgerStore?: WorkLedgerStore;
  evidenceLedgerStore?: EvidenceLedgerStore;
  runRetrospectiveStore?: RunRetrospectiveStore;
  now?: Date;
  timeZone?: string;
  /**
   * Phase 12 follow-up: resume an interrupted run instead of restarting
   * from scratch. The runtime skips the classify and plan phases when
   * `complexity` and `subtasks` are provided, and treats any subtask in
   * `completedReviews` with `verdict=pass` as already done — emitting
   * the cached worker output and review verbatim. Subtasks with
   * `needs_revision` are re-run so the agent can produce the missing
   * revision. The Work Ledger preserves heavy external work (web.search,
   * browser.operate) by default, so re-running a subtask reuses cached
   * evidence rather than calling the tools again.
   */
  resumeFrom?: import("./runResumption.js").RunResumptionState;
  /**
   * When the operator cancels a run via POST /api/runs/:id/cancel, the
   * server aborts this signal. The agent (and the council loop in
   * particular) checks `signal.aborted` between LLM calls and passes
   * the signal to `LlmClient.complete` so in-flight HTTP requests
   * unblock immediately instead of letting the model finish.
   */
  signal?: AbortSignal;
  /**
   * Phase 17: when true, this run cannot itself spawn research
   * sub-runs. Set by the parent run on every sub-agent it spawns
   * to prevent unbounded recursion (LLM in sub-agent asks for
   * research, which spawns another sub-agent, which asks for
   * research…). Leave false on top-level runs.
   */
  researchDisabled?: boolean;
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
  /**
   * Phase 28 follow-up — structured tool evidence the agent
   * collected on the way to producing `text`. Carries the FULL
   * `ToolResult` (ok, content, data) plus the saved artifact, so
   * downstream consumers (worker LLM, reviewer LLM, synthesizer)
   * can read fields like `data.pageText` and `data.numericTokens`
   * that the legacy `evidence: string[]` shape had to throw away.
   *
   * Co-exists with `evidence: string[]` during the staged
   * migration. Both arrays describe the same actions; readers that
   * want raw structure use `records`, readers that want the human
   * summary keep using `evidence` / `text`.
   */
  records?: EvidenceRecord[];
  artifacts: AgentArtifact[];
};

/**
 * Phase 28 follow-up — structured per-action evidence record.
 *
 * Every tool call, fallback, or artifact-save emits one record.
 * Subtask workers, reviewers, and the synthesizer all read these
 * (via `formatEvidenceRecordsForPrompt`) instead of the legacy
 * one-liner strings, so a screenshot tool that returns
 * `data: { pageText: "Bitcoin BTC $81,335.94 ..." }` no longer
 * gets summarized to `"Created artifact for screenshot: foo.png"`
 * before the model has a chance to read the number.
 */
export type EvidenceRecord =
  | {
      kind: "tool_call";
      toolName: string;
      capability?: string;
      input: Record<string, unknown>;
      output: { ok: boolean; content: string; data?: unknown };
      artifact?: { filename: string; mimeType: string; url: string };
      timestamp: string;
      spanId?: string;
    }
  | {
      kind: "artifact";
      artifact: { filename: string; mimeType: string; url: string };
      sourceTool?: string;
      sourceUrl?: string;
      timestamp: string;
      spanId?: string;
    }
  | {
      kind: "limitation";
      summary: string;
      provider?: string;
      timestamp: string;
      spanId?: string;
    };

const promptBudget = {
  classificationContextChars: 1_200,
  taskContextChars: 3_000,
  memoryEntryChars: 220,
  memoryEvidenceChars: 80,
  toolEvidenceChars: 1_500,
  dependencyContextChars: 1_800,
  workerUserPromptChars: 4_500,
  reviewWorkerOutputChars: 1_200,
  synthesisTaskContextChars: 1_200,
  synthesisStructuredEvidenceChars: 600,
  synthesisWorkerOutputChars: 900,
  synthesisReviewChars: 180,
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

  /**
   * Phase 12 Slice A (full): per-run classifier-resolved intents. Set when
   * `classify()` returns and consumed by deep helpers (collect browser
   * discovery, screenshot, declared inputs) without threading the full
   * `TaskComplexity` object through every subtask. Falls back to
   * `inferTaskIntents(text)` regex when the run has no entry (e.g. CLI
   * smokes that bypass classification).
   */
  private readonly runScopedIntents = new Map<string, string[]>();

  /**
   * Phase 13 follow-up: per-run thread artifacts (carried over from
   * `options.threadContext.relevantArtifacts`). Lets `createScreenshotArtifact`
   * reuse an existing PNG screenshot from a prior turn instead of triggering
   * yet another `tool-missing: input-missing-source-url` worker iteration
   * when the user simply asks "send me a screenshot of that".
   */
  private readonly runScopedThreadArtifacts = new Map<string, AgentArtifact[]>();

  /**
   * Phase 13 follow-up (TB-005b): per-run user-driven tool policy
   * extracted by `decideAgentStrategy`. Discovery helpers consult it
   * to drop denied tools and promote preferred ones in
   * `findByCapability` results, so a user instruction like
   * "use web.duckduckgo, don't use web.search" actually steers tool
   * selection inside the worker loop.
   */
  private readonly runScopedToolPolicy = new Map<
    string,
    { denied: readonly string[]; preferred: readonly string[] }
  >();

  /**
   * Phase 13: optional callback envelope source. When set, each
   * external tool invocation receives a short-lived bearer token and
   * the runtime callback base URL so dockerized tool services can
   * call back for artifacts / ledger / memory / events. Optional so
   * the in-process CLI / fixture path keeps working without wiring a
   * real Nest module.
   */
  private callbackIssuer?: {
    issue(input: { runId: string; toolName: string; scope: string[]; ttlMs?: number }): string;
  };
  private callbackBaseUrl?: string;
  private callbackDefaultScope: string[] = ["artifacts.save", "ledger.claim", "memory.search", "events.emit"];

  constructor(
    private readonly llm: LlmClient,
    private readonly skillMemory: SkillMemoryStore,
    private readonly tools = new ToolRegistry(),
  ) {}

  /**
   * Phase 13: wire the callback envelope source. Called from the
   * Nest runtime module on startup; CLI / fixture paths leave this
   * unset and tools that need callbacks fail explicitly with a
   * clear error.
   */
  setCallbackEnvelopeSource(options: {
    issuer: { issue(input: { runId: string; toolName: string; scope: string[]; ttlMs?: number }): string };
    baseUrl: string;
    defaultScope?: string[];
  }): void {
    this.callbackIssuer = options.issuer;
    this.callbackBaseUrl = options.baseUrl;
    if (options.defaultScope) this.callbackDefaultScope = [...options.defaultScope];
  }

  private resolveLedgerFromContext(
    toolExecutionContext: BaseToolExecutionContext | undefined,
  ): RuntimeLedgerCoordinator | undefined {
    const runId = toolExecutionContext?.runId;
    if (typeof runId !== "string" || runId === "") return undefined;
    return this.runScopedLedgers.get(runId);
  }

  /**
   * Phase 12 Slice A (full): the canonical intent source. Prefers the
   * classifier-resolved list stored in `runScopedIntents` when the run has
   * one; otherwise falls back to regex `inferTaskIntents(text)` so paths
   * that have not been threaded yet still work. Always returns a plain
   * deduped array.
   */
  private resolveTaskIntents(text: string, runId?: string): string[] {
    const fromRun = runId ? this.runScopedIntents.get(runId) : undefined;
    if (fromRun && fromRun.length > 0) return fromRun;
    return inferTaskIntents(text);
  }

  /**
   * Phase 12 Slice C: collect evidence patterns relevant to the active
   * intents from registered tools and accepted memory entries. Returned list
   * is empty when no intents are inferred — the runtime falls back to
   * `BUILTIN_EVIDENCE_PATTERNS` only. Failures from memory parsing are
   * swallowed (they would just mean a missing pattern, never a runtime
   * crash) but emitted via the registered emitter when available.
   */
  private async resolveEvidencePatterns(intents: string[]): Promise<EvidencePattern[]> {
    if (intents.length === 0) return [];
    const fromTools = this.tools.evidencePatternsForIntents(intents);
    let fromMemory: EvidencePattern[] = [];
    try {
      const result = await loadEvidencePatternsFromMemory(this.skillMemory, intents);
      fromMemory = result.patterns;
    } catch {
      // Defensive: a broken memory store should never block discovery; the
      // built-in seed remains. Surfacing the error stays a Slice C+/D task.
      fromMemory = [];
    }
    return [...fromTools, ...fromMemory];
  }

  private async finalizeRunLedger(
    ledger: RuntimeLedgerCoordinator | undefined,
    runOutcome: "completed" | "failed" | "cancelled",
    runId: string | undefined,
    parentSpanId: string,
  ): Promise<void> {
    try {
      if (ledger) {
        await ledger.writeRetrospective(runOutcome, parentSpanId);
      }
    } finally {
      if (runId) {
        this.runScopedLedgers.delete(runId);
        this.runScopedIntents.delete(runId);
        this.runScopedThreadArtifacts.delete(runId);
        this.runScopedToolPolicy.delete(runId);
      }
    }
  }

  /**
   * Phase 13 follow-up (TB-005b): expose the run-scoped user tool
   * policy so deep helpers can pass it to `findByCapability`.
   */
  /**
   * Phase 17: spawn a fresh sub-agent run to answer a research
   * question. Used by `runLLMWithResearch` to satisfy
   * `<request_research>` blocks emitted by council / worker LLM
   * calls. The sub-run inherits scope (instanceId, requesterUserId,
   * signal) from the parent so cancel propagates and audit lineage
   * is preserved, but starts with a clean classify→plan flow
   * The child run is
   * marked `researchDisabled` so it cannot recursively spawn more
   * research — keeps the call tree bounded.
   *
   * Returns the child's `finalAnswer`. Errors from the child are
   * caught upstream by `runLLMWithResearch` and surfaced to the
   * calling LLM as a "research delegate failed" note.
   */
  async spawnResearch(
    question: string,
    parent: Pick<RunOptions, "instanceId" | "requesterUserId" | "threadId" | "signal" | "memoryScopes">,
  ): Promise<string> {
    const result = await this.run(question, {
      instanceId: parent.instanceId,
      requesterUserId: parent.requesterUserId,
      threadId: parent.threadId,
      signal: parent.signal,
      memoryScopes: parent.memoryScopes,
      researchDisabled: true,
    });
    return result.finalAnswer;
  }

  private getToolPolicy(runId: string | undefined) {
    return runId ? this.runScopedToolPolicy.get(runId) : undefined;
  }

  async run(task: string, options: RunOptions = {}): Promise<AgentRunResult> {
    const emit = createEmitter(options.onEvent);
    const runSpanId = createSpanId("run");
    const memorySpanId = createSpanId("memory");
    const classificationSpanId = createSpanId("classification");
    const runStartedAt = options.now ?? new Date();
    const artifacts: AgentArtifact[] = [...(options.inputArtifacts ?? [])];
    // Phase 12 final: synthesize a runId for paths that did not provide one
    // (CLI smokes, fixtures, recursive in-memory invocations) so deep
    // helpers can still find run-scoped state via `toolExecutionContext.runId`.
    const effectiveRunId = options.runId ?? runSpanId;
    // Phase 13 follow-up: stash thread artifacts keyed by runId so deep
    // helpers (createScreenshotArtifact) can pick a reusable existing
    // screenshot without having to thread the array through every layer.
    const threadArtifacts = options.threadContext?.relevantArtifacts ?? [];
    if (threadArtifacts.length > 0) {
      this.runScopedThreadArtifacts.set(effectiveRunId, threadArtifacts);
    }
    const toolExecutionContext = buildToolExecutionContext({
      ...options,
      runId: effectiveRunId,
    });
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
    const improveTool: AgentImproveToolFn | undefined = undefined;
    const appendPendingImprovements = (answer: string): string => answer;

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
    // Phase 12 follow-up: when resuming from a prior run, skip the
    // classifier call entirely if the prior run already produced a
    // `TaskComplexity`. We still emit the `classification-completed`
    // event so the new run's trace shows what it inherited.
    const classificationContext = buildClassificationContext(task, options, runStartedAt);
    let complexity: TaskComplexity = options.resumeFrom?.complexity
      ?? (await this.classify(classificationContext, memories, classificationTier));
    if (complexity.mode === "direct" && hasActionableApiToolRequest(taskContext, this.tools.list())) {
      complexity = {
        ...complexity,
        mode: "delegated",
        reason: `${complexity.reason} Registered API tool execution is required.`,
      };
    }
    // Phase 12 Slice A (full): cache classifier-resolved intents per run so
    // deep helpers (browser discovery, screenshot, declared inputs) can read
    // them without threading complexity through every layer.
    // Phase 12 final: cache classifier-resolved intents under the same
    // runId that `toolExecutionContext` carries so deep helpers (browser
    // discovery, declared inputs, screenshot proof) read the right value.
    this.runScopedIntents.set(effectiveRunId, [...(complexity.intent ?? [])]);
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

    const strategy = decideAgentStrategy({
      task,
      complexity,
      memories,
      tools: this.tools.list(),
      hasWorkLedger: Boolean(ledger),
      pendingToolImprovements: 0,
    });
    // Phase 13 follow-up (TB-005b): stash the user-driven tool policy so
    // deep `findByCapability` callsites in the worker loop respect
    // "use X / don't use Y" intent extracted from the task body.
    if (
      strategy.toolPolicy.deniedToolNames.length > 0 ||
      strategy.toolPolicy.preferredToolNames.length > 0
    ) {
      this.runScopedToolPolicy.set(effectiveRunId, {
        denied: strategy.toolPolicy.deniedToolNames,
        preferred: strategy.toolPolicy.preferredToolNames,
      });
    }
    const strategySpanId = createSpanId("agent-strategy");
    await emit({
      spanId: strategySpanId,
      parentSpanId: classificationSpanId,
      type: "agent-strategy-selected",
      actor: "coordinator",
      activity: "agent",
      status: "completed",
      title: `Agent strategy selected: ${strategy.primary}`,
      detail: [
        `Actions: ${strategy.actions.join(", ")}`,
        `Review: ${strategy.reviewStrictness}`,
        `Model tier: ${strategy.modelTier}`,
        ...strategy.reasons,
        strategy.council
          ? `Council planned with ${strategy.council.participants.length} participant(s); execution remains delegated-DAG until recursive runtime lands.`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 0,
      payload: strategy,
    });
    const invocationStartedAt = new Date();
    const rootInvocation = createRootAgentInvocation({
      runId: options.runId,
      spanId: createSpanId("root-agent"),
      task,
      strategy,
      tools: this.tools.list(),
      createdAt: invocationStartedAt.toISOString(),
      caller: { kind: "human", runId: options.runId, spanId: runSpanId, actor: "user" },
    });
    await emit({
      spanId: createSpanId("agent-invocation"),
      parentSpanId: strategySpanId,
      type: "agent-invocation-created",
      actor: rootInvocation.actor,
      activity: "agent",
      status: "completed",
      title: `Agent invocation created: ${rootInvocation.strategy}`,
      detail: summarizeAgentInvocation(rootInvocation),
      startedAt: invocationStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(invocationStartedAt),
      payload: rootInvocation,
    });
    const recursiveLoopPlan = buildRecursiveAgentLoopPlan({
      invocation: rootInvocation,
      strategy,
      complexity,
    });
    await emit({
      spanId: createSpanId("agent-decision-loop"),
      parentSpanId: strategySpanId,
      type: "agent-decision-loop-completed",
      actor: rootInvocation.actor,
      activity: "agent",
      status: "completed",
      title: `Agent decision loop: ${recursiveLoopPlan.executionMode}`,
      detail: [
        recursiveLoopPlan.reason,
        `Actions: ${recursiveLoopPlan.actions.join(", ")}`,
        recursiveLoopPlan.requiresPlanning ? "Planning required before return." : "No child planning required.",
      ].join("\n"),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 0,
      payload: recursiveLoopPlan,
    });
    if (complexity.mode === "direct" && recursiveLoopPlan.executionMode === "delegate") {
      complexity = {
        ...complexity,
        mode: "delegated",
        reason: `${complexity.reason} Recursive decision loop selected delegated execution for tool, ledger, council, or external evidence work.`,
      };
    }
    const agentTaskContext = appendAgentRuntimeStrategyContext(
      taskContext,
      strategy,
      rootInvocation,
      Boolean(ledger),
      0,
      recursiveLoopPlan,
    );

    const councilStartedAt = new Date();
    const councilInvocations = strategy.council
      ? createCouncilInvocations({
        rootInvocation,
        strategy,
        task,
        spanIdPrefix: createSpanId("council-agent"),
        createdAt: councilStartedAt.toISOString(),
      })
      : [];
    if (strategy.council) {
      await emit({
        spanId: createSpanId("agent-council"),
        parentSpanId: strategySpanId,
        type: "agent-council-planned",
        actor: "council-planner",
        activity: "agent",
        status: "completed",
        title: `${councilInvocations.length} council participant invocation(s) planned`,
        detail: councilInvocations.map(summarizeAgentInvocation).join("\n"),
        startedAt: councilStartedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: elapsedMs(councilStartedAt),
        payload: {
          rootInvocation,
          councilInvocations,
          reason: strategy.council.reason,
        },
      });
    }
    const councilNotes = strategy.council
      ? await this.executeCouncilInvocations(agentTaskContext, councilInvocations, emit, strategySpanId)
      : [];

    if (complexity.mode === "direct") {
      let finalAnswer: string;
      if (recursiveLoopPlan.executionMode === "answer" && !rootInvocation.outputContract.requiredEvidence) {
        const recursiveResult = await runRecursiveAgentExecutor({
          invocation: rootInvocation,
          emit: async (event) => {
            await emit({
              spanId: event.spanId,
              parentSpanId: event.parentSpanId ?? runSpanId,
              type: event.type,
              actor: event.actor,
              activity: event.activity,
              status: event.status,
              title: event.title,
              detail: event.detail,
              startedAt: event.startedAt,
              completedAt: event.completedAt,
              durationMs: event.durationMs,
              payload: event.payload,
            });
          },
          handlers: {
            decide: async () => ({
              action: "answer_self",
              reason: "Root recursive executor can answer locally after direct synthesis.",
            }),
            answerSelf: async () => {
              const generatedArtifact = await this.createRequestedArtifact(
                task,
                [],
                emit,
                rootInvocation.spanId,
                options.saveArtifact,
                undefined,
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
                parentSpanId: rootInvocation.spanId,
                type: "synthesis-started",
                actor: "synthesizer",
                activity: "synthesis",
                status: "started",
                title: "Direct answer synthesis started",
                startedAt: synthesisStartedAt.toISOString(),
                payload: { modelTier: synthesisTier, invocationId: rootInvocation.id },
              });
              const directSynthesisContext = appendInternalProjectKnowledgeContextIfNeeded(agentTaskContext, task);
              const synthesisUserPrompt = synthesizePrompt(
                limitText(directSynthesisContext, promptBudget.taskContextChars),
                complexity,
                [],
                [],
                compactMemoriesForPrompt(memories),
                artifacts,
              );
              const rawFinalAnswer = await this.llm.complete([
                { role: "system", content: coordinatorSystemPrompt },
                { role: "user", content: synthesisUserPrompt },
              ], { modelTier: synthesisTier });
              const synthesisCorpus = buildSynthesisEvidenceCorpus(directSynthesisContext, [], artifacts);
              const guardedSynthesis = await enforceUngroundedSpecificsOnSynthesis({
                llm: this.llm,
                modelTier: synthesisTier,
                systemPrompt: coordinatorSystemPrompt,
                userPrompt: synthesisUserPrompt,
                rawAnswer: rawFinalAnswer,
                evidenceCorpus: synthesisCorpus,
              });
              // Phase 12 follow-up: recover any fenced code blocks
              // from the direct-mode synthesis answer. The model is
              // explicitly answering a coding task (no worker
              // pipeline ran) and the prose contains the file the
              // user asked for — persist it as an artifact so the
              // user actually receives the deliverable.
              if (options.saveArtifact) {
                const recovered = await recoverCodeArtifactsFromWorkerOutput(
                  guardedSynthesis.answer,
                  undefined,
                  artifacts,
                  options.saveArtifact,
                );
                if (recovered.length > 0) artifacts.push(...recovered);
              }
              const output = appendPendingImprovements(withArtifactLinks(guardedSynthesis.answer, artifacts));
              await emit({
                spanId: synthesisSpanId,
                parentSpanId: rootInvocation.spanId,
                type: "synthesis-completed",
                actor: "synthesizer",
                activity: "llm",
                status: "completed",
                title: "Direct answer synthesized",
                detail: limitText(output, 1_200),
                startedAt: synthesisStartedAt.toISOString(),
                completedAt: new Date().toISOString(),
                durationMs: elapsedMs(synthesisStartedAt),
                payload: {
                  finalAnswer: output,
                  modelTier: synthesisTier,
                  invocationId: rootInvocation.id,
                  ungroundedFirstPass: guardedSynthesis.ungroundedFirstPass,
                  ungroundedAfterRetry: guardedSynthesis.ungroundedAfterRetry,
                  disclaimerApplied: guardedSynthesis.disclaimerApplied,
                },
              });
              return {
                output,
                artifacts,
                evidenceCount: artifacts.length,
                metadata: {
                  synthesisSpanId,
                  councilNoteCount: councilNotes.length,
                },
              };
            },
          },
        });
        finalAnswer = recursiveResult.output;
      } else {
        const generatedArtifact = await this.createRequestedArtifact(
          task,
          [],
          emit,
          runSpanId,
          options.saveArtifact,
          undefined,
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
          parentSpanId: rootInvocation.spanId,
          type: "synthesis-started",
          actor: "synthesizer",
          activity: "synthesis",
          status: "started",
          title: "Direct answer synthesis started",
          startedAt: synthesisStartedAt.toISOString(),
          payload: { modelTier: synthesisTier, invocationId: rootInvocation.id },
        });
        const directSynthesisContext = appendInternalProjectKnowledgeContextIfNeeded(agentTaskContext, task);
        const synthesisUserPrompt = synthesizePrompt(
          limitText(directSynthesisContext, promptBudget.taskContextChars),
          complexity,
          [],
          [],
          compactMemoriesForPrompt(memories),
          artifacts,
        );
        const rawFinalAnswer = await this.llm.complete([
          { role: "system", content: coordinatorSystemPrompt },
          { role: "user", content: synthesisUserPrompt },
        ], { modelTier: synthesisTier });
        const synthesisCorpus = buildSynthesisEvidenceCorpus(directSynthesisContext, [], artifacts);
        const guardedSynthesis = await enforceUngroundedSpecificsOnSynthesis({
          llm: this.llm,
          modelTier: synthesisTier,
          systemPrompt: coordinatorSystemPrompt,
          userPrompt: synthesisUserPrompt,
          rawAnswer: rawFinalAnswer,
          evidenceCorpus: synthesisCorpus,
        });
        // Phase 12 follow-up: same code-recovery hook as the
        // recursive direct-answer path (see runner above).
        if (options.saveArtifact) {
          const recovered = await recoverCodeArtifactsFromWorkerOutput(
            guardedSynthesis.answer,
            undefined,
            artifacts,
            options.saveArtifact,
          );
          if (recovered.length > 0) artifacts.push(...recovered);
        }
        finalAnswer = appendPendingImprovements(withArtifactLinks(guardedSynthesis.answer, artifacts));
        await emit({
          spanId: synthesisSpanId,
          parentSpanId: rootInvocation.spanId,
          type: "synthesis-completed",
          actor: "synthesizer",
          activity: "llm",
          status: "completed",
          title: "Direct answer synthesized",
          detail: limitText(finalAnswer, 1_200),
          startedAt: synthesisStartedAt.toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: elapsedMs(synthesisStartedAt),
          payload: {
            finalAnswer,
            modelTier: synthesisTier,
            invocationId: rootInvocation.id,
            ungroundedFirstPass: guardedSynthesis.ungroundedFirstPass,
            ungroundedAfterRetry: guardedSynthesis.ungroundedAfterRetry,
            disclaimerApplied: guardedSynthesis.disclaimerApplied,
          },
        });
        await this.emitInvocationReturnCheck(
          rootInvocation,
          finalAnswer,
          artifacts,
          artifacts.length,
          emit,
          synthesisSpanId,
        );
      }

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

      await this.finalizeRunLedger(ledger, "completed", effectiveRunId, runSpanId);
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
    await emit({
      spanId: planningSpanId,
      parentSpanId: runSpanId,
      type: "planning-started",
      actor: "planner",
      activity: "planning",
      status: "started",
      title: "Planning started",
      detail: `Model tier: ${planningTier}`,
      startedAt: planningStartedAt.toISOString(),
      payload: { modelTier: planningTier },
    });
    // Phase 12 follow-up: skip the planner LLM call too when the resumed
    // run already has a subtasks array. The planner is the second-most
    // expensive coordinator phase after worker execution; a resume must
    // not pay for it twice.
    const deterministicToolPlan =
      options.resumeFrom?.subtasks === undefined
        ? buildInternalProjectKnowledgeFastPathSubtasks(task) ??
          buildLocalUtilityToolchainFastPathSubtasks(task, (toolName) => Boolean(this.tools.get(toolName))) ??
          (this.tools.get("http.request") ? buildExplicitHttpFastPathSubtasks(task) : undefined) ??
          (this.tools.get("browser.operate")
            ? buildExternalActionFastPathSubtasks(
                task,
                (toolName) => Boolean(this.tools.get(toolName)),
                agentTaskContext,
              ) ??
              buildExplicitBrowserFastPathSubtasks(task) ??
              (this.tools.findByCapability("web-search")[0]
                ? buildCurrentFactProofFastPathSubtasks(task)
                : undefined)
            : undefined)
        : undefined;
    let planningFallbackReason: string | undefined;
    let rawSubtasks: Subtask[];
    if (options.resumeFrom?.subtasks) {
      rawSubtasks = options.resumeFrom.subtasks;
    } else if (deterministicToolPlan) {
      rawSubtasks = deterministicToolPlan;
    } else {
      try {
        rawSubtasks = await this.plan(withCouncilNotes(agentTaskContext, councilNotes), complexity, memories, planningTier);
      } catch (error) {
        planningFallbackReason = error instanceof Error ? error.message : "Planner LLM failed";
        rawSubtasks = buildFallbackResearchSubtasks(task, (toolName) => Boolean(this.tools.get(toolName)));
        await emit({
          spanId: createSpanId("planning-fallback"),
          parentSpanId: planningSpanId,
          type: "planning-fallback-created",
          actor: "planner",
          activity: "planning",
          status: "completed",
          title: "Fallback research plan created",
          detail: planningFallbackReason,
          payload: {
            reason: planningFallbackReason,
            subtasks: rawSubtasks,
          },
        });
      }
    }
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
        deterministicFastPath: Boolean(deterministicToolPlan),
        fallbackReason: planningFallbackReason,
      },
    });

    const reviewedWorkerResults = await this.executeSubtaskDag(
      agentTaskContext,
      complexity,
      executionPlan,
      memories,
      emit,
      planningSpanId,
      options.saveArtifact,
      undefined,
      improveTool,
      toolExecutionContext,
      options.resumeFrom,
    );
    const workerResults = reviewedWorkerResults.map((result) => result.workerResult);
    const reviews = reviewedWorkerResults.flatMap((result) => result.reviews);
    pushUniqueArtifacts(artifacts, getApprovedArtifacts(reviewedWorkerResults));
    // Phase 12 follow-up: keep a wider set for UI / `run-completed` event
    // emission. Synthesis itself only sees `artifacts` (approved + generated)
    // so the LLM cannot cite weak proof, but the user still gets to see
    // every screenshot the run produced — even when every review failed.
    const collectedArtifacts: AgentArtifact[] = [...artifacts];
    pushUniqueArtifacts(collectedArtifacts, getAllWorkerArtifacts(reviewedWorkerResults));
    const generatedArtifact = await this.createRequestedArtifact(
      task,
      workerResults,
      emit,
      runSpanId,
      options.saveArtifact,
      undefined,
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
    // Phase 28 follow-up — aggregate structured tool records across
    // all workers so the synthesizer can read tool `data.pageText`
    // etc. directly, not via the LLM-summarized worker output.
    const aggregatedRecords = aggregateEvidenceRecords(workerResults);
    const structuredEvidenceText = formatEvidenceRecordsForPrompt(
      aggregatedRecords,
      promptBudget.synthesisStructuredEvidenceChars,
    );
    const synthesisUserPrompt = synthesizePrompt(
      limitText(agentTaskContext, promptBudget.synthesisTaskContextChars),
      complexity,
      compactWorkerResultsForPrompt(workerResults, promptBudget.synthesisWorkerOutputChars),
      compactReviewsForPrompt(reviews),
      compactMemoriesForPrompt(memories),
      artifacts,
      structuredEvidenceText,
    );
    let rawFinalAnswer: string;
    let usedCompactFallback = false;
    try {
      rawFinalAnswer = await this.llm.complete([
        { role: "system", content: coordinatorSystemPrompt },
        { role: "user", content: synthesisUserPrompt },
      ], { modelTier: synthesisTier, maxTokens: 1_000 });
    } catch (error) {
      if (!isContextWindowError(error)) throw error;
      usedCompactFallback = true;
      rawFinalAnswer = buildCompactSynthesisFallback(task, workerResults, reviews, artifacts, error);
    }
    // Phase 12 follow-up: deterministic gate against ungrounded specifics
    // at the synthesis layer too. Workers are already gated by
    // hardGateReview, but the synthesis LLM call can re-introduce model
    // numbers / versions / prices from training memory.
    const synthesisCorpus = buildSynthesisEvidenceCorpus(agentTaskContext, workerResults, artifacts);
    const guardedSynthesis = usedCompactFallback
      ? {
          answer: rawFinalAnswer,
          ungroundedFirstPass: [],
          ungroundedAfterRetry: [],
          disclaimerApplied: false,
        }
      : await enforceUngroundedSpecificsOnSynthesis({
          llm: this.llm,
          modelTier: synthesisTier,
          systemPrompt: coordinatorSystemPrompt,
          userPrompt: synthesisUserPrompt,
          rawAnswer: rawFinalAnswer,
          evidenceCorpus: synthesisCorpus,
        });
    const externalActionBlockerAnswer = buildExternalActionBlockerFinalAnswer(task, workerResults, artifacts);
    const finalAnswer = appendPendingImprovements(
      withArtifactLinks(externalActionBlockerAnswer ?? guardedSynthesis.answer, artifacts),
    );
    await emit({
      spanId: synthesisSpanId,
      parentSpanId: runSpanId,
      type: "synthesis-completed",
      actor: "synthesizer",
      activity: "llm",
      status: "completed",
      title: "Final answer synthesized",
      detail: limitText(finalAnswer, 1_200),
      startedAt: synthesisStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(synthesisStartedAt),
      payload: {
        finalAnswer,
        modelTier: synthesisTier,
        ungroundedFirstPass: guardedSynthesis.ungroundedFirstPass,
        ungroundedAfterRetry: guardedSynthesis.ungroundedAfterRetry,
        disclaimerApplied: guardedSynthesis.disclaimerApplied,
      },
    });
    await this.emitInvocationReturnCheck(
      rootInvocation,
      finalAnswer,
      artifacts,
      workerResults.length + workerResults.reduce((count, result) => count + (result.toolEvidence?.length ?? 0), 0),
      emit,
      synthesisSpanId,
    );

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
      payload: { finalAnswer, artifacts: collectedArtifacts },
    });

    await this.finalizeRunLedger(ledger, "completed", effectiveRunId, runSpanId);
    return {
      finalAnswer,
      complexity,
      subtasks,
      workerResults,
      reviews,
      artifacts: collectedArtifacts,
      learnedSkill,
    };
    } catch (error) {
      ledger?.trackWhatFailed(`Run failed: ${formatErrorMessage(error)}`);
      await ledger?.markUnfinishedWorkFailed(limitText(formatErrorMessage(error), 600));
      await this.finalizeRunLedger(ledger, "failed", effectiveRunId, runSpanId);
      throw error;
    }
  }

  private async emitInvocationReturnCheck(
    invocation: AgentInvocation,
    output: string,
    artifacts: AgentArtifact[],
    evidenceCount: number,
    emit: AgentEventEmitter,
    parentSpanId: string,
  ): Promise<void> {
    const startedAt = new Date();
    const selfCheck = buildAgentInvocationReturnCheck(invocation, {
      output,
      artifacts,
      evidenceCount,
      checkedAt: startedAt,
    });
    await emit({
      spanId: createSpanId("agent-invocation-return-check"),
      parentSpanId,
      type: "agent-invocation-return-checked",
      actor: invocation.actor,
      activity: "agent",
      status: selfCheck.readyToReturn ? "completed" : "failed",
      title: `Invocation return self-check: ${invocation.actor}`,
      detail: selfCheck.readyToReturn ? "Ready to return." : selfCheck.warnings.join("; "),
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(startedAt),
      payload: {
        invocation,
        selfCheck,
      },
    });
  }

  private async executeCouncilInvocations(
    taskContext: string,
    invocations: AgentInvocation[],
    emit: AgentEventEmitter,
    parentSpanId: string,
  ): Promise<string[]> {
    const results = await Promise.all(
      invocations.map(async (invocation) => {
        try {
          return await runRecursiveAgentExecutor({
            invocation,
            emit: async (event) => {
              await emit({
                spanId: event.spanId,
                parentSpanId: event.parentSpanId ?? parentSpanId,
                type: event.type,
                actor: event.actor,
                activity: event.activity,
                status: event.status,
                title: event.title,
                detail: event.detail,
                startedAt: event.startedAt,
                completedAt: event.completedAt,
                durationMs: event.durationMs,
                payload: event.payload,
              });
            },
            handlers: {
              decide: async () => ({
                action: "answer_self",
                reason: "Council participant returns an independent advisory note.",
              }),
              answerSelf: async ({ invocation: currentInvocation }) => {
                const output = await this.llm.complete([
                  { role: "system", content: coordinatorSystemPrompt },
                  {
                    role: "user",
                    content: buildCouncilParticipantPrompt(taskContext, currentInvocation),
                  },
                ], { modelTier: currentInvocation.modelTier });
                return {
                  output,
                  metadata: {
                    councilParticipant: currentInvocation.councilParticipant,
                  },
                };
              },
            },
          });
        } catch {
          return undefined;
        }
      }),
    );

    return results
      .filter((result): result is NonNullable<typeof result> => Boolean(result))
      .map((result) => formatCouncilNote(result.invocation, result.output));
  }

  private async classify(
    task: string,
    memories: SkillMemoryEntry[],
    modelTier: ReturnType<typeof selectModelTier>,
  ): Promise<TaskComplexity> {
    const promptTask = limitText(task, promptBudget.taskContextChars);
    const promptMemories = compactMemoriesForClassification(memories);
    const output = await this.llm.complete([
      { role: "system", content: coordinatorSystemPrompt },
      { role: "user", content: classifyPrompt(promptTask, promptMemories) },
    ], { modelTier, maxTokens: 512 });

    const parsed = extractJson<TaskComplexity>(output);
    // Phase 12 Slice A (full): normalize the new `intent` field. Older
    // classifier responses may omit it entirely. We also treat any
    // non-string entries as missing rather than throwing — defensive
    // because the LLM occasionally sneaks in objects.
    const rawIntent = (parsed as { intent?: unknown }).intent;
    const intent = Array.isArray(rawIntent)
      ? [...new Set(rawIntent.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()))]
      : [];
    // Phase 12 follow-up: same defensive normalization for the new
    // `geoAnchors` field. Older classifier responses won't include it.
    const rawGeo = (parsed as { geoAnchors?: unknown }).geoAnchors;
    const geoAnchors = Array.isArray(rawGeo)
      ? [...new Set(rawGeo.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()))]
      : [];
    return { ...parsed, intent, geoAnchors };
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
      { role: "user", content: planPrompt(promptTask, complexity, promptMemories, this.tools.list()) },
    ], { modelTier, maxTokens: 1_500 });

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
    resumeFrom?: import("./runResumption.js").RunResumptionState,
  ): Promise<ReviewedWorkerResult[]> {
    const completedResults = new Map<string, ReviewedWorkerResult>();
    const orderedResults: ReviewedWorkerResult[] = [];

    // Phase 12 follow-up: when a resumed run carries cached worker results
    // and reviews from the source run, materialize them as already-done
    // before iterating the DAG. Subtasks where the prior review verdict
    // is `pass` are skipped entirely; ones with `needs_revision` are
    // re-run normally so the agent produces the missing follow-up.
    const cachedWorkers = new Map<string, WorkerResult>(
      (resumeFrom?.completedWorkers ?? []).map((worker) => [worker.subtask.id, worker]),
    );
    const cachedReviews = new Map<string, ReviewResult>(
      (resumeFrom?.completedReviews ?? []).map((review) => [review.subtaskId, review]),
    );

    for (const level of executionPlan.levels) {
      const levelResults = await Promise.all(
        level.map(async (subtask) => {
          const cachedWorker = cachedWorkers.get(subtask.id);
          const cachedReview = cachedReviews.get(subtask.id);
          if (cachedWorker && cachedReview && cachedReview.verdict === "pass") {
            // Re-emit completion events so the resumed run's trace shows
            // what was inherited; downstream consumers (UI, audit,
            // synthesis) treat the resumed subtask exactly like a
            // freshly-executed one.
            await emit({
              spanId: createSpanId(`worker-${subtask.id}-resumed`),
              parentSpanId: planningSpanId,
              type: "worker-completed",
              actor: subtask.role || "worker",
              activity: "worker",
              status: "completed",
              title: `Worker (resumed): ${subtask.title}`,
              detail: limitText(cachedWorker.output, 600),
              payload: {
                ...cachedWorker,
                resumedFromSourceRunId: resumeFrom?.sourceRunId,
              },
            });
            await emit({
              spanId: createSpanId(`review-${subtask.id}-resumed`),
              parentSpanId: planningSpanId,
              type: "review-completed",
              actor: "reviewer",
              activity: "review",
              status: "completed",
              title: `Review (resumed): ${subtask.title}`,
              detail: cachedReview.notes,
              payload: { ...cachedReview, resumedFromSourceRunId: resumeFrom?.sourceRunId },
            });
            const reviewed: ReviewedWorkerResult = {
              workerResult: cachedWorker,
              review: cachedReview,
              attempts: [cachedWorker],
              reviews: [cachedReview],
            };
            return reviewed;
          }

          const dependencyResults = (subtask.dependsOn ?? [])
            .map((id) => completedResults.get(id))
            .filter((result): result is ReviewedWorkerResult => Boolean(result));
          const dependencySpanIds = dependencyResults
            .map((result) => result.workerResult.traceSpanId)
            .filter((spanId): spanId is string => Boolean(spanId));
          const dependencyContext = formatDependencyContext(dependencyResults);
          const dependencyArtifacts = dependencyResults.flatMap((result) => result.workerResult.artifacts ?? []);
          const parentSpanId = dependencySpanIds.at(-1) ?? planningSpanId;
          const failedDependencies = dependencyResults.filter((result) => result.review.verdict !== "pass");
          if (failedDependencies.length > 0 && isExternalActionBoundarySubtask(subtask)) {
            const spanId = createSpanId(`worker-blocked-${subtask.id}`);
            const notes = `Blocked: ${failedDependencies
              .map((result) => `${result.workerResult.subtask.id}: ${result.review.notes}`)
              .join("; ")}`;
            const workerResult: WorkerResult = {
              subtask,
              output:
                `Cannot prepare or commit an external action because required upstream work did not pass review.\n${notes}`,
              traceSpanId: spanId,
              modelTier: selectModelTier("worker", complexity, subtask),
              artifacts: [],
              toolEvidence: [],
              dependencyContextSnapshot: dependencyContext,
            };
            const review: ReviewResult = {
              subtaskId: subtask.id,
              verdict: "needs_revision",
              notes,
            };
            await emit({
              spanId,
              parentSpanId,
              type: "worker-completed",
              actor: `worker:${subtask.role}`,
              activity: "worker",
              status: "failed",
              title: `Worker blocked: ${subtask.title}`,
              detail: workerResult.output,
              payload: { output: workerResult.output, subtask, dependencySpanIds },
            });
            await emit({
              spanId: createSpanId(`review-blocked-${subtask.id}`),
              parentSpanId: spanId,
              type: "review-completed",
              actor: "reviewer",
              activity: "review",
              status: "failed",
              title: `Review blocked: ${subtask.title}`,
              detail: review.notes,
              payload: { ...review, deterministic: true },
            });
            return { workerResult, review, attempts: [workerResult], reviews: [review] };
          }

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
    let toolEvidenceCollected = false;
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
      toolEvidenceCollected = true;

      output = await this.llm.complete([
        { role: "system", content: workerSystemPrompt(subtask, compactMemoriesForPrompt(memories), this.tools.list()) },
        {
          role: "user",
          content: buildWorkerUserPrompt(originalTask, collectedEvidence.text, dependencyContext, revisionInstructions),
        },
      ], { modelTier });
      // Phase 12 follow-up: when a coding subtask declared a file
      // artifact requirement but the worker only produced a fenced
      // markdown code block in its prose, auto-recover by saving the
      // code as the requested file so hard-gate review does not kill
      // an otherwise valid run.
      if (saveArtifact) {
        const recovered = await recoverCodeArtifactsFromWorkerOutput(
          output,
          subtask,
          collectedEvidence.artifacts,
          saveArtifact,
        );
        if (recovered.length > 0) {
          collectedEvidence.artifacts.push(...recovered);
          collectedEvidence.evidence.push(
            ...recovered.map((artifact) => `Recovered code artifact: ${artifact.filename}\n${artifact.url}`),
          );
        }
      }
    } catch (error) {
      if (
        toolEvidenceCollected &&
        collectedEvidence &&
        isRecoverableWorkerModelError(error) &&
        hasCollectedToolEvidence(collectedEvidence)
      ) {
        output = buildWorkerModelFailureFallbackOutput(subtask, collectedEvidence, error);
        const completedAt = new Date().toISOString();
        await emit({
          spanId: createSpanId(`worker-synthesis-degraded-${subtask.id}`),
          parentSpanId: spanId,
          type: "worker-synthesis-degraded",
          actor,
          activity: "llm",
          status: "completed",
          title: `Worker synthesis degraded: ${subtask.title}`,
          detail: formatErrorMessage(error),
          startedAt: startedAt.toISOString(),
          completedAt,
          durationMs: elapsedMs(startedAt),
          payload: {
            subtask,
            modelTier,
            dependencySpanIds,
            error: formatErrorMessage(error),
            evidencePreview: limitText(collectedEvidence.text, 2000),
            callFrame: completeCallFrame(callFrame, {
              status: "completed",
              completedAt,
              outputSummary: "Worker returned a degraded evidence handoff after model synthesis failed.",
            }),
          },
        });
      } else {
        const completedAt = new Date().toISOString();
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
          completedAt,
          durationMs: elapsedMs(startedAt),
          payload: {
            subtask,
            modelTier,
            dependencySpanIds,
            error: formatErrorMessage(error),
            evidencePreview: collectedEvidence ? limitText(collectedEvidence.text, 2000) : undefined,
            callFrame: completeCallFrame(callFrame, {
              status: "failed",
              completedAt,
              outputSummary: formatErrorMessage(error),
            }),
          },
        });
        throw error;
      }
    }

    const workerResult: WorkerResult = {
      subtask,
      output,
      toolEvidence: collectedEvidence.evidence,
      // Phase 28 follow-up — also publish the structured records so
      // reviewer + synthesizer can read `data.pageText` etc. without
      // depending on the LLM-lossy worker prose. Typed as `unknown[]`
      // in WorkerResult so types.ts doesn't depend on agent code; we
      // cast back when consuming.
      toolEvidenceRecords: collectedEvidence.records,
      artifacts: collectedEvidence.artifacts,
      traceSpanId: spanId,
      modelTier,
      dependencyContextSnapshot: dependencyContext,
    };
    const selfCheckStartedAt = new Date();
    const selfCheck = buildWorkerSelfCheck(workerResult, selfCheckStartedAt, this.tools.list());
    workerResult.selfCheck = selfCheck;
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
    // Phase 28 follow-up — collect a STRUCTURED record per tool
    // call alongside the legacy string evidence. Lets the worker
    // LLM (and reviewer + synthesizer) read the FULL tool data
    // (pageText, numericTokens, pageTitle) without the string
    // summarizer throwing it away. Local sink for this subtask;
    // we publish it through `CollectedToolEvidence.records` at
    // the bottom of this method and via the run-scoped store so
    // sibling subtasks can read each other's findings.
    const evidenceRecords: EvidenceRecord[] = [];
    const onEvidence = (record: EvidenceRecord) => {
      evidenceRecords.push(record);
    };
    if (
      Array.isArray(subtask.requiredTools) &&
      subtask.requiredTools.length === 0 &&
      Object.keys(subtask.toolInputs ?? {}).length === 0 &&
      (subtask.requiredArtifacts ?? []).length === 0
    ) {
      return {
        text: "No external tool evidence was collected for this subtask because its plan explicitly requires no tools.",
        evidence: [],
        records: [],
        artifacts: [],
      };
    }
    // Phase 13 follow-up (TB-005a/b): user-driven tool policy applies
    // here. `findByCapability("web-search", policy)` returns the
    // built-in `web.search` first if present, but a user instruction
    // like "use web.duckduckgo, don't use web.search" deletes the
    // built-in and promotes the user's preferred tool to [0].
    const webSearchPolicy = this.getToolPolicy(toolExecutionContext?.runId);
    const webSearch = this.tools.findByCapability("web-search", webSearchPolicy)[0];
    const webRead = this.tools.get("web.read") ?? this.tools.findByCapability("web-read")[0];
    const originalUserTask = stripRuntimeContext(originalTask);
    const toolNeedText = `${originalUserTask}\n${subtask.title}\n${subtask.role}\n${subtask.prompt}\n${subtask.expectedOutput}\n${subtask.reviewCriteria.join("\n")}`;

    const apiEvidence = await this.collectApiToolEvidence(
      subtask,
      toolNeedText,
      emit,
      parentSpanId,
      toolExecutionContext,
    );
    evidence.push(...apiEvidence.evidence);
    artifacts.push(...apiEvidence.artifacts);

    const webReadEvidence = await this.collectWebReadEvidence(
      webRead,
      subtask,
      toolNeedText,
      apiEvidence.evidence.length > 0,
      emit,
      parentSpanId,
      toolExecutionContext,
    );
    evidence.push(...webReadEvidence.evidence);
    artifacts.push(...webReadEvidence.artifacts);

    if (webSearch && shouldCollectWebSearch(subtask, toolNeedText, dependencyContext)) {
      evidence.push(await this.runWebSearch(webSearch, subtask, toolNeedText, emit, parentSpanId, toolExecutionContext, originalTask));
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

    const declaredToolEvidence = await this.collectDeclaredToolInputs(
      subtask,
      [dependencyContext, ...evidence].filter((item): item is string => Boolean(item)),
      // unused-positional-context — keep current API by attaching original
      // task on a new dedicated parameter just below; we use it inside
      // collectDeclaredToolInputs to gate planner-injected text commands.
      originalTask,
      emit,
      parentSpanId,
      saveArtifact,
      toolExecutionContext,
    );
    evidence.push(...declaredToolEvidence.evidence);
    artifacts.push(...declaredToolEvidence.artifacts);

    const canPrepareExternalAction = subtaskCanPrepareExternalAction(subtask);
    const interactiveProofRequired = subtaskExpectsInteractiveBrowserProof(subtask);
    const hasCurrentInteractiveProof = declaredToolEvidence.artifacts.some((artifact) =>
      subtask.requiredArtifacts?.some((requirement) => artifactMatchesRequirement(artifact, requirement)),
    );
    if (canPrepareExternalAction && interactiveProofRequired && !hasCurrentInteractiveProof) {
      evidence.push(
        "external.action.prepare skipped: interactive browser preparation did not produce a QA-passed proof artifact. Retry a different provider/action URL before creating an approval draft.",
      );
    } else if (canPrepareExternalAction) {
      const externalActionEvidence = await this.collectExternalActionPrepareEvidence(
        originalUserTask,
        subtask,
        toolNeedText,
        [dependencyContext, ...evidence].filter((item): item is string => Boolean(item)),
        emit,
        parentSpanId,
        toolExecutionContext,
      );
      evidence.push(...externalActionEvidence.evidence);
      artifacts.push(...externalActionEvidence.artifacts);
    }

    for (const requirement of subtask.requiredArtifacts ?? []) {
      if (requirement.required === false) continue;
      const needsInteractiveProof =
        (requirement.kind === "screenshot" || requirement.capability === "browser-screenshot") &&
        subtaskExpectsInteractiveBrowserProof(subtask);

      const alreadyCreatedArtifact = artifacts.find((artifact) => artifactMatchesRequirement(artifact, requirement));
      if (alreadyCreatedArtifact) {
        evidence.push(
          `Current subtask artifact satisfies ${requirement.kind}: ${alreadyCreatedArtifact.filename}\n${alreadyCreatedArtifact.url}`,
        );
        continue;
      }

      const inheritedArtifact = dependencyArtifacts.find((artifact) => artifactMatchesRequirement(artifact, requirement));
      if (inheritedArtifact && !needsInteractiveProof) {
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
        onEvidence,
      );

      if (artifact) {
        artifacts.push(artifact);
        evidence.push(`Created artifact for ${requirement.kind}: ${artifact.filename}\n${artifact.url}`);
      }
    }

    if (evidence.length === 0 && evidenceRecords.length === 0) {
      return {
        text: "No external tool evidence was collected for this subtask.",
        evidence: [],
        records: [],
        artifacts: [],
      };
    }

    // Phase 28 follow-up — when we have structured records, prefer
    // them in the prompt text. The recordRendering carries pageText,
    // numericTokens, pageTitle, etc. — the data the model actually
    // needs to answer the user. We still keep the legacy `evidence`
    // string array attached for backward-compatible consumers (notes,
    // self-checks) that haven't migrated yet.
    const recordText = formatEvidenceRecordsForPrompt(evidenceRecords, promptBudget.toolEvidenceChars);
    const legacyText = summarizeEvidenceList(evidence, promptBudget.toolEvidenceChars);
    const composedText = [recordText, legacyText].filter(Boolean).join("\n\n");
    return {
      text: composedText
        ? `External tool evidence collected for this subtask:\n${composedText}`
        : "External tool evidence collected for this subtask:\n(empty)",
      evidence: evidence.map((item) => limitText(item, promptBudget.toolEvidenceChars)),
      records: evidenceRecords,
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
    originalTask: string = "",
  ): Promise<string> {
    const spanId = createSpanId(`tool-${webSearch.name}`);
    const startedAt = new Date();
    const searchIntents = this.resolveTaskIntents(
      `${subtask.title}\n${subtask.prompt}\n${contextText}`,
      toolExecutionContext?.runId,
    );
    const explicitSearchQuery = getExplicitToolInputString(subtask, "web.search", "query");
    const queries = explicitSearchQuery
      ? [explicitSearchQuery]
      : buildSearchQueries(subtask, `${contextText}\n${originalTask}`, searchIntents);
    // Phase 12 follow-up: pre-call ungrounded-specifics gate. The
    // planner sometimes writes hallucinated brand/model tokens
    // ("RTX 4080 with 12GB VRAM") into `subtask.prompt`, and they
    // propagate into the search query. That biases the entire run
    // toward the hallucination — every tool call is now anchored to a
    // token the user never asked for. Strip those tokens BEFORE the
    // call so the search reflects the user's task, not the planner's
    // guess. Grounding source is the original user task only — the
    // planner's prompt is exactly what we are policing.
    const executableQueries = uniqueStrings(
      queries
        .map((candidate) => guardSearchQueryAgainstUngroundedSpecifics(candidate, originalTask) || candidate)
        .map((candidate) => cleanSearchQuery(candidate))
        .filter(Boolean),
    ).slice(0, 3);
    const query = executableQueries.join(" | ");
    const searchEvidenceQualityVersion = 2;
    const marketHints = inferMarketSearchHints(`${query}\n${originalTask}\n${contextText}`);

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
        // Phase 28 follow-up — let the WorkLedger allow retries
        // after a prior failure (DDG transient "No results", network
        // blip). The trigger word "retry" tells `decideWorkReuse` to
        // skip the 30-minute blocked-by-recent-failure window.
        reason: `retry search via ${webSearch.name}`,
        metadata: {
          tool: webSearch.name,
          role: subtask.role,
          evidenceQualityVersion: searchEvidenceQualityVersion,
          marketHints,
          queryCount: executableQueries.length,
        },
      },
      parentSpanId,
    );
    if (claim?.decision.status === "reuse_completed" && claim.item.outputSummary) {
      // Phase 28 follow-up — only reuse a prior search summary if it
      // ACTUALLY contains usable evidence (at least one http(s) or
      // percent-encoded https URL the downstream screenshot pipeline
      // can extract). Old completions written before mergeToolResults
      // started surfacing URL lines into `content` left the
      // outputSummary URL-less; reusing them poisoned every retry
      // with empty evidence even after the underlying tool was fixed.
      const summary = claim.item.outputSummary;
      const hasUsableUrl = /https?:\/\//i.test(summary) || /https?%3A%2F%2F/i.test(summary);
      if (hasUsableUrl) {
        ledger?.trackWhatWorked(`Reused web search evidence for "${query.slice(0, 80)}"`);
        return `External tool evidence from ${webSearch.name} (reused via Work Ledger ${claim.item.id}):\n${limitText(summary, promptBudget.toolEvidenceChars)}`;
      }
      // Otherwise fall through to a fresh attempt below — the cached
      // entry is too thin to feed the screenshot pipeline.
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
      executableQueries.map((candidate) =>
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
        const searchEvidenceQuality = assessSearchEvidenceForReuse(result.content, query);
        await ledger?.markCompleted(claim.item.id, {
          outputSummary: limitText(result.content, 4_000),
          sourceUrls: searchEvidenceQuality.sourceUrls,
          confidence: searchEvidenceQuality.confidence,
          metadata: {
            evidenceQualityVersion: searchEvidenceQualityVersion,
            marketHints,
            queryCount: executableQueries.length,
            distinctSourceCount: searchEvidenceQuality.distinctSourceCount,
          },
        });
        ledger?.trackWhatWorked(`Web search returned evidence for "${query.slice(0, 80)}"`);
        await ledger?.recordEvidence(
          {
            kind: "search_result",
            title: `Web search: ${query.slice(0, 96)}`,
            summary: limitText(result.content, 600),
            contentPreview: limitText(result.content, 2_000),
            sourceUrl: searchEvidenceQuality.sourceUrls[0],
            provider: webSearch.name,
            toolName: webSearch.name,
            workItemId: claim.item.id,
            qaStatus: searchEvidenceQuality.qaStatus,
            confidence: searchEvidenceQuality.confidence,
            limitations: searchEvidenceQuality.limitations,
            metadata: {
              query,
              role: subtask.role,
              sourceCount: searchEvidenceQuality.sourceUrls.length,
              distinctSourceCount: searchEvidenceQuality.distinctSourceCount,
            },
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

  private async collectWebReadEvidence(
    webRead: Tool | undefined,
    subtask: Subtask,
    text: string,
    apiEvidenceCollected: boolean,
    emit: AgentEventEmitter,
    parentSpanId: string,
    toolExecutionContext?: BaseToolExecutionContext,
  ): Promise<CollectedToolEvidence> {
    if (apiEvidenceCollected && shouldPreferHttpRequestForUrls(subtask, text)) {
      return {
        text: "Skipped web.read because the explicit URL was handled as an HTTP/API request.",
        evidence: [],
        artifacts: [],
      };
    }
    if (!webRead || !shouldCollectWebRead(subtask, text)) {
      return { text: "No explicit URL page-read evidence was needed.", evidence: [], artifacts: [] };
    }

    const urls = extractHttpUrls(text).slice(0, requiresMultipleSources(subtask) ? 3 : 2);
    const evidence: string[] = [];

    for (const url of urls) {
      const { result } = await this.runLedgeredToolOperation({
        tool: webRead,
        input: { url, format: "text", maxBytes: 250_000 },
        capability: "web-read",
        caller: `worker:${subtask.role}`,
        detail: `Read explicit URL: ${url}`,
        emit,
        parentSpanId,
        toolExecutionContext,
        workKind: "data_fetch",
        evidenceKind: "source_url",
        metadata: { role: subtask.role, url, inferred: true, source: "explicit-url" },
        reuseCompletedOutput: true,
      });
      evidence.push(formatDeclaredToolEvidence(webRead.name, result, []));
    }

    return {
      text: evidence.length > 0 ? evidence.join("\n\n") : "No explicit URL page-read evidence was collected.",
      evidence,
      artifacts: [],
    };
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
      const detail = `${request.symbol}/${request.vsCurrency} for ${request.days} day(s)`;
      const { result, spanId } = await this.runLedgeredToolOperation({
        tool: marketTool,
        input: request,
        capability: "market-timeseries",
        caller: "worker",
        detail,
        emit,
        parentSpanId,
        toolExecutionContext,
        workKind: "api_call",
        evidenceKind: "api_response",
        metadata: { symbol: request.symbol, vsCurrency: request.vsCurrency, days: request.days },
        reuseCompletedOutput: true,
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
      .list()
      .filter((tool) =>
        tool.capabilities.some((capability) =>
          ["api-http-json", "http-request", "api-client", "json-api", "webhook-client"].includes(capability),
        ),
      )
      .filter((tool) => !declaredToolNames.has(tool.name));

    for (const tool of apiTools) {
      const input = inferApiToolInput(tool, text);
      if (!input) continue;

      const { result } = await this.runLedgeredToolOperation({
        tool,
        input,
        capability: tool.capabilities[0] ?? "api-http-json",
        caller: `worker:${subtask.role}`,
        detail: summarizeToolInput(input),
        emit,
        parentSpanId,
        toolExecutionContext,
        workKind: "api_call",
        evidenceKind: "api_response",
        metadata: { role: subtask.role, inferred: true },
        reuseCompletedOutput: true,
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
    if (isLocalUtilityToolchainSubtask(subtask)) {
      return { text: "No browser discovery evidence was needed for local toolchain execution.", evidence: [], artifacts: [] };
    }
    const discoveryIntents = this.resolveTaskIntents(
      `${subtask.title}\n${subtask.prompt}\n${text}`,
      toolExecutionContext?.runId,
    );
    if (alreadyDeclared || !shouldCollectBrowserDiscovery(subtask, text, discoveryIntents)) {
      return { text: "No browser discovery evidence was needed.", evidence: [], artifacts: [] };
    }

    if (!(this.tools.get("browser.operate") ?? this.tools.findByCapability("browser-operate")[0])) {
      return { text: "No browser discovery tool is registered.", evidence: [], artifacts: [] };
    }
    const extraPatterns = await this.resolveEvidencePatterns(discoveryIntents);
    const limit = requiresMultipleSources(subtask) ? 3 : 2;
    // Phase 12 follow-up: the LLM URL ranker is the primary mechanism. We
    // prefer pattern-scored URLs when any are available (built-in seed +
    // tool contracts + memory entries cover known intents like flight
    // search), but for the long tail where no pattern matches we hand
    // every non-low-value URL to the ranker so the model decides which
    // candidate snippet actually answers the subtask. This removes the
    // need to seed every domain in the runtime — the LLM's world
    // knowledge fills the gap.
    const evidenceText = priorEvidence.join("\n\n");
    const scoredCandidates = selectBestUrlsForArtifact(
      evidenceText,
      Math.max(limit * 2, 6),
      discoveryIntents,
      extraPatterns,
      [],
      `${subtask.title}\n${subtask.prompt}\n${text}`,
    );
    const unfilteredCandidatePool =
      scoredCandidates.length > 0
        ? scoredCandidates
        : extractHttpUrls(evidenceText)
            .filter((url) => !isLowValueProofUrl(url))
            .slice(0, 8);
    const anchorTerms = extractGeographicAnchorTerms(text);
    const anchoredCandidatePool =
      anchorTerms.length > 0
        ? unfilteredCandidatePool.filter((url) => evidenceUrlMatchesAnchor(evidenceText, url, anchorTerms))
        : unfilteredCandidatePool;
    const candidatePool = anchoredCandidatePool.length > 0 ? anchoredCandidatePool : unfilteredCandidatePool;
    if (candidatePool.length === 0) {
      return { text: "No browser discovery URLs were available.", evidence: [], artifacts: [] };
    }
    const ranked = await rankDiscoveryUrls(
      {
        subtask: { title: subtask.title, prompt: subtask.prompt },
        candidateUrls: candidatePool,
        candidateContext: evidenceText.slice(0, 6_000),
        intents: discoveryIntents,
        limit,
      },
      {
        llm: this.llm,
        // When there were scored candidates, the heuristic fallback is
        // those (intent-relevant). When candidates came from the
        // unscored-but-non-low-value pool, the ONLY safe fallback is to
        // skip discovery entirely — the model's veto is what kept us
        // from attaching arxiv.org / sss.gov screenshots in the first
        // place.
        fallback: (cap) => (scoredCandidates.length > 0 ? scoredCandidates.slice(0, cap) : []),
      },
    );
    const urls =
      ranked.selected.length > 0
        ? ranked.selected
        : scoredCandidates.length > 0
        ? scoredCandidates.slice(0, limit)
        : [];
    if (urls.length === 0) {
      await emit({
        spanId: createSpanId("discovery-url-ranked"),
        parentSpanId,
        type: "discovery-url-ranked",
        actor: "discovery-url-ranker",
        activity: "agent",
        status: "completed",
        title: "Discovery URL ranking",
        detail: `${ranked.source === "llm" ? "LLM" : "Heuristic"} found no relevant URL among ${candidatePool.length} candidates${ranked.reason ? ` (${ranked.reason})` : ""}`,
        payload: {
          source: ranked.source,
          intents: discoveryIntents,
          selected: [],
          rejected: ranked.rejected,
          reason: ranked.reason,
        },
      });
      return { text: "No browser discovery URLs were available.", evidence: [], artifacts: [] };
    }
    await emit({
      spanId: createSpanId("discovery-url-ranked"),
      parentSpanId,
      type: "discovery-url-ranked",
      actor: "discovery-url-ranker",
      activity: "agent",
      status: "completed",
      title: "Discovery URL ranking",
      detail:
        ranked.source === "llm"
          ? `LLM picked ${urls.length} of ${candidatePool.length} candidates`
          : `Heuristic picked ${urls.length} of ${candidatePool.length} candidates${ranked.reason ? ` (${ranked.reason})` : ""}`,
      payload: {
        source: ranked.source,
        intents: discoveryIntents,
        selected: urls,
        rejected: ranked.rejected,
        reason: ranked.reason,
      },
    });

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
              // Phase 12 follow-up: cap discovery screenshots to a screen-
              // friendly height so the artifact viewer renders a useful
              // image instead of an endless scroll.
              { type: "screenshot", label, fullPage: true, maxHeight: 3200 },
            ];
          }),
        },
      },
    };

    return this.collectDeclaredToolInputs(
      syntheticSubtask,
      priorEvidence,
      // Synthetic browser-discovery commands are built from already-ranked
      // search-evidence URLs; the ungrounded-specifics guard would be a
      // no-op here and we don't have the original task at this layer.
      "",
      emit,
      parentSpanId,
      saveArtifact,
      toolExecutionContext,
    );
  }

  private async collectDeclaredToolInputs(
    subtask: Subtask,
    priorEvidence: string[],
    originalTask: string,
    emit: AgentEventEmitter,
    parentSpanId: string,
    saveArtifact?: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>,
    toolExecutionContext?: BaseToolExecutionContext,
  ): Promise<CollectedToolEvidence> {
    const entries = Object.entries(subtask.toolInputs ?? {}).filter(([toolName]) => toolName !== "web.search");
    const evidence: string[] = [];
    const artifacts: AgentArtifact[] = [];
    const declaredIntents = this.resolveTaskIntents(
      `${subtask.title}\n${subtask.prompt}`,
      toolExecutionContext?.runId,
    );
    const declaredExtraPatterns = await this.resolveEvidencePatterns(declaredIntents);

    for (const [toolName, input] of entries) {
      const tool = this.tools.get(toolName) ?? this.tools.findByCapability(toolName)[0];
      if (!tool) {
        evidence.push(`Declared tool ${toolName} is not registered.`);
        continue;
      }
      // Phase 12 follow-up: pre-call ungrounded gate on declared tool
      // input. The planner sometimes embeds hallucinated specifics into
      // browser `type` commands ("RTX 4080 32GB RAM") which then drives
      // the rest of the run toward the hallucination. Strip those tokens
      // from any string-bearing field before the structural URL rewrite
      // takes over. Original user task is the grounding source — anything
      // the planner added that is not in the task is treated as injected.
      const guardedInput = guardDeclaredToolInputAgainstUngroundedSpecifics(input, originalTask);
      const runnableInput = improveDeclaredToolInput(
        tool.name,
        guardedInput,
        subtask,
        priorEvidence,
        declaredExtraPatterns,
        declaredIntents,
      );
      if (tool.name === "browser.operate" && hasInvalidBrowserNavigation(runnableInput, subtask)) {
        evidence.push(
          `Declared browser.operate input was skipped because it contains a placeholder or invalid navigation URL. Use real http(s) source URLs from previous evidence before running browser automation.`,
        );
        continue;
      }

      const rawRecord = isRecord(input) ? input : {};
      const guardedRecord = isRecord(guardedInput) ? guardedInput : {};
      const runnableRecord = isRecord(runnableInput) ? runnableInput : {};
      const browserOperateScope =
        tool.name === "browser.operate"
          ? isInteractiveBrowserOperateInput(rawRecord) ||
            isInteractiveBrowserOperateInput(guardedRecord) ||
            isInteractiveBrowserOperateInput(runnableRecord)
            ? "attempt"
            : "run"
          : undefined;
      const operation = await this.runLedgeredToolOperation({
        tool,
        input: runnableRecord,
        capability: toolName,
        caller: `worker:${subtask.role}`,
        detail: summarizeToolInput(runnableInput),
        emit,
        parentSpanId,
        toolExecutionContext,
        metadata: { role: subtask.role, declaredToolName: toolName },
        // Browser state is not a pure data fetch. Static read/screenshot
        // discovery can reuse only within the current run; interactive
        // form/navigation attempts must execute freshly so a later booking
        // run never inherits stale page state or an old screenshot.
        reuseCompletedOutput: tool.name !== "browser.operate" || browserOperateScope === "run",
        workKeyScope: browserOperateScope,
        recordLedgerOutcome: tool.name !== "browser.operate",
      });
      const { result, spanId, claim } = operation;

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
            const candidateUrls = extractExternalActionCandidateLinksFromBrowserData(result.data);
            const rejectionEvidence = [
              `Rejected screenshot artifact ${artifactInput.filename}: ${artifactQa.reason}`,
              result.data.finalUrl ? `Rejected browser URL: ${result.data.finalUrl}` : "",
              result.data.title ? `Rejected browser title: ${result.data.title}` : "",
              ...candidateUrls.map((url) => `Candidate action URL from rejected page: ${url}`),
            ].filter(Boolean).join("\n");
            evidence.push(
              rejectionEvidence,
            );
            const artifactRejectedSpanId = createSpanId("artifact-rejected");
            await emit({
              spanId: artifactRejectedSpanId,
              parentSpanId: spanId,
              type: "artifact-created",
              actor: "artifact:browser",
              activity: "tool",
              status: "failed",
              title: "Browser artifact rejected by semantic QA",
              detail: rejectionEvidence,
              startedAt: artifactStartedAt.toISOString(),
              completedAt: new Date().toISOString(),
              durationMs: elapsedMs(artifactStartedAt),
              payload: {
                artifact: sanitizeArtifactInput(artifactInput),
                artifactQa,
                finalUrl: result.data.finalUrl,
                title: result.data.title,
                rejectionEvidence,
              },
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

      if (tool.name === "browser.operate" && claim && !operation.reused) {
        // Phase 13 follow-up: skip the manual ledger.markCompleted /
        // markFailed dance when this claim was satisfied by a reused
        // prior result — the original entry is already terminal, and
        // the reused branch carries no fresh `result.data` to QA.
        const ledger = this.resolveLedgerFromContext(toolExecutionContext);
        if (!result.ok) {
          await ledger?.markFailed(claim.item.id, limitText(result.content, 600));
          ledger?.trackWhatFailed(`Declared browser.operate failed for ${subtask.title}`);
          ledger?.trackWeakTool(tool.name);
          await ledger?.recordEvidence(
            {
              kind: "limitation",
              title: "Declared browser.operate failed",
              summary: limitText(result.content, 600),
              toolName: tool.name,
              workItemId: claim.item.id,
              qaStatus: "failed",
              limitations: ["browser.operate returned a non-OK result."],
              metadata: { capability: toolName, role: subtask.role },
            },
            parentSpanId,
          );
        } else if (isBrowserOperateData(result.data) && result.data.screenshots.length > 0 && savedArtifacts.length === 0) {
          await ledger?.markFailed(claim.item.id, "All browser screenshots were rejected by semantic artifact QA.");
          ledger?.trackWhatFailed(`Declared browser.operate screenshots were rejected for ${subtask.title}`);
          ledger?.trackWeakTool(tool.name);
          await ledger?.recordEvidence(
            {
              kind: "limitation",
              title: "Declared browser screenshots rejected",
              summary: "All browser screenshots were rejected by semantic artifact QA.",
              toolName: tool.name,
              workItemId: claim.item.id,
              qaStatus: "failed",
              limitations: ["Screenshot outputs did not satisfy semantic artifact QA."],
              metadata: { capability: toolName, role: subtask.role },
            },
            parentSpanId,
          );
        } else {
          await ledger?.markCompleted(claim.item.id, {
            outputSummary: limitText(formatDeclaredToolEvidence(tool.name, result, savedArtifacts), 4_000),
          });
          ledger?.trackWhatWorked(`Declared browser.operate returned usable evidence for ${subtask.title}`);
          await ledger?.recordEvidence(
            {
              kind: savedArtifacts.length > 0 ? "screenshot" : "browser_snapshot",
              title: `browser.operate evidence: ${subtask.title}`,
              summary: limitText(result.content, 600),
              contentPreview: limitText(result.content, 2_000),
              toolName: tool.name,
              workItemId: claim.item.id,
              artifactId: savedArtifacts[0]?.id,
              qaStatus: savedArtifacts.length > 0 ? "passed" : "unchecked",
              metadata: { capability: toolName, role: subtask.role, artifactCount: savedArtifacts.length },
            },
            parentSpanId,
          );
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

  private async collectExternalActionPrepareEvidence(
    originalTask: string,
    subtask: Subtask,
    text: string,
    priorEvidence: string[],
    emit: AgentEventEmitter,
    parentSpanId: string,
    toolExecutionContext?: BaseToolExecutionContext,
  ): Promise<CollectedToolEvidence> {
    const declaredToolNames = new Set(Object.keys(subtask.toolInputs ?? {}).map((name) => name.toLowerCase()));
    if (declaredToolNames.has("external.action.prepare") || declaredToolNames.has("external-action-prepare")) {
      return { text: "external.action.prepare was already declared.", evidence: [], artifacts: [] };
    }

    if (!shouldPrepareExternalAction(subtask, text)) {
      return { text: "No external action preparation was needed.", evidence: [], artifacts: [] };
    }

    const tool = this.tools.get("external.action.prepare") ?? this.tools.findByCapability("external-action-prepare")[0];
    if (!tool) {
      return {
        text: "external.action.prepare is not registered.",
        evidence: ["external.action.prepare is not registered."],
        artifacts: [],
      };
    }

    const evidenceText = priorEvidence.join("\n\n");
    const blocker = detectExternalActionPreparationBlocker(evidenceText);
    if (blocker) {
      const message =
        `external.action.prepare skipped: ${blocker}. ` +
        "This is not approval-ready; report the blocker or retry another concrete provider/action URL before asking for approval.";
      return {
        text: message,
        evidence: [message],
        artifacts: [],
      };
    }

    const input = buildExternalActionPrepareInput(originalTask, subtask, text, evidenceText);
    const { result } = await this.runLedgeredToolOperation({
      tool,
      input,
      capability: "external-action-prepare",
      caller: `worker:${subtask.role}`,
      detail: summarizeToolInput(input),
      emit,
      parentSpanId,
      toolExecutionContext,
      workKind: "tool_call",
      evidenceKind: "other",
      metadata: { role: subtask.role, inferred: true, boundary: "prepare" },
      // External-action drafts are approval state, not reusable data.
      // Reusing an older draft can attach a stale/failed browser proof to a
      // new run after the current preparation evidence changed.
      reuseCompletedOutput: false,
      workKeyScope: "run",
    });

    return {
      text: formatDeclaredToolEvidence(tool.name, result, []),
      evidence: [formatDeclaredToolEvidence(tool.name, result, [])],
      artifacts: [],
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
    // Phase 28 follow-up — structured evidence sink (propagated
    // from `collectSubtaskEvidence`). When the chosen artifact
    // path is a tool call, this captures the FULL tool output
    // including `data.pageText / numericTokens / pageTitle` so
    // the worker LLM can read it. See `EvidenceRecord` type and
    // `formatEvidenceRecordsForPrompt` for the consumer side.
    onEvidence?: (record: EvidenceRecord) => void,
  ): Promise<AgentArtifact | undefined> {
    if (!saveArtifact) return undefined;

    if (requirement.kind === "screenshot" || requirement.capability === "browser-screenshot") {
      if (subtaskExpectsInteractiveBrowserProof(subtask)) {
        await emit({
          spanId: createSpanId("interactive-proof-missing"),
          parentSpanId,
          type: "tool-missing",
          actor: "screenshot-artifact",
          activity: "tool",
          status: "failed",
          title: "Interactive proof skipped: no prepared browser session",
          detail:
            "This subtask needs proof of a prepared interactive action (filled form, selected appointment, or pre-submit state). " +
            "A generic screenshot of a source URL is not valid proof for that requirement; the proof must come from browser.operate after the interactive steps succeed.",
          payload: {
            capability: "browser-screenshot",
            reason: "interactive-proof-requires-browser-operate-session",
            requirement,
            subtask: {
              id: subtask.id,
              title: subtask.title,
              requiredTools: subtask.requiredTools,
            },
          },
        });
        return undefined;
      }
      return this.createScreenshotArtifact(
        [dependencyContext, evidence.join("\n\n"), subtask.prompt, originalTask].filter(Boolean).join("\n\n"),
        emit,
        parentSpanId,
        saveArtifact,
        requestToolBuild,
        improveTool,
        toolExecutionContext,
        onEvidence,
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

    const revisionDependencyArtifacts = [...dependencyArtifacts];
    pushUniqueArtifacts(revisionDependencyArtifacts, workerResult.artifacts ?? []);
    const revisionDependencyContext = [
      dependencyContext,
      "Previous failed attempt tool evidence:",
      ...(workerResult.toolEvidence ?? []),
      "Previous review notes:",
      review.notes,
    ].filter(Boolean).join("\n\n");
    const revisedWorkerResult = await this.runWorker(
      originalTask,
      complexity,
      subtask,
      memories,
      emit,
      workerResult.traceSpanId ?? parentSpanId,
      revisionDependencyContext,
      dependencySpanIds,
      revisionDependencyArtifacts,
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
    // Phase 28 follow-up — when supplied, structured records for
    // the screenshot.url call AND the saved artifact land here so
    // the parent worker can surface data.pageText / numericTokens /
    // pageTitle to its LLM (and reviewer), not just the artifact URL.
    onEvidence?: (record: EvidenceRecord) => void,
  ): Promise<AgentArtifact | undefined> {
    const screenshotIntents = this.resolveTaskIntents(context, toolExecutionContext?.runId);
    const screenshotPatterns = await this.resolveEvidencePatterns(screenshotIntents);

    // Phase 13 follow-up: when the user asks for "a screenshot proof" of
    // information already established earlier in the same conversation
    // thread, the prior turn typically saved one or more PNG artifacts.
    // Reusing them is strictly better than spawning yet another browser
    // navigation (no extra time, no extra LLM tokens, no risk of a
    // different page state). Only when none of the thread artifacts look
    // like a usable screenshot do we fall through to the original
    // capture-or-skip path.
    const threadArtifacts = toolExecutionContext?.runId
      ? this.runScopedThreadArtifacts.get(toolExecutionContext.runId) ?? []
      : [];
    const reusable = pickReusableThreadScreenshot(threadArtifacts, context, screenshotIntents);
    if (reusable) {
      await emit({
        spanId: createSpanId("screenshot-thread-reuse"),
        parentSpanId,
        type: "artifact-created",
        actor: "screenshot-artifact",
        activity: "tool",
        status: "completed",
        title: "Screenshot proof reused from thread",
        detail:
          `Reused existing thread artifact ${reusable.id} (${reusable.filename ?? "<unnamed>"}) ` +
          "instead of capturing a new screenshot. The capture tool was not invoked.",
        payload: {
          capability: "browser-screenshot",
          reused: true,
          artifactId: reusable.id,
          filename: reusable.filename,
          intents: screenshotIntents,
        },
      });
      return reusable;
    }

    const url = selectBestUrlForArtifact(context, screenshotIntents, screenshotPatterns);
    if (!url) {
      // Phase 12 follow-up: this is a MISSING INPUT, not a missing capability.
      // The screenshot tool already exists (`browser.operate` + any registered
      // `browser-screenshot` provider) — we just have no URL to feed it. Do
      // NOT queue a tool build (which would generate yet another redundant
      // browser-screenshot tool). Emit a structured failure that the
      // reviewer will treat as `needs_revision`, and the next worker
      // iteration can either find a URL or skip the screenshot.
      await emit({
        spanId: createSpanId("screenshot-input-missing"),
        parentSpanId,
        type: "tool-missing",
        actor: "screenshot-artifact",
        activity: "tool",
        status: "failed",
        title: "Screenshot proof skipped: no source URL",
        detail:
          "Cannot capture a screenshot artifact because no http(s) source URL was found in the task, " +
          "dependency outputs, or upstream evidence. The screenshot tool itself is available — only the " +
          "input data is missing. The worker should produce a real source URL via web.search or " +
          "browser.operate evidence, or drop the screenshot requirement if the task doesn't need it.",
        payload: {
          capability: "browser-screenshot",
          reason: "input-missing-source-url",
          intents: screenshotIntents,
        },
      });
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
        undefined,
        onEvidence,
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
      (data) => {
        // Phase 28 follow-up — accept both the canonical
        // `{artifact: {filename, mimeType, contentBase64}}` shape
        // and the simpler `{imageBase64}` / `{image}` / `{contentBase64}`
        // shape that council-built screenshot tools emit. Derive the
        // canonical AgentArtifact record from whatever's there.
        const dAny = data as unknown as {
          artifact?: { filename?: string; mimeType?: string; contentBase64?: string; description?: string };
          imageBase64?: string;
          image?: string;
          contentBase64?: string;
        };
        if (dAny.artifact && typeof dAny.artifact === "object" && dAny.artifact.contentBase64) {
          return {
            filename: dAny.artifact.filename ?? "screenshot.png",
            mimeType: dAny.artifact.mimeType ?? "image/png",
            content: Buffer.from(dAny.artifact.contentBase64, "base64"),
            description: dAny.artifact.description,
          };
        }
        const base64 = dAny.imageBase64 ?? dAny.image ?? dAny.contentBase64 ?? "";
        // Derive a sensible filename from the URL host + path so the
        // Tools page + artifact viewer pick the right alt text.
        const slug = (() => {
          try {
            const parsed = new URL(url);
            const host = parsed.hostname.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
            const path = parsed.pathname.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 60).replace(/^-+|-+$/g, "");
            return `${host}${path ? `-${path}` : ""}`.slice(0, 90) || "screenshot";
          } catch {
            return "screenshot";
          }
        })();
        return {
          filename: `${slug}.png`,
          mimeType: "image/png",
          content: Buffer.from(base64, "base64"),
          description: `Screenshot captured from ${url}`,
        };
      },
      "artifact:screenshot",
      "Screenshot artifact generated",
      toolExecutionContext,
      requestToolBuild,
      improveTool,
      undefined,
      onEvidence,
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
    const envelope = this.maybeIssueCallbackEnvelope(tool.name, baseContext?.runId);
    return this.tools.execute(tool, input, {
      ...(baseContext ?? {}),
      ...spanContext,
      now: new Date(),
      ...(envelope ? { callback: envelope } : {}),
    });
  }

  /**
   * Phase 13: build a per-call callback envelope for the tool when
   * the runtime knows where it lives (`callbackBaseUrl`) and has an
   * issuer wired. The token is scoped to (runId, toolName) and the
   * default scope grants the four callback verbs the SDK exposes.
   * Returns undefined when callbacks are not configured (CLI, tests)
   * or when there is no run id to scope to (one-off invocations).
   */
  private maybeIssueCallbackEnvelope(
    toolName: string,
    runId: string | undefined,
  ): { baseUrl: string; token: string; scope: string[] } | undefined {
    if (!this.callbackIssuer || !this.callbackBaseUrl) return undefined;
    if (!runId) return undefined;
    const scope = [...this.callbackDefaultScope];
    const token = this.callbackIssuer.issue({ runId, toolName, scope });
    return { baseUrl: this.callbackBaseUrl, token, scope };
  }

  private async runLedgeredToolOperation(
    options: {
      tool: Tool;
      input: Record<string, unknown>;
      capability: string;
      caller: string;
      detail: string;
      emit: AgentEventEmitter;
      parentSpanId: string;
      toolExecutionContext?: BaseToolExecutionContext;
      workKind?: WorkLedgerKind;
      workKey?: string;
      workTitle?: string;
      evidenceKind?: EvidenceKind;
      metadata?: Record<string, unknown>;
      reuseCompletedOutput?: boolean;
      recordLedgerOutcome?: boolean;
      workKeyScope?: "global" | "run" | "attempt";
    },
  ): Promise<{
    result: ToolResult;
    spanId: string;
    startedAt: Date;
    claim?: Awaited<ReturnType<RuntimeLedgerCoordinator["claim"]>>;
    reused: boolean;
  }> {
    const spanId = createSpanId(`tool-${options.tool.name}`);
    const startedAt = new Date();
    const ledger = this.resolveLedgerFromContext(options.toolExecutionContext);
    const workKind = options.workKind ?? workLedgerKindForTool(options.tool, options.capability);
    const baseWorkKey = options.workKey ?? workKeyForLedgeredTool(options.tool, options.capability, options.input);
    const workKey = scopedToolWorkKey(baseWorkKey, options.workKeyScope, {
      runId: options.toolExecutionContext?.runId,
      spanId,
    });
    const claim = await ledger?.claim(
      {
        kind: workKind,
        workKey,
        title: options.workTitle ?? `Tool call: ${options.tool.name}`,
        ownerSpanId: spanId,
        inputSummary: limitText(options.detail, 600),
        metadata: {
          capability: options.capability,
          tool: options.tool.name,
          caller: options.caller,
          ...(options.metadata ?? {}),
        },
      },
      options.parentSpanId,
    );

    if (options.reuseCompletedOutput && claim?.decision.status === "reuse_completed" && claim.item.outputSummary) {
      ledger?.trackWhatWorked(`Reused ${options.tool.name} evidence for ${options.capability}`);
      return {
        spanId,
        startedAt,
        claim,
        reused: true,
        result: {
          ok: true,
          content: `Reused Work Ledger evidence from ${claim.item.id}:\n${limitText(
            claim.item.outputSummary,
            promptBudget.toolEvidenceChars,
          )}`,
        },
      };
    }

    await options.emit({
      spanId,
      parentSpanId: options.parentSpanId,
      type: "tool-started",
      actor: options.tool.name,
      activity: "tool",
      status: "started",
      title: `Tool: ${options.tool.name}`,
      detail: options.detail,
      startedAt: startedAt.toISOString(),
      payload: {
        tool: options.tool.name,
        capability: options.capability,
        input: sanitizeToolPayload(options.input),
        workItemId: claim?.item.id,
      },
    });

    const result = await this.executeTool(options.tool, options.input, options.toolExecutionContext, {
      spanId,
      parentSpanId: options.parentSpanId,
      capability: options.capability,
      caller: options.caller,
    });

    await options.emit({
      spanId,
      parentSpanId: options.parentSpanId,
      type: "tool-completed",
      actor: options.tool.name,
      activity: "tool",
      status: result.ok ? "completed" : "failed",
      title: `Tool: ${options.tool.name}`,
      detail: result.content,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(startedAt),
      payload: sanitizeToolPayload(result),
    });

    if (claim && options.recordLedgerOutcome !== false) {
      if (result.ok) {
        await ledger?.markCompleted(claim.item.id, {
          outputSummary: limitText(result.content, 4_000),
        });
        ledger?.trackWhatWorked(`${options.tool.name} returned evidence for ${options.capability}`);
        await ledger?.recordEvidence(
          {
            kind: options.evidenceKind ?? evidenceKindForLedgeredTool(options.tool, options.capability),
            title: `${options.tool.name}: ${options.capability}`,
            summary: limitText(result.content, 600),
            contentPreview: limitText(result.content, 2_000),
            provider: options.tool.name,
            toolName: options.tool.name,
            workItemId: claim.item.id,
            qaStatus: "unchecked",
            metadata: {
              capability: options.capability,
              caller: options.caller,
              ...(options.metadata ?? {}),
            },
          },
          options.parentSpanId,
        );
      } else {
        await ledger?.markFailed(claim.item.id, limitText(result.content, 600));
        ledger?.trackWhatFailed(`${options.tool.name} failed for ${options.capability}`);
        ledger?.trackWeakTool(options.tool.name);
        await ledger?.recordEvidence(
          {
            kind: "limitation",
            title: `${options.tool.name} failed: ${options.capability}`,
            summary: limitText(result.content, 600),
            provider: options.tool.name,
            toolName: options.tool.name,
            workItemId: claim.item.id,
            qaStatus: "failed",
            limitations: [`${options.tool.name} returned a non-OK result for ${options.capability}.`],
            metadata: {
              capability: options.capability,
              caller: options.caller,
              ...(options.metadata ?? {}),
            },
          },
          options.parentSpanId,
        );
      }
    }

    return { result, spanId, startedAt, claim, reused: false };
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
    // Phase 28 follow-up — caller-supplied sink for structured
    // evidence records. When provided, this method emits one
    // EvidenceRecord per tool-call attempt + one per saved artifact,
    // carrying the FULL `ToolResult.data` (pageText, numericTokens,
    // pageTitle, etc.) so downstream worker/reviewer/synthesizer
    // LLMs see the actual extracted content. The legacy callsites
    // that don't supply this sink still get the AgentArtifact return
    // and the legacy `Created artifact for ...` string evidence path
    // untouched, so this is a pure additive seam.
    onEvidence?: (record: EvidenceRecord) => void,
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
        // Phase 28 follow-up — explicitly ask the WorkLedger to
        // allow revalidation. Without this, a transient failure
        // recorded on a prior run (e.g. v1.0.8 of screenshot.url
        // crashed with rosetta error, marking the workKey "failed")
        // blocks every subsequent retry with
        // `blocked_by_recent_failure` for the next 30 minutes — even
        // though the underlying tool now works after a rebuild.
        // The reason text below contains the trigger word "retry"
        // which decideWorkReuse already recognizes.
        reason: `retry artifact via ${tool.name} (capability=${capability})`,
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

    // Phase 28 follow-up — capture the FULL ToolResult into the
    // structured evidence sink, NOT just a one-liner. The artifact
    // record is appended below after saveArtifact completes.
    onEvidence?.({
      kind: "tool_call",
      toolName: tool.name,
      capability,
      input,
      output: {
        ok: toolResult.ok,
        content: toolResult.content,
        data: toolResult.data,
      },
      timestamp: new Date().toISOString(),
      spanId,
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
    // Phase 28 follow-up — surface the artifact metadata to the
    // structured evidence sink so the worker LLM doesn't have to
    // guess the filename / url from the prose layer.
    onEvidence?.({
      kind: "artifact",
      artifact: { filename: artifact.filename, mimeType: artifact.mimeType, url: artifact.url },
      sourceTool: tool.name,
      sourceUrl: typeof input.url === "string" ? input.url : undefined,
      timestamp: new Date().toISOString(),
      spanId: artifactSpanId,
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
    // Phase 12 follow-up: defensive guard. Each generated tool added to the
    // registry over time can satisfy `findByCapability(...)`, so by the time
    // we reach this method the capability is genuinely uncovered. But a
    // race or legacy caller could still invoke us when a built-in tool DOES
    // satisfy the capability. In that case do not create yet another
    // generated tool (the registry already had ~42 redundant
    // `generated.browser.screenshot.N` entries this fix removes).
    const alreadyCovered = this.tools.findByCapability(request.capability);
    if (alreadyCovered.length > 0) {
      const missingStartedAt = new Date();
      await emit({
        spanId: createSpanId(`tool-already-covered-${request.capability}`),
        parentSpanId,
        type: "tool-missing",
        actor: "tool-registry",
        activity: "tool",
        status: "completed",
        title: `Capability ${request.capability} already covered`,
        detail:
          `Skipped build request — capability is already provided by ${alreadyCovered.length} ` +
          `registered tool(s): ${alreadyCovered.map((t) => t.name).join(", ")}.`,
        startedAt: missingStartedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: elapsedMs(missingStartedAt),
        payload: { capability: request.capability, existingToolNames: alreadyCovered.map((t) => t.name) },
      });
      return undefined;
    }

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
      // Phase 28 follow-up — emit `completed` status for deterministic
      // PASS verdicts (e.g. artifact-fast-pass), `failed` for the
      // existing negative gates. Without this split, a hard-gate pass
      // would render in the Trace Lab as a red `failed` span even
      // though the worker actually succeeded — confusing operators
      // and breaking downstream span-aggregation that expects status
      // to mirror verdict.
      const emitStatus = deterministicReview.verdict === "pass" ? "completed" : "failed";
      await emit({
        spanId,
        parentSpanId,
        type: "review-completed",
        actor: "reviewer",
        activity: "review",
        status: emitStatus,
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
        { role: "system", content: reviewerSystemPrompt(compactWorkerResultForPrompt(workerResult, promptBudget.reviewWorkerOutputChars), []) },
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
	    let learning: LearningResponse;
	    try {
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
	      ], { modelTier, signal: learningAbortSignal() });
	      learning = extractJson<LearningResponse>(output);
	    } catch {
	      return undefined;
	    }

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

function learningAbortSignal(): AbortSignal | undefined {
  const raw = process.env.LEARNING_TIMEOUT_MS;
  const timeoutMs = raw === undefined ? 8_000 : Number(raw);
  if (!Number.isFinite(timeoutMs)) return AbortSignal.timeout(8_000);
  if (timeoutMs <= 0) return AbortSignal.abort("Learning disabled by LEARNING_TIMEOUT_MS");
  return AbortSignal.timeout(timeoutMs);
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

function buildExplicitBrowserFastPathSubtasks(task: string): Subtask[] | undefined {
  const urls = extractHttpUrls(task).filter((url) => !isLowValueProofUrl(url));
  const url = urls[0];
  if (!url) return undefined;

  const text = task.toLowerCase();
  const asksForBrowserRead =
    asksForScreenshot(task) ||
    /\b(open|navigate|visit|read|title|visible|page)\b|открой|перейди|прочитай|заголов|видн|страниц/i.test(
      text,
    );
  const looksLikeExternalSubmit =
    /\b(submit|send|book|reserve|checkout|pay|purchase|commit|approve|sign in|login)\b|отправ|заброн|запиш|оплат|куп|логин|войти/i.test(
      text,
    );

  if (!asksForBrowserRead || looksLikeExternalSubmit) return undefined;

  const needsScreenshot = asksForScreenshot(task);
  const hostLabel = safeLabel(normalizedHost(url));
  const commands: Array<Record<string, unknown>> = [
    { type: "navigate", url },
    { type: "dismissDialogs" },
    { type: "extractText", label: `page-${hostLabel}`, maxLength: 6000 },
    { type: "extractLinks", label: `links-${hostLabel}`, limit: 30 },
  ];
  if (needsScreenshot) {
    commands.push({
      type: "screenshot",
      label: `proof-${hostLabel}`,
      fullPage: false,
      maxHeight: 1200,
    });
  }

  return [
    {
      id: "explicit-browser-source",
      title: "Open explicit source URL and collect browser evidence",
      role: "browser evidence worker",
      prompt:
        `Open the explicit URL from the user task (${url}), collect the visible page title/text, ` +
        `${needsScreenshot ? "capture a proof screenshot, " : ""}` +
        "and answer only from the collected browser evidence.",
      expectedOutput:
        "A concise answer grounded in the visible browser evidence, with any saved proof artifact URL if one was captured.",
      reviewCriteria: [
        "The answer uses the explicit URL requested by the user.",
        "The answer is grounded in browser evidence returned by the tool.",
        ...(needsScreenshot ? ["A real saved screenshot artifact is attached."] : []),
      ],
      requiredTools: ["browser-operate", ...(needsScreenshot ? ["browser-screenshot"] : [])],
      requiredArtifacts: needsScreenshot
        ? [
            {
              kind: "screenshot",
              capability: "browser-screenshot",
              description: `Proof screenshot for ${url}.`,
              required: true,
            },
          ]
        : [],
      toolInputs: {
        "browser.operate": {
          defaultTimeoutMs: 12000,
          commands,
        },
      },
    },
  ];
}

function buildExplicitHttpFastPathSubtasks(task: string): Subtask[] | undefined {
  const url = extractHttpUrls(task)[0];
  if (!url) return undefined;
  if (!shouldPreferHttpRequestForUrls({ requiredTools: [] }, task)) return undefined;
  if (/\b(?:submit|send|book|reserve|checkout|pay|purchase|commit|delete)\b|отправ|заброн|запиш|оплат|куп|удали/i.test(task)) {
    return undefined;
  }

  const method = inferHttpMethod(task);
  return [
    {
      id: "explicit-http-api-request",
      title: "Call explicit HTTP API and summarize response",
      role: "api integration worker",
      prompt:
        `Call the explicit HTTP endpoint from the user task (${url}) with ${method}, ` +
        "then answer only from the returned status and response body.",
      expectedOutput:
        "A concise summary of the HTTP status and returned response fields, grounded only in the http.request result.",
      reviewCriteria: [
        "The worker called the explicit URL requested by the user.",
        "The worker used http.request rather than browser page reading for the API endpoint.",
        "The answer summarizes only fields present in the HTTP response.",
      ],
      requiredTools: ["http.request"],
      requiredArtifacts: [],
      toolInputs: {
        "http.request": {
          url,
          method,
          responseType: /\bjson\b|джсон|api|апи|эйпиай/i.test(task) ? "json" : "auto",
          maxBytes: 1_000_000,
        },
      },
    },
  ];
}

function buildLocalUtilityToolchainFastPathSubtasks(
  task: string,
  hasTool: (toolName: string) => boolean,
): Subtask[] | undefined {
  const plan = inferLocalUtilityToolchainPlan(task);
  if (!plan) return undefined;
  if (plan.requiredTools.some((toolName) => !hasTool(toolName))) return undefined;

  return [
    {
      id: "local-utility-toolchain",
      title: "Run local document/data/file toolchain",
      role: "toolchain worker",
      prompt:
        "Execute only the declared local toolchain from the user task. " +
        "Do not search the web or open a browser unless the user explicitly requested external discovery.",
      expectedOutput:
        "A concise report listing the tools called, transformed result, and written file path when a file is written.",
      reviewCriteria: [
        "The worker used the declared local tools rather than web search/browser discovery.",
        "The transformation matches the user-requested filter, sort, template, or serialization.",
        "If a file path was requested, the file.write result confirms the path.",
      ],
      requiredTools: plan.requiredTools,
      requiredArtifacts: [],
      toolInputs: plan.toolInputs,
    },
  ];
}

function inferLocalUtilityToolchainPlan(task: string): { requiredTools: string[]; toolInputs: Record<string, ToolInput> } | undefined {
  const lower = task.toLowerCase();
  const explicitLocalTools = ["document.extract", "data.transform", "file.read", "file.write"].filter((toolName) =>
    lower.includes(toolName),
  );
  const inlineContent = extractInlineDocumentContent(task);
  const jsonValue = extractFirstJsonValue(task);
  const outputPath = extractWorkspaceOutputPath(task);
  const asksForTransform = /\b(?:filter|sort|transform|convert|template|serialize|parse)\b|фильтр|сортир|преобраз|шаблон|распарс|вытащи|извлек/i.test(
    task,
  );
  const hasLocalDataShape = Boolean(inlineContent) || jsonValue !== undefined || Boolean(outputPath);
  if (explicitLocalTools.length === 0 && !(hasLocalDataShape && asksForTransform)) return undefined;

  const requiredTools: string[] = [];
  const toolInputs: Record<string, ToolInput> = {};

  if (inlineContent) {
    requiredTools.push("document.extract");
    toolInputs["document.extract"] = {
      content: inlineContent.content,
      mimeType: inlineContent.mimeType,
      maxChars: 200_000,
    };
  }

  const transformInput = buildDataTransformInput(task, jsonValue ?? inlineContent?.jsonValue);
  if (transformInput) {
    requiredTools.push("data.transform");
    toolInputs["data.transform"] = transformInput;
  }

  if (outputPath) {
    requiredTools.push("file.write");
    toolInputs["file.write"] = {
      path: outputPath,
      content: transformInput ? previewDataTransformContent(transformInput) ?? "" : extractExplicitFileContent(task) ?? "",
    };
  }

  for (const toolName of explicitLocalTools) {
    if (!requiredTools.includes(toolName)) requiredTools.push(toolName);
  }

  return requiredTools.length > 0 ? { requiredTools, toolInputs } : undefined;
}

function extractInlineDocumentContent(task: string): { content: string; mimeType: string; jsonValue?: unknown } | undefined {
  const html =
    task.match(/<html[\s\S]*?<\/html>/i)?.[0] ??
    task.match(/<(?:script|table|div|section|article)\b[\s\S]*?<\/(?:script|table|div|section|article)>/i)?.[0];
  if (html) return { content: html, mimeType: "text/html", jsonValue: extractJsonFromHtml(html) };

  const jsonValue = extractFirstJsonValue(task);
  if (jsonValue !== undefined) return { content: JSON.stringify(jsonValue), mimeType: "application/json", jsonValue };
  return undefined;
}

function extractJsonFromHtml(html: string): unknown | undefined {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const parsed = safeJsonParse(match[1]?.trim() ?? "");
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function extractFirstJsonValue(text: string): unknown | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const fencedParsed = fenced ? safeJsonParse(fenced.trim()) : undefined;
  if (fencedParsed !== undefined) return fencedParsed;

  const candidates = text.match(/(?:\[[\s\S]*?\]|\{[\s\S]*?\})/g) ?? [];
  for (const candidate of candidates) {
    const parsed = safeJsonParse(candidate);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function safeJsonParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractWorkspaceOutputPath(task: string): string | undefined {
  const explicit = task.match(/\b(?:workspace\/)?((?:reports|artifacts|outputs|tmp|files)\/[^\s"'<>]+)\b/i)?.[1];
  return explicit?.replace(/[),.;:]+$/g, "");
}

function buildDataTransformInput(task: string, input: unknown): ToolInput | undefined {
  if (input === undefined) return undefined;
  const operations: Array<Record<string, unknown>> = [];
  const rows = Array.isArray(input) ? input.filter(isRecord) : [];
  const sample = rows[0] ?? (isRecord(input) ? input : undefined);

  const paidField = sample ? findFirstKey(sample, ["status", "state", "paid", "paymentStatus", "payment_status"]) : undefined;
  if (paidField && /\bpaid\b|оплач/i.test(task)) {
    const value = sample[paidField];
    operations.push({
      type: "filter",
      path: paidField,
      ...(typeof value === "boolean" ? { equals: true } : { equals: inferPaidValue(rows, paidField) ?? "paid" }),
    });
  }

  const sortField = sample ? inferSortField(task, sample) : undefined;
  if (sortField) {
    operations.push({
      type: "sort",
      path: sortField,
      direction: /\b(?:desc|descending|highest|largest|biggest)\b|убыв|сначала\s+больш|по\s+больш/i.test(task)
        ? "desc"
        : "asc",
    });
  }

  const template = inferTemplate(task, sample);
  if (template) operations.push({ type: "template", template });

  return { input, format: "json", operations, outputFormat: template ? "text" : "json" };
}

function findFirstKey(record: Record<string, unknown>, keys: string[]): string | undefined {
  const lowerMap = new Map(Object.keys(record).map((key) => [key.toLowerCase(), key]));
  for (const key of keys) {
    const found = lowerMap.get(key.toLowerCase());
    if (found) return found;
  }
  return undefined;
}

function inferPaidValue(rows: Array<Record<string, unknown>>, path: string): unknown {
  return rows.map((row) => row[path]).find((value) => typeof value === "string" && /^paid$/i.test(value));
}

function inferSortField(task: string, sample: Record<string, unknown>): string | undefined {
  const explicitSort = task.match(/\b(?:sort|order)\s+by\s+([a-zA-Z0-9_.-]+)/i)?.[1] ??
    task.match(/сортир\w*\s+по\s+([a-zA-Z0-9_.-]+)/i)?.[1];
  if (explicitSort) {
    const explicitKey = findFirstKey(sample, [explicitSort]);
    if (explicitKey) return explicitKey;
  }
  if (/total|amount|sum|price|стоим|сумм|итог/i.test(task) && /sort|сортир|убыв|возраст|highest|largest|biggest/i.test(task)) {
    const numericKey = findFirstKey(sample, ["total", "amount", "sum", "price", "value"]);
    if (numericKey) return numericKey;
  }
  const mentioned = Object.keys(sample).find((key) => new RegExp(`\\b${escapeRegExp(key)}\\b`, "i").test(task));
  if (mentioned && /sort|сортир|убыв|возраст|highest|largest|biggest/i.test(task)) return mentioned;
  return undefined;
}

function inferTemplate(task: string, sample?: Record<string, unknown>): string | undefined {
  const literal = task.match(/template\s+["'`]([^"'`]+)["'`]/i)?.[1] ?? task.match(/шаблон\s+["'`]([^"'`]+)["'`]/i)?.[1];
  if (literal) return literal;
  if (!sample) return undefined;
  const nameKey = findFirstKey(sample, ["name", "title", "label"]);
  const valueKey = inferSortField(task, sample) ?? findFirstKey(sample, ["total", "amount", "sum", "price", "value"]);
  if (nameKey && valueKey && /name|title|имя|назван|total|amount|сумм|итог|:/i.test(task)) return `{${nameKey}}: {${valueKey}}`;
  return undefined;
}

function previewDataTransformContent(input: ToolInput): string | undefined {
  const data = input.input;
  if (data === undefined) return undefined;
  const operations = Array.isArray(input.operations) ? input.operations : [];
  let current: unknown = data;
  for (const operation of operations) {
    if (isRecord(operation)) current = applyPreviewTransformOperation(current, operation);
  }
  return input.outputFormat === "text" && typeof current === "string" ? current : JSON.stringify(current, null, 2);
}

function applyPreviewTransformOperation(value: unknown, operation: Record<string, unknown>): unknown {
  switch (operation.type) {
    case "filter":
      return Array.isArray(value)
        ? value.filter((item) => isRecord(item) && getPreviewPath(item, String(operation.path ?? "")) === operation.equals)
        : value;
    case "sort":
      return Array.isArray(value)
        ? [...value].sort((a, b) => {
            const path = String(operation.path ?? "");
            const compared = String(getPreviewPath(a, path) ?? "").localeCompare(String(getPreviewPath(b, path) ?? ""), undefined, {
              numeric: true,
              sensitivity: "base",
            });
            return operation.direction === "desc" ? -compared : compared;
          })
        : value;
    case "template":
      return Array.isArray(value)
        ? value.map((item) => applyPreviewTemplate(String(operation.template ?? ""), item)).join("\n")
        : applyPreviewTemplate(String(operation.template ?? ""), value);
    default:
      return value;
  }
}

function applyPreviewTemplate(template: string, value: unknown): string {
  return template.replace(/\{([^}]+)\}/g, (_, path: string) => String(getPreviewPath(value, path.trim()) ?? ""));
}

function getPreviewPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, segment) => (isRecord(current) ? current[segment] : undefined), value);
}

function extractExplicitFileContent(task: string): string | undefined {
  return task.match(/content\s+["'`]([^"'`]+)["'`]/i)?.[1] ?? task.match(/текст\s+["'`]([^"'`]+)["'`]/i)?.[1];
}

function buildCurrentFactProofFastPathSubtasks(task: string): Subtask[] | undefined {
  if (extractHttpUrls(task).some((url) => !isLowValueProofUrl(url))) return undefined;

  const text = task.toLowerCase();
  const asksForProof = asksForScreenshot(task) || /\bproof|source|evidence|screenshot\b|пруф|источник|доказ|скрин/i.test(text);
  const asksForFreshFact =
    /\b(current|now|today|latest|live|price|rate|quote|status|weather|score)\b|сейчас|текущ|сегодня|последн|актуальн|цена|курс|котиров|погода|счет/i.test(
      text,
    );
  const looksLikeExternalSubmit =
    /\b(submit|send|book|reserve|checkout|pay|purchase|commit|approve|sign in|login)\b|отправ|заброн|запиш|оплат|куп|логин|войти/i.test(
      text,
    );

  if (!asksForFreshFact || looksLikeExternalSubmit) return undefined;

  return [
    {
      id: "current-fact-with-proof",
      title: "Find current fact and capture proof evidence",
      role: "research evidence worker",
      prompt:
        `User question: ${task}\n` +
        "Search the web for the current answer to that user question, prefer a primary or reputable source, " +
        `${asksForProof ? "open the best source and capture a proof screenshot, " : "open the best source when useful, "}` +
        "then answer only from collected tool evidence. Use the current date/time context from the task.",
      expectedOutput:
        "A concise current answer with source name, source URL, and saved proof artifact URL when captured.",
      reviewCriteria: [
        "The answer is based on fresh web/search/browser evidence, not model memory.",
        "The source URL is visible in tool evidence.",
        ...(asksForProof ? ["A real saved screenshot artifact is attached or a precise blocker is reported."] : []),
      ],
      requiredTools: ["web-search", "browser-operate", ...(asksForProof ? ["browser-screenshot"] : [])],
      toolInputs: {
        "web.search": {
          query: task,
          limit: 5,
        },
      },
      requiredArtifacts: asksForProof
        ? [
            {
              kind: "screenshot",
              capability: "browser-screenshot",
              description: "Proof screenshot for the current factual answer source.",
              required: true,
            },
          ]
        : [],
    },
  ];
}

function buildExternalActionFastPathSubtasks(
  task: string,
  hasTool: (toolName: string) => boolean,
  contextText = "",
): Subtask[] | undefined {
  if (!looksLikeExternalActionTask(task)) return undefined;
  if (!hasTool("web.search") || !hasTool("browser.operate")) return undefined;

  const query = buildExternalActionSearchQuery(task, contextText);
  const approvalRequiredTools = hasTool("external.action.prepare") ? ["external-action-prepare"] : [];

  return [
    {
      id: "external-action-source-discovery",
      title: "Find a concrete provider page for the requested external action",
      role: "researcher",
      prompt:
        `Search objective: ${query}\n` +
        "The original user request is an external action preparation task. Do not submit externally and do not collect proof in this discovery step. " +
        "Find concrete provider pages that can satisfy the requested external action. Prefer direct booking, appointment, reservation, checkout, or contact-form pages over directories, maps, ads, or generic listicles. Return source URLs, provider names, visible location/contact details, and why the best candidate is actionable.",
      expectedOutput:
        "A ranked shortlist of concrete provider/action URLs with enough evidence to pick one page for browser preparation.",
      reviewCriteria: [
        "Uses fresh web evidence rather than model memory.",
        "Prefers a direct provider/action page over a generic directory or map when available.",
        "Reports uncertainty or blockers instead of inventing availability, addresses, prices, or confirmation details.",
      ],
      requiredTools: ["web-search", "web-read"],
      toolInputs: {
        "web.search": {
          query,
          limit: 8,
        },
      },
      requiredArtifacts: [],
    },
    {
      id: "external-action-browser-preparation",
      title: "Prepare the external action in the browser without final submit",
      role: "browser action preparer",
      prompt:
        "Use the best concrete provider/action URL from upstream evidence. Open it in browser.operate, dismiss generic consent dialogs, inspect visible action controls, and try only safe pre-submit preparation steps. Stop before any provider-side final submit, payment, login, account creation, CAPTCHA bypass, or irreversible confirmation. If the site blocks preparation, capture the blocker state and explain exactly what is missing.",
      expectedOutput:
        "Prepared browser state or a precise blocker, with a saved screenshot of the pre-submit/preparation state or blocker.",
      reviewCriteria: [
        "Uses a URL from upstream discovery evidence.",
        "Does not submit, reserve, pay, send, confirm, or mutate external state.",
        "Attaches a screenshot from browser.operate showing the prepared form/action state or the exact blocker.",
      ],
      dependsOn: ["external-action-source-discovery"],
      requiredTools: ["browser-operate"],
      toolInputs: {
        "browser.operate": {
          defaultTimeoutMs: 12_000,
          maxCommands: 40,
          commands: [
            { type: "navigate", url: "URL_FROM_UPSTREAM_DISCOVERY" },
            { type: "dismissDialogs", timeoutMs: 4_000 },
            { type: "extractText", label: "initial-action-page", maxLength: 8_000 },
            { type: "extractLinks", label: "initial-action-links", limit: 60 },
            { type: "observe", label: "initial-visible-controls", limit: 80, enabledOnly: true },
            { type: "clickVisible", text: "Book", optional: true, timeoutMs: 1_500, externalActionSafe: true },
            { type: "clickVisible", text: "Reserve", optional: true, timeoutMs: 1_500, externalActionSafe: true },
            { type: "clickVisible", text: "Appointment", optional: true, timeoutMs: 1_500, externalActionSafe: true },
            { type: "clickVisible", text: "Reservar", optional: true, timeoutMs: 1_500, externalActionSafe: true },
            { type: "clickVisible", text: "Cita", optional: true, timeoutMs: 1_500, externalActionSafe: true },
            { type: "clickVisible", text: "Continuar", optional: true, timeoutMs: 1_500, externalActionSafe: true },
            { type: "dismissDialogs", timeoutMs: 2_000 },
            {
              type: "fillFormSemantically",
              label: "external-action-safe-form-prep",
              goal: task,
              valuesText: task,
              allowContinue: true,
              allowPolicyConsent: false,
              submit: false,
              maxRounds: 3,
              timeoutMs: 3_000,
            },
            { type: "observe", label: "prepared-visible-controls", limit: 100, enabledOnly: true },
            { type: "extractText", label: "prepared-action-page", maxLength: 12_000 },
            { type: "extractLinks", label: "prepared-action-links", limit: 80 },
            { type: "screenshot", label: "external-action-pre-submit-proof", fullPage: false, maxHeight: 1200 },
          ],
        },
      },
      requiredArtifacts: [
        {
          kind: "screenshot",
          capability: "browser-screenshot",
          description:
            "Screenshot proof of the prepared external action state before submission, or the visible blocker that prevents preparation.",
          required: true,
        },
      ],
    },
    {
      id: "external-action-approval-draft",
      title: "Create auditable external action approval draft",
      role: "approval drafter",
      prompt:
        "Create an external.action.prepare draft from the browser preparation evidence. Summarize target, target URL, intended action, data that would be sent, proof artifacts, blocker/commit boundary, and what final approval would commit. Do not submit externally.",
      expectedOutput:
        "An approval-ready external action draft with target, data summary, proof status, and explicit final-submit boundary.",
      reviewCriteria: [
        "Draft is based on upstream browser evidence and proof artifacts.",
        "Commit boundary is explicit and no external submission has occurred.",
        "If preparation was blocked, the draft says what user/operator action or provider requirement is missing.",
      ],
      dependsOn: ["external-action-browser-preparation"],
      requiredTools: approvalRequiredTools,
      requiredArtifacts: [],
    },
    {
      id: "external-action-final-report",
      title: "Report preparation result and next step",
      role: "analyst",
      prompt:
        "Use only upstream evidence. Give the user a concise report: selected provider, why it was selected, exact page URL, what data would be submitted, what is still required before final submit, how to cancel/change if known, where to go/contact if known, and proof artifact or blocker proof. Be explicit if the task could not be prepared.",
      expectedOutput: "A user-readable report with provider, data, proof, blocker/approval status, and next step.",
      reviewCriteria: [
        "Does not claim that an external action was submitted unless commit evidence proves it.",
        "Does not invent confirmation ids, addresses, policies, or availability.",
        "Mentions proof artifact or explains why only blocker proof is available.",
      ],
      dependsOn: ["external-action-source-discovery", "external-action-browser-preparation", "external-action-approval-draft"],
    },
  ];
}

function looksLikeExternalActionTask(task: string): boolean {
  return /\b(?:book|reserve|schedule|appointment|submit|send|purchase|order|checkout|fill|form|commit|cancel|confirm)\b|заброни|брон|запис|запиши|заполн|отправ|подтверд|куп|закаж|оформ|форма|столик|стриж/i.test(
    task,
  );
}

function buildExternalActionSearchQuery(task: string, contextText = ""): string {
  const stripped = stripSearchExecutionDetails(task)
    .replace(/\b(?:do not|don't|without|before|after|final|submit|approval|approve|proof|screenshot)\b.*$/gi, " ")
    .replace(/\b(?:не\s+отправ\w*|без\s+подтвержд\w*|пруф|скриншот|доказательств\w*)\b.*$/gi, " ");
  const anchors = inferMarketSearchHints(`${task}\n${contextText}`).filter((hint) => !/^(?:USD|EUR)$/i.test(hint));
  const normalized = normalizeAnchorTerm(task);
  const serviceTerms = new Set<string>();
  for (const [pattern, terms] of EXTERNAL_ACTION_SEARCH_TERMS) {
    if (pattern.test(normalized)) terms.forEach((term) => serviceTerms.add(term));
  }
  if (serviceTerms.size === 0) {
    if (/\b(?:appointment|schedule|запис|форма|form)\b/i.test(task)) serviceTerms.add("appointment");
    if (/\b(?:book|reserve|reservation|заброни|брон|столик)\b/i.test(task)) serviceTerms.add("reservation");
  }
  const actionTerms = /(?:\bappointment\b|\bschedule\b|запис|стриж)/i.test(task)
    ? ["online booking", "appointment"]
    : ["online booking", "reservation"];
  const baseTerms =
    serviceTerms.size > 0 || anchors.length > 0
      ? [...serviceTerms, ...anchors, ...actionTerms]
      : [...actionTerms, stripped];
  return cleanSearchQuery(
    baseTerms
      .filter(Boolean)
      .join(" "),
  );
}

const EXTERNAL_ACTION_SEARCH_TERMS: Array<[RegExp, string[]]> = [
  [/\bbarber|барбер|стриж/, ["barbershop", "haircut"]],
  [/\brestaurant|ресторан|столик/, ["restaurant"]],
  [/\bsalon|салон/, ["salon"]],
  [/\bdoctor|clinic|dentist|врач|клиник|стоматолог/, ["clinic"]],
  [/\bvilla|hotel|отел|вилл/, ["venue"]],
];

function buildInternalProjectKnowledgeFastPathSubtasks(task: string): Subtask[] | undefined {
  if (!isInternalProjectKnowledgeQuestion(task)) return undefined;

  return [
    {
      id: "internal-project-context-answer",
      title: "Answer from Agentic project context",
      role: "project context analyst",
      prompt:
        `User task: ${task}\n\n` +
        "Use only the Agentic project context below. Do not use web search, browser discovery, or external docs.\n\n" +
        `${buildInternalProjectKnowledgeContext()}\n\n` +
        "Answer the user directly in the user's language. Preserve explicit formatting constraints such as 'one short sentence'. If the requested internal detail is not covered above, say that it is not available in the current project context.",
      expectedOutput:
        "A direct answer grounded only in the Agentic project context, with no external web claims.",
      reviewCriteria: [
        "Uses only the Agentic project context provided in the prompt.",
        "Does not cite or rely on unrelated external products or generic web definitions.",
        "Preserves the user's requested brevity and language.",
      ],
      requiredTools: [],
      requiredArtifacts: [],
    },
  ];
}

function appendInternalProjectKnowledgeContextIfNeeded(taskContext: string, task: string): string {
  if (!isInternalProjectKnowledgeQuestion(task)) return taskContext;
  return `${buildInternalProjectKnowledgeContext()}\n\nFor this internal project question, answer from the Agentic project context above. Do not use unrelated external product definitions.\n\n${taskContext}`;
}

function buildInternalProjectKnowledgeContext(): string {
  return [
    "Agentic project context:",
    "- Agentic Universal Agent is a TypeScript prototype of a coordinator agent.",
    "- The active tool foundation is the preinstalled core toolbelt registry created by createCoreToolbelt().",
    "- The preinstalled toolbelt means the built-in, versioned tools available to agents before the redesigned dynamic tool builder exists.",
    "- Active preinstalled tools: web.search, web.read, browser.operate, browser.screenshot, http.request, file.read, file.write, document.extract, data.transform, external.action.prepare, external.action.commit, and channel.telegram.",
    "- Legacy Tool Builder / tool-rework APIs are removed from the active server and UI; missing capabilities should surface as unsupported until the new builder lifecycle is redesigned.",
    "- Future generated tools must use the same versioned registry/metadata contract and live as out-of-tree portable packages or services.",
  ].join("\n");
}

function isInternalProjectKnowledgeQuestion(task: string): boolean {
  const text = task.toLowerCase();
  const asksQuestion =
    /\?|что такое|что значит|объясни|расскажи|как у нас|как работает|что у нас|зачем|почему|what is|explain|how does|how do we/.test(
      text,
    );
  if (!asksQuestion) return false;

  const hasInternalAnchor =
    /\bagentic\b|агентик|наш(?:а|у|ей|ем|их)?\s+(?:проект|платформ|систем|код|архитектур)|в\s+этой\s+платформ|в\s+наш(?:ем|ей)\s+(?:проект|платформ|систем)|this\s+(?:project|platform|codebase|system)|our\s+(?:project|platform|system|codebase)/i.test(
      task,
    );
  const hasKnownInternalTerm =
    /\bpreinstalled\s+toolbelt\b|\bcore\s+toolbelt\b|\bcreateCoreToolbelt\b|предустановленн\w+\s+тул|ядр\w+\s+тул|реестр\s+тул|tool\s+registry|toolbelt/i.test(
      task,
    );

  return hasInternalAnchor || hasKnownInternalTerm;
}

function buildFallbackResearchSubtasks(task: string, hasTool: (toolName: string) => boolean): Subtask[] {
  const requiredTools = [
    hasTool("web.search") ? "web-search" : undefined,
    hasTool("web.read") ? "web-read" : undefined,
  ].filter((toolName): toolName is string => Boolean(toolName));
  const screenshotTools = hasTool("browser.screenshot") ? ["browser-screenshot"] : [];

  return [
    {
      id: "research-evidence",
      title: "Collect current source evidence",
      role: "researcher",
      prompt:
        `User task: ${task}\n` +
        "Search for current, reputable sources that directly address the user task. " +
        "Read the best result pages when possible. Return concrete candidates, URLs, dates, prices/specs when present, " +
        "and explicitly mark any missing evidence.",
      expectedOutput:
        "A source-grounded research summary with candidate options, URLs, and the criteria each source supports.",
      reviewCriteria: [
        "Uses fresh tool evidence rather than model memory.",
        "Includes source URLs for concrete claims.",
        "Reports uncertainty instead of inventing specs, prices, dates, or model names.",
      ],
      requiredTools,
      toolInputs: hasTool("web.search")
        ? {
            "web.search": {
              query: task,
              limit: 6,
            },
          }
        : undefined,
    },
    {
      id: "proof-screenshot",
      title: "Capture proof screenshot from the best source",
      role: "evidence worker",
      prompt:
        "Use the research output to identify the best source URL for the final recommendation. " +
        "Capture a screenshot proof when browser screenshot capability is available. If proof cannot be captured, " +
        "return the exact URL and blocker.",
      expectedOutput: "A proof artifact URL or a precise explanation of why visual proof could not be captured.",
      reviewCriteria: [
        "Uses a source URL from the research output.",
        "Does not capture generic search/home pages when a concrete source URL is available.",
        "Reports blocker details if a screenshot is unavailable.",
      ],
      dependsOn: ["research-evidence"],
      requiredTools: screenshotTools,
      requiredArtifacts: hasTool("browser.screenshot")
        ? [
            {
              kind: "screenshot",
              capability: "browser-screenshot",
              description: "Visual proof for the selected source or recommendation.",
              required: false,
            },
          ]
        : [],
    },
    {
      id: "final-recommendation",
      title: "Synthesize final recommendation",
      role: "analyst",
      prompt:
        "Use only the research and proof evidence from upstream subtasks. Give the user a direct recommendation, " +
        "explain the tradeoffs, cite source URLs, and mention proof artifacts or proof blockers.",
      expectedOutput: "A concise final answer with recommendation, tradeoffs, source links, and proof status.",
      reviewCriteria: [
        "Every concrete product/model/price/spec claim is grounded in upstream evidence.",
        "The answer addresses the user's actual constraints and tradeoffs.",
        "Proof artifact or proof limitation is stated clearly.",
      ],
      dependsOn: ["research-evidence", "proof-screenshot"],
    },
  ];
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

  // Phase 28 follow-up — DETERMINISTIC DAG REPAIR.
  //
  // Observed planner failure: bitcoin task got
  //   - subtask "research-price"   requiredTools=[web-search]
  //   - subtask "capture-screenshot" requiredArtifacts=[browser-screenshot]
  // with NO dependsOn relationship. Both subtasks ran in parallel,
  // capture-screenshot started before research-price produced a URL,
  // emitted `tool-missing: input-missing-source-url`, the whole run
  // collapsed into a tool-rework wait.
  //
  // The model writes good per-subtask metadata but forgets to wire
  // the DAG. Rather than chase prompts forever, we patch dependencies
  // deterministically: a subtask that requires an artifact derived
  // from a URL (screenshot, browser-screenshot) AND has no explicit
  // URL in its own prompt MUST depend on a subtask that runs a
  // web-search or browser-discovery tool. We attach the missing
  // edge here so the DAG executor honours it.
  //
  // Other links worth inferring later (Slice TBD): chart subtasks
  // depending on the market-timeseries source, synthesis subtasks
  // depending on every prior subtask (already common). Bitcoin's
  // case was the urgent one.
  const URL_IN_PROMPT_RE = /https?:\/\//i;
  for (const subtask of subtasks) {
    const needsUrl = (subtask.requiredArtifacts ?? []).some(
      (a) => a.kind === "screenshot" || a.capability === "browser-screenshot",
    );
    if (!needsUrl) continue;
    // If the subtask's own prompt already cites a URL, the worker
    // can act without waiting on a sibling — no edge required.
    const promptText = [subtask.prompt, subtask.title, subtask.expectedOutput]
      .filter(Boolean)
      .join("\n");
    if (URL_IN_PROMPT_RE.test(promptText)) continue;
    // Find candidate producers — subtasks that look like they
    // discover a URL (web-search / browser-discovery / "research" /
    // "find" roles).
    const producers = subtasks.filter((other) => {
      if (other.id === subtask.id) return false;
      if (other.dependsOn?.includes(subtask.id)) return false; // would create a cycle
      const tools = (other.requiredTools ?? []).map((t) => t.toLowerCase());
      if (tools.includes("web-search") || tools.includes("browser-discovery")) return true;
      const otherText = `${other.title} ${other.role} ${other.prompt}`.toLowerCase();
      if (/\b(search|research|find|discover|locate|identify)\b/.test(otherText)) return true;
      return false;
    });
    if (producers.length === 0) continue;
    const before = new Set(subtask.dependsOn ?? []);
    let added = false;
    for (const producer of producers) {
      if (before.has(producer.id)) continue;
      before.add(producer.id);
      added = true;
    }
    if (added) {
      subtask.dependsOn = Array.from(before);
      warnings.push(
        `Auto-linked ${subtask.id} → depends on [${producers.map((p) => p.id).join(", ")}] (needs URL from upstream search/research).`,
      );
    }
  }
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
  // Phase 13 follow-up: defensive against LLM-emitted plans that put a
  // `null` entry into requiredTools — `.trim()` on null crashes the
  // entire review path with "Cannot read properties of null (reading
  // 'trim')". Filter to strings first.
  const requiredTools = new Set(
    (subtask.requiredTools ?? [])
      .filter((tool): tool is string => typeof tool === "string")
      .map((tool) => tool.trim())
      .filter(Boolean),
  );
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
  tool evidence:
${indent(formatDependencyToolEvidence(result.workerResult.toolEvidence))}
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

function formatDependencyToolEvidence(evidence: string[] | undefined): string {
  if (!evidence || evidence.length === 0) return "No tool evidence.";
  return evidence
    .slice(0, 3)
    .map((item) => limitText(item, 700))
    .join("\n\n");
}

function buildWorkerUserPrompt(
  originalTask: string,
  toolEvidence: string,
  dependencyContext?: string,
  revisionInstructions?: string,
): string {
  // Phase 12 follow-up: when re-running a worker after a hard-gate
  // rejection, parse the deterministic ungrounded-specifics list out of
  // the review notes and surface it as its own emphatic "forbidden
  // tokens" section. Earlier iterations buried this inside a generic
  // "Revise your previous work using these notes" paragraph and the
  // model just reused the same hallucinated specifics on retry.
  const forbiddenTokens = revisionInstructions
    ? parseForbiddenTokensFromReviewNotes(revisionInstructions)
    : [];
  const forbiddenSection: [string, string] | undefined = forbiddenTokens.length
    ? [
        "FORBIDDEN TOKENS (must NOT appear in your output)",
        `${forbiddenTokens.join(", ")}\n` +
          "These are the exact specifics the previous attempt invented from training memory. They are NOT in any tool evidence and NOT in the user's task. Do not use them, do not paraphrase them, and do not introduce other specifics with the same shape (model numbers, version strings, prices, years) unless they appear verbatim in the tool evidence above. If the evidence does not support a concrete specific, use a generic description instead or report that the data is unavailable.",
      ]
    : undefined;

  return joinPromptSections(
    [
      ["Original user task for context", limitText(originalTask, promptBudget.taskContextChars)],
      ["External tool evidence", limitText(toolEvidence, promptBudget.toolEvidenceChars)],
      [
        "Runtime rule",
        "Available tools have already been executed and their evidence is above. Do not emit tool-call syntax, hidden browser commands, or pretend to navigate/click. Use only the evidence and artifact URLs you were given.",
      ],
      dependencyContext ? ["Dependency context", limitText(dependencyContext, promptBudget.dependencyContextChars)] : undefined,
      forbiddenSection,
      [
        "Instruction",
        revisionInstructions
          ? `Revise your previous work using these review notes. Switch source / strategy if the evidence is insufficient — do not retry the same query that already failed.\n${limitText(revisionInstructions, 3_000)}`
          : "Execute only your assigned subtask.",
      ],
    ],
    promptBudget.workerUserPromptChars,
  );
}

const workerModelFailureFallbackMarker = "[runtime:model-synthesis-degraded]";

function isRecoverableWorkerModelError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  return /LLM request failed for all model candidates|LLM request timed out|timed out after \d+ms|model output was truncated/i.test(
    message,
  );
}

function hasCollectedToolEvidence(evidence: CollectedToolEvidence): boolean {
  return evidence.evidence.some((item) => item.trim().length > 0) ||
    (evidence.records ?? []).length > 0 ||
    evidence.artifacts.length > 0;
}

function buildWorkerModelFailureFallbackOutput(
  subtask: Subtask,
  evidence: CollectedToolEvidence,
  error: unknown,
): string {
  const evidencePreview = limitText(evidence.text, 2_500);
  const legacyEvidence = summarizeEvidenceList(evidence.evidence, 1_500);
  const artifactLines = evidence.artifacts
    .slice(0, 5)
    .map((artifact) => `- ${artifact.filename}: ${artifact.url}`)
    .join("\n");
  return [
    workerModelFailureFallbackMarker,
    "Runtime limitation: the worker model could not finish synthesis after the platform had already collected tool evidence.",
    `Subtask: ${subtask.title}`,
    `Model/runtime error: ${formatErrorMessage(error)}`,
    "Available evidence for the parent agent:",
    evidencePreview || "(no textual evidence preview)",
    legacyEvidence ? `Tool evidence summaries:\n${legacyEvidence}` : undefined,
    artifactLines ? `Artifacts:\n${artifactLines}` : undefined,
    "Use this as a degraded evidence handoff. Do not invent missing facts; answer only from the evidence above and state the limitation when needed.",
  ].filter((line): line is string => Boolean(line)).join("\n\n");
}

function isWorkerModelFailureFallback(workerResult: WorkerResult): boolean {
  return workerResult.output.includes(workerModelFailureFallbackMarker);
}

/**
 * Phase 12 follow-up: pull the comma-separated list of ungrounded
 * tokens out of a `hardGateReview` notes string of the form:
 *   "Output names specifics that are NOT in tool evidence or the task: T1, T2, T3. ..."
 * Returns an empty array if the notes do not match (other failure
 * reasons like missing artifacts, weak browser evidence, etc.).
 */
function parseForbiddenTokensFromReviewNotes(notes: string): string[] {
  // Phase 13 follow-up: a reviewer LLM that returned `notes: null` would
  // crash here. Coerce to empty string instead so the parser harmlessly
  // returns [].
  const safeNotes = typeof notes === "string" ? notes : "";
  const match = safeNotes.match(/specifics that are NOT in tool evidence or the task:\s*([^\n.]+)\./i);
  if (!match) return [];
  return (match[1] ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .slice(0, 12);
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
  return memories.slice(0, 1).map((memory) => ({
    ...memory,
    summary: limitText(memory.summary, promptBudget.memoryEntryChars),
    reusableProcedure: limitText(memory.reusableProcedure, promptBudget.memoryEntryChars),
    evidence: (memory.evidence ?? []).slice(0, 1).map((item) => limitText(item, promptBudget.memoryEvidenceChars)),
  }));
}

function compactMemoriesForClassification(memories: SkillMemoryEntry[]): SkillMemoryEntry[] {
  return memories.slice(0, 1).map((memory) => ({
    ...memory,
    summary: limitText(memory.summary, 120),
    reusableProcedure: "",
    evidence: [],
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
  const perWorkerBudget = Math.max(500, Math.floor(maxTotalOutputChars / Math.max(1, workerResults.length)));
  return workerResults.map((workerResult) => compactWorkerResultForPrompt(workerResult, perWorkerBudget));
}

function compactReviewsForPrompt(reviews: ReviewResult[]): ReviewResult[] {
  return reviews.slice(-4).map((review) => ({
    ...review,
    notes: limitText(review.notes, promptBudget.synthesisReviewChars),
  }));
}

function compactWorkerResultForPrompt(workerResult: WorkerResult, outputBudget: number): WorkerResult {
  return {
    ...workerResult,
    output: limitText(workerResult.output, outputBudget),
    toolEvidence: workerResult.toolEvidence?.slice(0, 2).map((item) => limitText(item, 350)),
    // Phase 28 follow-up — drop raw `toolEvidenceRecords` from the
    // serialized worker result so the synthesizer's `JSON.stringify`
    // doesn't print every `data.imageBase64` payload. The synthesizer
    // reads records via a separate, properly-rendered block — see
    // `aggregateEvidenceRecords` + the structured-evidence section in
    // `synthesizePrompt`.
    toolEvidenceRecords: undefined,
    artifacts: workerResult.artifacts?.map((artifact) => ({
      ...artifact,
      contentPreview: artifact.contentPreview ? limitText(artifact.contentPreview, 500) : undefined,
    })),
  };
}

/**
 * Phase 28 follow-up — flatten the `toolEvidenceRecords` from every
 * worker result into a single chronologically-ordered list of
 * `EvidenceRecord` entries. Used by the synthesizer + reviewer so
 * they can read tool data (pageText, numericTokens, pageTitle, …)
 * across all workers, not just one worker's prose summary.
 *
 * Returns a fresh array. Order = source-worker order, then the order
 * that the records were emitted within that worker.
 */
function aggregateEvidenceRecords(workerResults: readonly WorkerResult[]): EvidenceRecord[] {
  const acc: EvidenceRecord[] = [];
  for (const wr of workerResults) {
    const records = (wr.toolEvidenceRecords as EvidenceRecord[] | undefined) ?? [];
    for (const r of records) {
      acc.push(r);
    }
  }
  return acc;
}

function summarizeEvidenceList(evidence: string[], maxChars: number): string {
  if (evidence.length === 0) return "";
  const perItemBudget = Math.max(800, Math.floor(maxChars / evidence.length));
  return evidence.map((item) => limitText(item, perItemBudget)).join("\n\n");
}

/**
 * Phase 28 follow-up — render the structured `EvidenceRecord[]` into
 * a single text block worker / reviewer / synthesizer LLMs can read.
 *
 * Each record is formatted with its FULL semantically-useful payload
 * (tool input + output.content + output.data + saved artifact url),
 * not just a one-liner like the legacy string evidence path. Without
 * this, a screenshot tool that returns
 * `data: { pageText: "...$81,335.94 USD..." }` would have its text
 * thrown away before the model that needs to cite the price ever sees
 * it.
 *
 * `maxChars` is a soft budget: we render records newest-last (so the
 * most recent run dominates if we truncate), and each record's `data`
 * payload is per-field-capped so a single huge `data.imageBase64`
 * can't blow out the budget for the rest of the run.
 */
function formatEvidenceRecordsForPrompt(
  records: readonly EvidenceRecord[] | undefined,
  maxChars: number,
): string {
  if (!records || records.length === 0) return "";
  const lines: string[] = [];
  for (const rec of records) {
    if (rec.kind === "tool_call") {
      const inputSummary = JSON.stringify(rec.input).slice(0, 400);
      lines.push(`[tool:${rec.toolName}${rec.capability ? `:${rec.capability}` : ""}] at ${rec.timestamp}`);
      lines.push(`  input: ${inputSummary}`);
      lines.push(`  ok: ${rec.output.ok}`);
      if (rec.output.content) {
        lines.push(`  content: ${limitText(rec.output.content, 1200)}`);
      }
      if (rec.output.data !== undefined && rec.output.data !== null) {
        const dataPreview = formatToolDataForEvidenceRecord(rec.output.data, 2000);
        if (dataPreview) lines.push(`  data:\n${dataPreview}`);
      }
      if (rec.artifact) {
        lines.push(`  artifact: ${rec.artifact.filename} (${rec.artifact.mimeType}) ${rec.artifact.url}`);
      }
    } else if (rec.kind === "artifact") {
      lines.push(`[artifact:${rec.artifact.filename}] at ${rec.timestamp}`);
      lines.push(`  mimeType: ${rec.artifact.mimeType}`);
      lines.push(`  url: ${rec.artifact.url}`);
      if (rec.sourceTool) lines.push(`  fromTool: ${rec.sourceTool}`);
      if (rec.sourceUrl) lines.push(`  capturedFrom: ${rec.sourceUrl}`);
    } else {
      lines.push(`[limitation${rec.provider ? `:${rec.provider}` : ""}] at ${rec.timestamp}`);
      lines.push(`  ${limitText(rec.summary, 800)}`);
    }
    lines.push("");
  }
  return limitText(lines.join("\n"), maxChars).trim();
}

/**
 * Per-record `data` field renderer. Inlines small primitives, strings
 * up to ~700 chars, arrays up to 12 items, and explicit
 * `[<bytes>-byte base64 omitted]` placeholders so a giant
 * `data.imageBase64` doesn't trample the rest of the prompt.
 */
function formatToolDataForEvidenceRecord(data: unknown, maxChars: number): string {
  if (data === undefined || data === null) return "";
  if (typeof data === "string") return `    "${limitText(data, Math.min(maxChars, 1200))}"`;
  if (typeof data === "number" || typeof data === "boolean") return `    ${String(data)}`;
  if (Array.isArray(data)) {
    const slice = data.slice(0, 12);
    const more = data.length > slice.length ? ` (and ${data.length - slice.length} more)` : "";
    return `    [${slice.map((item) => formatToolDataValue(item, 200)).join(", ")}]${more}`;
  }
  if (typeof data === "object") {
    const record = data as Record<string, unknown>;
    const entries: string[] = [];
    let used = 0;
    for (const [key, value] of Object.entries(record)) {
      // Special-case BIG base64 fields — emit a placeholder so the
      // prompt budget isn't blown by a 30 KB PNG payload that the
      // LLM cannot use anyway.
      if (typeof value === "string" && /^[A-Za-z0-9+/=\s]+$/.test(value) && value.length > 1500) {
        entries.push(`    ${key}: <${value.length}-byte base64 omitted>`);
        continue;
      }
      const rendered = formatToolDataValue(value, 800);
      const line = `    ${key}: ${rendered}`;
      if (used + line.length > maxChars) {
        entries.push(`    [...${Object.keys(record).length - entries.length} more keys truncated...]`);
        break;
      }
      entries.push(line);
      used += line.length;
    }
    return entries.join("\n");
  }
  return "";
}

function formatToolDataValue(value: unknown, maxChars: number): string {
  if (value === undefined || value === null) return String(value);
  if (typeof value === "string") {
    if (value.length > 1500 && /^[A-Za-z0-9+/=\s]+$/.test(value)) {
      return `<${value.length}-byte base64 omitted>`;
    }
    return JSON.stringify(limitText(value, maxChars));
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const slice = value.slice(0, 8);
    const more = value.length > slice.length ? `,...+${value.length - slice.length}` : "";
    return `[${slice.map((item) => formatToolDataValue(item, 100)).join(",")}${more}]`;
  }
  return limitText(JSON.stringify(value), maxChars);
}

/**
 * Build a single text block summarizing the FULL `EvidenceRecord[]`
 * for a subtask, designed to slot under the `[Tool Evidence]` heading
 * that worker / review prompts already render. When the legacy
 * `evidence: string[]` had at least one entry the caller may keep
 * appending it for backward compatibility; the structured block sits
 * on top.
 */
function buildEvidenceTextFromRecords(records: readonly EvidenceRecord[] | undefined, maxChars: number): string {
  return formatEvidenceRecordsForPrompt(records, maxChars);
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

function buildCouncilParticipantPrompt(taskContext: string, invocation: AgentInvocation): string {
  return `
You are an independent council participant in a recursive universal-agent run.

Your local invocation:
${JSON.stringify({
  actor: invocation.actor,
  role: invocation.role,
  localTask: invocation.localTask,
  outputContract: invocation.outputContract,
  modelTier: invocation.modelTier,
  reviewStrictness: invocation.reviewStrictness,
  budget: invocation.budget,
}, null, 2)}

Full task context:
${limitText(taskContext, promptBudget.taskContextChars)}

Return a compact advisory note for the parent agent:
- proposal or critique;
- key risks and assumptions;
- evidence or tools that should be reused, collected, or avoided;
- duplicated work to avoid;
- one clear recommendation for the execution plan.
`.trim();
}

function withCouncilNotes(taskContext: string, councilNotes: string[]): string {
  if (councilNotes.length === 0) return taskContext;
  return `${taskContext}

Council advisory notes:
${councilNotes.map((note, index) => `Council note ${index + 1}:\n${note}`).join("\n\n")}`;
}

function formatCouncilNote(invocation: AgentInvocation, output: string): string {
  return [
    `${invocation.actor} (${invocation.modelTier}, ${invocation.councilParticipant?.focus ?? invocation.role})`,
    limitText(output, promptBudget.synthesisWorkerOutputChars),
  ].join(":\n");
}

function buildClassificationContext(task: string, options: RunOptions, now: Date): string {
  const lines: string[] = [`Task: ${limitText(task, promptBudget.classificationContextChars)}`];

  const profile = options.instanceContext?.groupProfile;
  if (profile) {
    const profileParts = [
      `group=${profile.name}`,
      profile.description.trim() ? `description=${limitText(profile.description.trim(), 220)}` : undefined,
    ].filter(Boolean);
    if (profileParts.length > 0) lines.push(`Instance: ${profileParts.join("; ")}`);
  }

  const requester = options.instanceContext?.requesterUser;
  if (requester) {
    lines.push(`Requester: ${requester.displayName} (${requester.id})`);
  }

  if (options.threadContext?.summary) {
    lines.push(`Thread summary: ${limitText(options.threadContext.summary, 220)}`);
  }

  const timeZone = options.timeZone ?? process.env.AGENT_TIME_ZONE ?? process.env.TZ ?? "Europe/Madrid";
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  lines.push(`Runtime: current_date=${localDate}; time_zone=${timeZone}`);

  return lines.join("\n");
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isContextWindowError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  return /context (?:size|length)|context window|n_keep|n_ctx|maximum context/i.test(message);
}

function buildCompactSynthesisFallback(
  task: string,
  workerResults: WorkerResult[],
  reviews: ReviewResult[],
  artifacts: AgentArtifact[],
  error: unknown,
): string {
  const passedWorkers = workerResults.filter((worker) =>
    reviews.some((review) => review.subtaskId === worker.subtask.id && review.verdict === "pass"),
  );
  const failedReviews = reviews.filter((review) => review.verdict !== "pass").slice(-3);
  const artifactLines = artifacts.slice(0, 5).map((artifact) =>
    `- ${artifact.filename}: ${artifact.url}`,
  );
  const workerLines = (passedWorkers.length > 0 ? passedWorkers : workerResults).slice(-3).map((worker) =>
    `- ${worker.subtask.title}: ${limitText(worker.output, 280).replace(/\s+/g, " ")}`,
  );

  return [
    "Не удалось собрать полноценный финальный ответ: локальная модель не вместила финальный synthesis prompt.",
    `Техническая причина: ${limitText(formatErrorMessage(error), 240)}`,
    "",
    `Исходная задача: ${limitText(task, 240)}`,
    "",
    workerLines.length > 0 ? `Что уже удалось выполнить:\n${workerLines.join("\n")}` : undefined,
    failedReviews.length > 0
      ? `Что не прошло проверку:\n${failedReviews.map((review) => `- ${limitText(review.notes, 220).replace(/\s+/g, " ")}`).join("\n")}`
      : undefined,
    artifactLines.length > 0 ? `Артефакты:\n${artifactLines.join("\n")}` : undefined,
    "",
    "Системный вывод: ран не должен падать на этом этапе; нужно еще сильнее дробить широкий research на короткие доказательные блоки и не тащить все evidence в один финальный LLM-вызов.",
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
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
    formatScreenshotReuseDirective(task, threadContext.relevantArtifacts),
  ].filter(Boolean);

  return `${task}

${lines.join("\n")}`;
}

/**
 * Phase 13 follow-up: when the user asks "send me a screenshot proof"
 * (in any language) of something the prior turn already produced, the
 * planner used to invent a `get-live-screenshot` subtask anyway —
 * driving Chromium through an unrelated capture and then tripping a
 * tool-missing failure path. The thread artifacts directive in
 * `formatThreadArtifacts` was too soft to override that habit, so this
 * helper surfaces a sharper, screenshot-specific instruction whenever
 * the task asks for a screenshot AND the thread already carries PNG
 * artifacts. Returns `undefined` when the case doesn't apply, so the
 * directive is silent for the common path.
 */
function formatScreenshotReuseDirective(
  task: string,
  artifacts: AgentArtifact[] | undefined,
): string | undefined {
  if (!artifacts || artifacts.length === 0) return undefined;
  if (!asksForScreenshot(task) && !/proof|доказательств|пруф|подтвержд/i.test(task)) return undefined;
  const pngs = artifacts.filter(
    (artifact) => artifact.mimeType === "image/png" || artifact.filename?.toLowerCase().endsWith(".png"),
  );
  if (pngs.length === 0) return undefined;

  const idList = pngs.map((p) => `${p.id} (${p.filename ?? "unnamed"})`).join("; ");
  return [
    "Screenshot reuse directive:",
    `The current request asks for a screenshot / proof, AND the conversation thread already contains ${pngs.length} reusable PNG artifact(s): ${idList}.`,
    "Do NOT plan a fresh `get-live-screenshot`, `capture-bitcoin-page`, or any other browser-driven capture subtask.",
    "Instead plan ONE attach-and-respond subtask that references the existing artifact id(s) by URL and finishes the turn. The synthesizer is responsible for the final markdown.",
  ].join("\n");
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

function appendAgentRuntimeStrategyContext(
  task: string,
  strategy: AgentStrategyDecision,
  rootInvocation: AgentInvocation,
  hasLedger: boolean,
  pendingToolImprovementCount: number,
  recursiveLoopPlan?: RecursiveAgentLoopPlan,
): string {
  const matchedTools = strategy.toolPolicy.matchedToolNames.length > 0
    ? strategy.toolPolicy.matchedToolNames.join(", ")
    : "none";
  const missingCapabilities = strategy.toolPolicy.missingCapabilityHints.length > 0
    ? strategy.toolPolicy.missingCapabilityHints.join(", ")
    : "none";
  const council = strategy.council
    ? [
        `Council: ${strategy.council.reason}`,
        `Council participants: ${strategy.council.participants.map((participant) =>
          `${participant.role}/${participant.modelTier}`,
        ).join(", ")}`,
      ]
    : ["Council: not required"];

  return `${task}

Agent runtime strategy:
- Primary strategy: ${strategy.primary}
- Invocation: ${summarizeAgentInvocation(rootInvocation)}
- Allowed actions: ${strategy.actions.join(", ")}
- Model tier: ${strategy.modelTier}
- Review strictness: ${strategy.reviewStrictness}
- Child budget: maxDepth=${strategy.maxChildDepth}, maxParallelChildren=${strategy.maxParallelChildren}
- Work Ledger available: ${hasLedger ? "yes" : "no"}
- Work Ledger policy: check=${strategy.ledgerPolicy.shouldCheck}, reuseFresh=${strategy.ledgerPolicy.reuseFreshEvidence}, waitForInFlight=${strategy.ledgerPolicy.waitForInFlight}, revalidateStaleOrFailed=${strategy.ledgerPolicy.revalidateStaleOrFailed}
- Matched tools: ${matchedTools}
- Missing capability hints: ${missingCapabilities}
- Tool policy: mayCall=${strategy.toolPolicy.mayCallTools}, mayRequestBuild=${strategy.toolPolicy.mayRequestBuild}, mayRequestRework=${strategy.toolPolicy.mayRequestRework}
- Pending tool improvement waits: ${pendingToolImprovementCount}
- Recursive loop execution mode: ${recursiveLoopPlan?.executionMode ?? "not-computed"}
- Recursive loop actions: ${recursiveLoopPlan?.actions.join(", ") ?? "not-computed"}
- Recursive loop reason: ${recursiveLoopPlan?.reason ?? "not-computed"}
${council.map((line) => `- ${line}`).join("\n")}

Agent operating rules:
- Use the allowed actions above as your local capability menu; do not invent hidden abilities.
- Before repeating search, browser, API, file, or artifact work, prefer reusable thread artifacts and Work Ledger evidence when available.
- If another branch is already doing the same expensive work, wait for or reuse that evidence instead of duplicating it.
- If an available tool is insufficient, describe a reusable versioned tool improvement with acceptance criteria rather than a one-off workaround.
- Before returning to the caller, self-check that the answer, evidence, artifacts, and limitations satisfy the local invocation contract.`;
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

function buildExternalActionBlockerFinalAnswer(
  task: string,
  workerResults: WorkerResult[],
  artifacts: AgentArtifact[],
): string | undefined {
  const hasExternalActionWork = workerResults.some((workerResult) =>
    workerResult.subtask?.id?.startsWith("external-action") ||
    /external action|appointment|reservation|booking|final submit|commit boundary|prepare/i.test(
      [
        workerResult.subtask?.title,
        workerResult.subtask?.prompt,
        workerResult.subtask?.expectedOutput,
      ].join("\n"),
    ),
  );
  if (!hasExternalActionWork) return undefined;

  const evidenceText = buildSynthesisEvidenceCorpus(task, workerResults, artifacts);
  const blocker = detectExternalActionPreparationBlocker(evidenceText);
  if (!blocker) return undefined;

  const providerUrl = pickExternalActionProviderUrl(evidenceText);
  const proofArtifact = artifacts.find((artifact) => artifact.kind === "output") ?? artifacts[0];
  const russian = /[а-яё]/i.test(task);
  const blockerReason = formatExternalActionBlockerReason(blocker, russian);

  if (!russian) {
    return [
      "I could not prepare the external action to a safe pre-submit state.",
      "",
      `Reason: ${blockerReason}.`,
      providerUrl ? `Provider/page checked: ${providerUrl}` : undefined,
      proofArtifact ? `Proof artifact: ${proofArtifact.filename} (${proofArtifact.url})` : "No usable proof artifact was created.",
      "",
      "Nothing was submitted externally. There is no booking/request confirmation.",
      "Next step: sign in/create the required provider account, solve the provider challenge, or choose another provider/action page and retry preparation.",
    ].filter(Boolean).join("\n");
  }

  return [
    "Подготовить внешнее действие до безопасного pre-submit состояния не удалось.",
    "",
    `Причина: ${blockerReason}.`,
    providerUrl ? `Проверенная страница: ${providerUrl}` : undefined,
    proofArtifact ? `Пруф: ${proofArtifact.filename} (${proofArtifact.url})` : "Пруф-артефакт создать не удалось.",
    "",
    "Внешняя отправка не выполнялась. Подтверждения записи/заявки нет.",
    "Следующий шаг: войти или создать аккаунт у провайдера, пройти проверку провайдера, либо выбрать другой сайт/провайдера и повторить подготовку.",
  ].filter(Boolean).join("\n");
}

function formatExternalActionBlockerReason(blocker: string, russian: boolean): string {
  if (!russian) return blocker;
  if (/login|account|authentication|create an account|sign in/i.test(blocker)) {
    return "провайдер требует вход, создание аккаунта или пользовательскую аутентификацию до состояния, где можно безопасно подготовить отправку";
  }
  if (/captcha|bot-check|robot|human/i.test(blocker)) {
    return "провайдер показывает CAPTCHA или проверку на человека до состояния, где можно безопасно подготовить отправку";
  }
  if (/unavailable|not found/i.test(blocker)) {
    return "страница провайдера недоступна или не найдена";
  }
  if (/unresolved fields|blockers/i.test(blocker)) {
    return "подготовка формы обнаружила обязательные незаполненные поля или блокеры до финальной отправки";
  }
  if (/QA-passed proof artifact/i.test(blocker)) {
    return "браузерная подготовка не дала пригодного proof-артефакта";
  }
  return blocker;
}

function pickExternalActionProviderUrl(evidenceText: string): string | undefined {
  const urls = extractHttpUrls(evidenceText).filter((url) => !isLowValueProofUrl(url));
  const directActionUrl = urls.find((url) => isActionableExternalActionUrl(url, evidenceText));
  return directActionUrl ?? urls[0];
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

/**
 * Phase 12 follow-up: collect every artifact a worker produced during the
 * run, regardless of whether the review passed it. Used for the
 * `run-completed` event (and the UI / API) so users can still see the
 * screenshots / files that were actually captured even when every worker
 * went `needs_revision`. The `getApprovedArtifacts` set remains the
 * source of truth for what synthesis is allowed to cite as proof.
 *
 * Phase 13 follow-up: walk **every attempt** of each subtask, not just
 * the latest revised `workerResult`. Without this, an initial worker
 * that captured 3 PNG screenshots followed by a `needs_revision` review
 * and a stripped revision (zero new artifacts) would lose all 3
 * screenshots from `run-completed` / `thread.artifact_ids`. That, in
 * turn, breaks every downstream feature that relies on thread artifact
 * carry-over (Bug A reuse, follow-up "send a screenshot" requests).
 */
function getAllWorkerArtifacts(results: ReviewedWorkerResult[]): AgentArtifact[] {
  return results.flatMap((result) => {
    const attempts = result.attempts && result.attempts.length > 0 ? result.attempts : [result.workerResult];
    return attempts.flatMap((attempt) => attempt.artifacts ?? []);
  });
}

function asksForScreenshot(task: string): boolean {
  return /screenshot|screen\s*capture|capture\s+page|скриншот|скрин|снимок\s+экрана|заскрин|зафиксируй\s+экран/i.test(
    task,
  );
}

function stripRuntimeContext(task: string): string {
  const marker = "\n\nRuntime context:";
  const index = task.indexOf(marker);
  return index >= 0 ? task.slice(0, index).trim() : task;
}

function shouldCollectWebSearch(subtask: Subtask, text: string, dependencyContext?: string): boolean {
  if (isLocalUtilityToolchainSubtask(subtask)) return false;
  const requiredTools = subtask.requiredTools ?? [];
  const hasExplicitUrls = extractHttpUrls(text).length > 0;
  const onlyNeedsKnownUrl = hasExplicitUrls && !explicitlyRequestsDiscovery(text);
  const hasDependencyUrls = extractHttpUrls(dependencyContext ?? "").length > 0;
  const isDependent = Boolean(dependencyContext) && (subtask.dependsOn?.length ?? 0) > 0;
  const isDependentSynthesisOrReview =
    isDependent &&
    /(analyst|reviewer|synthesizer|audit|quality)/i.test(`${subtask.role} ${subtask.title}`) &&
    /using|provided|dependency|review|synthesize|audit|анализ|проверь|используя/i.test(text);
  const explicitlyCollectsNewExternalData = /perform\s+(?:a\s+)?(?:real-time\s+)?(?:web\s+)?search|collect\s+(?:new|additional|more)\s+(?:web\s+)?data|find\s+(?:new|additional|more|alternative)|use\s+at\s+least|check\s+(?:external|current)|найди\s+(?:нов|актуаль|дополнительн|еще)|искать\s+(?:нов|актуаль|дополнительн)|дополнительн(?:ые|ых)?\s+источник/i.test(
    text,
  );
  const usesPriorDependency = /\b(using|from|provided|previous|earlier|dependency|upstream|list from|urls from)\b|используя|из\s+(?:предыдущ|списк|найден)|полученн|зависим/i.test(
    text,
  );
  if (isDependent && usesPriorDependency && !explicitlyCollectsNewExternalData) return false;
  if (isDependent && hasDependencyUrls && !explicitlyCollectsNewExternalData) return false;
  if (isDependentSynthesisOrReview && !explicitlyCollectsNewExternalData) return false;
  if (onlyNeedsKnownUrl) return false;

  return (
    shouldUseWebSearch(text) ||
    requiredTools.some((tool) =>
      ["web.search", "web-search", "research", "current-information"].includes(tool.toLowerCase()),
    )
  );
}

function isLocalUtilityToolchainSubtask(subtask: Subtask): boolean {
  const toolNames = new Set([
    ...(subtask.requiredTools ?? []),
    ...Object.keys(subtask.toolInputs ?? {}),
  ].map((toolName) => toolName.toLowerCase()));
  if (toolNames.size === 0) return false;
  const localTools = ["document.extract", "data.transform", "file.read", "file.write"];
  return [...toolNames].some((toolName) => localTools.includes(toolName)) &&
    ![...toolNames].some((toolName) => ["web.search", "web-search", "browser.operate", "browser-operate"].includes(toolName));
}

function shouldPrepareExternalAction(subtask: Subtask, text: string): boolean {
  if (!isExternalActionBoundarySubtask(subtask)) return false;

  const requestedTools = (subtask.requiredTools ?? []).map((tool) => tool.toLowerCase());
  if (
    requestedTools.some((tool) =>
      ["external.action.prepare", "external-action-prepare", "form-preparation", "commit-boundary"].includes(tool),
    )
  ) {
    return true;
  }
  return /\bexternal\.action\.prepare\b|\bexternal action draft\b|\bcommit boundary\b|\bapproval boundary\b|черновик\s+действ|границ[ауы]\s+(?:апрув|одобр|отправ|commit)/i.test(
    `${subtask.title}\n${subtask.prompt}\n${text}`,
  );
}

function subtaskCanPrepareExternalAction(subtask: Subtask): boolean {
  if (subtask.id === "external-action-approval-draft") return true;
  const requestedTools = (subtask.requiredTools ?? []).map((tool) => tool.toLowerCase());
  if (
    requestedTools.some((tool) =>
      ["external.action.prepare", "external-action-prepare", "form-preparation", "commit-boundary"].includes(tool),
    )
  ) {
    return true;
  }
  return Object.keys(subtask.toolInputs ?? {}).some((toolName) =>
    ["external.action.prepare", "external-action-prepare"].includes(toolName.toLowerCase()),
  );
}

function isExternalActionBoundarySubtask(subtask: Subtask): boolean {
  const requestedTools = (subtask.requiredTools ?? []).map((tool) => tool.toLowerCase());
  if (
    requestedTools.some((tool) =>
      [
        "external.action.prepare",
        "external-action-prepare",
        "external.action.commit",
        "external-action-commit",
        "form-preparation",
        "commit-boundary",
      ].includes(tool),
    )
  ) {
    return true;
  }

  const localText = `${subtask.role} ${subtask.title} ${subtask.prompt}`.toLowerCase();
  return (
    /\b(external action|action draft|approval|commit boundary|commit|submit externally|final submit|prepare external)\b/.test(
      localText,
    ) || /\b(черновик\s+действ|одобр|апрув|границ|финальн\w*\s+отправ|внешн\w*\s+действ|подтвержд)\b/.test(localText)
  );
}

function buildExternalActionPrepareInput(
  originalTask: string,
  subtask: Subtask,
  text: string,
  evidenceText: string,
): Record<string, unknown> {
  const sourceText = `${evidenceText}\n${text}`;
  const urls = extractHttpUrls(sourceText).filter((url) => !isLowValueProofUrl(url));
  const targetUrl = urls.find((url) => !isShallowLandingUrl(url)) ?? urls[0];
  return {
    goal: limitText(originalTask, 1_200),
    targetName: inferExternalActionTargetName(subtask, sourceText),
    targetUrl,
    action: inferExternalActionDescription(subtask, text),
    data: {
      userRequest: limitText(originalTask, 1_200),
      preparedFromEvidence: limitText(evidenceText, 2_000),
    },
    commitBoundary:
      "Stop before any provider-side submit, confirm, payment, send, reserve, book, delete, or state-changing control. Final external submission requires explicit approval and external.action.commit.",
    proofRequired: true,
    approvalMode: /automode|auto mode|автомод/i.test(`${originalTask}\n${text}`) ? "automode" : "manual",
  };
}

function inferExternalActionTargetName(subtask: Subtask, evidenceText: string): string {
  const candidates = [
    subtask.title,
    ...evidenceText
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.length <= 120 && !/^https?:\/\//i.test(line)),
  ];
  return candidates.find(Boolean)?.replace(/\s+/g, " ").slice(0, 120) || "external provider";
}

function inferExternalActionDescription(subtask: Subtask, text: string): string {
  const source = [subtask.expectedOutput, subtask.prompt, text].find((item) => item && item.trim().length > 0) ?? "";
  const sentence = source
    .split(/(?<=[.!?])\s+|\n+/)
    .map((item) => item.trim())
    .find(Boolean);
  return limitText(sentence || `Prepare external action for ${subtask.title}`, 600);
}

function shouldCollectWebRead(subtask: Subtask, text: string): boolean {
  if (extractHttpUrls(text).length === 0) return false;
  const requestedTools = (subtask.requiredTools ?? []).map((tool) => tool.toLowerCase());
  if (requestedTools.some((tool) => ["web.read", "web-read", "page-reading", "html-extraction"].includes(tool))) {
    return true;
  }
  if (shouldPreferHttpRequestForUrls(subtask, text)) return false;
  return !explicitlyRequestsDiscovery(text) || asksForScreenshot(text);
}

function shouldPreferHttpRequestForUrls(subtask: { requiredTools?: string[] }, text: string): boolean {
  if (extractHttpUrls(text).length === 0) return false;
  const requestedTools = (subtask.requiredTools ?? []).map((tool) => tool.toLowerCase());
  if (
    requestedTools.some((tool) =>
      ["http.request", "http-request", "api-client", "json-api", "webhook-client"].includes(tool),
    )
  ) {
    return true;
  }
  return /\b(?:http|api|json|endpoint|request|curl|webhook)\b|апи|эйпиай|джсон|запрос/i.test(text) && !asksForScreenshot(text);
}

function explicitlyRequestsDiscovery(text: string): boolean {
  return /\b(?:search|find|research|discover|compare|rank|best|alternatives?|options?)\b|найди|искать|исслед|подбери|сравн|лучши|вариант/i.test(
    text,
  );
}

function shouldCollectBrowserDiscovery(
  subtask: Subtask,
  text: string,
  intents: string[],
): boolean {
  const requestedTools = (subtask.requiredTools ?? []).map((tool) => tool.toLowerCase());
  if (requestedTools.some((tool) => ["browser-operate", "browser.operate", "dom-extraction"].includes(tool))) {
    return true;
  }
  if (isExternalActionBoundarySubtask(subtask)) return false;
  // Phase 12 Slice E: domain-specific anchors moved into intentInference.ts.
  // Discovery fires on generic discovery + interactive-source signals OR when
  // the classifier (or its regex fallback) reported any known task intent.
  return (isDiscoveryText(text) && wantsInteractiveSource(text)) || intents.length > 0;
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
  const isGenericHttpTool =
    tool.name === "http.request" ||
    tool.capabilities.some((capability) =>
      ["http-request", "api-client", "json-api", "webhook-client"].includes(capability),
    );
  if (isGenericHttpTool) {
    const url = extractHttpUrls(text)[0];
    if (!url || !/\b(?:http|api|json|endpoint|request|curl|webhook)\b|апи|эйпиай|джсон|запрос/i.test(text)) {
      return undefined;
    }
    return {
      url,
      method: inferHttpMethod(text),
      responseType: /\bjson\b|джсон|api|апи|эйпиай/i.test(text) ? "json" : "auto",
      maxBytes: 1_000_000,
    };
  }

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

function inferHttpMethod(text: string): string {
  const upper = text.toUpperCase();
  for (const method of ["DELETE", "PATCH", "POST", "PUT", "HEAD", "GET"]) {
    if (new RegExp(`\\b${method}\\b`).test(upper)) return method;
  }
  return "GET";
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

function buildSearchQueries(
  subtask: Subtask,
  contextText = "",
  _intents: string[] = [],
): string[] {
  // Phase 12 final: a single search query from the planner-produced
  // subtask. We do not regex the prompt for specific source names, country
  // dictionaries, or domain-specific seed queries — the planner already
  // wrote what it wants searched, and any specific source it chose to name
  // is preserved verbatim in `subtask.title` / `subtask.prompt`.
  const promptLines = subtask.prompt
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((line) => stripSearchExecutionDetails(line.replace(/^[-*\d.\s:]+/, "").trim()))
    .filter(Boolean);
  const leadLine = promptLines.find((line) => /search|find|найди|искать|research/i.test(line)) ?? promptLines[0] ?? "";
  const title = stripSearchExecutionDetails(subtask.title);
  const primary = cleanSearchQuery(`${title} ${leadLine}`);
  if (!primary) return [];
  const marketQuery = buildMarketAwareSearchQuery(primary, `${subtask.title}\n${subtask.prompt}\n${contextText}`);
  const domainQuery = buildDomainAwareSearchQuery(primary, `${subtask.title}\n${subtask.prompt}\n${contextText}`);
  return uniqueStrings([primary, marketQuery, domainQuery].filter((query): query is string => Boolean(query)));
}

function getExplicitToolInputString(subtask: Subtask, toolName: string, key: string): string | undefined {
  const input = subtask.toolInputs?.[toolName];
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stripSearchExecutionDetails(value: string): string {
  return value
    .replace(/\b(?:must|you must|need to|once|after that|then)\b.*$/gi, " ")
    .replace(/\b(?:verify|check)\s+(?:specific\s+)?availability\b/gi, " ")
    .replace(/\b(?:available|availability|time slots?|slot)\b.*$/gi, " ")
    .replace(/\b(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+[A-Z][a-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b(?:after|before|at)\s+\d{1,2}[:.]\d{2}\b/gi, " ")
    .replace(/\b[A-Z][a-z]+ Test\b/g, " ")
    .replace(/[+]?[\d\s().-]{8,}/g, " ")
    .replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildMarketAwareSearchQuery(primary: string, contextText: string): string | undefined {
  if (!isMarketSensitiveSearch(`${primary}\n${contextText}`)) return undefined;
  const hints = inferMarketSearchHints(contextText);
  if (hints.length === 0) return undefined;
  const normalizedPrimary = normalizeAnchorTerm(primary);
  const missingHints = hints.filter((hint) => !normalizedPrimary.includes(normalizeAnchorTerm(hint)));
  if (missingHints.length === 0) return undefined;
  return cleanSearchQuery(`${primary} ${missingHints.join(" ")}`);
}

function buildDomainAwareSearchQuery(primary: string, contextText: string): string | undefined {
  const domains = extractSearchDomains(contextText).slice(0, 3);
  if (domains.length === 0) return undefined;
  const normalizedPrimary = normalizeAnchorTerm(primary);
  const missingDomains = domains.filter((domain) => !normalizedPrimary.includes(normalizeAnchorTerm(domain)));
  if (missingDomains.length === 0) return undefined;
  const siteClauses = missingDomains.map((domain) => `site:${domain}`);
  return cleanSearchQuery(`${primary} ${siteClauses.join(" OR ")}`);
}

function extractSearchDomains(text: string): string[] {
  const domains = new Set<string>();
  for (const match of text.matchAll(/\b(?:site:)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[^\s),.;]*)?/gi)) {
    const rawDomain = match[1];
    const domainStart = match.index + match[0].indexOf(rawDomain ?? "");
    const domainEnd = domainStart + (rawDomain?.length ?? 0);
    if (text[domainEnd] === "@" || text[Math.max(0, domainStart - 1)] === "@") continue;
    const domain = match[1]?.replace(/^www\./i, "").toLowerCase();
    if (!domain || isLowValueSearchDomain(domain)) continue;
    domains.add(domain);
  }
  return [...domains].slice(0, 8);
}

function isLowValueSearchDomain(domain: string): boolean {
  const tld = domain.split(".").at(-1) ?? "";
  return [
    "example.com",
    "localhost",
    "127.0.0.1",
    "web.search",
    "web.read",
    "web.write",
    "browser.operate",
    "browser.screenshot",
    "http.request",
    "data.transform",
    "document.extract",
    "external.action",
    "external.action.prepare",
    "external.action.commit",
    "channel.telegram",
  ].includes(domain) ||
    [
      "test",
      "local",
      "search",
      "read",
      "write",
      "operate",
      "screenshot",
      "request",
      "transform",
      "extract",
      "telegram",
      "prepare",
      "commit",
    ].includes(tld);
}

function isMarketSensitiveSearch(text: string): boolean {
  return /\b(?:best|recommend|compare|buy|purchase|price|budget|under|available|availability|book|booking|appointment|reserve|reservation|schedule|near|local)\b|лучши|рекоменд|сравн|купить|покуп|цена|бюджет|доступн|заброни|брон|запис|рядом|локальн/i.test(
    text,
  );
}

function inferMarketSearchHints(text: string): string[] {
  const hints = new Set<string>();
  const explicitLocationTerms = extractGeographicAnchorTerms(text);
  for (const term of explicitLocationTerms) {
    if (!isGenericAnchorTerm(term)) hints.add(capitalizeSearchHint(term));
  }
  for (const phrase of extractProfileLocationPhrases(text)) hints.add(phrase);
  if (/\b(?:usd|dollars?)\b|доллар/i.test(text)) hints.add("USD");
  if (/\b(?:eur|euros?)\b|евро/i.test(text)) hints.add("EUR");
  return [...hints].slice(0, 5);
}

function extractProfileLocationPhrases(text: string): string[] {
  const phrases = new Set<string>();
  const patterns = [
    /\b(?:lives?|located|based)\s+in\s+([\p{Lu}][\p{L}\p{M}' -]{2,40})(?:,\s*([\p{Lu}][\p{L}\p{M}' -]{2,40}))?/gu,
    /\b(?:живет|живут|находится|базируется)\s+(?:в|во)\s+([\p{Lu}][\p{L}\p{M}' -]{2,40})(?:,\s*([\p{Lu}][\p{L}\p{M}' -]{2,40}))?/gu,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      for (const group of [match[1], match[2]]) {
        const value = group?.trim();
        if (!value) continue;
        const normalized = normalizeAnchorTerm(value);
        if (normalized.length < 3 || isGenericAnchorTerm(normalized)) continue;
        phrases.add(value);
      }
    }
  }
  if (/time_zone=Europe\/Madrid|Europe\/Madrid/i.test(text)) {
    phrases.add("Spain");
  }
  return [...phrases];
}

function capitalizeSearchHint(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function extractGeographicAnchorTerms(text: string): string[] {
  const terms = new Set<string>();
  const patterns = [
    /\b(?:in|near|around|located\s+in|within)\s+([\p{Lu}][\p{L}\p{M}' -]{2,50})/gu,
    /(?:^|[\s,.;:])(?:в|во|около|рядом\s+с|внутри)\s+([\p{Lu}][\p{L}\p{M}' -]{2,50})/gu,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const phrase = match[1] ?? "";
      for (const term of phrase.split(/[^\p{L}\p{M}]+/u)) {
        const normalized = normalizeAnchorTerm(term);
        if (isAnchorConnectorTerm(normalized)) break;
        if (normalized.length >= 4 && !isGenericAnchorTerm(normalized)) terms.add(normalized);
      }
    }
  }
  return [...terms].slice(0, 6);
}

function evidenceUrlMatchesAnchor(evidenceText: string, url: string, anchorTerms: string[]): boolean {
  const normalizedUrl = normalizeAnchorTerm(url);
  if (anchorTerms.some((term) => normalizedUrl.includes(term))) return true;
  const lines = evidenceText.split(/\n/);
  const lineIndex = lines.findIndex((line) => line.includes(url));
  const context = lineIndex >= 0
    ? lines
        .slice(Math.max(0, lineIndex - 1), Math.min(lines.length, lineIndex + 3))
        .join("\n")
    : "";
  const normalizedContext = normalizeAnchorTerm(context);
  return anchorTerms.some((term) => normalizedContext.includes(term));
}

function normalizeAnchorTerm(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function isGenericAnchorTerm(term: string): boolean {
  return [
    "online",
    "booking",
    "available",
    "availability",
    "under",
    "converted",
    "friday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "saturday",
    "sunday",
    "список",
    "онлайн",
  ].includes(term);
}

function isAnchorConnectorTerm(term: string): boolean {
  return [
    "that",
    "which",
    "with",
    "where",
    "and",
    "when",
    "after",
    "before",
    "from",
    "который",
    "которая",
    "которые",
    "где",
    "и",
    "что",
    "после",
    "перед",
    "для",
  ].includes(term);
}

function cleanSearchQuery(value: string): string {
  return value
    .replace(/[`*_#>]/g, " ")
    .replace(/\bIMPORTANT\b:?/gi, " ")
    .replace(/\bmust\b|\byou\b|\busing\b|\bextract\b|\bprovide\b|\bcapture\b/gi, " ")
    .replace(/[^\p{L}\p{N}\s().,:\-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function assessSearchEvidenceForReuse(
  evidenceText: string,
  query: string,
): {
  sourceUrls: string[];
  distinctSourceCount: number;
  confidence: number;
  qaStatus: "passed" | "partial" | "failed";
  limitations: string[];
} {
  const sourceUrls = extractHttpUrls(evidenceText).filter((url) => !isLowValueProofUrl(url));
  const distinctSourceCount = new Set(sourceUrls.map((url) => normalizedHost(url)).filter(Boolean)).size;
  const limitations: string[] = [];
  if (sourceUrls.length === 0) limitations.push("Search result did not expose reusable source URLs.");
  const normalizedEvidence = normalizeAnchorTerm(evidenceText);
  for (const hint of inferMarketSearchHints(query)) {
    const normalizedHint = normalizeAnchorTerm(hint);
    if (normalizedHint && !normalizedEvidence.includes(normalizedHint)) {
      limitations.push(`Search result does not visibly support market/context hint: ${hint}.`);
    }
  }
  if (/\b(?:usd|dollars?)\b|доллар/i.test(query) && /\b(?:rub|rur|руб(?:\.|л|лей)?)\b/i.test(evidenceText) && !/\b(?:usd|dollars?)\b|доллар/i.test(evidenceText)) {
    limitations.push("Search result appears to use a different currency than the requested USD budget.");
  }
  const broadOrCurrent = /\b(?:current|latest|fresh|today|now|recent|best|compare|recommend|availability|price|book|appointment|reserve)\b|сейчас|сегодня|актуальн|последн|лучши|сравн|рекоменд|цена|доступн|заброни|запис/i.test(
    query,
  );
  if (broadOrCurrent && distinctSourceCount < 2) {
    limitations.push("Broad/current search result has fewer than two distinct source hosts.");
  }
  const confidence = sourceUrls.length === 0 ? 0.2 : limitations.length > 0 ? 0.45 : distinctSourceCount >= 3 ? 0.85 : 0.72;
  return {
    sourceUrls: sourceUrls.slice(0, 8),
    distinctSourceCount,
    confidence,
    qaStatus: limitations.length === 0 ? "passed" : sourceUrls.length > 0 ? "partial" : "failed",
    limitations,
  };
}

function mergeToolResults(results: Awaited<ReturnType<Tool["run"]>>[]): Awaited<ReturnType<Tool["run"]>> {
  const ok = results.some((result) => result.ok);
  const lines: string[] = [];
  const seenUrls = new Set<string>();
  const data: unknown[] = [];

  for (const result of results) {
    // Phase 28 follow-up — accept the TWO shapes search tools
    // actually return:
    //   (a) data is an array of result objects (legacy / some
    //       builtins)
    //   (b) data is `{ results: [...] }` — natural shape when the
    //       outputSchema declares `data: { type: "object",
    //       properties: { results: { type: "array", ... } } }`,
    //       which is what every council-built search tool we've
    //       generated does (the LLM picks that shape).
    // Previously we only handled (a); council-built searches ended
    // up with `data: []` here and the agent lost every URL the tool
    // worked hard to produce.
    const resultItems: unknown[] = Array.isArray(result.data)
      ? result.data
      : result.data && typeof result.data === "object" && Array.isArray((result.data as { results?: unknown }).results)
        ? (result.data as { results: unknown[] }).results
        : [];
    for (const item of resultItems) {
      const url = typeof item === "object" && item && "url" in item ? String((item as { url?: unknown }).url) : "";
      if (url && seenUrls.has(url)) continue;
      if (url) seenUrls.add(url);
      data.push(item);
    }
    if (result.content) lines.push(result.content);
  }

  // Phase 28 follow-up — also surface result URLs in the merged
  // `content` text so downstream `extractHttpUrls` (which only
  // reads text) can find them. Without this, every search result
  // URL stayed buried inside the structured `data` field, and the
  // screenshot pipeline saw the tool's "Found 5 results" summary
  // with no URL to feed `screenshot.url`. Each line as
  // `- TITLE — URL` so the text reads naturally for the worker
  // LLM too.
  const urlLines: string[] = [];
  for (const item of data) {
    if (typeof item !== "object" || !item) continue;
    const rec = item as Record<string, unknown>;
    const url = typeof rec.url === "string" ? rec.url : "";
    if (!url) continue;
    const title = typeof rec.title === "string" ? rec.title.slice(0, 120) : "";
    // Phase 28 follow-up — include the snippet too. Search-result
    // snippets typically carry the actual factual answer the user
    // is asking about (price, date, version, location). Without
    // them in the evidence text, the worker LLM sees only titles
    // and URLs and reports "value not found in evidence" — even
    // though the DDG tool happily returned a snippet like
    // "The live Bitcoin price today is $79,661.91 USD with a
    // 24-hour trading volume of $36,837,381,984.16 USD". Promoting
    // snippets into the text the worker actually reads is the
    // single highest-impact change for factual question-answering.
    const snippet = typeof rec.snippet === "string" ? rec.snippet.slice(0, 500) : "";
    const head = title ? `- ${title} — ${url}` : `- ${url}`;
    urlLines.push(snippet ? `${head}\n  ${snippet}` : head);
  }
  const mergedContent = (urlLines.length > 0
    ? `${lines.join("\n\n")}\n\nResults:\n${urlLines.join("\n")}`
    : lines.join("\n\n")
  ).slice(0, 8000);

  return {
    ok,
    content: mergedContent,
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
    const structuredEvidence = formatBrowserOperateStructuredEvidence(result.data);
    const extractedText = result.data.extractedText
      .map((item) => `\n[${item.label}]\n${item.text.slice(0, 2500)}`)
      .join("\n");
    return limitText(
      `Declared tool evidence from ${toolName}:\n${result.content}${artifactText}${structuredEvidence}${extractedText}`,
      promptBudget.toolEvidenceChars,
    );
  }

  const dataText = formatToolDataEvidence(result.data);
  return limitText(`Declared tool evidence from ${toolName}:\n${result.content}${dataText}${artifactText}`, promptBudget.toolEvidenceChars);
}

function formatBrowserOperateStructuredEvidence(data: BrowserOperateData): string {
  const sections: string[] = [];
  const actionState = summarizeBrowserActionState(data);
  if (actionState) {
    sections.push(`\nExternal action state:\n${actionState}`);
  }
  if (data.steps.length > 0) {
    sections.push(
      `\nBrowser steps:\n${data.steps
        .slice(0, 24)
        .map((step) => `- ${step.index}. ${step.type}: ${step.status} - ${limitText(step.summary, 220)}`)
        .join("\n")}`,
    );
  }

  const formFills = data.formFills ?? [];
  if (formFills.length > 0) {
    sections.push(
      `\nSemantic form-fill reports:\n${formFills
        .map((report) => {
          const changed = [
            ...report.filled.map((item) => `filled ${item.field}=${item.valuePreview}`),
            ...report.selected.map((item) => `selected ${item.field}=${item.valuePreview}`),
            ...report.checked.map((item) => `checked ${item.field}`),
            ...report.clicked.map((item) => `clicked ${item.text}`),
          ];
          const blockers = report.blockers.length > 0 ? ` blockers: ${report.blockers.join("; ")}` : "";
          const beforeSubmit = report.beforeSubmit.length > 0 ? ` before-submit controls: ${report.beforeSubmit.join(", ")}` : "";
          return `- ${report.label}: ${report.status}; ${changed.join("; ") || "no field changes"}.${blockers}${beforeSubmit}`;
        })
        .join("\n")}`,
    );
  }

  const observations = data.observations ?? [];
  const observationLines = observations
    .map((group) => {
      const controls = uniqueStrings(
        group.elements
          .filter((element) => element.enabled && element.text.trim().length > 0)
          .map((element) => limitText(element.text.replace(/\s+/g, " ").trim(), 90)),
      )
        .slice(0, 40)
        .join("; ");
      return controls ? `[${group.label}] ${controls}` : undefined;
    })
    .filter((line): line is string => Boolean(line));
  if (observationLines.length > 0) {
    sections.push(`\nVisible browser controls/text:\n${observationLines.join("\n")}`);
  }

  return sections.join("\n");
}

function summarizeBrowserActionState(data: BrowserOperateData): string | undefined {
  const texts = [
    data.title,
    data.finalUrl,
    ...(data.formFills ?? []).flatMap((report) => [
      report.status,
      ...report.filled.map((item) => `${item.field} ${item.valuePreview}`),
      ...report.selected.map((item) => `${item.field} ${item.valuePreview}`),
      ...report.checked.map((item) => item.field),
      ...report.clicked.map((item) => item.text),
      ...report.skipped.map((item) => `${item.field} ${item.reason}`),
      ...report.blockers,
      ...report.beforeSubmit,
    ]),
    ...(data.observations ?? []).flatMap((group) => group.elements.map((element) => `${element.text} ${element.ariaLabel ?? ""}`)),
    ...data.extractedText.map((item) => item.text.slice(0, 4000)),
  ]
    .filter((item): item is string => Boolean(item))
    .join("\n");
  if (!texts.trim()) return undefined;

  const normalized = texts.toLowerCase();
  const hasUnavailable = /(?:404|not found|page unavailable|p[aá]gina no est[aá] disponible|страниц[аы] не найден)/i.test(texts);
  const hasCaptcha = /(?:captcha|i'?m not a robot|no soy un robot|robot check|bot check|verify you are human|verifica que eres humano)/i.test(texts);
  const hasLogin = /(?:log in|sign in|iniciar sesi[oó]n|registrarse|create account|account required|войдите|авториз)/i.test(texts);
  const hasSelectedOrder = /(?:tu pedido|your order|order summary|total|corte de pelo|haircut|service:|servicio:)/i.test(texts);
  const hasTimeSlot = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(texts);
  const hasSafeProgress = /(?:continuar|continue|siguiente|next)/i.test(texts);
  const hasFinalBoundary = /(?:stopped before final submit|before-submit controls|confirmar|confirm|pagar|pay|submit|enviar)/i.test(texts);

  if (hasUnavailable) return "- blocker: provider page is unavailable/not-found; do not report successful preparation.";
  if (hasCaptcha) return "- blocker: CAPTCHA/bot-check is visible in browser evidence.";
  if (hasLogin) return "- blocker: login/account requirement is visible in browser evidence.";

  if (hasSelectedOrder || hasTimeSlot || hasSafeProgress || hasFinalBoundary) {
    const facts: string[] = ["- browser preparation is on a live provider/action page; no CAPTCHA/login/not-found blocker is visible in structured evidence."];
    if (hasSelectedOrder) facts.push("- selected service/order summary is visible.");
    if (hasTimeSlot) facts.push("- appointment time slot text is visible.");
    if (hasSafeProgress) facts.push("- safe progress control is visible; this is not evidence of final external submission.");
    if (hasFinalBoundary) facts.push("- final-submit boundary exists or is near; do not claim external submission without external.action.commit evidence.");
    if (normalized.includes("privacy") || normalized.includes("terms") || normalized.includes("política")) {
      facts.push("- legal/privacy consent may still require explicit operator approval before final submit.");
    }
    return facts.join("\n");
  }

  return undefined;
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

function workKeyForLedgeredTool(tool: Tool, capability: string, input: Record<string, unknown>): string {
  if (capability === "market-timeseries") {
    return toolCallWorkKey(tool.name, { capability, ...input });
  }
  if (capability === "api-http-json" || tool.capabilities.includes("api-http-json")) {
    return toolCallWorkKey(tool.name, { capability: "api-http-json", ...input });
  }
  if (tool.name === "browser.operate" || capability === "browser-operate") {
    return toolCallWorkKey(tool.name, { capability: "browser-operate", ...input });
  }
  return toolCallWorkKey(tool.name, { capability, ...input });
}

function scopedToolWorkKey(
  baseWorkKey: string,
  scope: "global" | "run" | "attempt" | undefined,
  ids: { runId?: string; spanId: string },
): string {
  if (!scope || scope === "global") return baseWorkKey;
  if (scope === "run") {
    return compactWorkKey("tool-scope-run", JSON.stringify({
      baseWorkKey,
      runId: ids.runId ?? "unknown-run",
    }));
  }
  return compactWorkKey("tool-scope-attempt", JSON.stringify({
    baseWorkKey,
    runId: ids.runId ?? "unknown-run",
    spanId: ids.spanId,
  }));
}

function isInteractiveBrowserOperateInput(input: Record<string, unknown>): boolean {
  const commands = Array.isArray(input.commands) ? input.commands : [];
  return commands.some((command) => {
    if (!isRecord(command)) return false;
    const type = typeof command.type === "string" ? command.type.toLowerCase() : "";
    return [
      "click",
      "clickvisible",
      "fill",
      "select",
      "check",
      "uncheck",
      "type",
      "press",
      "submit",
      "waitfornavigation",
    ].includes(type);
  });
}

function subtaskExpectsInteractiveBrowserProof(subtask: Subtask): boolean {
  const declaredInputs = Object.entries(subtask.toolInputs ?? {});
  const hasInteractiveBrowserInput = declaredInputs.some(([toolName, input]) => {
    const normalized = toolName.toLowerCase();
    return (
      (normalized === "browser.operate" || normalized === "browser-operate") &&
      isRecord(input) &&
      isInteractiveBrowserOperateInput(input)
    );
  });
  if (hasInteractiveBrowserInput) return true;

  const text = [
    subtask.title,
    subtask.prompt,
    subtask.expectedOutput,
    ...(subtask.reviewCriteria ?? []),
    ...(subtask.requiredArtifacts ?? []).map((requirement) => requirement.description),
  ].join("\n");
  return /(?:filled|fill(?:ed)?\s+form|form fields|before submission|pre-submit|submit boundary|booking draft|appointment|reservation|schedule an appointment|заполн|форма|перед отправк|до отправк|запис[ьи]|брон)/i.test(
    text,
  );
}

function workLedgerKindForTool(tool: Tool, capability: string): WorkLedgerKind {
  if (capability === "market-timeseries" || capability === "api-http-json" || tool.capabilities.includes("api-http-json")) {
    return "api_call";
  }
  if (tool.name === "browser.operate" || capability === "browser-operate") {
    return "url_visit";
  }
  if (capability.includes("file-read")) return "data_fetch";
  if (capability.includes("file-write")) return "artifact_generation";
  return "tool_call";
}

function evidenceKindForLedgeredTool(tool: Tool, capability: string): EvidenceKind {
  if (capability === "market-timeseries" || capability === "api-http-json" || tool.capabilities.includes("api-http-json")) {
    return "api_response";
  }
  if (tool.name === "browser.operate" || capability === "browser-operate") {
    return "browser_snapshot";
  }
  if (capability.includes("file-read")) return "file";
  if (capability.includes("artifact") || capability.includes("file-write")) return "artifact";
  return "model_observation";
}

function improveDeclaredToolInput(
  toolName: string,
  input: unknown,
  subtask: Subtask,
  priorEvidence: string[],
  extraPatterns: readonly EvidencePattern[] = [],
  intents: string[] = [],
): unknown {
  if (toolName !== "browser.operate" || !isRecord(input)) return input;
  const commands = Array.isArray(input.commands) ? input.commands : [];
  const hasPlaceholderNavigation = commands.some(isPlaceholderNavigateCommand);
  const hasBrittleInteraction = commands.some(isBrittleBrowserInteractionCommand);
  // Phase 12 follow-up: the planner often hardcodes navigation URLs to a
  // retailer homepage (`https://www.amazon.es`, `https://www.apple.com/es/`)
  // and expects the worker to "click around" to find products. The
  // browser tool can extract from a homepage but the agent has no
  // multi-step interaction loop, so the worker is stuck with whatever the
  // homepage shows. This is universal across any retailer / aggregator —
  // detect navigation to a SHALLOW path (root or single segment) and treat
  // it the same as placeholder navigation: rewrite from web.search
  // evidence which already has specific result URLs.
  //
  // Phase 13 follow-up: ONLY rewrite a shallow URL when it was NOT
  // explicitly named by the user in the task / subtask prompt. If the
  // user typed `https://example.com` and the planner faithfully
  // forwarded it to browser.operate, replacing that URL with whatever
  // the search engine surfaced is destructive (iter showed
  // `chromewebstore.google.com/.../gofullpage` getting picked over
  // the user's literal `https://example.com`). The intent check is
  // a simple substring lookup against subtask metadata — no need to
  // parse URLs because the planner copies them verbatim.
  const firstNavigationUrl = commands.find(isNavigateCommand)?.url;
  const hasShallowLandingNavigation = firstNavigationUrl
    ? isShallowLandingUrl(firstNavigationUrl)
    : false;
  const userIntendedNavigation = firstNavigationUrl
    ? userExplicitlyAskedForUrl(firstNavigationUrl, subtask)
    : false;
  // A user-intended URL is honoured regardless of shape — even when the
  // URL matches the historical "placeholder" regex (literal example.com)
  // or has a shallow path. The runtime should never silently override a
  // navigation target the user typed into their task. Brittle interaction
  // (form-fill loops the runtime cannot drive) is the only trigger that
  // still fires unconditionally because it isn't about the URL.
  if (userIntendedNavigation && !hasBrittleInteraction) {
    return input;
  }
  const shallowNeedsRewrite = hasShallowLandingNavigation && !userIntendedNavigation;
  if (!hasPlaceholderNavigation && !hasBrittleInteraction && !shallowNeedsRewrite) {
    return input;
  }

  // Phase 12 final: intents come from the caller (classifier-resolved at
  // run start). Empty intents fall back to legacy first-non-low-value
  // path inside `selectBestUrlsForArtifact`.
  const evidenceText = priorEvidence.join("\n\n");
  const wantSources = requiresMultipleSources(subtask) ? 3 : 1;
  let evidenceUrls = selectBestUrlsForArtifact(
    evidenceText,
    wantSources,
    intents,
    extraPatterns,
  );
  // Phase 12 follow-up: when classifier-derived intents do not match any
  // built-in or memory-supplied pattern (e.g. brand-new "product-comparison"
  // intent with no domain pack registered), `selectBestUrlsForArtifact`
  // returns []. Previously this collapsed back to the planner's hardcoded
  // homepage navigation, leading to amazon.com / google.com home-page
  // scrapes that contain no product evidence. Fall back to the first few
  // non-low-value URLs straight out of search evidence — even without a
  // pattern hit, anything is a better target than the placeholder
  // homepage the planner wrote.
  if (evidenceUrls.length === 0) {
    const placeholderUrl = firstNavigationUrl && /^https?:\/\//i.test(firstNavigationUrl) ? firstNavigationUrl : undefined;
    evidenceUrls = extractHttpUrls(evidenceText)
      .filter((url) => !isLowValueProofUrl(url))
      .filter((url) => {
        // Skip the same shallow placeholder we are trying to escape from.
        try {
          const parsed = new URL(url);
          if (placeholderUrl) {
            const placeholder = new URL(placeholderUrl);
            if (parsed.hostname === placeholder.hostname && isShallowLandingUrl(url)) return false;
          }
          return !isShallowLandingUrl(url);
        } catch {
          return false;
        }
      })
      .slice(0, wantSources);
  }
  if (subtaskExpectsInteractiveBrowserProof(subtask)) {
    const actionUrls = rankExternalActionCandidateUrls(
      extractHttpUrls(evidenceText).filter((url) => !isLowValueProofUrl(url)),
      evidenceText,
      `${subtask.title}\n${subtask.prompt}\n${subtask.expectedOutput}`,
    );
    if (actionUrls.length > 0) {
      evidenceUrls = actionUrls.slice(0, wantSources);
    } else {
      const rejectedUrls = extractRejectedBrowserUrls(evidenceText);
      evidenceUrls = evidenceUrls.filter(
        (url) => !isRejectedExternalActionUrl(url, rejectedUrls) && !isExternalActionIneligibleUrl(url),
      );
      if (evidenceUrls.length === 0) {
        evidenceUrls = extractHttpUrls(evidenceText)
          .filter((url) => !isLowValueProofUrl(url))
          .filter((url) => !isRejectedExternalActionUrl(url, rejectedUrls))
          .filter((url) => !isExternalActionIneligibleUrl(url))
          .filter((url) => !isExternalActionListingUrl(url))
          .filter((url) => !isExternalActionEditorialEvidence(url, extractUrlEvidenceContext(evidenceText, url)))
          .slice(0, wantSources);
      }
    }
  }
  if (evidenceUrls.length === 0) return input;

  if (isInteractiveBrowserOperateInput(input)) {
    const originalCommands = commands.filter(isRecord);
    return {
      ...input,
      commands: evidenceUrls.flatMap((url, index) =>
        originalCommands.map((command) => {
          if (isNavigateCommand(command) && command.url === firstNavigationUrl) {
            return { ...command, url };
          }
          if (
            evidenceUrls.length > 1 &&
            (command.type === "screenshot" || command.type === "extractText" || command.type === "extractLinks" || command.type === "observe") &&
            typeof command.label === "string"
          ) {
            return { ...command, label: `${command.label}-${index + 1}` };
          }
          return command;
        }),
      ),
    };
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
        { type: "screenshot", label, fullPage: true, maxHeight: 3200 },
      ];
    }),
  };
}

function rankExternalActionCandidateUrls(urls: string[], evidenceText: string, context: string): string[] {
  const unique = uniqueStrings(urls);
  const rejected = extractRejectedBrowserUrls(evidenceText);
  const ranked = unique
    .filter((url) => !isRejectedExternalActionUrl(url, rejected))
    .filter((url) => !isExternalActionIneligibleUrl(url))
    .map((url) => {
      const urlText = normalizeAnchorTerm(url);
      const nearby = normalizeAnchorTerm(extractUrlEvidenceContext(evidenceText, url));
      const combined = `${urlText}\n${nearby}\n${normalizeAnchorTerm(context)}`;
      const listing = isExternalActionListingUrl(url);
      const editorial = isExternalActionEditorialEvidence(url, nearby);
      let score = 0;
      if (/(?:book|booking|appointment|reserve|reservation|reservar|cita|schedule|checkout|contact|form|formulario)/i.test(combined)) {
        score += 8;
      }
      if (/(?:online|available|availability|open appointments|appointments online|disponible|reservas? online)/i.test(combined)) {
        score += 4;
      }
      if (classifyEvidenceUrlShape(url) === "detail") score += 2;
      if (classifyEvidenceUrlShape(url) === "listing") score -= 3;
      if (listing) score -= 6;
      if (editorial) score -= 20;
      if (/(?:instagram|facebook|tiktok|youtube|twitter|x\.com|linkedin|pinterest|maps\.|\/maps\/|\/search\/|\/category\/)/i.test(url)) {
        score -= 6;
      }
      return { url, score, listing, editorial };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const directActionPages = ranked.filter((item) => !item.listing && !item.editorial);
  return (directActionPages.length > 0 ? directActionPages : ranked).map((item) => item.url);
}

function extractExternalActionCandidateLinksFromBrowserData(data: BrowserOperateData): string[] {
  const evidenceLines: string[] = [];
  const urls: string[] = [];
  for (const group of data.extractedLinks ?? []) {
    for (const link of group.links ?? []) {
      const href = cleanExtractedHttpUrl(link.href);
      if (!href || !/^https?:\/\//i.test(href)) continue;
      if (isLowValueProofUrl(href) || isExternalActionIneligibleUrl(href)) continue;
      urls.push(href);
      evidenceLines.push(`${link.text || "link"} ${href}`);
    }
  }
  if (urls.length === 0) return [];
  return rankExternalActionCandidateUrls(
    urls,
    evidenceLines.join("\n"),
    "external action booking appointment reservation contact form provider page",
  ).slice(0, 6);
}

function isRejectedExternalActionUrl(url: string, rejectedUrls: readonly string[]): boolean {
  const comparable = normalizeComparableUrl(url);
  if (rejectedUrls.includes(comparable)) return true;

  for (const rejected of rejectedUrls) {
    if (sameRejectedExternalActionBranch(url, rejected)) return true;
  }
  return false;
}

function sameRejectedExternalActionBranch(url: string, rejectedUrl: string): boolean {
  try {
    const candidate = new URL(url);
    const rejected = new URL(rejectedUrl);
    if (candidate.hostname.toLowerCase() !== rejected.hostname.toLowerCase()) return false;

    const candidateFirst = firstPathSegment(candidate.pathname);
    const rejectedFirst = firstPathSegment(rejected.pathname);
    if (!candidateFirst || candidateFirst !== rejectedFirst) return false;

    const candidateLooksLikeListing = isExternalActionListingUrl(url) || isExternalActionIneligibleUrl(url);
    const rejectedLooksLikeListing = isExternalActionListingUrl(rejectedUrl) || isExternalActionIneligibleUrl(rejectedUrl);
    return candidateLooksLikeListing && rejectedLooksLikeListing;
  } catch {
    return false;
  }
}

function firstPathSegment(pathname: string): string {
  return pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
}

function extractRejectedBrowserUrls(text: string): string[] {
  const rejected = new Set<string>();
  for (const match of text.matchAll(/Rejected browser URL:\s*(https?:\/\/[^\s<>"'`]+)/gi)) {
    const cleaned = cleanExtractedHttpUrl(match[1] ?? "");
    if (cleaned) rejected.add(normalizeComparableUrl(cleaned));
  }
  return [...rejected];
}

function normalizeComparableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}

function isExternalActionIneligibleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    const haystack = `${host}${path}`;
    return (
      /(?:^|\/)(?:for-business|business|businesses|partners|partner|software|pricing|careers|about|blog|help|support)(?:\/|$)/i.test(
        path,
      ) ||
      /(?:^|\/)(?:industries|industry|use-cases|usecases|solutions|features)(?:\/|$)/i.test(path) ||
      /(?:salon|spa|barber|booking|appointment).{0,40}(?:software|management|pos|crm)/i.test(haystack)
    );
  } catch {
    return true;
  }
}

function isExternalActionListingUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return /(?:^|\/)(?:lp|directory|directories|near-me|nearby|search|find|category|categories)(?:\/|$)/i.test(path) ||
      /(?:^|\/)(?:barbershops|restaurants|salons|clinics|doctors|dentists|hotels|villas|venues)(?:\/|$).*(?:^|\/)(?:in|near|city|location)(?:\/|$)/i.test(path) ||
      /(?:best|top|near[-_]me|directory|compare|find[-_])/i.test(path);
  } catch {
    return false;
  }
}

function isExternalActionEditorialEvidence(url: string, nearbyEvidence: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    if (/(?:booksy|fresha|opentable|thefork|treatwell|calendly|acuityscheduling|simplybook|setmore|squareup)/i.test(host)) {
      return false;
    }
    const evidence = normalizeAnchorTerm(`${parsed.hostname} ${path} ${nearbyEvidence}`);
    const rootOrBusinessHome = path === "/" || path === "";
    const hasDirectActionSignal =
      /\b(?:official|direct business|dedicated business|provider|book online|online booking|booking interface|booking widget|appointment|appointments|reserve|reservation|schedule|contact form|services)\b|записаться\s+онлайн|онлайн[-\s]?запис/i.test(
        evidence,
      );
    if (rootOrBusinessHome && hasDirectActionSignal) {
      return false;
    }
    return (
      /(?:^|\/)(?:blog|article|guide|news|magazine|things-to-do|best|top)(?:\/|$)/i.test(path) ||
      /\b(?:top|best|guide|discover|explore|compare|list|listicle|directory|near me|near you|offers and discounts|reviews and compare|recommended|recommendations)\b/i.test(
        evidence,
      )
    );
  } catch {
    return true;
  }
}

function extractUrlEvidenceContext(text: string, url: string): string {
  const lines = text.split(/\n/);
  const index = lines.findIndex((line) => line.includes(url));
  if (index < 0) return "";
  return lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 4)).join("\n");
}

/**
 * Phase 12 follow-up: universal "homepage / top-level" detector. A URL
 * with empty / `/` / one-segment path is treated as a landing page that
 * a multi-step browser interaction loop would normally drill into. The
 * runtime does not have such a loop, so we replace these with specific
 * URLs from web.search evidence whenever they appear in declared
 * navigation commands. No domain knowledge — the rule is purely
 * structural: depth of path < 2 segments.
 */
/**
 * Phase 13 follow-up: did the user (via the subtask the planner
 * generated from the user's original task) explicitly name this
 * URL? When yes, the runtime must NOT rewrite it even if it has a
 * shallow path. Detection is a simple substring search across
 * subtask.title / .prompt / .expectedOutput / .reviewCriteria —
 * the planner copies user-provided URLs verbatim and the runtime
 * never prefixes the URL with anything, so a substring is enough
 * to confirm intent. Only http(s) URLs are checked; other schemes
 * pass through unaltered (no rewrite anyway).
 */
function userExplicitlyAskedForUrl(url: string, subtask: Subtask): boolean {
  if (!url) return false;
  const haystack = [
    subtask.title ?? "",
    subtask.prompt ?? "",
    subtask.expectedOutput ?? "",
    ...(subtask.reviewCriteria ?? []),
  ].join("\n");
  if (!haystack) return false;
  // Compare the URL both as-typed and without trailing slash so
  // `https://example.com` matches both forms in the prompt.
  const normalized = url.replace(/\/+$/, "");
  if (haystack.includes(normalized)) return true;
  // Also check the bare host: planner sometimes writes `example.com`
  // without the protocol.
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host && haystack.toLowerCase().includes(host.toLowerCase())) return true;
  } catch {
    /* malformed URL — skip */
  }
  return false;
}

function isShallowLandingUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.search || parsed.hash) return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.length <= 1;
  } catch {
    return false;
  }
}

function hasInvalidBrowserNavigation(input: unknown, subtask?: Subtask): boolean {
  if (!isRecord(input)) return false;
  const commands = Array.isArray(input.commands) ? input.commands : [];
  return commands.some((command) => {
    if (!isPlaceholderNavigateCommand(command)) return false;
    // Phase 13 follow-up: when the user explicitly named the URL in
    // the task / subtask prompt, the URL is intentional even if it
    // matches the historical placeholder regex (e.g. literal
    // example.com). The skip would otherwise drop a perfectly
    // legitimate navigation request.
    if (
      subtask &&
      isNavigateCommand(command) &&
      userExplicitlyAskedForUrl(command.url, subtask)
    ) {
      return false;
    }
    return true;
  });
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

/**
 * Phase 12 Slice B: a "generic" landing URL is the bare host (or known
 * placeholder path) of any host that participates in built-in evidence
 * patterns. Used to downgrade an empty navigation, exactly as before — but
 * the host list is data, not code. Future tool packs that declare hosts
 * automatically inherit the same generic-landing handling.
 */
function isGenericBrowserSearchUrl(
  url: string,
  patterns: readonly EvidencePattern[] = BUILTIN_EVIDENCE_PATTERNS,
): boolean {
  return isGenericLandingUrl(url, patterns);
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

function selectBestUrlForArtifact(
  text: string,
  intents: string[] = [],
  extraPatterns: readonly EvidencePattern[] = [],
  geoAnchors: string[] = [],
): string | undefined {
  return selectBestUrlsForArtifact(text, 1, intents, extraPatterns, geoAnchors)[0];
}

/**
 * Phase 13 follow-up: pick a thread-scoped artifact that already satisfies a
 * "send me a screenshot proof" request without re-capturing. Selection rules:
 *
 *   1. Only PNG artifacts (mimeType `image/png` or `.png` filename) qualify.
 *   2. Prefer artifacts whose filename overlaps with task/intent tokens —
 *      e.g. asking for "цена биткоина / proof" matches a thread artifact
 *      named `discovery-2-coingecko-com-…-bitcoin-screenshot.png`.
 *   3. If nothing matches by token, fall back to the most recent screenshot
 *      in the array (thread artifacts are appended chronologically by the
 *      runtime, so the last entry is freshest).
 *   4. Returns `undefined` when there is no PNG to reuse, so callers fall
 *      through to the original capture path.
 */
function pickReusableThreadScreenshot(
  threadArtifacts: readonly AgentArtifact[],
  context: string,
  intents: readonly string[],
): AgentArtifact | undefined {
  const screenshots = threadArtifacts.filter((artifact) => {
    if (artifact.mimeType === "image/png") return true;
    return Boolean(artifact.filename?.toLowerCase().endsWith(".png"));
  });
  if (screenshots.length === 0) return undefined;

  const tokens = new Set<string>();
  for (const intent of intents) {
    for (const part of intent.toLowerCase().split(/[\s\-_/]+/)) {
      if (part.length >= 4) tokens.add(part);
    }
  }
  for (const part of context.toLowerCase().split(/[^a-z0-9а-яё]+/i)) {
    if (part.length >= 4) tokens.add(part);
  }

  for (const artifact of screenshots) {
    const fname = (artifact.filename ?? "").toLowerCase();
    if (!fname) continue;
    for (const token of tokens) {
      if (fname.includes(token)) return artifact;
    }
  }

  return screenshots[screenshots.length - 1];
}

function selectBestUrlsForArtifact(
  text: string,
  limit: number,
  intents: string[] = [],
  extraPatterns: readonly EvidencePattern[] = [],
  geoAnchors: string[] = [],
  hostMentionText = text,
): string[] {
  // Phase 12 Slice C: combine built-in seed with operator-supplied patterns
  // (tool contracts and memory entries). Memory + tool patterns can override
  // built-ins because they appear later in the array yet
  // `scoreUrlAgainstPatterns` returns the highest score, so a higher-scored
  // override wins.
  const patterns = extraPatterns.length > 0
    ? [...BUILTIN_EVIDENCE_PATTERNS, ...extraPatterns]
    : BUILTIN_EVIDENCE_PATTERNS;
  const urls = extractHttpUrls(text);
  if (urls.length === 0) return [];
  const sourceUrls = urls.filter((url) => !isLowValueProofUrl(url));
  const selectionContext = `${hostMentionText}\n${intents.join(" ")}`;
  const ranked = sourceUrls
    .map((url) => {
      const baseScore = scoreArtifactUrl(url, intents, patterns) + geoBiasScore(url, geoAnchors);
      return {
        url,
        score: baseScore > 0 ? baseScore + evidenceUrlShapeScore(url, selectionContext) : 0,
      };
    })
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

  // Phase 12 follow-up: when intents are inferred but no URL matches any
  // pattern, return an empty list rather than promoting whatever URL came
  // first in the evidence text. The previous fallback attached arxiv.org
  // research papers and sss.gov to a "buy a laptop" run because they were
  // the top non-low-value URLs in a noisy search result. The agent now
  // skips browser discovery cleanly instead of capturing junk screenshots.
  if (selected.length > 0) return selected;
  // Phase 28 follow-up — task-anchored URL fallback. When no
  // pattern matches but a URL's HOST is explicitly mentioned in
  // the task / subtask / evidence text (e.g. planner wrote
  // "CoinMarketCap, Binance"), treat that URL as task-approved
  // and include it. This keeps the safety net for off-topic URLs
  // (arxiv.org on a travel task → not in the prompt → still
  // dropped) while unblocking legitimate cases the pattern bank
  // doesn't cover (bitcoin price on coinmarketcap.com).
  if (intents.length > 0) {
    // Tokenize the text WITHOUT the URLs themselves — otherwise
    // every URL's host self-matches its own substring (e.g. an
    // arxiv.org URL puts "arxiv" into the token set, then matches
    // itself). The remaining prose is what the planner / task /
    // dependency context actually said about sources.
    const proseOnly = hostMentionText
      .replace(/https?:\/\/[^\s"'<>(),\]\[`]+/gi, " ")
      .replace(/https?%3A%2F%2F[^\s"'<>(),\]\[`&]+/gi, " ");
    const taskTokens = new Set<string>();
    for (const token of proseOnly.toLowerCase().match(/[a-z0-9][a-z0-9.-]{2,}/g) ?? []) {
      taskTokens.add(token);
      // Also add the bare second-level domain prefix so "coinmarketcap.com"
      // in evidence matches "coinmarketcap" in prose.
      const dotIdx = token.indexOf(".");
      if (dotIdx > 2) taskTokens.add(token.slice(0, dotIdx));
    }
    const hostMatchedUrls = sourceUrls
      .filter((url) => {
        const host = normalizedHost(url);
        const hostBase = host.split(".")[0] ?? host;
        return taskTokens.has(host) || taskTokens.has(hostBase);
      })
      .map((url) => ({ url, score: evidenceUrlShapeScore(url, selectionContext) + geoBiasScore(url, geoAnchors) }))
      .sort((a, b) => b.score - a.score);
    for (const item of hostMatchedUrls) {
      if (selected.includes(item.url)) continue;
      selected.push(item.url);
      if (selected.length >= limit) return selected;
    }
    return selected;
  }

  // Legacy / intent-less path: keep the previous behaviour for callers that
  // never threaded intents through (CLI smokes, fixtures).
  for (const url of sourceUrls) {
    if (selected.includes(url)) continue;
    selected.push(url);
    if (selected.length >= limit) return selected;
  }

  return selected.length > 0 ? selected : urls.slice(0, limit);
}

function evidenceUrlShapeScore(url: string, context: string): number {
  if (!requiresConcretePageEvidence(context)) return 0;
  const shape = classifyEvidenceUrlShape(url);
  if (shape === "detail") return 2;
  if (shape === "listing") return -2;
  if (shape === "blocked_or_maintenance") return -3;
  return 0;
}

function requiresConcretePageEvidence(context: string): boolean {
  return /\b(?:best|recommend|compare|buy|purchase|price|budget|under|available|availability|book|booking|appointment|reserve|reservation|schedule|proof|screenshot|product|model|provider|restaurant|barbershop)\b|лучши|рекоменд|сравн|купить|цена|бюджет|доступн|заброни|брон|запис|пруф|скриншот|товар|модель/i.test(
    context,
  );
}

function classifyEvidenceUrlShape(url: string): "detail" | "listing" | "blocked_or_maintenance" | "unknown" {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const segments = path.split("/").filter(Boolean);
    const query = parsed.search.toLowerCase();
    if (/(?:maintenance|just-a-moment|captcha|challenge|verify|bot-check)/i.test(`${path} ${query}`)) {
      return "blocked_or_maintenance";
    }
    if (
      query ||
      /(?:^|\/)(?:search|s|category|categories|collections|catalog|product-category|products|shop|store|deals?|discounts?|offers?|used|refurbished|traditional-laptops|laptops?|computers-laptops)(?:\/|$|-)/i.test(
        path,
      )
    ) {
      return "listing";
    }
    const last = segments.at(-1) ?? "";
    if (segments.length >= 2 && last.length >= 12 && /[a-z]/i.test(last)) {
      return "detail";
    }
    if (segments.length >= 1 && /(?:booking|booksy|appointment|reserve|reservation)/i.test(path)) {
      return "detail";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

function normalizedHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url;
  }
}

/**
 * Phase 12 Slice B: domain-specific URL scoring is no longer hardcoded here.
 * Patterns come from tool contracts (`Tool.evidencePatterns`) plus a built-in
 * seed (`BUILTIN_EVIDENCE_PATTERNS`). Caller supplies the active intent set
 * and the resolved pattern list. Without an intent or pattern, every URL
 * scores 0 — which is the correct outcome: no domain pack registered ⇒ no
 * domain ranking. Slice A's `inferTaskIntents` decides which intents are
 * active; Slice C will let memory entries override / extend these patterns.
 */
function scoreArtifactUrl(
  url: string,
  intents: string[] = [],
  patterns: readonly EvidencePattern[] = BUILTIN_EVIDENCE_PATTERNS,
): number {
  return scoreUrlAgainstPatterns(url, intents, patterns);
}

/**
 * Phase 12 follow-up: lightweight, generic geo-bias for URL ranking.
 * For every geoAnchor token from `TaskComplexity.geoAnchors`, check
 * whether its lowercase / accent-stripped form appears as a substring
 * of the URL. Match → +1.0 boost (added on top of intent / pattern
 * score). Multiple anchors stack, but the bonus is capped at +2.0 so
 * a heavily geo-named URL doesn't drown out content relevance.
 *
 * Intentionally NOT a country-name → TLD lookup table — that would
 * be the hardcode the rest of Phase 12 explicitly removed. The LLM
 * planner is responsible for picking concrete `.es` / `.de` retailer
 * domains when geoAnchors are set; this function just nudges the
 * ranker to prefer geo-named URLs when several candidates compete.
 */
function geoBiasScore(url: string, geoAnchors: string[] = []): number {
  if (!geoAnchors.length) return 0;
  const haystack = stripAccentsLower(url);
  let bonus = 0;
  for (const anchor of geoAnchors) {
    const needle = stripAccentsLower(anchor);
    if (needle.length >= 2 && haystack.includes(needle)) {
      bonus += 1;
      if (bonus >= 2) break;
    }
  }
  return bonus;
}

function stripAccentsLower(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Phase 12 follow-up: when an output (worker prose OR direct-mode
 * synthesis answer) contains fenced code blocks that the model
 * intended to deliver as a file but never wrote through file.write,
 * hard-gate would fail the run and the user would never get the
 * code as an artifact. This function extracts every fenced block
 * from the output, infers a sensible filename + MIME type from the
 * language tag, persists each via the supplied `saveArtifact`, and
 * returns the resulting AgentArtifact list. Best-effort: returns []
 * on parse / save failure so it never blocks the pipeline.
 *
 * In delegated mode the caller supplies a `subtask` so the recovery
 * is gated to coding-style requiredArtifacts. In direct mode no
 * subtask exists; pass `subtask: undefined` and the function will
 * recover any fenced block (the user explicitly asked for code, the
 * model produced code, save it).
 */
async function recoverCodeArtifactsFromWorkerOutput(
  output: string,
  subtask: Subtask | undefined,
  existingArtifacts: AgentArtifact[],
  saveArtifact: (input: ArtifactCreateInput) => Promise<AgentArtifact>,
  fallbackSlug = "code",
): Promise<AgentArtifact[]> {
  if (subtask) {
    const requirements = (subtask.requiredArtifacts ?? []).filter(
      (req) =>
        req.required !== false &&
        (req.kind === "data"
          || req.kind === "document"
          || req.kind === "source"
          || req.capability === "file-write"
          || req.capability === "code-generation"),
    );
    if (requirements.length === 0) return [];
  }
  const alreadyHave = new Set(existingArtifacts.map((a) => a.id || a.url));
  const recovered: AgentArtifact[] = [];
  const fenceRe = /```([a-zA-Z0-9_+\-]*)\n([\s\S]*?)```/g;
  const blocks: { language: string; code: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(output)) !== null) {
    const language = (match[1] || "").trim().toLowerCase();
    const code = match[2] ?? "";
    if (!code.trim()) continue;
    blocks.push({ language, code });
  }
  if (blocks.length === 0) return [];

  const baseSlug = safeArtifactSlug(subtask?.id || subtask?.title || fallbackSlug);
  let counter = 0;
  for (const block of blocks) {
    const ext = languageToExtension(block.language);
    const mime = languageToMimeType(block.language);
    counter += 1;
    const filename = blocks.length === 1
      ? `${baseSlug}${ext}`
      : `${baseSlug}-${counter}${ext}`;
    try {
      const artifact = await saveArtifact({
        filename,
        mimeType: mime,
        content: block.code,
        description: subtask
          ? `Recovered ${block.language || "code"} artifact from worker output for subtask ${subtask.id}.`
          : `Recovered ${block.language || "code"} artifact from direct-mode synthesis answer.`,
      });
      if (alreadyHave.has(artifact.id || artifact.url)) continue;
      recovered.push(artifact);
    } catch {
      // Best effort — never block the pipeline on a save failure.
    }
  }
  return recovered;
}

/**
 * Phase 12 follow-up: the previous implementation shipped a 30-entry
 * map and fell back to `.txt` for anything missing. Replace with a
 * structural rule that requires no per-language patches:
 *   1. The handful of cases where the markdown fence tag differs from
 *      the file extension (`python` -> `py`, `csharp` -> `cs`) live in
 *      a tiny ALIASES table that operators rarely need to touch.
 *   2. Any other tag becomes the extension verbatim. Editors / IDEs
 *      pick the language by extension regardless of whether we
 *      shipped its name in a map.
 */
const LANGUAGE_TAG_TO_EXTENSION_ALIAS: Record<string, string> = {
  python: "py",
  javascript: "js",
  typescript: "ts",
  bash: "sh",
  zsh: "sh",
  shell: "sh",
  golang: "go",
  ruby: "rb",
  rust: "rs",
  csharp: "cs",
  kotlin: "kt",
  markdown: "md",
  yml: "yaml",
  "c++": "cpp",
  cxx: "cpp",
  text: "txt",
  plaintext: "txt",
};

function languageToExtension(language: string): string {
  const tag = (language ?? "").trim().toLowerCase();
  if (!tag) return ".txt";
  const ext = LANGUAGE_TAG_TO_EXTENSION_ALIAS[tag] ?? tag;
  // Sanitize: editors only honor [a-z0-9_-] extensions; if the tag
  // contains anything weirder, fall back to the safe `.txt` extension.
  if (!/^[a-z0-9_-]{1,12}$/.test(ext)) return ".txt";
  return `.${ext}`;
}

function languageToMimeType(language: string): string {
  const ext = languageToExtension(language).slice(1);
  const map: Record<string, string> = {
    py: "text/x-python",
    js: "text/javascript",
    ts: "text/typescript",
    tsx: "text/typescript",
    jsx: "text/javascript",
    sh: "text/x-shellscript",
    json: "application/json",
    yaml: "application/yaml",
    toml: "application/toml",
    md: "text/markdown",
    html: "text/html",
    css: "text/css",
    sql: "application/sql",
  };
  // Anything else gets a structural fallback: editors and the
  // download path care more about the file extension than the MIME
  // type, and `text/plain` is a safe default for source code.
  return map[ext] ?? "text/plain";
}

function isLowValueProofUrl(url: string): boolean {
  // Phase 12 final: structural filter only. The previous host blacklist
  // (facebook, reddit, quora, github, stanford, ...) was domain-specific
  // judgement that should live in the LLM URL ranker, not in runtime
  // regex. Localhost stays because it is structurally invalid as
  // cross-run evidence; .pdf stays because the browser screenshot tool
  // cannot meaningfully render PDFs as visual proof. `example.com` is
  // intentionally not filtered here: it is a valid explicit target in
  // smoke tests and operator diagnostics. Placeholder/fake proof links
  // are still rejected later by `containsPlaceholderProof()`.
  if (
    /(?:^|\/\/)(?:localhost|127\.0\.0\.1)(?:[/:?#]|$)|placeholder|\.pdf(?:$|[?#])/i.test(
      url,
    )
  ) {
    return true;
  }
  // Phase 12 follow-up: also reject programmatic / API endpoints that
  // are not user-facing pages. The LLM URL ranker keeps mistakenly
  // promoting things like `worksheets.codalab.org/rest/bundles/<id>/contents/blob/...`
  // (academic dataset blobs) or `*/api/v1/*` REST routes when the
  // search engine surfaces them. They contain no useful HTML for
  // browser screenshots and waste a navigation slot. Structural test
  // only — any path containing `/rest/`, `/api/`, `/v1/`, `/v2/`,
  // `/raw/`, `/blob/`, or `/contents/` is treated as low-value.
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    if (/(?:^|\/)(?:rest|api|v\d+|raw|blob|contents)(?:\/|$)/i.test(pathname)) {
      return true;
    }
    // Phase 12 follow-up: structural detector for "single-post"
    // URLs on any social platform. Match URL paths whose last (or
    // second-to-last) segment is a known post/status/thread indicator
    // followed by an opaque ID-like segment of 6+ alphanumeric chars.
    // No host allow-list — the same shape catches facebook posts,
    // bluesky/mastodon posts, twitter status URLs, linkedin activity
    // posts, reddit comments, and any future social platform that
    // adopts the same convention. Profile / landing pages
    // (linkedin.com/in/<name>, facebook.com/<page>) do NOT have an
    // ID-segment after a post indicator so they correctly stay
    // allowed for brand verification.
    if (
      /(?:^|\/)(?:posts?|status(?:es)?|comments?|tweets?|reels?|threads?|notes?|p|note)\/[A-Za-z0-9._-]{6,}(?:\/|$)/i.test(
        pathname,
      )
    ) {
      return true;
    }
  } catch {
    // Malformed URL — let extractHttpUrls / scoring handle it elsewhere.
  }
  return false;
}

function extractHttpUrls(text: string): string[] {
  // Phase 12 Slice D follow-up: also exclude backtick (`` ` ``) and the
  // closing characters from common Markdown punctuation. Without this, an
  // evidence string like `[link](https://example.com/foo)` or
  // ``\`https://example.com/foo\``` produced a candidate URL with a trailing
  // backtick or paren, which the LLM ranker correctly returned without that
  // suffix — but our `candidateSet.has(url)` check then failed and the
  // ranker fell back to heuristic with reason "LLM selected no valid
  // candidate URLs". Stripping noise here closes both the LLM and heuristic
  // paths in one go.
  const matches = text.matchAll(/https?:\/\/[^\s"'<>(),\]\[`]+/gi);
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of matches) {
    const url = cleanExtractedHttpUrl(match[0]);
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  // Phase 28 follow-up — decode URL-encoded targets hiding inside
  // search-engine redirect URLs. DuckDuckGo wraps every result in
  // `//duckduckgo.com/l/?uddg=https%3A%2F%2Fcoinmarketcap.com…`,
  // Bing in `?u=…`, Google in `?url=…` / `?q=…`. The plain regex
  // above misses these because the colon + slash are percent-encoded.
  // Without this decode the screenshot pipeline saw "no source URL"
  // even though the search tool returned 10 useful destinations,
  // because every URL was hiding inside a `uddg=` parameter.
  //
  // Look for any percent-encoded `https%3A%2F%2F` (case-insensitive)
  // and decode it. This is generic — works for any redirect format
  // that URL-encodes the destination, not just DDG.
  const encodedMatches = text.matchAll(/https?%3A%2F%2F[^\s"'<>(),\]\[`&]+/gi);
  for (const m of encodedMatches) {
    try {
      const decoded = cleanExtractedHttpUrl(decodeURIComponent(m[0]));
      if (!decoded || seen.has(decoded)) continue;
      if (!/^https?:\/\//i.test(decoded)) continue;
      seen.add(decoded);
      urls.push(decoded);
    } catch {
      // Bad encoding — skip silently.
    }
  }
  return urls;
}

function cleanExtractedHttpUrl(value: string): string {
  return value
    .replace(/\\[nrt].*$/i, "")
    .replace(/(?:%5C[nrt]).*$/i, "")
    .replace(/[.;:!?`)\]}]+$/, "");
}

function hardGateReview(workerResult: WorkerResult): ReviewResult | undefined {
  if (isWorkerModelFailureFallback(workerResult) && (workerResult.toolEvidence?.length || workerResult.artifacts?.length)) {
    return {
      subtaskId: workerResult.subtask.id,
      verdict: "pass",
      notes:
        "Deterministic pass: worker model synthesis degraded after runtime tool evidence was collected. Parent synthesis should use the attached evidence and report limitations instead of re-running the same worker.",
    };
  }

  if (hasPreparedExternalActionBoundary(workerResult)) {
    return {
      subtaskId: workerResult.subtask.id,
      verdict: "pass",
      notes:
        "Deterministic fast-pass: external.action.prepare created an auditable no-submit boundary from current browser evidence. Parent synthesis should report the prepared/blocked state instead of revising free-form draft prose.",
    };
  }

  if (hasBlockedExternalActionPreparationBoundary(workerResult)) {
    return {
      subtaskId: workerResult.subtask.id,
      verdict: "pass",
      notes:
        "Deterministic fast-pass: browser preparation reached a real external-action blocker before approval. Parent synthesis should report the blocker and next operator/user action, not request final approval.",
    };
  }

  if (containsUnexecutedToolCall(workerResult.output)) {
    return {
      subtaskId: workerResult.subtask.id,
      verdict: "needs_revision",
      notes:
        "Output contains unexecuted tool-call or browser-command syntax. The worker must answer from actual runtime tool evidence and artifact URLs only.",
    };
  }

  if (hasActionableExternalActionDiscoveryEvidence(workerResult)) {
    return {
      subtaskId: workerResult.subtask.id,
      verdict: "pass",
      notes:
        "Deterministic fast-pass: external-action discovery returned runtime web evidence with actionable provider/action URLs. Browser preparation must verify availability/details instead of re-running discovery.",
    };
  }

  // Phase 28 follow-up — deterministic FAST-PASS for artifact subtasks.
  //
  // Symptom we're killing: when the screenshot subtask successfully
  // captured a CoinMarketCap PNG, the LLM reviewer kept emitting
  // `needs_revision` ("toolEvidence array doesn't contain the raw
  // pageText" or similar pedantic complaints), the worker re-ran the
  // whole subtask, called screenshot.url a second time, saved a
  // second PNG — and the run ended up with two artifacts attached.
  //
  // Fast-pass rule: when EVERY required artifact for this subtask is
  // backed by an actual tool call that returned ok=true AND a saved
  // artifact landed on the WorkerResult, the work is done. There is
  // no useful "revision" the second worker run can do — the file
  // already exists. We skip the LLM reviewer entirely with a synthetic
  // pass verdict. The negative gates (ungrounded specifics, weak proof,
  // placeholder URLs, irrelevant artifacts) still run below this — a
  // bad capture is still flagged, only the no-op re-runs are avoided.
  const requiredArtifacts = (workerResult.subtask.requiredArtifacts ?? []).filter(
    (r) => r.required !== false,
  );
	  if (requiredArtifacts.length > 0) {
	    const records = (workerResult.toolEvidenceRecords as EvidenceRecord[] | undefined) ?? [];
	    const allSatisfied = requiredArtifacts.every((req) => {
	      const matchingArtifact = (workerResult.artifacts ?? []).find((a) => artifactMatchesRequirement(a, req));
	      if (!matchingArtifact) return false;
	      if (isClearlyIrrelevantArtifact(matchingArtifact)) return false;
      // We need at least one tool_call record with ok=true backing
      // the artifact. Match by capability when present, otherwise
      // by tool name in the artifact record kind.
      const backingTool = records.some((rec) => {
        if (rec.kind !== "tool_call") return false;
        if (!rec.output.ok) return false;
        if (req.capability && rec.capability === req.capability) return true;
        if (
          req.capability === "browser-screenshot" &&
          (rec.capability === "browser-operate" || rec.capability === "browser.operate")
        ) {
          return true;
        }
        return false;
	      });
	      return backingTool;
	    });
	    const runtimeSelfCheckSatisfied =
	      workerResult.selfCheck?.readyToReturn === true &&
	      workerResult.selfCheck.evidenceCount > 0 &&
	      requiredArtifacts.every((req) =>
	        workerResult.selfCheck?.checks.some(
	          (check) =>
	            check.ok &&
	            check.name === `artifact_required:${req.kind}:${req.capability}`,
	        ),
	      );
	    if (allSatisfied || runtimeSelfCheckSatisfied) {
	      return {
	        subtaskId: workerResult.subtask.id,
	        verdict: "pass",
	        notes:
	          allSatisfied
	            ? "Deterministic fast-pass: every required artifact is backed by a tool call that returned ok=true and a saved artifact is attached. No revision can improve a file the runtime already saved."
	            : "Deterministic fast-pass: worker runtime self-check confirmed non-empty output, attached evidence, and every required artifact. No LLM review is needed for this runtime-verified proof handoff.",
	      };
	    }
	  }

  // Phase 12 follow-up: deterministic ungrounded-specifics gate. The
  // soft prompt rules (workerSystemPrompt + reviewerSystemPrompt) tell
  // the LLM not to invent specific model numbers / version strings /
  // prices unless they appear in evidence — but the model still slips
  // them in (often prefaced with "e.g."). Deterministically extract
  // tokens that *look* like specific product / version identifiers
  // from the worker output and fail the review when they are absent
  // from the evidence and the original task. The reviewer's LLM
  // cross-check is the second line of defence; this check is the
  // first and is not bypassable by clever phrasing.
  const ungrounded = findUngroundedSpecifics(workerResult);
  if (ungrounded.length > 0) {
    return {
      subtaskId: workerResult.subtask.id,
      verdict: "needs_revision",
      notes:
        `Output names specifics that are NOT in tool evidence or the task: ${ungrounded
          .slice(0, 6)
          .join(", ")}. The worker must ground every model number, version, price, or year in the evidence text or report that the data is unavailable rather than naming items from training memory.`,
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

function hasActionableExternalActionDiscoveryEvidence(workerResult: WorkerResult): boolean {
  if (workerResult.subtask.id !== "external-action-source-discovery") return false;
  const subtaskText = [
    workerResult.subtask.title,
    workerResult.subtask.prompt,
    workerResult.subtask.expectedOutput,
    ...(workerResult.subtask.reviewCriteria ?? []),
  ].join("\n");
  if (!/provider\/action URLs|concrete provider|direct booking|appointment|reservation|contact-form/i.test(subtaskText)) {
    return false;
  }

  const evidenceText = (workerResult.toolEvidence ?? []).join("\n");
  if (!evidenceText.trim()) return false;
  const evidenceUrls = extractHttpUrls(evidenceText).filter((url) => !isLowValueProofUrl(url));
  const actionableEvidenceUrls = evidenceUrls.filter((url) => isActionableExternalActionUrl(url, evidenceText));
  if (actionableEvidenceUrls.length === 0) return false;

  const outputText = workerResult.output ?? "";
  if (containsUnsatisfiedDiscoveryFailure(workerResult) || containsPlaceholderProof(outputText)) return false;
  const outputUrls = extractHttpUrls(outputText).filter((url) => !isLowValueProofUrl(url));
  const outputNamesActionableUrl =
    outputUrls.some((url) => actionableEvidenceUrls.includes(url)) ||
    actionableEvidenceUrls.some((url) => outputText.includes(url) || outputText.includes(normalizedHost(url)));
  const outputLooksLikeShortlist =
    /ranked|shortlist|candidate|provider|actionable|book online|booking|appointment|reservation|reservar|cita|direct/i.test(
      outputText,
    );

  return outputNamesActionableUrl && outputLooksLikeShortlist;
}

function hasPreparedExternalActionBoundary(workerResult: WorkerResult): boolean {
  if (workerResult.subtask.id !== "external-action-approval-draft") return false;
  const dependencyContext = workerResult.dependencyContextSnapshot ?? "";
  const evidenceText = [(workerResult.toolEvidence ?? []).join("\n"), dependencyContext].join("\n");
  if (detectExternalActionPreparationBlocker(evidenceText)) return false;
  if (!/external\.action\.prepare/i.test(evidenceText)) return false;
  if (!/Prepared external action/i.test(evidenceText)) return false;
  if (!/Commit boundary/i.test(evidenceText)) return false;
  const hasBrowserPreparationDependency =
    /external-action-browser-preparation/i.test(dependencyContext) &&
    /browser\.operate|browser action preparer|browser execution|browser artifact/i.test(dependencyContext);
  const hasConcreteProofOrPage =
    /https?:\/\//i.test(dependencyContext) ||
    /artifact_|external-action-pre-submit-proof|screenshot/i.test(dependencyContext);
  return hasBrowserPreparationDependency && hasConcreteProofOrPage;
}

function hasBlockedExternalActionPreparationBoundary(workerResult: WorkerResult): boolean {
  if (workerResult.subtask.id !== "external-action-approval-draft") return false;
  const evidenceText = [
    workerResult.output,
    ...(workerResult.toolEvidence ?? []),
    workerResult.dependencyContextSnapshot ?? "",
  ].join("\n");
  return Boolean(detectExternalActionPreparationBlocker(evidenceText));
}

function detectExternalActionPreparationBlocker(evidenceText: string): string | undefined {
  if (!evidenceText.trim()) return undefined;
  if (
    /External action state:\s*[\s\S]{0,500}?-\s*blocker:\s*login\/account requirement/i.test(evidenceText) ||
    /blocker:log\\s\*in|blocker:login|log\s*in|sign\s*in|inicia sesi[oó]n|crea una cuenta|create an account/i.test(evidenceText)
  ) {
    return "the provider requires login, account creation, or user authentication before a usable pre-submit state";
  }
  if (/External action state:\s*[\s\S]{0,500}?-\s*blocker:\s*CAPTCHA|captcha|bot-check|robot check|verify you are human/i.test(evidenceText)) {
    return "the provider shows a CAPTCHA or bot-check before a usable pre-submit state";
  }
  if (/External action state:\s*[\s\S]{0,500}?-\s*blocker:\s*provider page is unavailable|not-found|not found|page unavailable/i.test(evidenceText)) {
    return "the provider page is unavailable or not found";
  }
  if (/Semantic form-fill reports:[\s\S]{0,1000}?-\s*[^:\n]+:\s*(?:partial|blocked);[\s\S]{0,500}?blockers:/i.test(evidenceText)) {
    return "semantic form preparation reported required unresolved fields or blockers before final submit";
  }
  if (/before submit:\s*(?:login|sign in|captcha|account|not found|unavailable)/i.test(evidenceText)) {
    return "browser preparation stopped at a blocker before final submit";
  }
  if (
    /external\.action\.prepare\s+skipped:\s*interactive browser preparation did not produce a QA-passed proof artifact/i.test(
      evidenceText,
    )
  ) {
    return "interactive browser preparation did not produce a QA-passed proof artifact";
  }
  return undefined;
}

function isActionableExternalActionUrl(url: string, context: string): boolean {
  const haystack = `${url}\n${extractUrlEvidenceContext(context, url)}`;
  if (/(?:instagram\.com|facebook\.com|x\.com|twitter\.com|tiktok\.com|youtube\.com|maps\.google|google\.[^/]+\/maps)/i.test(url)) {
    return false;
  }
  return /(?:booksy|fresha|calendly|opentable|resy|thefork|booking|appointment|reserve|reservation|reservar|cita|checkout|contact|form|book online|open appointments|appointments online)/i.test(
    haystack,
  );
}

function isClearlyIrrelevantArtifact(artifact: AgentArtifact): boolean {
  const haystack = `${artifact.filename}\n${artifact.description ?? ""}\n${artifact.url}`;
  return isLowValueProofUrl(haystack);
}

function containsPlaceholderProof(text: string): boolean {
  return /https?:\/\/(?:www\.)?example\.com|(?:^|[\s/._-])placeholder(?:$|[\s/._-])|fake-|screenshot-capture\.placeholder|(?:^|[\s/._-])dummy(?:$|[\s/._-])|todo-url/i.test(text);
}

function isProtocolStatusSpecific(phrase: string): boolean {
  return /^(?:http|status|status\s+code|http\s+status|статус|код\s+состояния)\s+\d{3}$/i.test(
    phrase.trim(),
  );
}

function containsUnsatisfiedDiscoveryFailure(workerResult: WorkerResult): boolean {
  const subtaskText = [
    workerResult.subtask.title,
    workerResult.subtask.prompt,
    workerResult.subtask.expectedOutput,
    ...(workerResult.subtask.reviewCriteria ?? []),
  ].join("\n");
  // Phase 12 final: discovery activation depends only on generic verbs that
  // describe an action (find / search / compare / recommend / ...). Domain-
  // specific anchors no longer live in this regex; classifier-driven
  // `intent[]` already gates pattern-based scoring elsewhere.
  const expectsDiscovery =
    /(find|search|identify|discover|collect|candidate|source|lookup|recommend|rank|compare|list|profile|price|найди|поиск|подбери|кандидат|источник|список|рекоменд|сравн|цена)/i.test(
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

/**
 * Phase 12 follow-up: extract tokens from the worker output that look
 * like specific product / version identifiers and check whether they
 * appear in the evidence corpus or the original task. Tokens that fail
 * BOTH lookups are returned and the review is failed.
 *
 * The patterns are intentionally narrow — only catch high-confidence
 * "this is a specific brand/version" shapes:
 *   - GPU / chip names like "RTX 4080", "M3 Pro", "Ryzen 9 7950X"
 *   - Model numbers with letters+digits like "G16", "M4 Max"
 *   - Years (2023, 2024, 2025, 2026, 2027) standing on their own
 *   - Currency amounts ($1999, €2300)
 *
 * Generic words ("laptop", "GPU", "VRAM") and category labels ("Pro",
 * "Max" alone) are never caught. The grounding lookup uses simple
 * case-insensitive substring with whitespace normalisation, which is
 * good enough for "RTX 4080" vs "RTX 4080" / "rtx-4080" cases.
 */
function findUngroundedSpecifics(workerResult: WorkerResult): string[] {
  const output = workerResult.output ?? "";
  const evidenceText = [
    workerResult.subtask.title ?? "",
    workerResult.subtask.prompt ?? "",
    workerResult.subtask.expectedOutput ?? "",
    ...(workerResult.subtask.reviewCriteria ?? []),
    ...(workerResult.toolEvidence ?? []),
    // Phase 12 follow-up: include the dependency context that was
    // passed into the worker prompt. Upstream workers' outputs and
    // tool evidence already passed THEIR own hard-gate review (or were
    // rejected), so any specific surviving upstream is grounded data
    // the downstream worker is entitled to cite.
    workerResult.dependencyContextSnapshot ?? "",
    buildRuntimeDateGroundingText(),
  ].join("\n");
  return findUngroundedSpecificsInText(output, evidenceText);
}

function buildRuntimeDateGroundingText(date = new Date()): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = get("weekday");
  const month = get("month");
  const day = get("day");
  const year = get("year");
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return [
    `Runtime current date: ${iso}`,
    `${weekday}, ${month} ${day}, ${year}`,
    `${month} ${day}, ${year}`,
    `${day} ${month} ${year}`,
    `current year ${year}`,
  ].join("\n");
}

/**
 * Phase 12 follow-up: deeply walk a declared toolInput value and strip
 * ungrounded specific tokens from every string-bearing field. The
 * planner often hand-writes browser `type` / search query commands
 * with hallucinated specifics — strip them at the same gate that
 * cleans web.search query text.
 *
 * The returned object is a deep clone with the same shape; only
 * string leaves are touched. Numbers, booleans, and structural keys
 * are preserved. Empty originalTask short-circuits to identity.
 */
function guardDeclaredToolInputAgainstUngroundedSpecifics(input: unknown, originalTask: string): unknown {
  if (!originalTask) return input;
  if (typeof input === "string") {
    return guardSearchQueryAgainstUngroundedSpecifics(input, originalTask);
  }
  if (Array.isArray(input)) {
    return input.map((item) => guardDeclaredToolInputAgainstUngroundedSpecifics(item, originalTask));
  }
  if (input && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([key, value]) => [
        key,
        // Don't touch URL fields — pre-call URL rewrite is handled
        // structurally by improveDeclaredToolInput.
        key === "url" ? value : guardDeclaredToolInputAgainstUngroundedSpecifics(value, originalTask),
      ]),
    );
  }
  return input;
}

/**
 * Phase 12 follow-up: pre-call gate on a search query string. Strips
 * tokens that look like specific product / version identifiers but
 * are NOT in the user's original task. The planner is allowed to
 * elaborate on the user's intent, but it is not allowed to seed the
 * query with a specific model number / brand line / year / price the
 * user never mentioned — that biases discovery toward the
 * hallucination from the very first tool call.
 *
 * Returns the same string when there is nothing to strip.
 */
function guardSearchQueryAgainstUngroundedSpecifics(query: string, originalTask: string): string {
  if (!query || !originalTask) return query;
  const ungrounded = findUngroundedSpecificsInText(query, originalTask);
  if (ungrounded.length === 0) return query;

  let stripped = query;
  for (const token of ungrounded) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    stripped = stripped.replace(new RegExp(escaped, "gi"), " ");
  }
  // Collapse whitespace so the cleaned query is still well-formed.
  return stripped.replace(/\s+/g, " ").trim();
}

/**
 * Phase 12 follow-up: shared deterministic gate used by both worker
 * review (`hardGateReview`) and the synthesis layer
 * (`enforceUngroundedSpecificsOnSynthesis`). The candidate-extraction
 * step is fully generic — no brand allow-list, no domain-specific
 * regex. A "specific" is any noun-phrase made of 1-4 tokens where each
 * token starts with an uppercase letter or a digit AND the phrase
 * contains at least one digit. That captures product/version/model
 * shapes ("RTX 4080", "MacBook Pro M5", "Galaxy S25 Ultra", "Boeing
 * 737 MAX", "GPT-5", "Tesla Model 3", "Лада Гранта 2024", ...) without
 * naming any brand. Currency amounts and 4-digit years stay as
 * dedicated structural patterns because they obey their own shape and
 * may appear without any leading capital.
 */
function findUngroundedSpecificsInText(output: string, evidenceText: string): string[] {
  const evidenceCorpus = (evidenceText ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s$€£¥]/gu, " ")
    .replace(/\s+/g, " ");

  const candidates = new Set<string>();

  // Generic "branded specific" extractor without any brand allow-list.
  // A "specific" is a 1-4 word phrase where:
  //   1. The phrase starts at a word that contains at least one
  //      uppercase letter (so "MacBook" / "iPhone" / "RTX" / "Лада"
  //      qualify, but "the" / "300" / "32" do NOT — bare digits and
  //      lowercase prose never anchor a specific).
  //   2. The phrase as a whole contains at least one digit (this is
  //      what separates a specific model number / version from a plain
  //      proper-noun like "Hospital Universitario La Paz").
  // The combined effect: catches "RTX 4080", "MacBook Pro M5", "iPhone
  // 15 Pro", "Galaxy S25 Ultra", "Boeing 737 MAX", "Лада Гранта 2024"
  // — without per-brand patches. Drops false positives like bare
  // numbers ("300"), numeric specs ("12 ГБ VRAM", "32 GB RAM") and
  // ordinary capitalized prose ("Hospital Universitario La Paz").
  const wordRe = /\b([\p{L}][\p{L}\p{N}]*|\d+)\b/gu;
  const wordMatches: { word: string; start: number; end: number }[] = [];
  const haystack = output ?? "";
  for (const match of haystack.matchAll(wordRe)) {
    const word = match[1];
    if (!word) continue;
    const start = match.index ?? 0;
    wordMatches.push({ word, start, end: start + word.length });
  }
  for (let i = 0; i < wordMatches.length; i += 1) {
    if (!/\p{Lu}/u.test(wordMatches[i]!.word)) continue;
    for (let len = 1; len <= 4 && i + len <= wordMatches.length; len += 1) {
      // Phrase must be contiguous prose: no sentence-internal
      // punctuation between consecutive words. Without this guard a
      // slide of "...GB RAM, 12 ГБ VRAM..." picks "GB RAM 12" as
      // a fake "specific" because the comma is invisible to a
      // word-list. Stop expanding the window as soon as we cross a
      // sentence-internal break.
      if (len >= 2) {
        const previousEnd = wordMatches[i + len - 2]!.end;
        const currentStart = wordMatches[i + len - 1]!.start;
        const between = haystack.slice(previousEnd, currentStart);
	        if (/[.,;:!?\n\r()\[\]{}$€£¥*]/.test(between)) break;
	      }
	      const windowWords = wordMatches.slice(i, i + len);
	      const phrase = windowWords.map((w) => w.word).join(" ");
	      if (!/\d/.test(phrase)) continue;
	      if (phrase.length < 2) continue;
	      if (containsLowercaseConnectorBeforeNumber(windowWords.map((w) => w.word))) {
	        continue;
	      }
      if (containsLowercaseConnectorBeforeNumberInSource(haystack, windowWords)) {
        continue;
      }
      if (isProtocolStatusSpecific(phrase)) continue;
      if (isNumberedStructuralLabelSpecific(phrase)) continue;
      // Structural numeric-spec filter: phrases containing a known
      // measurement unit attached to a number ("8 GB", "12 ГБ",
      // "2.5 kg", "75 Wh") are quantitative specs, not branded
      // specifics. Strip them so worker recommendations like "32 GB
      // of RAM" / "12 ГБ VRAM" never trip the gate. The unit set
      // covers SI / computing units and their Russian equivalents;
      // it is a finite well-known config, not a per-case allowlist.
      if (containsNumericSpec(phrase)) continue;
      candidates.add(phrase);
    }
  }

  // Years 2023-2030 mentioned without "20" prefix or as standalone tokens.
  for (const match of (output ?? "").matchAll(/\b(20(?:2[3-9]|30))\b/g)) {
    candidates.add(match[1]);
  }

  // Specific currency amounts.
  // Phase 13 follow-up: broaden to capture amounts with thousands
  // separators ("$79,581", "€68.819,05") and arbitrarily long decimal
  // tails ("€68 819,0591"). Numerical grounding below tolerates the
  // differences between worker output ("$79,581") and CSV evidence
  // ("79581.42") via normalize+compare instead of literal substring.
  // Single, non-alternation regex so `\d+` is greedy across the whole
  // amount — earlier alternation form picked `$249` out of `$2499`.
  const currencyRe = /(?:[$€£¥])\s?\d+(?:[\s.,]\d{3})*(?:[.,]\d{1,4})?/g;
  for (const match of (output ?? "").matchAll(currencyRe)) {
    candidates.add(match[0].replace(/\s/g, ""));
  }

  // Phase 13 follow-up: pre-extract every numeric value from the
  // evidence corpus once so the per-token currency check below stays
  // O(candidates × evidence-numbers). Without this we'd re-scan the
  // (potentially large) corpus for every token.
  const evidenceNumbers = extractNumericValuesFromEvidence(evidenceCorpus);

  const ungrounded: string[] = [];
  for (const token of candidates) {
    const normalized = token.toLowerCase().replace(/\s+/g, " ");
    if (evidenceCorpus.includes(normalized)) continue;
    // Partial-match fallback: drop the trailing qualifier (e.g. "RTX
    // 5080 Super" -> "RTX 5080") and check that. Important: we do NOT
    // accept by brand alone ("RTX") — a token like "RTX 4080" must not
    // pass simply because the evidence mentions "RTX 50 series". The
    // matched core must contain at least one digit so brand-only
    // matches are rejected.
    const parts = normalized.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const core = parts.slice(0, 2).join(" ");
      if (/\d/.test(core) && evidenceCorpus.includes(core)) continue;
    }
    // Phase 12 follow-up: pair-with-gap fallback. Worker writes a multi-
    // word brand token like "MacBook Pro M3 Max" but evidence has the
    // same brand expressed with a small stop-word inserted, e.g. "MacBook
    // Pro with M3 Max". A literal substring fails on the inserted word;
    // a naive word-set check would accept any token whose words happen to
    // appear in evidence (false positive: "MacBook Pro M4" would pass
    // because "m4" is mentioned somewhere unrelated). The correct check
    // is: every adjacent pair of words in the token must appear in the
    // evidence either back-to-back or with a single stop word between
    // them. That preserves the "tokens travel together" property without
    // demanding strict substring equality.
    if (parts.length >= 2 && pairsAppearTogetherInEvidence(parts, evidenceCorpus)) continue;
    // Phase 12 follow-up: contiguous sub-phrase fallback. A
    // candidate token is grounded if any contiguous slice of its
    // words (containing a digit) appears verbatim in the evidence
    // OR satisfies the pair-with-gap rule. This handles:
    //   - "Apple M5 chip" grounded by "Apple M5" (trim trailing
    //     descriptor word).
    //   - "Apple M4" grounded by any M4 mention in evidence (the
    //     digit-bearing chip name is what's specific).
    //   - "Lenovo Legion Pro 7i Gen 8" grounded by mid-slice
    //     "Legion Pro 7i" in evidence.
    // Single-word slices are accepted because the digit-bearing
    // word IS the specific the gate is policing — if it's anywhere
    // in evidence, the worker claim is grounded. The pure-digit
    // exclusion below makes sure we still reject claims like "RTX
    // 4080" when only "5090" is in evidence.
    let groundedBySubPhrase = false;
    outer: for (let i = 0; i < parts.length; i += 1) {
      for (let j = i + 1; j <= parts.length; j += 1) {
        if (i === 0 && j === parts.length) continue;
        const subParts = parts.slice(i, j);
        const subPhrase = subParts.join(" ");
        if (!/\d/.test(subPhrase)) continue;
        // A pure-digit slice ("4080") would falsely ground "RTX
        // 4080" against any unrelated "4080" appearance — require
        // the slice to also contain a letter so the digit travels
        // with its identifier.
        if (!/\p{L}/u.test(subPhrase)) continue;
        if (evidenceCorpus.includes(subPhrase)) { groundedBySubPhrase = true; break outer; }
        if (subParts.length >= 2 && pairsAppearTogetherInEvidence(subParts, evidenceCorpus)) {
          groundedBySubPhrase = true;
          break outer;
        }
      }
    }
    if (groundedBySubPhrase) continue;
    // Phase 13 follow-up: numerical grounding for currency amounts.
    // Workers (and synthesizers) round / shorten / re-format numbers
    // that ARE in evidence — "$79,581" written by synth vs
    // "79581.42" in a market.timeseries CSV evidence row, "€68 819,0591"
    // vs "68819.0591", "$81" rounded from "$81,234.56". Substring match
    // can't bridge those formats. Numerical match (tolerant ±1%) can.
    if (isCurrencyAmountGroundedNumerically(token, evidenceNumbers)) continue;
    ungrounded.push(token);
  }
  return ungrounded;
}

function isNumberedStructuralLabelSpecific(phrase: string): boolean {
  return /^(?:evidence|source|result|step|item|artifact|claim|check|proof)\s+\d+$/i.test(phrase.trim());
}

/**
 * Phase 13 follow-up: pull every numeric value out of the evidence
 * corpus, returning a deduped sorted array. Handles:
 *   - "79581.42" → 79581.42
 *   - "79,581.42" → 79581.42 (English thousands separator)
 *   - "79.581,42" → 79581.42 (European thousands separator)
 *   - "68 819,0591" → 68819.0591 (space thousands separator)
 *   - "$79,581" → 79581
 * Used by the ungrounded-specifics gate to compare numerical
 * representations of currency amounts independent of formatting.
 */
function extractNumericValuesFromEvidence(evidenceCorpus: string): number[] {
  const found = new Set<number>();
  // Match runs of digits with optional thousands/decimal separators.
  // Allow both `,` and `.` as separators in either role; we resolve the
  // ambiguity by inspecting the trailing group length (1-2 digits → decimal).
  const numRe = /\d{1,3}(?:[\s.,]\d{3})+(?:[.,]\d{1,4})?|\d+(?:[.,]\d{1,4})?/g;
  for (const match of evidenceCorpus.matchAll(numRe)) {
    const raw = match[0];
    const value = parseFlexibleNumber(raw);
    if (value !== undefined && value > 0) found.add(value);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Phase 13 follow-up: parse a number string that may use English
 * (`,` thousands, `.` decimal) or European (`.` thousands, `,` decimal)
 * conventions, optionally with spaces as thousands separators and any
 * leading currency symbol. Returns `undefined` for unparseable input.
 *
 * Disambiguation rules (in order):
 *   1. No separators → straight Number().
 *   2. Multiple separators of the same kind (`1,000,000`, `1.000.000`)
 *      → all separators are thousands.
 *   3. Multiple separators of different kinds (`79,581.42`,
 *      `79.581,42`) → last is decimal, earlier ones are thousands.
 *   4. Single separator with 3 trailing digits (`1,000`) → ambiguous,
 *      default to thousands (most common English/Russian usage).
 *   5. Single separator with 1-2 or 4+ trailing digits (`79.42`,
 *      `68819,0591`) → decimal.
 */
function parseFlexibleNumber(raw: string): number | undefined {
  const cleaned = raw.replace(/[$€£¥\s]/g, "");
  if (!/\d/.test(cleaned)) return undefined;
  const dotCount = (cleaned.match(/\./g) ?? []).length;
  const commaCount = (cleaned.match(/,/g) ?? []).length;
  const totalSeps = dotCount + commaCount;

  if (totalSeps === 0) {
    const direct = Number(cleaned);
    return Number.isFinite(direct) ? direct : undefined;
  }

  const lastSep = Math.max(cleaned.lastIndexOf("."), cleaned.lastIndexOf(","));
  const trailing = cleaned.length - lastSep - 1;

  let intPart = "";
  let decPart = "";

  if (totalSeps > 1) {
    const allSepsAreSame = dotCount === 0 || commaCount === 0;
    if (allSepsAreSame) {
      // All thousands separators (`1,000,000` or `1.000.000`).
      intPart = cleaned.replace(/[.,]/g, "");
    } else {
      // Mixed → last separator is decimal.
      intPart = cleaned.slice(0, lastSep).replace(/[.,]/g, "");
      decPart = cleaned.slice(lastSep + 1);
    }
  } else if (trailing === 3) {
    // Single separator with 3 trailing digits → likely thousands.
    intPart = cleaned.replace(/[.,]/g, "");
  } else {
    // Single separator with 1-2 or 4+ trailing digits → decimal.
    intPart = cleaned.slice(0, lastSep).replace(/[.,]/g, "");
    decPart = cleaned.slice(lastSep + 1);
  }

  const numeric = decPart ? Number(`${intPart}.${decPart}`) : Number(intPart);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/**
 * Phase 13 follow-up: a currency token like "$79,581" is grounded if
 * the evidence corpus contains a numeric value within ±1% of its
 * normalized magnitude. Tolerates rounding ("$81,000" vs "81234.56"
 * → 0.4% off, accepted) but rejects fabrications ("$50" vs evidence
 * showing only "79581.42" → ~37% off, rejected). Returns false for
 * non-currency tokens so the caller falls through to its other
 * grounding paths.
 */
function isCurrencyAmountGroundedNumerically(token: string, evidenceNumbers: number[]): boolean {
  if (!/^[$€£¥]/.test(token.trim())) return false;
  const value = parseFlexibleNumber(token);
  if (value === undefined || value <= 0) return false;
  const tolerance = Math.max(value * 0.01, 0.5); // 1%, but at least 0.5 absolute (handles tiny amounts)
  for (const evidenceValue of evidenceNumbers) {
    if (Math.abs(evidenceValue - value) <= tolerance) return true;
    // Worker may shorten "$79,581" → "$81" (thousand-rounded). Try value*1000.
    if (Math.abs(evidenceValue - value * 1000) <= Math.max(value * 1000 * 0.01, 0.5)) return true;
  }
  return false;
}

function containsLowercaseConnectorBeforeNumber(words: string[]): boolean {
  const firstNumber = words.findIndex((word) => /^\d+$/.test(word));
  if (firstNumber <= 1) return false;
  return words.slice(1, firstNumber).some((word) => {
    if (/\d/.test(word)) return false;
    return word === word.toLocaleLowerCase() && /\p{L}/u.test(word);
  });
}

function containsLowercaseConnectorBeforeNumberInSource(
  source: string,
  words: Array<{ start: number; end: number; word: string }>,
): boolean {
  const firstNumber = words.findIndex((word) => /^\d+$/.test(word.word));
  if (firstNumber <= 0) return false;
  const between = source.slice(words[0]!.end, words[firstNumber]!.start);
  return /[\p{Ll}]{2,}/u.test(between);
}

/**
 * Phase 12 follow-up: structural numeric-spec detector. Returns true
 * when the phrase contains a number directly attached (with optional
 * single space) to a known measurement unit. Used to prune candidate
 * "branded specifics" that are actually quantitative specs the worker
 * is allowed to mention freely (memory size, weight, battery
 * capacity, frequency, voltage, etc.).
 *
 * The unit set is intentionally finite and well-known (SI + computing
 * units + their Russian equivalents). It is a "config lookup" not a
 * per-case allowlist that grows arbitrarily — new units are rare and
 * adding one is a one-liner.
 */
function containsNumericSpec(phrase: string): boolean {
  // Pattern A: digit attached to a known measurement unit
  // ("8 GB", "12 ГБ", "2.5 kg", "75 Wh"). Standard SI / computing
  // unit set + Russian equivalents.
  const digitThenUnit = /\b\d+(?:[.,]\d+)?\s?(?:GB|MB|TB|KB|PB|GiB|MiB|KiB|TiB|GHz|MHz|kHz|Hz|kW|MW|mW|W|kV|mV|V|mA|A|kg|mg|g|km|cm|mm|nm|μm|m|°C|°F|°K|%|fps|rpm|dpi|ppi|MP|MP\/s|ms|μs|ns|s|min|h|Wh|mAh|kWh|bps|kbps|Mbps|Gbps|ГБ|МБ|ТБ|КБ|ГГц|МГц|кГц|Гц|Вт|КВт|кг|см|мм|мин|ч|Втч|мАч)\b/i;
  if (digitThenUnit.test(phrase)) return true;
  // Pattern B: hardware / spec tag attached to a digit
  // ("VRAM 8", "RAM 32", "CPU 12", "USB 3"). The tags are
  // well-known component / interface acronyms — finite config
  // list, not a per-case allowlist that grows arbitrarily.
  const tagThenDigit = /\b(?:RAM|VRAM|ROM|EEPROM|EPROM|FLASH|NVME|SSD|HDD|EMMC|UFS|CPU|GPU|TPU|NPU|APU|FPGA|ASIC|DSP|MCU|SoC|USB|HDMI|DP|VGA|DVI|PCIe|PCI|SATA|SAS|NIC|GPIO|UART|SPI|I2C|JTAG|RGB|YUV|HEVC|AV1|H264|H265|UHD|HDR|sRGB|DCI|TDP|TGP|PSU|RPM|IP|Wi[-‒–—]?Fi|Bluetooth|BT|NFC|GPS|LTE|5G|4G|3G|ОЗУ|ПЗУ)\s?\d+(?:[.,]\d+)?\b/i;
  return tagThenDigit.test(phrase);
}

/**
 * Phase 12 follow-up: check that AT LEAST ONE adjacent pair of words
 * in `parts` is anchored in evidence AND contains a digit-bearing
 * word. "Anchored" means: directly adjacent OR separated by one of a
 * small set of stop-words (with, and, the, of, ...). This is the
 * deterministic heuristic used by the ungrounded-specifics gate to
 * allow grounded tokens like "Apple M4 Pro" (vs evidence "MacBook Pro
 * M4 Pro" — pair `m4 pro` is anchored) and "MacBook Pro M3 Max" (vs
 * evidence "MacBook Pro with M3 Max" — pair `m3 max` is anchored)
 * through, while still rejecting brand+chip tokens like "MacBook Pro
 * M4" when the chip is not adjacent to a brand word in evidence.
 *
 * The digit-bearing constraint is the actual anchor: a token is
 * "specific" because of the digits it carries; if the digit-bearing
 * pair is in evidence, the specific is real regardless of how the
 * worker spelled the brand prefix.
 */
function pairsAppearTogetherInEvidence(parts: string[], evidenceCorpus: string): boolean {
  const stopWords = new Set([
    "a", "an", "the", "and", "or", "with", "of", "by", "in", "on", "for", "to", "from", "is", "are",
    "с", "и", "или", "в", "на", "по",
  ]);
  for (let i = 0; i < parts.length - 1; i += 1) {
    const a = parts[i];
    const b = parts[i + 1];
    if (!a || !b) continue;
    const pairCarriesDigit = /\d/.test(a) || /\d/.test(b);
    if (!pairCarriesDigit) continue;
    if (evidenceCorpus.includes(`${a} ${b}`)) return true;
    for (const sw of stopWords) {
      if (evidenceCorpus.includes(`${a} ${sw} ${b}`)) return true;
    }
  }
  return false;
}

/**
 * Phase 12 follow-up: build a synthesis-level evidence corpus from
 * GROUND-TRUTH sources only. The earlier version of this function
 * included worker `output` text in the corpus, which silently
 * "grounded" any specific that the worker had hallucinated (and was
 * already rejected for by hardGateReview). The synthesis LLM call could
 * then re-emit those tokens and pass the synthesis-level gate because
 * the rejected worker output was being treated as evidence.
 *
 * Sources, in priority order:
 *   1. The original task text (a token in the user's own request is
 *      grounded by definition).
 *   2. Every worker's `toolEvidence[]` (raw tool result text — the
 *      closest thing to ground truth available at synthesis time).
 *   3. Subtask metadata (title/prompt/expectedOutput/reviewCriteria) —
 *      the planner sometimes mentions specific anchor terms that the
 *      tools then verify, and those should count as grounded.
 *   4. Every artifact's filename / description / URL — these often
 *      carry page titles or source domains that the worker visited.
 *
 * Worker `output` is intentionally NOT in the corpus — that's the
 * exact channel the gate is supposed to check.
 */
function buildSynthesisEvidenceCorpus(
  task: string,
  workerResults: WorkerResult[],
  artifacts: AgentArtifact[],
): string {
  const parts: string[] = [task ?? "", buildRuntimeDateGroundingText()];
  for (const wr of workerResults ?? []) {
    parts.push(wr.subtask?.title ?? "");
    parts.push(wr.subtask?.prompt ?? "");
    parts.push(wr.subtask?.expectedOutput ?? "");
    if (wr.subtask?.reviewCriteria) parts.push(wr.subtask.reviewCriteria.join("\n"));
    if (wr.toolEvidence) parts.push(wr.toolEvidence.join("\n"));
    // Phase 28 follow-up — also dump the structured tool records into
    // the corpus. The ungrounded-specifics gate works by checking
    // whether tokens cited in the synthesis answer appear ANYWHERE in
    // this corpus (full-text search). If we don't include the raw
    // tool data (e.g. `data.pageText: "Bitcoin BTC $81,335.94 ..."`),
    // the synthesizer's correctly-quoted number gets flagged as
    // ungrounded and the gate strips it out — exactly the failure
    // mode where worker prose hedged but the page actually held the
    // answer.
    const recs = wr.toolEvidenceRecords as EvidenceRecord[] | undefined;
    if (recs && recs.length > 0) {
      parts.push(formatEvidenceRecordsForPrompt(recs, 12_000));
    }
    // Phase 12 follow-up: include the dependency context that fed the
    // upstream → downstream chain. A subtask's `toolEvidence` only
    // covers what THAT subtask's tools produced; tokens grounded in
    // an earlier subtask's evidence (e.g. discovery → verify →
    // synthesis) reach the synthesizer via the dependency context
    // chain, not through tool evidence on the synthesizer subtask.
    if (wr.dependencyContextSnapshot) parts.push(wr.dependencyContextSnapshot);
  }
  for (const artifact of artifacts ?? []) {
    parts.push(artifact.filename ?? "");
    parts.push(artifact.description ?? "");
    parts.push(artifact.url ?? "");
  }
  return parts.join("\n");
}

/**
 * Phase 12 follow-up: synthesis-level enforcement of the same
 * "specifics must be in evidence" rule. The worker hard-gate already
 * enforces this per-subtask, but synthesis is a separate LLM call that
 * can re-introduce specifics from training memory. This function:
 *
 *   1. Runs `findUngroundedSpecificsInText` against the synthesis
 *      output and the synthesis-level evidence corpus.
 *   2. If anything is ungrounded, retries the synthesis exactly once
 *      with a reinforced rule listing the forbidden tokens.
 *   3. If the retry still produces ungrounded tokens, deterministically
 *      replaces the offending answer with a plain "could not produce a
 *      grounded answer for these specifics" disclaimer that lists what
 *      was missing — never silently shipping ungrounded specifics.
 *
 * Returns the safe final answer (possibly the original, possibly
 * retried, possibly the disclaimer) plus a metadata object describing
 * what happened so callers can emit it.
 */
async function enforceUngroundedSpecificsOnSynthesis(args: {
  llm: LlmClient;
  modelTier: ReturnType<typeof selectModelTier>;
  systemPrompt: string;
  userPrompt: string;
  rawAnswer: string;
  evidenceCorpus: string;
}): Promise<{ answer: string; ungroundedFirstPass: string[]; ungroundedAfterRetry: string[]; disclaimerApplied: boolean }> {
  const initial = findUngroundedSpecificsInText(args.rawAnswer, args.evidenceCorpus);
  if (initial.length === 0) {
    return { answer: args.rawAnswer, ungroundedFirstPass: [], ungroundedAfterRetry: [], disclaimerApplied: false };
  }

  const forbidden = initial.slice(0, 12);
  const reinforced = `${args.userPrompt}

CRITICAL GROUND-TRUTH GATE (deterministic, non-negotiable):
The previous draft mentioned specifics that are NOT present in any worker tool evidence or in the user's task: ${forbidden.join(", ")}.
You MUST NOT mention any model number, version string, year, place name, person, organization, or currency amount that is not present verbatim in the worker outputs or the user's task above.
If a specific is not in the evidence, either omit it entirely or replace it with a generic description (e.g. "a current-generation discrete GPU" instead of an exact model number).
If the evidence is insufficient to give the user a concrete recommendation, say so plainly and explain what evidence would be needed — do NOT fall back to training-memory specifics.`;

  let retryAnswer = args.rawAnswer;
  try {
    retryAnswer = await args.llm.complete(
      [
        { role: "system", content: args.systemPrompt },
        { role: "user", content: reinforced },
      ],
      { modelTier: args.modelTier },
    );
  } catch {
    retryAnswer = args.rawAnswer;
  }

  const remaining = findUngroundedSpecificsInText(retryAnswer, args.evidenceCorpus);
  if (remaining.length === 0) {
    return {
      answer: retryAnswer,
      ungroundedFirstPass: initial,
      ungroundedAfterRetry: [],
      disclaimerApplied: false,
    };
  }

  // Last resort: never ship ungrounded specifics. Replace the answer
  // with a deterministic disclaimer that lists exactly what was missing
  // so the user can decide whether to broaden the search.
  const disclaimer = [
    "I could not produce a grounded recommendation for this task.",
    "",
    "The drafts the model produced kept naming the following specifics that are NOT supported by any tool evidence collected during this run, so I am not shipping them as advice:",
    `  ${remaining.slice(0, 12).join(", ")}`,
    "",
    "What this means: the live evidence I was able to collect (search results, opened pages, screenshots) did not include these exact model names, version numbers, prices, or dates. Using them would be guessing from training data rather than from the run, which is exactly what I was told not to do.",
    "",
    "Suggested next steps:",
    "- Re-run with more specific source URLs (e.g. paste a manufacturer or retailer page directly).",
    "- Loosen the requirement to specific model numbers and ask for categories or ranges instead.",
    "- Provide an alternative source if a particular site keeps returning loaders or login walls.",
  ].join("\n");

  return {
    answer: disclaimer,
    ungroundedFirstPass: initial,
    ungroundedAfterRetry: remaining,
    disclaimerApplied: true,
  };
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
  // Canonical shape: `{artifact: {filename, mimeType: "image/png",
  // contentBase64, ...}}` — what `browser.operate` and any agent-built
  // screenshot tool that mirrored it returns.
  const artifact = (data as { artifact?: unknown }).artifact;
  if (artifact && typeof artifact === "object") {
    const candidate = artifact as Partial<ScreenshotToolData["artifact"]>;
    if (
      typeof candidate.filename === "string" &&
      candidate.mimeType === "image/png" &&
      typeof candidate.contentBase64 === "string" &&
      candidate.contentBase64.length > 0
    ) {
      return true;
    }
  }
  // Phase 28 follow-up — accept the simpler shape council-built tools
  // emit when they don't wrap the bytes in an `artifact` object.
  // We've observed `screenshot.url@1.0.8+` returning
  // `data: { imageBase64: "<base64>" }`. Agent's `toArtifact` closure
  // adapts both shapes to the canonical AgentArtifact record.
  const flat = data as { imageBase64?: unknown; image?: unknown; contentBase64?: unknown };
  for (const key of ["imageBase64", "image", "contentBase64"] as const) {
    const value = flat[key];
    if (typeof value === "string" && value.length > 0) return true;
  }
  return false;
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

// Phase 12 Slice A/E: expose intent inference and URL scoring for unit tests
// so the laptop-research / flight-search regression has explicit coverage.
// These remain internal helpers; consumers should not rely on them.
// `inferTaskIntents` lives in `intentInference.ts` but is re-exposed here for
// the existing test suite.
export const __testing__ = {
  inferTaskIntents,
  scoreArtifactUrl,
  selectBestUrlsForArtifact,
  buildSearchQueries,
  extractSearchDomains,
  buildMarketAwareSearchQuery,
  inferMarketSearchHints,
  assessSearchEvidenceForReuse,
  getExplicitToolInputString,
  findUngroundedSpecificsInText,
  buildRuntimeDateGroundingText,
  buildSynthesisEvidenceCorpus,
  buildExternalActionBlockerFinalAnswer,
  enforceUngroundedSpecificsOnSynthesis,
  guardSearchQueryAgainstUngroundedSpecifics,
  guardDeclaredToolInputAgainstUngroundedSpecifics,
  parseForbiddenTokensFromReviewNotes,
  geoBiasScore,
  getAllWorkerArtifacts,
  getApprovedArtifacts,
  improveDeclaredToolInput,
  isShallowLandingUrl,
  isLowValueProofUrl,
  containsPlaceholderProof,
  buildInternalProjectKnowledgeFastPathSubtasks,
  buildLocalUtilityToolchainFastPathSubtasks,
  buildExternalActionFastPathSubtasks,
  buildExternalActionSearchQuery,
  hasActionableExternalActionDiscoveryEvidence,
  hasPreparedExternalActionBoundary,
  hasBlockedExternalActionPreparationBoundary,
  detectExternalActionPreparationBlocker,
  hardGateReview,
  rankExternalActionCandidateUrls,
  extractExternalActionCandidateLinksFromBrowserData,
  extractHttpUrls,
  isExternalActionIneligibleUrl,
  buildFallbackResearchSubtasks,
  buildClassificationContext,
  buildCompactSynthesisFallback,
  isContextWindowError,
  isRecoverableWorkerModelError,
  hasCollectedToolEvidence,
  buildWorkerModelFailureFallbackOutput,
  isWorkerModelFailureFallback,
  subtaskExpectsInteractiveBrowserProof,
  shouldCollectBrowserDiscovery,
  inferLocalUtilityToolchainPlan,
  isLocalUtilityToolchainSubtask,
  userExplicitlyAskedForUrl,
  pickReusableThreadScreenshot,
  parseFlexibleNumber,
  extractNumericValuesFromEvidence,
  isCurrencyAmountGroundedNumerically,
  formatScreenshotReuseDirective,
  parseProposalTail,
  parseRankingJson,
  parseFilesJson,
  parseReviewVerdict,
  parseQaOracle,
  formatFilesForPrompt,
};

// ──────────────────────────────────────────────────────────────────────
// Phase 14 — small parsing helpers for the council pipeline.
// The LLM output for each step is structured (single-JSON ending lines),
// but real models sometimes wrap JSON in backticks or prepend prose. These
// helpers tolerate the common deviations and fall back to safe defaults
// when the model output is gibberish, so a single bad responder can't
// crash the entire council run.
// ──────────────────────────────────────────────────────────────────────

function parseProposalTail(raw: string): { packages: string[]; externalDependencies: string[] } {
  // Look for the last JSON object in the text, which the prompt instructed
  // the model to emit on the final line.
  const match = raw.match(/\{[^{}]*"packages"[^{}]*\}/);
  if (!match) return { packages: [], externalDependencies: [] };
  try {
    const obj = JSON.parse(match[0]) as { packages?: unknown; externalDependencies?: unknown };
    const packages = Array.isArray(obj.packages)
      ? obj.packages.filter((v): v is string => typeof v === "string")
      : [];
    const externalDependencies = Array.isArray(obj.externalDependencies)
      ? obj.externalDependencies.filter((v): v is string => typeof v === "string")
      : [];
    return { packages, externalDependencies };
  } catch {
    return { packages: [], externalDependencies: [] };
  }
}

function parseRankingJson(raw: string, proposalCount: number): number[] {
  const obj = extractFirstJson<{ ranking?: unknown }>(raw);
  const ranking = Array.isArray(obj?.ranking)
    ? obj.ranking.filter((v): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < proposalCount)
    : [];
  // Deduplicate while preserving order.
  const seen = new Set<number>();
  const out: number[] = [];
  for (const idx of ranking) {
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(idx);
  }
  return out;
}

function parseFilesJson(raw: string): Array<{ path: string; content: string }> {
  const obj = extractFirstJson<{ files?: unknown }>(raw);
  if (!obj || !Array.isArray(obj.files)) return [];
  const out: Array<{ path: string; content: string }> = [];
  for (const entry of obj.files) {
    if (!entry || typeof entry !== "object") continue;
    const path = (entry as { path?: unknown }).path;
    const content = (entry as { content?: unknown }).content;
    if (typeof path === "string" && typeof content === "string") {
      out.push({ path, content });
    }
  }
  return out;
}

function parseReviewVerdict(raw: string): { verdict: "pass" | "needs_revision"; findings: string[] } {
  const obj = extractFirstJson<{ verdict?: unknown; findings?: unknown }>(raw);
  const verdict = obj?.verdict === "pass" ? "pass" : "needs_revision";
  const findings = Array.isArray(obj?.findings)
    ? (obj.findings as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  return { verdict, findings };
}

function parseQaOracle(raw: string): { verdict: "passed" | "failed"; failures: string[] } {
  const obj = extractFirstJson<{ verdict?: unknown; failures?: unknown }>(raw);
  const verdict = obj?.verdict === "passed" ? "passed" : "failed";
  const failures = Array.isArray(obj?.failures)
    ? (obj.failures as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  return { verdict, failures };
}

function extractFirstJson<T>(raw: string): T | undefined {
  if (!raw) return undefined;
  // Strip triple-backtick fences the model often wraps JSON in.
  const stripped = raw.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1").trim();
  const start = stripped.indexOf("{");
  if (start < 0) return undefined;
  // Find the matching closing brace by depth, ignoring those inside strings.
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i += 1) {
    const ch = stripped[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(stripped.slice(start, i + 1)) as T;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function formatFilesForPrompt(files: ReadonlyArray<{ path: string; content: string }>): string {
  if (files.length === 0) return "(no files)";
  return files
    .map((file) => `// ===== ${file.path} =====\n${file.content}`)
    .join("\n\n");
}
