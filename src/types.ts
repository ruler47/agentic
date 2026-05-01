export type AgentRole =
  | "coordinator"
  | "planner"
  | "worker"
  | "reviewer"
  | "synthesizer";

export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmConfig = {
  baseUrl: string;
  model: string;
  temperature: number;
};

export type SkillMemoryEntry = {
  id: string;
  title: string;
  tags: string[];
  summary: string;
  reusableProcedure: string;
  createdAt: string;
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
};

export type WorkerResult = {
  subtask: Subtask;
  output: string;
  traceSpanId?: string;
};

export type ReviewResult = {
  subtaskId: string;
  verdict: "pass" | "needs_revision";
  notes: string;
};

export type AgentRunResult = {
  finalAnswer: string;
  complexity: TaskComplexity;
  subtasks: Subtask[];
  workerResults: WorkerResult[];
  reviews: ReviewResult[];
  learnedSkill?: SkillMemoryEntry;
};

export type AgentEventType =
  | "run-started"
  | "memory-search-completed"
  | "classification-completed"
  | "planning-completed"
  | "worker-started"
  | "worker-completed"
  | "review-started"
  | "review-completed"
  | "synthesis-started"
  | "synthesis-completed"
  | "learning-completed"
  | "run-completed";

export type AgentActivity =
  | "coordination"
  | "memory"
  | "llm"
  | "planning"
  | "worker"
  | "review"
  | "synthesis"
  | "tool"
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
