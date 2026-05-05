import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/registry.js";
import { Tool } from "../src/tools/tool.js";
import { ToolServiceSupervisor } from "../src/tools/toolServiceSupervisor.js";
import { InMemoryToolServiceStatusStore } from "../src/tools/toolServiceStatusStore.js";

function serviceTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "service.echo",
    version: "1.0.0",
    description: "Always-on service test tool.",
    capabilities: ["service.echo"],
    startupMode: "always-on",
    async healthcheck() {
      return { ok: true, detail: "service healthy" };
    },
    async run() {
      return { ok: true, content: "ok" };
    },
    ...overrides,
  };
}

test("ToolServiceSupervisor starts, heartbeats, restarts, and stops always-on tools", async () => {
  const registry = new ToolRegistry();
  registry.register(serviceTool());
  const supervisor = new ToolServiceSupervisor(registry);

  const initial = await supervisor.list();
  const started = await supervisor.start("service.echo");
  const heartbeat = await supervisor.heartbeat("service.echo");
  const restarted = await supervisor.restart("service.echo");
  const stopped = await supervisor.stop("service.echo");

  assert.equal(initial[0]?.status, "stopped");
  assert.equal(started.status, "running");
  assert.equal(started.desiredState, "running");
  assert.equal(started.detail, "service healthy");
  assert.equal(heartbeat.status, "running");
  assert.equal(restarted.restartCount, 1);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.desiredState, "stopped");
  assert.match((await supervisor.listLogs("service.echo")).map((log) => log.message).join("\n"), /Service stopped/);
});

test("ToolServiceSupervisor starts and stops generic service runtimes", async () => {
  const registry = new ToolRegistry();
  let started = 0;
  let stopped = 0;
  let aborted = false;
  registry.register(serviceTool({
    async startService(context) {
      started += 1;
      context.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return {
        stop() {
          stopped += 1;
        },
        async healthcheck() {
          return { ok: true, detail: "runtime healthy" };
        },
      };
    },
  }));
  const supervisor = new ToolServiceSupervisor(registry);

  const service = await supervisor.start("service.echo");
  const heartbeat = await supervisor.heartbeat("service.echo");
  await supervisor.stop("service.echo");

  assert.equal(started, 1);
  assert.equal(stopped, 1);
  assert.equal(aborted, true);
  assert.equal(service.status, "running");
  assert.equal(service.detail, "runtime healthy");
  assert.equal(heartbeat.detail, "runtime healthy");
});

test("ToolServiceSupervisor stops runtime when start healthcheck fails", async () => {
  const registry = new ToolRegistry();
  let stopped = 0;
  let aborted = false;
  registry.register(serviceTool({
    async startService(context) {
      context.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return {
        stop() {
          stopped += 1;
        },
        async healthcheck() {
          return { ok: false, detail: "runtime missing credential" };
        },
      };
    },
  }));
  const supervisor = new ToolServiceSupervisor(registry);

  const service = await supervisor.start("service.echo");

  assert.equal(service.status, "failed");
  assert.equal(service.detail, "runtime missing credential");
  assert.equal(aborted, true);
  assert.equal(stopped, 1);
});

test("ToolServiceSupervisor does not mark a missing runtime healthy from static healthchecks", async () => {
  const registry = new ToolRegistry();
  let startAttempts = 0;
  registry.register(serviceTool({
    async startService() {
      startAttempts += 1;
      throw new Error("runtime credential missing");
    },
    async healthcheck() {
      return { ok: true, detail: "module metadata healthy" };
    },
  }));
  const supervisor = new ToolServiceSupervisor(registry);

  const first = await supervisor.start("service.echo");
  const heartbeat = await supervisor.heartbeat("service.echo");

  assert.equal(first.status, "failed");
  assert.equal(heartbeat.status, "failed");
  assert.equal(heartbeat.detail, "runtime credential missing");
  assert.equal(heartbeat.consecutiveFailureCount, 2);
  assert.equal(startAttempts, 2);
  assert.match((await supervisor.listLogs("service.echo")).map((log) => log.message).join("\n"), /no active runtime/);
});

test("ToolServiceSupervisor auto-restarts a running service after failed heartbeat", async () => {
  const registry = new ToolRegistry();
  let started = 0;
  let stopped = 0;
  registry.register(serviceTool({
    async startService() {
      started += 1;
      const instance = started;
      let healthchecks = 0;
      return {
        stop() {
          stopped += 1;
        },
        async healthcheck() {
          healthchecks += 1;
          if (instance === 1 && healthchecks > 1) {
            return { ok: false, detail: "runtime socket closed" };
          }
          return { ok: true, detail: `runtime healthy ${instance}` };
        },
      };
    },
  }));
  const supervisor = new ToolServiceSupervisor(registry, undefined, undefined, {}, {
    maxAutoRestartsPerService: 2,
  });

  const startedService = await supervisor.start("service.echo");
  const restarted = await supervisor.heartbeat("service.echo");
  const logs = await supervisor.listLogs("service.echo");

  assert.equal(startedService.status, "running");
  assert.equal(startedService.detail, "runtime healthy 1");
  assert.equal(restarted.status, "running");
  assert.equal(restarted.detail, "runtime healthy 2");
  assert.equal(restarted.restartCount, 1);
  assert.equal(restarted.consecutiveFailureCount, 0);
  assert.equal(restarted.lastRestartReason, "failed-heartbeat");
  assert.equal(started, 2);
  assert.equal(stopped, 1);
  assert.match(logs.map((log) => log.message).join("\n"), /auto-restart/i);
});

