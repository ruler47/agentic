import { ToolRegistry } from "./registry.js";
import { ToolHealth, ToolServiceContext, ToolServiceHandle } from "./tool.js";
import {
  InMemoryToolServiceLogStore,
  ToolServiceLogRecord,
  ToolServiceLogStore,
} from "./toolServiceLogStore.js";
import {
  InMemoryToolServiceStatusStore,
  StoredToolServiceStatus,
  ToolServiceStatus,
  ToolServiceStatusStore,
  defaultToolServiceStatus,
} from "./toolServiceStatusStore.js";

export type ToolServiceSupervisorOptions = {
  restartOnFailedHeartbeat?: boolean;
  maxAutoRestartsPerService?: number;
};

export type ToolServiceRestartPolicyInput = {
  autoRestartEnabled?: boolean;
  maxAutoRestarts?: number;
  restartBackoffMs?: number;
  restartBackoffMultiplier?: number;
  restartBackoffMaxMs?: number;
  restartRequiresApproval?: boolean;
};

export class ToolServiceSupervisor {
  private readonly logListeners = new Set<(record: ToolServiceLogRecord) => void>();
  private readonly activeServices = new Map<string, {
    controller: AbortController;
    handle?: ToolServiceHandle;
  }>();

  constructor(
    private readonly registry: Pick<ToolRegistry, "get" | "list">,
    private readonly statusStore: ToolServiceStatusStore = new InMemoryToolServiceStatusStore(),
    private readonly logStore: ToolServiceLogStore = new InMemoryToolServiceLogStore(),
    private readonly serviceContext: Omit<ToolServiceContext, "toolName" | "now" | "signal" | "logger"> = {},
    private readonly supervisorOptions: ToolServiceSupervisorOptions = {},
  ) {}

  private get restartOnFailedHeartbeat(): boolean {
    return this.supervisorOptions.restartOnFailedHeartbeat ?? true;
  }

