import { AgentEvent, AgentRunResult, ModelTier, TokenUsage } from "../types.js";

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentRunRecord = {
  id: string;
  task: string;
  status: RunStatus;
  instanceId?: string;
  requesterUserId?: string;
  channel?: string;
  threadId?: string;
  parentRunId?: string;
  sourceUserId?: string;
  sourceMessageId?: string;
  sourceChatId?: string;
  sourceThreadId?: string;
  createdAt: string;
  updatedAt: string;
  events: AgentEvent[];
  result?: AgentRunResult;
  error?: string;
  metrics?: RunMetrics;
};

export type PublicRunRecord = Omit<AgentRunRecord, "result"> & {
  result?: AgentRunResult;
};

export type RunMetrics = {
  startedAt: string;
  completedAt?: string;
  elapsedMs: number;
  llmCalls: number;
  toolCalls: number;
  failedToolCalls: number;
  artifacts: number;
  tokenUsage: TokenUsage;
  models: Array<{
    model: string;
    calls: number;
    requestedTiers: ModelTier[];
    totalTokens?: number;
  }>;
  slowestEvents: Array<{
    eventId: string;
    spanId: string;
    title: string;
    activity: AgentEvent["activity"];
    durationMs: number;
  }>;
};

export type RunCreateContext = {
  instanceId?: string;
  requesterUserId?: string;
  channel?: string;
  threadId?: string;
  parentRunId?: string;
  sourceUserId?: string;
  sourceMessageId?: string;
  sourceChatId?: string;
  sourceThreadId?: string;
};

export type RunMeta = {
  status: RunStatus;
  updatedAt: string;
  eventCount: number;
};

export type RunStore = {
  create(task: string, context?: RunCreateContext): Promise<AgentRunRecord>;
  list(): Promise<AgentRunRecord[]>;
  get(id: string): Promise<AgentRunRecord | undefined>;
  /**
   * Cheap change-detection projection for pollers (SSE stream): status,
   * updated-at, and event count without hydrating the event list.
   */
  getMeta(id: string): Promise<RunMeta | undefined>;
  markRunning(id: string): Promise<void>;
  waitForApproval(id: string, result: AgentRunResult, reason: string): Promise<void>;
  appendEvent(id: string, event: AgentEvent): Promise<void>;
  complete(id: string, result: AgentRunResult): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  cancel(id: string, reason: string): Promise<void>;
  /**
   * Sweep runs left in `queued` / `running` after a process restart and mark
   * them `failed` with the supplied reason. `staleAfterMs` (optional) filters
   * the sweep to runs whose `updated_at` is older than the threshold so a
   * brand-new run that the same process just started a moment ago is not
   * killed. Default 0 = no filter (legacy behaviour).
   */
  recoverInterrupted(error: string, options?: { staleAfterMs?: number }): Promise<number>;
  delete(id: string): Promise<boolean>;
  deleteByThreadId(threadId: string): Promise<number>;
};