test("ToolServiceSupervisor can leave failed heartbeats stopped by policy", async () => {
  const registry = new ToolRegistry();
  let stopped = 0;
  registry.register(serviceTool({
    async startService() {
      let healthchecks = 0;
      return {
        stop() {
          stopped += 1;
        },
        async healthcheck() {
          healthchecks += 1;
          return healthchecks > 1
            ? { ok: false, detail: "still failing" }
            : { ok: true, detail: "initially healthy" };
        },
      };
    },
  }));
  const supervisor = new ToolServiceSupervisor(registry, undefined, undefined, {}, {
    restartOnFailedHeartbeat: false,
  });

  await supervisor.start("service.echo");
  const failed = await supervisor.heartbeat("service.echo");

  assert.equal(failed.status, "failed");
  assert.equal(failed.desiredState, "running");
  assert.equal(failed.consecutiveFailureCount, 1);
  assert.equal(failed.restartCount, 0);
  assert.equal(failed.lastHealthOk, false);
  assert.equal(stopped, 0);
});

test("ToolServiceSupervisor stores per-service restart policy overrides", async () => {
  const registry = new ToolRegistry();
  let stopped = 0;
  registry.register(serviceTool({
    async startService() {
      let healthchecks = 0;
      return {
        stop() {
          stopped += 1;
        },
        async healthcheck() {
          healthchecks += 1;
          return healthchecks > 1
            ? { ok: false, detail: "runtime unavailable" }
            : { ok: true, detail: "initially healthy" };
        },
      };
    },
  }));
  const supervisor = new ToolServiceSupervisor(registry);

  const policy = await supervisor.updateRestartPolicy("service.echo", {
    autoRestartEnabled: false,
    maxAutoRestarts: 7,
  });
  await supervisor.start("service.echo");
  const failed = await supervisor.heartbeat("service.echo");

  assert.equal(policy.autoRestartEnabled, false);
  assert.equal(policy.maxAutoRestarts, 7);
  assert.equal(failed.status, "failed");
  assert.equal(failed.autoRestartEnabled, false);
  assert.equal(failed.maxAutoRestarts, 7);
  assert.equal(failed.restartCount, 0);
  assert.equal(stopped, 0);
});

test("ToolServiceSupervisor stops all active service runtimes", async () => {
  const registry = new ToolRegistry();
  let stopped = 0;
  registry.register(serviceTool({
    async startService() {
      return {
        stop() {
          stopped += 1;
        },
        async healthcheck() {
          return { ok: true, detail: "runtime healthy" };
        },
      };
    },
  }));
  const supervisor = new ToolServiceSupervisor(registry);

  await supervisor.start("service.echo");
  await supervisor.stopAll();

  const listed = await supervisor.list();
  assert.equal(stopped, 1);
  assert.equal(listed[0]?.status, "stopped");
  assert.equal(listed[0]?.desiredState, "running");
});

test("ToolServiceSupervisor rejects non-service tools and marks failed healthchecks", async () => {
  const registry = new ToolRegistry();
  registry.register(serviceTool({
    name: "service.failed",
    async healthcheck() {
      return { ok: false, detail: "missing token" };
    },
  }));
  registry.register(serviceTool({ name: "tool.on-demand", startupMode: "on-demand" }));
  const supervisor = new ToolServiceSupervisor(registry);

  const failed = await supervisor.start("service.failed");
  await assert.rejects(() => supervisor.start("tool.on-demand"), /not an always-on service tool/);

  assert.equal(failed.status, "failed");
  assert.equal(failed.desiredState, "running");
  assert.equal(failed.lastHealthOk, false);
  assert.equal(failed.detail, "missing token");
});

test("ToolServiceSupervisor preserves lifecycle state through the status store", async () => {
  const registry = new ToolRegistry();
  registry.register(serviceTool());
  const statusStore = new InMemoryToolServiceStatusStore();
  const firstSupervisor = new ToolServiceSupervisor(registry, statusStore);

  await firstSupervisor.start("service.echo");

  const secondSupervisor = new ToolServiceSupervisor(registry, statusStore);
  const services = await secondSupervisor.list();

  assert.equal(services[0]?.toolName, "service.echo");
  assert.equal(services[0]?.status, "running");
  assert.equal(services[0]?.desiredState, "running");
  assert.equal(services[0]?.detail, "service healthy");
});

test("ToolServiceSupervisor reconciles desired running services on startup", async () => {
  const registry = new ToolRegistry();
  let healthDetail = "initial health";
  let started = 0;
  registry.register(serviceTool({
    async startService() {
      started += 1;
      return {
        async healthcheck() {
          return { ok: true, detail: healthDetail };
        },
      };
    },
    async healthcheck() {
      return { ok: true, detail: healthDetail };
    },
  }));
  const statusStore = new InMemoryToolServiceStatusStore();
  const firstSupervisor = new ToolServiceSupervisor(registry, statusStore);

  await firstSupervisor.start("service.echo");
  healthDetail = "reconciled health";

  const secondSupervisor = new ToolServiceSupervisor(registry, statusStore);
  const reconciled = await secondSupervisor.reconcileDesiredServices();

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]?.status, "running");
  assert.equal(reconciled[0]?.detail, "reconciled health");
  assert.equal(started, 2);
});