  private get maxAutoRestartsPerService(): number {
    const configured = this.supervisorOptions.maxAutoRestartsPerService ?? 3;
    return normalizeMaxAutoRestarts(configured, 3);
  }

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
    let active = this.activeServices.get(toolName);
    if (!active && tool.startService) {
      const controller = new AbortController();
      try {
        const handle = await tool.startService({
          ...this.serviceContext,
          toolName,
          now: new Date(),
          signal: controller.signal,
          logger: this.loggerFor(toolName),
        });
        active = { controller, handle };
        this.activeServices.set(toolName, active);
        await this.logLifecycle(toolName, "info", "Service runtime started.", starting);
      } catch (error) {
        controller.abort();
        const failed = await this.write({
          ...starting,
          status: "failed",
          detail: error instanceof Error ? error.message : "Service runtime failed to start.",
          lastHealthOk: false,
          consecutiveFailureCount: starting.consecutiveFailureCount + 1,
          lastFailureAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await this.logLifecycle(toolName, "error", "Service runtime failed to start.", failed);
        return { ...failed, displayName: tool.displayName, description: tool.description };
      }
    }

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
      consecutiveFailureCount: health.ok ? 0 : starting.consecutiveFailureCount + 1,
      lastFailureAt: health.ok ? starting.lastFailureAt : nextNow,
      nextRestartAt: health.ok ? undefined : starting.nextRestartAt,
      pendingRestartApproval: health.ok ? false : starting.pendingRestartApproval,
      updatedAt: nextNow,
    });
    if (!health.ok) {
      await this.stopRuntime(toolName, "Service runtime stopped after failed start healthcheck.");
    }
    await this.logLifecycle(toolName, health.ok ? "info" : "error", "Service start healthcheck completed.", next);
    return { ...next, displayName: tool.displayName, description: tool.description };
  }

  async stop(toolName: string): Promise<ToolServiceStatus> {
    const tool = this.requiredAlwaysOnTool(toolName);
    await this.stopRuntime(toolName, "Service runtime stopped by operator.");
    const now = new Date().toISOString();
    const next = await this.write({
      ...(await this.statusFor(toolName)),
      status: "stopped",
      desiredState: "stopped",
      detail: "Stopped by operator.",
      stoppedAt: now,
      consecutiveFailureCount: 0,
      nextRestartAt: undefined,
      pendingRestartApproval: false,
      updatedAt: now,
    });
    await this.logLifecycle(toolName, "info", "Service stopped by operator.", next);
    return { ...next, displayName: tool.displayName, description: tool.description };
  }

  async stopAll(): Promise<void> {
    const toolNames = Array.from(this.activeServices.keys());
    for (const toolName of toolNames) {
      await this.stopRuntime(toolName, "Service runtime stopped during supervisor shutdown.");
      const existing = await this.statusFor(toolName);
      const now = new Date().toISOString();
      const next = await this.write({
        ...existing,
        status: "stopped",
        detail: "Stopped during supervisor shutdown.",
        stoppedAt: now,
        updatedAt: now,
      });
      await this.logLifecycle(toolName, "info", "Service stopped during supervisor shutdown.", next);
    }
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
      lastRestartAt: new Date().toISOString(),
      lastRestartReason: "manual",
      nextRestartAt: undefined,
      pendingRestartApproval: false,
      updatedAt: new Date().toISOString(),
    });
    await this.logLifecycle(toolName, "info", "Service restart requested.", await this.statusFor(toolName));
    return this.start(toolName);
  }

  async updateRestartPolicy(toolName: string, input: ToolServiceRestartPolicyInput): Promise<ToolServiceStatus> {
    const tool = this.requiredAlwaysOnTool(toolName);
    const existing = await this.statusFor(toolName);
    const now = new Date().toISOString();
    const next = await this.write({
      ...existing,
      autoRestartEnabled: input.autoRestartEnabled,
      maxAutoRestarts: input.maxAutoRestarts === undefined
        ? undefined
        : normalizeMaxAutoRestarts(input.maxAutoRestarts, this.maxAutoRestartsPerService),
      restartBackoffMs: input.restartBackoffMs === undefined
        ? undefined
        : normalizeNonNegativeInteger(input.restartBackoffMs, 0),
      restartBackoffMultiplier: input.restartBackoffMultiplier === undefined
        ? undefined
        : normalizeRestartBackoffMultiplier(input.restartBackoffMultiplier),
      restartBackoffMaxMs: input.restartBackoffMaxMs === undefined
        ? undefined
        : normalizeNonNegativeInteger(input.restartBackoffMaxMs, 0),
      restartRequiresApproval: input.restartRequiresApproval,
      updatedAt: now,
    });
    await this.logLifecycle(toolName, "info", "Service restart policy updated.", next);
    return { ...next, displayName: tool.displayName, description: tool.description };
  }

  async heartbeat(toolName: string): Promise<ToolServiceStatus> {
    const tool = this.requiredAlwaysOnTool(toolName);
    const existing = await this.statusFor(toolName);
    if (existing.desiredState !== "running") {
      return { ...existing, displayName: tool.displayName, description: tool.description };
    }
    if (existing.pendingRestartApproval) {
      return { ...existing, displayName: tool.displayName, description: tool.description };
    }
    if (existing.nextRestartAt) {
      const nextRestartAtMs = Date.parse(existing.nextRestartAt);
      if (Number.isFinite(nextRestartAtMs) && nextRestartAtMs > Date.now()) {
        return { ...existing, displayName: tool.displayName, description: tool.description };
      }
      await this.logLifecycle(toolName, "warn", "Service restart backoff elapsed; auto-restart requested.", existing);
      return this.autoRestartAfterHeartbeatFailure(toolName, existing, tool.displayName, tool.description);
    }
    if (tool.startService && !this.activeServices.has(toolName)) {
      await this.logLifecycle(
        toolName,
        "warn",
        "Service heartbeat found no active runtime; start requested by supervisor.",
        existing,
      );
      return this.start(toolName);
    }

    const now = new Date().toISOString();
    const health = await this.runHealthcheck(toolName);
    const consecutiveFailureCount = health.ok ? 0 : existing.consecutiveFailureCount + 1;
    const next = await this.write({
      ...existing,
      status: health.ok ? "running" : "failed",
      detail: health.detail,
      lastHealthOk: health.ok,
      lastHeartbeatAt: now,
      consecutiveFailureCount,
      lastFailureAt: health.ok ? existing.lastFailureAt : now,
      updatedAt: now,
    });
    await this.logLifecycle(toolName, health.ok ? "info" : "error", "Service heartbeat completed.", next);
    if (!health.ok && this.shouldAutoRestart(next)) {
      await this.logLifecycle(toolName, "warn", "Service heartbeat failed; auto-restart requested by restart policy.", next);
      return this.handleRestartPolicyAfterHeartbeatFailure(toolName, next, tool.displayName, tool.description);
    }
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
        const service = await this.start(tool.name);
        await this.logLifecycle(tool.name, "info", "Service reconciled on app startup.", service);
        reconciled.push(service);
      }
    }
    return reconciled;
  }

  async listLogs(toolName?: string, limit = 100) {
    return this.logStore.list({ toolName, limit });
  }

  onLog(listener: (record: ToolServiceLogRecord) => void): () => void {
    this.logListeners.add(listener);
    return () => {
      this.logListeners.delete(listener);
    };
  }

  private async runHealthcheck(toolName: string): Promise<ToolHealth> {
    const tool = this.requiredAlwaysOnTool(toolName);
    const active = this.activeServices.get(toolName);
    if (active?.handle?.healthcheck) {
      try {
        return await active.handle.healthcheck();
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : "Tool service runtime healthcheck failed.",
        };
      }
    }
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

  private async stopRuntime(toolName: string, message: string): Promise<void> {
    const active = this.activeServices.get(toolName);
    if (!active) return;
    active.controller.abort();
    try {
      await active.handle?.stop?.();
      await this.logLifecycle(toolName, "info", message, await this.statusFor(toolName));
    } catch (error) {
      await this.logLifecycle(
        toolName,
        "warn",
        error instanceof Error ? `Service runtime stop reported: ${error.message}` : "Service runtime stop reported an error.",
        await this.statusFor(toolName),
      );
    } finally {
      this.activeServices.delete(toolName);
    }
  }

  private shouldAutoRestart(status: StoredToolServiceStatus): boolean {
    return (
      (status.autoRestartEnabled ?? this.restartOnFailedHeartbeat) &&
      status.desiredState === "running" &&
      status.restartCount < normalizeMaxAutoRestarts(status.maxAutoRestarts, this.maxAutoRestartsPerService)
    );
  }

  private async handleRestartPolicyAfterHeartbeatFailure(
    toolName: string,
    failed: StoredToolServiceStatus,
    displayName: string | undefined,
    description: string,
  ): Promise<ToolServiceStatus> {
    await this.stopRuntime(toolName, "Service runtime stopped after failed heartbeat before auto-restart.");
    if (failed.restartRequiresApproval) {
      const now = new Date().toISOString();
      const pending = await this.write({
        ...failed,
        status: "failed",
        detail: "Auto-restart requires operator approval.",
        pendingRestartApproval: true,
        nextRestartAt: undefined,
        updatedAt: now,
      });
      await this.logLifecycle(toolName, "warn", "Service auto-restart is waiting for operator approval.", pending);
      return { ...pending, displayName, description };
    }
    const backoffMs = restartBackoffDelayMs(failed);
    if (backoffMs > 0) {
      const nowMs = Date.now();
      const scheduled = await this.write({
        ...failed,
        status: "failed",
        detail: `Auto-restart scheduled after ${backoffMs} ms backoff.`,
        nextRestartAt: new Date(nowMs + backoffMs).toISOString(),
        pendingRestartApproval: false,
        updatedAt: new Date(nowMs).toISOString(),
      });
      await this.logLifecycle(toolName, "warn", "Service auto-restart scheduled after backoff.", scheduled);
      return { ...scheduled, displayName, description };
    }
    return this.autoRestartAfterHeartbeatFailure(toolName, failed, displayName, description);
  }

  private async autoRestartAfterHeartbeatFailure(
    toolName: string,
    failed: StoredToolServiceStatus,
    displayName: string | undefined,
    description: string,
  ): Promise<ToolServiceStatus> {
    const now = new Date().toISOString();
    await this.write({
      ...failed,
      status: "starting",
      desiredState: "running",
      detail: "Auto-restarting after failed heartbeat.",
      restartCount: failed.restartCount + 1,
      nextRestartAt: undefined,
      pendingRestartApproval: false,
      lastRestartAt: now,
      lastRestartReason: "failed-heartbeat",
      updatedAt: now,
    });
    await this.logLifecycle(toolName, "warn", "Service auto-restart started.", await this.statusFor(toolName));
    const restarted = await this.start(toolName);
    return {
      ...restarted,
      displayName,
      description,
    };
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

  private async logLifecycle(
    toolName: string,
    level: "info" | "warn" | "error",
    message: string,
    status: StoredToolServiceStatus,
  ): Promise<void> {
    const record = await this.logStore.append({
      toolName,
      level,
      message,
      status: status.status,
      detail: status.detail,
    });
    for (const listener of this.logListeners) listener(record);
  }

  private loggerFor(toolName: string): ToolServiceContext["logger"] {
    return {
      info: (message, metadata) => {
        void this.logStore.append({
          toolName,
          level: "info",
          message,
          detail: metadata ? JSON.stringify(metadata) : undefined,
        }).then((record) => {
          for (const listener of this.logListeners) listener(record);
        });
      },
      warn: (message, metadata) => {
        void this.logStore.append({
          toolName,
          level: "warn",
          message,
          detail: metadata ? JSON.stringify(metadata) : undefined,
        }).then((record) => {
          for (const listener of this.logListeners) listener(record);
        });
      },
      error: (message, metadata) => {
        void this.logStore.append({
          toolName,
          level: "error",
          message,
          detail: metadata ? JSON.stringify(metadata) : undefined,
        }).then((record) => {
          for (const listener of this.logListeners) listener(record);
        });
      },
    };
  }
}

function normalizeMaxAutoRestarts(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeRestartBackoffMultiplier(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(100, value);
}

function restartBackoffDelayMs(status: StoredToolServiceStatus): number {
  const baseMs = normalizeNonNegativeInteger(status.restartBackoffMs, 0);
  if (baseMs <= 0) return 0;
  const multiplier = normalizeRestartBackoffMultiplier(status.restartBackoffMultiplier);
  const exponent = Math.max(0, status.restartCount);
  const uncapped = baseMs * multiplier ** exponent;
  const capMs = status.restartBackoffMaxMs === undefined
    ? uncapped
    : normalizeNonNegativeInteger(status.restartBackoffMaxMs, baseMs);
  return Math.floor(Math.min(uncapped, capMs, Number.MAX_SAFE_INTEGER));
}
