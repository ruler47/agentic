export type ToolServiceRuntimeStatus = "stopped" | "starting" | "running" | "failed";
export type ToolServiceDesiredState = "stopped" | "running";

export type ToolServiceStatus = {
  toolName: string;
  displayName?: string;
  description: string;
  status: ToolServiceRuntimeStatus;
  desiredState: ToolServiceDesiredState;
  detail: string;
  lastHealthOk?: boolean;
  lastHeartbeatAt?: string;
  startedAt?: string;
  stoppedAt?: string;
  updatedAt: string;
  restartCount: number;
  consecutiveFailureCount: number;
  autoRestartEnabled?: boolean;
  maxAutoRestarts?: number;
  lastFailureAt?: string;
  lastRestartAt?: string;
  lastRestartReason?: string;
};

export type StoredToolServiceStatus = Omit<ToolServiceStatus, "displayName" | "description">;

export type ToolServiceStatusStore = {
  get(toolName: string): Promise<StoredToolServiceStatus | undefined>;
  set(status: StoredToolServiceStatus): Promise<StoredToolServiceStatus>;
};

export class InMemoryToolServiceStatusStore implements ToolServiceStatusStore {
  private readonly statuses = new Map<string, StoredToolServiceStatus>();

  async get(toolName: string): Promise<StoredToolServiceStatus | undefined> {
    const existing = this.statuses.get(toolName);
    return existing ? cloneStoredStatus(existing) : undefined;
  }

  async set(status: StoredToolServiceStatus): Promise<StoredToolServiceStatus> {
    this.statuses.set(status.toolName, cloneStoredStatus(status));
    return cloneStoredStatus(status);
  }
}

export function defaultToolServiceStatus(toolName: string, now = new Date()): StoredToolServiceStatus {
  return {
    toolName,
    status: "stopped",
    desiredState: "stopped",
    detail: "Service is installed but not started by the supervisor.",
    updatedAt: now.toISOString(),
    restartCount: 0,
    consecutiveFailureCount: 0,
  };
}

export function cloneStoredStatus(status: StoredToolServiceStatus): StoredToolServiceStatus {
  return {
    ...status,
  };
}
