export type AgentRole =
  | "coordinator"
  | "planner"
  | "worker"
  | "reviewer"
  | "synthesizer"
  | "tool-user";

export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /**
   * Phase 28 — present on `assistant` turns when the model invoked
   * tools. Echoed back to the chat API on the NEXT turn so it can
   * match `tool_call_id` on subsequent `role: "tool"` messages.
   * Optional + only used by `RecursiveAgent`; legacy code paths
   * ignore it.
   */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  /**
   * Phase 28 — present on `role: "tool"` messages. Links the result
   * back to the assistant turn's `tool_calls[].id`. Required by the
   * OpenAI function-calling protocol.
   */
  tool_call_id?: string;
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
  /**
   * Phase 28 follow-up — structured per-action tool records.
   * Carries the FULL `ToolResult.data` (pageText, numericTokens,
   * pageTitle, etc.) from each tool call this worker made, so the
   * reviewer + synthesizer + retrospective can read what the tool
   * ACTUALLY returned without going through the worker LLM's
   * lossy prose summary. Optional + co-exists with `toolEvidence`
   * during the staged migration; new callers should read this when
   * they need to verify or quote specifics like numbers / titles.
   * Shape is intentionally `unknown[]` here (rather than the
   * concrete `EvidenceRecord` union) so the type module doesn't
   * depend on the agent module; consumers cast as needed.
   */
  toolEvidenceRecords?: unknown[];
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

export type ExternalActionType =
  | "reservation"
  | "appointment"
  | "purchase"
  | "outbound_message"
  | "api_write"
  | "generic_external_action";

export type ExternalActionProposalStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "committed"
  | "cancelled";

export type ExternalActionCommitStatus =
  | "not_requested"
  | "blocked"
  | "committed"
  | "failed";

export type ExternalActionExecutionMode = "auto" | "approval";

export type ExternalActionCommitExecutorKind = "generated_tool" | "manual_operator";

export type ExternalActionCommitExecutor = {
  kind: ExternalActionCommitExecutorKind;
  toolName?: string;
  toolVersion?: string;
  toolInput?: Record<string, unknown>;
  expectedProof?: string[];
  risk: "low" | "medium" | "high";
  ready: boolean;
  reason: string;
  missing?: string[];
};

export type ExternalActionPreparation = {
  stage: "research_only" | "prepared_for_approval" | "ready_to_commit" | "blocked";
  objective: string;
  target?: string;
  targetUrl?: string;
  collectedInputs: Array<{
    label: string;
    value: string;
    source: "user_request" | "agent_inferred" | "source_evidence" | "profile" | "unknown";
  }>;
  missingInputs: string[];
  commitBoundary: string;
  operatorChecklist: string[];
  proofPlan: string[];
};

export type ExternalActionPreparedSession = {
  preparedAt: string;
  toolName: string;
  toolVersion?: string;
  currentUrl?: string;
  pageTitle?: string;
  textPreview?: string;
  links: Array<{ text?: string; href: string }>;
  formFields?: Array<{
    id?: string;
    label?: string;
    name?: string;
    type?: string;
    selector?: string;
    required?: boolean;
    placeholder?: string;
    autocomplete?: string;
  }>;
  formFieldGaps?: Array<{
    field?: string;
    label?: string;
    name?: string;
    type?: string;
    selector?: string;
    required?: boolean;
    reason: string;
    profileAvailable?: boolean;
    profileSource?: "user_profile" | "group_profile";
    valuePreview?: string;
  }>;
  approvedProfileFields?: Array<{
    field: string;
    source: "user_profile" | "group_profile";
    valuePreview: string;
    approvedAt: string;
    approvedBy: string;
  }>;
  availableProfileFields?: Array<{
    field: string;
    source: "user_profile" | "group_profile";
    valuePreview: string;
    reason: string;
  }>;
  filledFields: Array<{ label?: string; selector?: string; valuePreview: string }>;
  replaySteps: Array<Record<string, unknown>>;
  commitCandidates: Array<{ label?: string; selector?: string; reason: string }>;
  proofArtifactIds?: string[];
  artifactIds: string[];
  warnings: string[];
  actionDraft?: {
    status: "needs_preparation" | "needs_more_input" | "ready_for_operator_review";
    target?: string;
    action: string;
    pageUrl?: string;
    dataPreview: Array<{ label: string; value: string; source: "proposal" | "prepared_form" }>;
    missingBeforeCommit: string[];
    proofArtifactIds: string[];
    commitControls: Array<{ label?: string; selector?: string; reason: string }>;
    operatorNextStep: string;
    postCommitReportRequirements: string[];
  };
};

