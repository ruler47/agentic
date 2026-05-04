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
  registry.register(serviceTool({
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
});
