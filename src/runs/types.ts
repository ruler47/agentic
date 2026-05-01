import { AgentEvent, AgentRunResult } from "../types.js";

export type RunStatus = "queued" | "running" | "completed" | "failed";

export type AgentRunRecord = {
  id: string;
  task: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  events: AgentEvent[];
  result?: AgentRunResult;
  error?: string;
};

export type PublicRunRecord = Omit<AgentRunRecord, "result"> & {
  result?: AgentRunResult;
};

export type RunStore = {
  create(task: string): Promise<AgentRunRecord>;
  list(): Promise<AgentRunRecord[]>;
  get(id: string): Promise<AgentRunRecord | undefined>;
  markRunning(id: string): Promise<void>;
  appendEvent(id: string, event: AgentEvent): Promise<void>;
  complete(id: string, result: AgentRunResult): Promise<void>;
  fail(id: string, error: string): Promise<void>;
};
