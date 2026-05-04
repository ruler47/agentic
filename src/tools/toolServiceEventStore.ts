export type ToolServiceEventDirection = "inbound" | "outbound" | "system";
export type ToolServiceEventStatus = "received" | "queued" | "sent" | "failed" | "ignored";

export type ToolServiceEventRecord = {
  id: string;
  toolName: string;
  direction: ToolServiceEventDirection;
  status: ToolServiceEventStatus;
  summary: string;
  sourceUserId?: string;
  sourceChatId?: string;
  sourceMessageId?: string;
  threadId?: string;
  runId?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
};

export type ToolServiceEventInput = {
  toolName: string;
  direction: ToolServiceEventDirection;
  status: ToolServiceEventStatus;
  summary: string;
  sourceUserId?: string;
  sourceChatId?: string;
  sourceMessageId?: string;
  threadId?: string;
  runId?: string;
  payload?: Record<string, unknown>;
};

export type ToolServiceEventListOptions = {
  toolName?: string;
  direction?: ToolServiceEventDirection;
  limit?: number;
};

export type ToolServiceEventStore = {
  record(input: ToolServiceEventInput): Promise<ToolServiceEventRecord>;
  list(options?: ToolServiceEventListOptions): Promise<ToolServiceEventRecord[]>;
};

export class InMemoryToolServiceEventStore implements ToolServiceEventStore {
  private readonly events: ToolServiceEventRecord[] = [];

  async record(input: ToolServiceEventInput): Promise<ToolServiceEventRecord> {
    const record: ToolServiceEventRecord = {
      id: createToolServiceEventId(),
      ...input,
      payload: input.payload ? { ...input.payload } : undefined,
      createdAt: new Date().toISOString(),
    };
    this.events.unshift(cloneEvent(record));
    return cloneEvent(record);
  }

  async list(options: ToolServiceEventListOptions = {}): Promise<ToolServiceEventRecord[]> {
    const limit = Math.max(1, Math.min(200, options.limit ?? 100));
    return this.events
      .filter((event) => !options.toolName || event.toolName === options.toolName)
      .filter((event) => !options.direction || event.direction === options.direction)
      .slice(0, limit)
      .map(cloneEvent);
  }
}

export function createToolServiceEventId(): string {
  return `toolsvc_evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function cloneEvent(record: ToolServiceEventRecord): ToolServiceEventRecord {
  return {
    ...record,
    payload: record.payload ? { ...record.payload } : undefined,
  };
}
