import { ToolRegistry } from "./registry.js";
import { ToolHealth } from "./tool.js";

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
};

type StoredToolServiceStatus = Omit<ToolServiceStatus, "displayName" | "description">;

export class ToolServiceSupervisor {
  private readonly statuses = new Map<string, StoredToolServiceStatus>();

  constructor(private readonly registry: Pick<ToolRegistry, "get" | "list">) {}

  async list(): Promise<ToolServiceStatus[]> {
    const tools = this.registry
      .list()
      .filter((tool) => tool.startupMode === "always-on")
      .sort((a, b) => a.name.localeCompare(b.name));

    return tools.map((tool) => ({
      ...this.statusFor(tool.name),
      displayName: tool.displayName,
      description: tool.description,
    }));
  }

  async start(toolName: string): Promise<ToolServiceStatus> {
    const tool = this.requiredAlwaysOnTool(toolName);
    const now = new Date();
    const starting = this.write(toolName, {
      ...this.statusFor(toolName),
      status: "starting",
      desiredState: "running",
      detail: "Starting service and checking health.",
      updatedAt: now.toISOString(),
    });
    const health = await this.runHealthcheck(toolName);
    const nextNow = new Date().toISOString();
    const next = this.write(toolName, {
      ...starting,
      status: health.ok ? "running" : "failed",
      desiredState: "running",
      detail: health.detail,
      lastHealthOk: health.ok,
      lastHeartbeatAt: nextNow,
      startedAt: health.ok ? (starting.startedAt ?? nextNow) : starting.startedAt,
      updatedAt: nextNow,
    });
    return { ...next, displayName: tool.displayName, description: tool.description };
  }

  async stop(toolName: string): Promise<ToolServiceStatus> {
    const tool = this.requiredAlwaysOnTool(toolName);
    const now = new Date().toISOString();
    const next = this.write(toolName, {
      ...this.statusFor(toolName),
      status: "stopped",
      desiredState: "stopped",
      detail: "Stopped by operator.",
      stoppedAt: now,
      updatedAt: now,
    });
    return { ...next, displayName: tool.displayName, description: tool.description };
  }

  async restart(toolName: string): Promise<ToolServiceStatus> {
    const existing = this.statusFor(toolName);
    this.write(toolName, {
      ...existing,
      restartCount: existing.restartCount + 1,
      status: "stopped",
      desiredState: "running",
      detail: "Restart requested.",
      stoppedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return this.start(toolName);
  }

  async heartbeat(toolName: string): Promise<ToolServiceStatus> {
    const tool = this.requiredAlwaysOnTool(toolName);
    const existing = this.statusFor(toolName);
    if (existing.desiredState !== "running") {
      return { ...existing, displayName: tool.displayName, description: tool.description };
    }

    const health = await this.runHealthcheck(toolName);
    const now = new Date().toISOString();
    const next = this.write(toolName, {
      ...existing,
      status: health.ok ? "running" : "failed",
      detail: health.detail,
      lastHealthOk: health.ok,
      lastHeartbeatAt: now,
      updatedAt: now,
    });
    return { ...next, displayName: tool.displayName, description: tool.description };
  }

  private async runHealthcheck(toolName: string): Promise<ToolHealth> {
    const tool = this.requiredAlwaysOnTool(toolName);
    if (!tool.healthcheck) {
      return { ok: true, detail: "No healthcheck registered; service lifecycle marked running." };
    }
    try {
      return await tool.healthcheck();
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "Tool service healthcheck failed.",
      };
    }
  }

  private requiredAlwaysOnTool(toolName: string) {
    const tool = this.registry.get(toolName);
    if (!tool) throw new Error(`Tool ${toolName} was not found`);
    if (tool.startupMode !== "always-on") {
      throw new Error(`Tool ${toolName} is not an always-on service tool`);
    }
    return tool;
  }

  private statusFor(toolName: string): StoredToolServiceStatus {
    const existing = this.statuses.get(toolName);
    if (existing) return { ...existing };
    const now = new Date().toISOString();
    return {
      toolName,
      status: "stopped",
      desiredState: "stopped",
      detail: "Service is installed but not started by the supervisor.",
      updatedAt: now,
      restartCount: 0,
    };
  }

  private write(toolName: string, status: StoredToolServiceStatus): StoredToolServiceStatus {
    this.statuses.set(toolName, { ...status });
    return { ...status };
  }
}
