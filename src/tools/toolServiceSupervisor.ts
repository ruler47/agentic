import { ToolRegistry } from "./registry.js";
import { ToolHealth } from "./tool.js";
import {
  InMemoryToolServiceStatusStore,
  StoredToolServiceStatus,
  ToolServiceStatus,
  ToolServiceStatusStore,
  defaultToolServiceStatus,
} from "./toolServiceStatusStore.js";

export class ToolServiceSupervisor {
  constructor(
    private readonly registry: Pick<ToolRegistry, "get" | "list">,
    private readonly statusStore: ToolServiceStatusStore = new InMemoryToolServiceStatusStore(),
  ) {}

  async list(): Promise<ToolServiceStatus[]> {
    const tools = this.registry
      .list()
      .filter((tool) => tool.startupMode === "always-on")
      .sort((a, b) => a.name.localeCompare(b.name));

    return Promise.all(tools.map(async (tool) => ({
      ...(await this.statusFor(tool.name)),
      displayName: tool.displayName,
      description: tool.description,
    })));
  }

  async start(toolName: string): Promise<ToolServiceStatus> {
    const tool = this.requiredAlwaysOnTool(toolName);
    const now = new Date();
    const starting = await this.write({
      ...(await this.statusFor(toolName)),
      status: "starting",
      desiredState: "running",
      detail: "Starting service and checking health.",
      updatedAt: now.toISOString(),
    });
    const health = await this.runHealthcheck(toolName);
    const nextNow = new Date().toISOString();
    const next = await this.write({
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
    const next = await this.write({
      ...(await this.statusFor(toolName)),
      status: "stopped",
      desiredState: "stopped",
      detail: "Stopped by operator.",
      stoppedAt: now,
      updatedAt: now,
    });
    return { ...next, displayName: tool.displayName, description: tool.description };
  }

  async restart(toolName: string): Promise<ToolServiceStatus> {
    const existing = await this.statusFor(toolName);
    await this.write({
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
    const existing = await this.statusFor(toolName);
    if (existing.desiredState !== "running") {
      return { ...existing, displayName: tool.displayName, description: tool.description };
    }

    const health = await this.runHealthcheck(toolName);
    const now = new Date().toISOString();
    const next = await this.write({
      ...existing,
      status: health.ok ? "running" : "failed",
      detail: health.detail,
      lastHealthOk: health.ok,
      lastHeartbeatAt: now,
      updatedAt: now,
    });
    return { ...next, displayName: tool.displayName, description: tool.description };
  }

  async reconcileDesiredServices(): Promise<ToolServiceStatus[]> {
    const tools = this.registry
      .list()
      .filter((tool) => tool.startupMode === "always-on")
      .sort((a, b) => a.name.localeCompare(b.name));
    const reconciled: ToolServiceStatus[] = [];
    for (const tool of tools) {
      const existing = await this.statusFor(tool.name);
      if (existing.desiredState === "running") {
        reconciled.push(await this.heartbeat(tool.name));
      }
    }
    return reconciled;
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

  private async statusFor(toolName: string): Promise<StoredToolServiceStatus> {
    return (await this.statusStore.get(toolName)) ?? defaultToolServiceStatus(toolName);
  }

  private async write(status: StoredToolServiceStatus): Promise<StoredToolServiceStatus> {
    return this.statusStore.set(status);
  }
}