export type ExternalActionProposal = {
  id: string;
  runId: string;
  threadId?: string;
  actionType: ExternalActionType;
  status: ExternalActionProposalStatus;
  title: string;
  summary: string;
  proposedAction: string;
  executionMode?: ExternalActionExecutionMode;
  target?: string;
  payloadPreview?: string;
  preparation?: ExternalActionPreparation;
  approvalRequired: boolean;
  userExplicitlyForbidsAction: boolean;
  allowedWithoutApproval: string[];
  prohibitedWithoutApproval: string[];
  sourceUrls: string[];
  artifactIds: string[];
  commitExecutor?: ExternalActionCommitExecutor;
  createdAt: string;
  createdBy: "base-agent";
};

export type AgentRunResult = {
  finalAnswer: string;
  complexity: TaskComplexity;
  subtasks: Subtask[];
  workerResults: WorkerResult[];
  reviews: ReviewResult[];
  artifacts?: AgentArtifact[];
  toolCreationRequests?: Array<{
    toolName: string;
    toolVersion?: string;
    request: string;
    status: "requested" | "registered" | "failed";
    runId?: string;
    creationId?: string;
    packageRef?: string;
    error?: string;
  }>;
  toolEditRequests?: Array<{
    toolName: string;
    toolVersion?: string;
    request: string;
    status: "requested" | "registered" | "failed";
    runId?: string;
    creationId?: string;
    packageRef?: string;
    activeVersion?: string;
    replacesVersion?: string;
    error?: string;
  }>;
  actionProposals?: ExternalActionProposal[];
  learnedSkill?: SkillMemoryEntry;
  /** Optional status override for agents that complete with a failed gate or pause for approval. */
  runStatus?: "completed" | "failed" | "waiting_approval";
  /** Human-readable reason for `runStatus: "failed"`. */
  runFailureReason?: string;
};

export type AgentEventType =
  | "run-started"
  | "run-waiting-approval"
  | "artifacts-received"
  | "artifact-created"
  | "artifact-quality-updated"
  | "memory-search-completed"
  | "classification-completed"
  | "agent-strategy-selected"
  | "agent-task-framed"
  | "agent-context-prepared"
  | "memory-context-prepared"
  | "local-utility-fast-path-selected"
  | "current-fact-fast-path-selected"
  | "current-fact-source-rejected"
  | "current-fact-synthesis-completed"
  | "current-fact-synthesis-failed"
  | "proof-skipped"
  | "proof-degraded"
  | "agent-invocation-created"
  | "agent-decision-loop-completed"
  | "agent-council-planned"
  | "agent-invocation-started"
  | "agent-invocation-decision-selected"
  | "agent-invocation-completed"
  | "agent-invocation-failed"
  | "agent-invocation-return-checked"
  | "agent-truncated-answer-repair-requested"
  | "agent-proof-repair-requested"
  | "agent-research-contract-repair-requested"
  | "agent-source-grounding-repair-requested"
  | "agent-source-grounding-degraded"
  | "agent-tool-contract-fields-added"
  | "agent-final-answer-grounding-degraded"
  | "external-action-proposal-created"
  | "external-action-proposal-approved"
  | "external-action-proposal-rejected"
  | "external-action-approval-auto-advance-started"
  | "external-action-approval-auto-advance-completed"
  | "external-action-approval-auto-advance-failed"
  | "external-action-executor-build-requested"
  | "external-action-executor-build-completed"
  | "external-action-executor-build-failed"
  | "external-action-executor-attached"
  | "external-action-preparation-started"
  | "external-action-preparation-completed"
  | "external-action-preparation-failed"
  | "external-action-profile-hydration-approved"
  | "external-action-commit-started"
  | "external-action-commit-blocked"
  | "external-action-commit-failed"
  | "external-action-committed"
  | "agent-candidate-use-repair-requested"
  | "planning-completed"
  | "worker-started"
  | "worker-completed"
  | "worker-failed"
  | "review-started"
  | "review-completed"
  | "review-failed"
  | "tool-missing"
  | "tool-started"
  | "tool-completed"
  | "tool-creation-started"
  | "tool-creation-discovery-completed"
  | "tool-creation-secrets-registered"
  | "tool-creation-strategy-selected"
  | "tool-creation-authoring-completed"
  | "tool-creation-package-qa-completed"
  | "tool-creation-registered"
  | "tool-creation-reloaded"
  | "tool-creation-completed"
  | "tool-creation-failed"
  | "tool-version-manual-run"
  | "tool-version-marked-available"
  | "tool-version-activated"
  | "tool-version-agent-accepted"
  | "tool-version-rejected"
  | "tool-version-deleted"
  | "agent-tool-catalog-updated"
  | "tool-candidate-accepted"
  | "tool-candidate-manual-review-required"
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
  | "work-ledger-reuse-available"
  | "work-ledger-reuse-skipped"
  | "work-ledger-reuse-applied"
  | "work-ledger-reuse-index-updated"
  | "work-ledger-prior-context-resolved"
  | "work-ledger-prior-context-applied"
  | "evidence-ledger-recorded"
  | "run-retrospective-proposed";

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
