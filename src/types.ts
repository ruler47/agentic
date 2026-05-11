export type AgentRole =
  | "coordinator"
  | "planner"
  | "worker"
  | "reviewer"
  | "synthesizer"
  | "tool-builder"
  | "tool-qa"
  | "tool-registrar"
  | "tool-user";

export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmConfig = {
  baseUrl: string;
  model: string;
  temperature: number;
  tierModels: Partial<Record<ModelTier, string>>;
  tierModelCandidates: Partial<Record<ModelTier, string[]>>;
};

export type ModelTier = "S" | "M" | "L" | "XL";

export type ModelTierSettings = {
  tier: ModelTier;
  models: string[];
  maxAttempts: number;
  escalateOnFailure: boolean;
  updatedAt: string;
};

export type MemoryScope = "global" | "group" | "user" | "thread" | "run";
export type MemoryStatus = "proposed" | "accepted" | "rejected" | "archived";
export type MemorySensitivity = "normal" | "sensitive" | "private";

export type SkillMemoryEntry = {
  id: string;
  title: string;
  tags: string[];
  summary: string;
  reusableProcedure: string;
  scope?: MemoryScope;
  scopeId?: string;
  status?: MemoryStatus;
  confidence?: number;
  sensitivity?: MemorySensitivity;
  sourceRunId?: string;
  sourceThreadId?: string;
  evidence?: string[];
  match?: SkillMemoryMatch;
  createdAt: string;
  updatedAt?: string;
};

export type SkillMemoryMatch = {
  score: number;
  reason: string;
  matchedTokens: string[];
  scope: MemoryScope;
  scopeId?: string;
};

export type TaskComplexity = {
  mode: "direct" | "delegated";
  reason: string;
  domains: string[];
  riskLevel: "low" | "medium" | "high";
  /**
   * Phase 12 Slice A (full): semantic task intents inferred by the
   * classifier model. The runtime uses these to gate domain-specific URL
   * scoring, search query expansion, and discovery activation. Free-form
   * strings — the canonical seed list is in `src/agents/intentInference.ts`
   * (`KNOWN_INTENTS`) but operators / future tools can add new values.
   * Empty array means "no domain-specific knowledge applies". Optional in
   * the type to keep older fixtures and tests source-compatible; the
   * runtime always normalizes it to `[]` on parse.
   */
  intent?: string[];
  /**
   * Phase 12 follow-up: geographic anchors detected in the user's
   * task — country / city / locale tokens like "Spain", "España",
   * "Madrid", "in Germany", "in Spain". The classifier extracts them
   * (free-form, no hardcoded country list) and the runtime uses them
   * to (a) bias `discoveryUrlRanker` toward matching TLDs / locale
   * markers, (b) include the anchor verbatim in search queries, and
   * (c) tell the worker prompt that all navigation MUST stay
   * inside the requested geography. Empty array means no anchor was
   * detected and runs proceed without geo-bias. Optional for source
   * compatibility with older fixtures.
   */
  geoAnchors?: string[];
};

export type Subtask = {
  id: string;
  title: string;
  role: string;
  prompt: string;
  expectedOutput: string;
  reviewCriteria: string[];
  dependsOn?: string[];
  requiredTools?: string[];
  requiredArtifacts?: ArtifactRequirement[];
  toolInputs?: Record<string, unknown>;
};

export type WorkerResult = {
  subtask: Subtask;
  output: string;
  toolEvidence?: string[];
  artifacts?: AgentArtifact[];
  traceSpanId?: string;
  modelTier?: ModelTier;
  /**
   * Phase 12 follow-up: snapshot of the dependency-context block that
   * was passed into the worker prompt for this subtask. Captures the
   * upstream worker outputs and tool-evidence summaries that this
   * worker is allowed to reuse. Hard-gate review needs it so that a
   * downstream worker citing a token like "MacBook Pro M3 Max" — which
   * was grounded in the upstream discovery worker's evidence — does
   * not get falsely rejected just because the downstream worker's own
   * tool calls did not re-fetch the same source.
   */
  dependencyContextSnapshot?: string;
};

