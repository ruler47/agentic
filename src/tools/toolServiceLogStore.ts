export type ToolServiceLogLevel = "info" | "warn" | "error";

export type ToolServiceLogRecord = {
  id: string;
  toolName: string;
  level: ToolServiceLogLevel;
  message: string;
  status?: string;
  detail?: string;
  createdAt: string;
};

export type ToolServiceLogInput = {
  toolName: string;
  level: ToolServiceLogLevel;
  message: string;
  status?: string;
  detail?: string;
};

export type ToolServiceLogListOptions = {
  toolName?: string;
  limit?: number;
};

export type ToolServiceLogStore = {
  append(input: ToolServiceLogInput): Promise<ToolServiceLogRecord>;
  list(options?: ToolServiceLogListOptions): Promise<ToolServiceLogRecord[]>;
};

export class InMemoryToolServiceLogStore implements ToolServiceLogStore {
  private readonly logs: ToolServiceLogRecord[] = [];

  async append(input: ToolServiceLogInput): Promise<ToolServiceLogRecord> {
    const record: ToolServiceLogRecord = {
      id: createToolServiceLogId(),
      ...input,
      createdAt: new Date().toISOString(),
    };
    this.logs.unshift({ ...record });
    return { ...record };
  }

  async list(options: ToolServiceLogListOptions = {}): Promise<ToolServiceLogRecord[]> {
    const limit = Math.max(1, Math.min(200, options.limit ?? 100));
    return this.logs
      .filter((record) => !options.toolName || record.toolName === options.toolName)
      .slice(0, limit)
      .map((record) => ({ ...record }));
  }
}

export function createToolServiceLogId(): string {
  return `toolsvc_log_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
