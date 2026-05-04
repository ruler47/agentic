import { AgentEvent, AgentRunResult } from "../types.js";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

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
};

export type PublicRunRecord = Omit<AgentRunRecord, "result"> & {
  result?: AgentRunResult;
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

export type RunStore = {
  create(task: string, context?: RunCreateContext): Promise<AgentRunRecord>;
  list(): Promise<AgentRunRecord[]>;
  get(id: string): Promise<AgentRunRecord | undefined>;
  markRunning(id: string): Promise<void>;
  appendEvent(id: string, event: AgentEvent): Promise<void>;
  complete(id: string, result: AgentRunResult): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  cancel(id: string, reason: string): Promise<void>;
  recoverInterrupted(error: string): Promise<number>;
  deleteByThreadId(threadId: string): Promise<number>;
};