export type ReviewResult = {
  subtaskId: string;
  verdict: "pass" | "needs_revision";
  notes: string;
};

export type AgentArtifactKind = "input" | "output";

export type ArtifactRequirement = {
  kind: "screenshot" | "chart" | "document" | "data" | "image" | "source";
  capability: string;
  description: string;
  required?: boolean;
};

export type AgentArtifact = {
  id: string;
  runId: string;
  kind: AgentArtifactKind;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  description?: string;
  contentPreview?: string;
  quality?: ArtifactQualityMetadata;
  createdAt: string;
};

export type ArtifactQualityMetadata = {
  status: "passed" | "warning" | "failed";
  reviewedAt: string;
  checks: ArtifactQualityCheck[];
};

export type ArtifactQualityCheck = {
  name: string;
  ok: boolean;
  decision: string;
  reason: string;
  signals?: string[];
  warnings?: string[];
};

export type ArtifactUploadInput = {
  filename: string;
  mimeType?: string;
  contentBase64: string;
  description?: string;
};

export type ArtifactCreateInput = {
  filename: string;
  mimeType: string;
  content: string | Buffer;
  description?: string;
  quality?: ArtifactQualityMetadata;
};

export type AgentRunResult = {
  finalAnswer: string;
  complexity: TaskComplexity;
  subtasks: Subtask[];
  workerResults: WorkerResult[];
  reviews: ReviewResult[];
  artifacts?: AgentArtifact[];
  learnedSkill?: SkillMemoryEntry;
};

export type AgentEventType =
  | "run-started"
  | "artifacts-received"
  | "artifact-created"
  | "memory-search-completed"
  | "classification-completed"
  | "agent-strategy-selected"
  | "agent-invocation-created"
  | "agent-decision-loop-completed"
  | "agent-council-planned"
  | "agent-invocation-started"
  | "agent-invocation-decision-selected"
  | "agent-invocation-completed"
  | "agent-invocation-failed"
  | "agent-invocation-return-checked"
  | "planning-completed"
  | "worker-started"
  | "worker-completed"
  | "worker-failed"
  | "review-started"
  | "review-completed"
  | "review-failed"
  | "tool-missing"
  | "tool-build-requested"
  | "tool-rework-wait-opened"
  | "tool-started"
  | "tool-completed"
  | "agent-self-check-completed"
  | "synthesis-started"
  | "synthesis-completed"
  | "discovery-url-ranked"
  | "learning-completed"
  | "run-completed"
  | "work-ledger-claim-created"
  | "work-ledger-revalidation-created"
  | "work-ledger-blocked"
  | "work-ledger-reused"
  | "work-ledger-waiting-existing"
  | "evidence-ledger-recorded"
  | "run-retrospective-proposed"
  // Phase 14: tool-build council events.
  | "tool-build-brainstorm-proposal"
  | "tool-build-vote-cast"
  | "tool-build-council-winner-selected"
  | "tool-build-code-drafted"
  | "tool-build-code-review-cast"
  | "tool-build-code-revised"
  | "tool-build-qa-attempt"
  | "tool-build-code-repaired"
  | "tool-build-registered"
  // Phase 14 / Phase 2: parent build halted on a missing reader tool.
  | "tool-build-waiting-for-reader";

export type AgentActivity =
  | "coordination"
  | "memory"
  | "llm"
  | "planning"
  | "worker"
  | "review"
  | "synthesis"
  | "tool"
  | "agent"
  | "database";

export type AgentEventStatus = "started" | "completed" | "failed";

export type AgentEvent = {
  id: string;
  spanId: string;
  parentSpanId?: string;
  type: AgentEventType;
  actor: string;
  activity: AgentActivity;
  status: AgentEventStatus;
  title: string;
  detail?: string;
  timestamp: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  payload?: unknown;
};

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
