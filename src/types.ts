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
  | "learning-completed"
  | "run-completed"
  | "work-ledger-claim-created"
  | "work-ledger-reused"
  | "work-ledger-waiting-existing"
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
