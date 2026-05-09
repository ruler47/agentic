import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { InMemoryToolReworkWaitStore } from "../src/runs/toolReworkWaitStore.js";
import { InMemoryToolBuildRequestStore } from "../src/tools/toolBuildRequestStore.js";
import { InMemoryToolInvestigationStore } from "../src/tools/toolInvestigationStore.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import {
  ToolImprovementAuditEvent,
  ToolImprovementCoordinator,
} from "../src/tools/toolImprovementCoordinator.js";

type Setup = {
  coordinator: ToolImprovementCoordinator;
  toolInvestigationStore: InMemoryToolInvestigationStore;
  toolBuildRequestStore: InMemoryToolBuildRequestStore;
  toolReworkWaitStore: InMemoryToolReworkWaitStore;
  toolMetadataStore: InMemoryToolMetadataStore;
  runStore: InMemoryRunStore;
  auditEvents: ToolImprovementAuditEvent[];
};

async function setupCoordinator(): Promise<Setup> {
  const toolInvestigationStore = new InMemoryToolInvestigationStore();
  const toolBuildRequestStore = new InMemoryToolBuildRequestStore();
  const toolReworkWaitStore = new InMemoryToolReworkWaitStore();
  const toolMetadataStore = new InMemoryToolMetadataStore([
    {
      name: "browser.operate",
      version: "1.0.0",
      description: "Reusable browser command executor.",
      capabilities: ["browser-operate", "browser-screenshot"],
      startupMode: "on-demand",
      requiredConfigurationKeys: [],
      requiredSecretHandles: [],
      examples: [],
      successCount: 0,
      failureCount: 0,
      source: "builtin",
      status: "available",
      updatedAt: new Date().toISOString(),
    },
  ]);
  const runStore = new InMemoryRunStore();
  const auditEvents: ToolImprovementAuditEvent[] = [];
  const coordinator = new ToolImprovementCoordinator({
    toolInvestigationStore,
    toolBuildRequestStore,
    toolReworkWaitStore,
    toolMetadataStore,
    runStore,
    audit: async (event) => {
      auditEvents.push(event);
    },
  });
  return {
    coordinator,
    toolInvestigationStore,
    toolBuildRequestStore,
    toolReworkWaitStore,
    toolMetadataStore,
    runStore,
    auditEvents,
  };
}

test("Coordinator promotes investigation with registered tool and opens a wait", async () => {
  const setup = await setupCoordinator();
  const run = await setup.runStore.create("Find Spanish cities");
  const investigation = await setup.toolInvestigationStore.create({
    source: "trace_span",
    title: "browser.operate cannot dismiss CAPTCHA",
    runId: run.id,
    spanId: "span-A",
    toolName: "browser.operate",
    toolVersion: "1.0.0",
    contextBundle: { taskPrompt: "find Spanish cities", error: "CAPTCHA blocker" },
  });

  const result = await setup.coordinator.requestImprovement({
    source: "investigation_promote",
    investigationId: investigation.id,
  });

  assert.equal(result.status, "waiting");
  assert.ok(result.buildRequest);
  assert.equal(result.buildRequest!.replacesToolName, "browser.operate");
  assert.equal(result.buildRequest!.replacesVersion, "1.0.0");
  assert.equal(result.buildRequest!.desiredToolName, "browser.operate");
  assert.ok(result.investigation);
  assert.equal(result.investigation!.status, "linked_to_build");
  assert.equal(result.investigation!.linkedBuildRequestId, result.buildRequest!.id);
  assert.ok(result.wait);
  assert.equal(result.wait!.runId, run.id);
  assert.equal(result.wait!.status, "waiting");
  assert.equal(result.wait!.investigationId, investigation.id);
  assert.equal(result.wait!.buildRequestId, result.buildRequest!.id);

  const stored = await setup.runStore.get(run.id);
  assert.equal(stored?.status, "waiting_tool_rework");

  const actions = setup.auditEvents.map((event) => event.action);
  assert.deepEqual(actions, [
    "tool_build.requested",
    "tool_investigation.updated",
    "tool_rework_wait.created",
  ]);
});

test("Coordinator refuses to fuzzy-retarget when toolName is not registered", async () => {
  const setup = await setupCoordinator();
  const run = await setup.runStore.create("Some task");
  const investigation = await setup.toolInvestigationStore.create({
    source: "trace_span",
    title: "Made-up tool failure",
    runId: run.id,
    toolName: "tool.does.not.exist",
  });

  const result = await setup.coordinator.requestImprovement({
    source: "investigation_promote",
    investigationId: investigation.id,
  });

  assert.equal(result.status, "failed_to_request");
  assert.equal(result.errorCode, "investigation_promotion_ambiguous");
  assert.match(result.error ?? "", /not registered/);

  const builds = await setup.toolBuildRequestStore.list();
  assert.equal(builds.length, 0);
  const waits = await setup.toolReworkWaitStore.list();
  assert.equal(waits.length, 0);
  const stored = await setup.runStore.get(run.id);
  assert.notEqual(stored?.status, "waiting_tool_rework");
});

test("Coordinator agent-runtime mode creates investigation, build, and wait", async () => {
  const setup = await setupCoordinator();
  const run = await setup.runStore.create("Take screenshot");

  const result = await setup.coordinator.requestImprovement({
    source: "agent_runtime",
    runId: run.id,
    spanId: "tool-browser.operate-span",
    toolName: "browser.operate",
    toolVersion: "1.0.0",
    title: "Insufficient tool: browser.operate",
    contextBundle: {
      taskPrompt: "Take screenshot of public site",
      outputSummary: "Screenshot rejected by semantic QA",
      error: "blocker_or_loader",
    },
    buildRequestInput: {
      capability: "browser-screenshot",
      reason: "Existing browser.operate cannot satisfy public-site screenshot QA.",
      sourceSpanId: "tool-browser.operate-span",
    },
  });

  assert.equal(result.status, "waiting");
  assert.ok(result.investigation);
  assert.equal(result.investigation!.source, "trace_span");
  assert.equal(result.investigation!.toolName, "browser.operate");
  assert.equal(result.investigation!.runId, run.id);
  assert.ok(result.buildRequest);
  // Coordinator backfills replacesToolName/Version from the registered tool target.
  assert.equal(result.buildRequest!.replacesToolName, "browser.operate");
  assert.equal(result.buildRequest!.replacesVersion, "1.0.0");
  assert.ok(result.wait);
  assert.equal(result.wait!.investigationId, result.investigation!.id);
  assert.equal(result.wait!.buildRequestId, result.buildRequest!.id);

  const stored = await setup.runStore.get(run.id);
  assert.equal(stored?.status, "waiting_tool_rework");

  const actions = setup.auditEvents.map((event) => event.action);
  assert.deepEqual(actions, [
    "tool_investigation.created",
    "tool_build.requested",
    "tool_investigation.updated",
    "tool_rework_wait.created",
  ]);
  const agentDrivenAudits = setup.auditEvents.filter(
    (event) => event.metadata?.agentDriven === true,
  );
  assert.equal(agentDrivenAudits.length, 3);
});

test("Coordinator reuses an equivalent open wait instead of creating duplicate builds for one run", async () => {
  const setup = await setupCoordinator();
  const run = await setup.runStore.create("Take screenshot");

  const first = await setup.coordinator.requestImprovement({
    source: "agent_runtime",
    runId: run.id,
    spanId: "tool-browser.operate-span-1",
    toolName: "browser.operate",
    toolVersion: "1.0.0",
    title: "Insufficient tool: browser.operate",
    contextBundle: {
      taskPrompt: "Take screenshot of public site",
      outputSummary: "Screenshot rejected by semantic QA",
      error: "blocker_or_loader",
    },
    buildRequestInput: {
      capability: "browser-screenshot",
      reason: "Existing browser.operate cannot satisfy public-site screenshot QA.",
      sourceSpanId: "tool-browser.operate-span-1",
    },
  });
  const second = await setup.coordinator.requestImprovement({
    source: "agent_runtime",
    runId: run.id,
    spanId: "tool-browser.operate-span-2",
    toolName: "browser.operate",
    toolVersion: "1.0.0",
    title: "Insufficient tool: browser.operate again",
    contextBundle: {
      taskPrompt: "Take screenshot of public site",
      outputSummary: "A second span hit the same missing screenshot capability",
      error: "same capability",
    },
    buildRequestInput: {
      capability: "browser-screenshot",
      reason: "Second request for the same screenshot rework.",
      sourceSpanId: "tool-browser.operate-span-2",
    },
  });

  assert.equal(first.status, "waiting");
  assert.equal(second.status, "waiting");
  assert.equal(second.wait?.id, first.wait?.id);
  assert.equal(second.buildRequest?.id, first.buildRequest?.id);
  assert.match(second.detail ?? "", /equivalent tool rework wait/i);

  const builds = await setup.toolBuildRequestStore.list();
  const waits = await setup.toolReworkWaitStore.list();
  const investigations = await setup.toolInvestigationStore.list();
  assert.equal(builds.length, 1);
  assert.equal(waits.length, 1);
  assert.equal(investigations.length, 2);
  assert.equal(investigations.every((item) => item.linkedBuildRequestId === first.buildRequest?.id), true);
});

test("Coordinator agent-runtime mode can request a missing capability without a known toolName", async () => {
  const setup = await setupCoordinator();
  const run = await setup.runStore.create("Create a PDF report");

  const result = await setup.coordinator.requestImprovement({
    source: "agent_runtime",
    runId: run.id,
    spanId: "tool-missing-pdf-generation",
    title: "Missing tool capability: pdf-generation",
    contextBundle: {
      taskPrompt: "Create a PDF report",
      outputSummary: "No registered tool can create a PDF artifact.",
      error: "Tool capability pdf-generation was missing in the registry.",
    },
    buildRequestInput: {
      capability: "pdf-generation",
      displayName: "PDF generation",
      reason: "The task requires a reusable PDF artifact generator.",
      sourceRunId: run.id,
      sourceSpanId: "tool-missing-pdf-generation",
      startupMode: "on-demand",
    },
  });

  assert.equal(result.status, "waiting");
  assert.ok(result.investigation);
  assert.equal(result.investigation!.toolName, undefined);
  assert.ok(result.buildRequest);
  assert.equal(result.buildRequest!.capability, "pdf-generation");
  assert.equal(result.buildRequest!.desiredToolName, undefined);
  assert.equal(result.buildRequest!.replacesToolName, undefined);
  assert.ok(result.wait);
  assert.equal(result.wait!.runId, run.id);
  assert.equal(result.wait!.toolName, undefined);

  const stored = await setup.runStore.get(run.id);
  assert.equal(stored?.status, "waiting_tool_rework");
});

test("Coordinator returns failed_to_request when the run does not exist", async () => {
  const setup = await setupCoordinator();
  const investigation = await setup.toolInvestigationStore.create({
    source: "trace_span",
    title: "Orphan investigation",
    runId: "run-missing",
    toolName: "browser.operate",
  });

  const result = await setup.coordinator.requestImprovement({
    source: "investigation_promote",
    investigationId: investigation.id,
  });

  assert.equal(result.status, "failed_to_request");
  assert.match(result.error ?? "", /does not match any run/);
  const builds = await setup.toolBuildRequestStore.list();
  assert.equal(builds.length, 0);
  const waits = await setup.toolReworkWaitStore.list();
  assert.equal(waits.length, 0);
});

test("notifyBuildRegistered promotes pending waits and skips terminal ones", async () => {
  const setup = await setupCoordinator();
  const run = await setup.runStore.create("task");
  const investigation = await setup.toolInvestigationStore.create({
    source: "trace_span",
    title: "needs upgrade",
    runId: run.id,
    toolName: "browser.operate",
  });
  const promote = await setup.coordinator.requestImprovement({
    source: "investigation_promote",
    investigationId: investigation.id,
  });
  assert.equal(promote.status, "waiting");
  const buildId = promote.buildRequest!.id;
  const waitId = promote.wait!.id;

  await setup.coordinator.notifyBuildRegistered(buildId, "browser.operate", "1.1.0");
  const promotedWait = await setup.toolReworkWaitStore.get(waitId);
  assert.equal(promotedWait?.status, "promoted");
  assert.equal(promotedWait?.promotedVersion, "1.1.0");

  // Idempotent on a second registered notification.
  await setup.coordinator.notifyBuildRegistered(buildId, "browser.operate", "1.1.0");
  const stillPromoted = await setup.toolReworkWaitStore.get(waitId);
  assert.equal(stillPromoted?.status, "promoted");
});

test("notifyBuildRegistered refuses to promote waits when no registered version is available", async () => {
  const setup = await setupCoordinator();
  const run = await setup.runStore.create("task");
  const wait = await setup.toolReworkWaitStore.create({
    runId: run.id,
    reason: "manual wait with missing build metadata",
    buildRequestId: "build-without-version",
    toolName: "browser.operate",
    status: "waiting",
  });

  await setup.coordinator.notifyBuildRegistered("build-without-version", "browser.operate");

  const unchanged = await setup.toolReworkWaitStore.get(wait.id);
  assert.equal(unchanged?.status, "waiting");
  assert.equal(unchanged?.promotedVersion, undefined);
  const lastAudit = setup.auditEvents.at(-1);
  assert.equal(lastAudit?.action, "tool_rework_wait.updated");
  assert.equal(lastAudit?.status, "failure");
  assert.match(lastAudit?.summary ?? "", /no registered version/i);
});

test("notifyBuildRegistered audits failure when a wait update does not persist promoted state", async () => {
  const setup = await setupCoordinator();
  const run = await setup.runStore.create("task");
  const wait = await setup.toolReworkWaitStore.create({
    runId: run.id,
    reason: "manual wait",
    buildRequestId: "build-1",
    toolName: "browser.operate",
    status: "waiting",
  });
  const brokenWaitStore = new class extends InMemoryToolReworkWaitStore {
    constructor(seed: InMemoryToolReworkWaitStore) {
      super();
      this.seed = seed;
    }
    private readonly seed: InMemoryToolReworkWaitStore;
    override listByBuildRequest(buildRequestId: string) {
      return this.seed.listByBuildRequest(buildRequestId);
    }
    override async update(id: string, update: Parameters<InMemoryToolReworkWaitStore["update"]>[1]) {
      const stored = await this.seed.update(id, update);
      return { ...stored, status: "waiting" as const, promotedVersion: undefined };
    }
  }(setup.toolReworkWaitStore);
  const auditEvents: ToolImprovementAuditEvent[] = [];
  const coordinator = new ToolImprovementCoordinator({
    toolReworkWaitStore: brokenWaitStore,
    toolBuildRequestStore: setup.toolBuildRequestStore,
    runStore: setup.runStore,
    audit: async (event) => {
      auditEvents.push(event);
    },
  });

  await coordinator.notifyBuildRegistered("build-1", "browser.operate", "1.1.0");

  assert.equal((await setup.toolReworkWaitStore.get(wait.id))?.status, "promoted");
  const lastAudit = auditEvents.at(-1);
  assert.equal(lastAudit?.action, "tool_rework_wait.updated");
  assert.equal(lastAudit?.status, "failure");
  assert.match(lastAudit?.summary ?? "", /did not persist/i);
});

test("notifyBuildRegistered audits post-promotion hook failures without undoing promotion", async () => {
  const setup = await setupCoordinator();
  const run = await setup.runStore.create("task");
  const wait = await setup.toolReworkWaitStore.create({
    runId: run.id,
    reason: "manual wait",
    buildRequestId: "build-1",
    toolName: "browser.operate",
    status: "waiting",
  });
  const auditEvents: ToolImprovementAuditEvent[] = [];
  const coordinator = new ToolImprovementCoordinator({
    toolReworkWaitStore: setup.toolReworkWaitStore,
    toolBuildRequestStore: setup.toolBuildRequestStore,
    runStore: setup.runStore,
    audit: async (event) => {
      auditEvents.push(event);
    },
    onWaitPromoted: async () => {
      throw new Error("auto retry offline");
    },
  });

  await coordinator.notifyBuildRegistered("build-1", "browser.operate", "1.1.0");

  assert.equal((await setup.toolReworkWaitStore.get(wait.id))?.status, "promoted");
  assert.equal(auditEvents.at(-2)?.status, "success");
  assert.equal(auditEvents.at(-1)?.status, "failure");
  assert.match(auditEvents.at(-1)?.summary ?? "", /post-promotion hook failed/i);
});

test("requestImprovement audits background scheduler failures after durable build creation", async () => {
  const setup = await setupCoordinator();
  const run = await setup.runStore.create("task");
  const investigation = await setup.toolInvestigationStore.create({
    source: "trace_span",
    title: "needs upgrade",
    runId: run.id,
    toolName: "browser.operate",
  });
  const auditEvents: ToolImprovementAuditEvent[] = [];
  const coordinator = new ToolImprovementCoordinator({
    toolInvestigationStore: setup.toolInvestigationStore,
    toolBuildRequestStore: setup.toolBuildRequestStore,
    toolReworkWaitStore: setup.toolReworkWaitStore,
    toolMetadataStore: setup.toolMetadataStore,
    runStore: setup.runStore,
    audit: async (event) => {
      auditEvents.push(event);
    },
    backgroundBuildScheduler: {
      scheduleImmediate: () => {
        throw new Error("worker unavailable");
      },
    },
  });

  const result = await coordinator.requestImprovement({
    source: "investigation_promote",
    investigationId: investigation.id,
  });

  assert.equal(result.status, "waiting");
  const failure = auditEvents.find((event) => event.status === "failure" && /scheduler failed/i.test(event.summary));
  assert.equal(failure?.action, "tool_build.requested");
});

test("markReadyForRetry resumes only promoted waits and returns the run to failed", async () => {
  const setup = await setupCoordinator();
  const run = await setup.runStore.create("task");
  const investigation = await setup.toolInvestigationStore.create({
    source: "trace_span",
    title: "needs upgrade",
    runId: run.id,
    toolName: "browser.operate",
  });
  const promote = await setup.coordinator.requestImprovement({
    source: "investigation_promote",
    investigationId: investigation.id,
  });
  const waitId = promote.wait!.id;

  await assert.rejects(
    () => setup.coordinator.markReadyForRetry(waitId),
    /not promoted yet/,
  );

  await setup.coordinator.notifyBuildRegistered(promote.buildRequest!.id, "browser.operate", "1.1.0");
  const resumed = await setup.coordinator.markReadyForRetry(waitId, { retryRunId: "retry-1" });
  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.retryRunId, "retry-1");

  const finalRun = await setup.runStore.get(run.id);
  assert.equal(finalRun?.status, "failed", "resumed wait returns the run to failed");

  const lastAudit = setup.auditEvents.at(-1);
  assert.equal(lastAudit?.action, "tool_rework_wait.resumed");
});

test("Late agent completion cannot overwrite a coordinator-opened wait", async () => {
  const setup = await setupCoordinator();
  const run = await setup.runStore.create("task");
  const investigation = await setup.toolInvestigationStore.create({
    source: "trace_span",
    title: "needs upgrade",
    runId: run.id,
    toolName: "browser.operate",
  });
  await setup.coordinator.requestImprovement({
    source: "investigation_promote",
    investigationId: investigation.id,
  });

  // Late agent thinks the run is still active and tries to write a result.
  await setup.runStore.complete(run.id, {
    finalAnswer: "stale answer",
    complexity: { mode: "direct", reason: "test", domains: ["test"], riskLevel: "low" },
    subtasks: [],
    workerResults: [],
    reviews: [],
  });
  await setup.runStore.fail(run.id, "stale failure");

  const stillWaiting = await setup.runStore.get(run.id);
  assert.equal(stillWaiting?.status, "waiting_tool_rework");
  assert.equal(stillWaiting?.result, undefined);
});

test("Coordinator with no rework wait store still creates the build but skips wait", async () => {
  const toolInvestigationStore = new InMemoryToolInvestigationStore();
  const toolBuildRequestStore = new InMemoryToolBuildRequestStore();
  const toolMetadataStore = new InMemoryToolMetadataStore([
    {
      name: "browser.operate",
      version: "1.0.0",
      description: "Reusable browser command executor.",
      capabilities: ["browser-operate"],
      startupMode: "on-demand",
      requiredConfigurationKeys: [],
      requiredSecretHandles: [],
      examples: [],
      successCount: 0,
      failureCount: 0,
      source: "builtin",
      status: "available",
      updatedAt: new Date().toISOString(),
    },
  ]);
  const runStore = new InMemoryRunStore();
  const coordinator = new ToolImprovementCoordinator({
    toolInvestigationStore,
    toolBuildRequestStore,
    toolMetadataStore,
    runStore,
  });
  const run = await runStore.create("task");
  const investigation = await toolInvestigationStore.create({
    source: "trace_span",
    title: "needs upgrade",
    runId: run.id,
    toolName: "browser.operate",
  });

  const result = await coordinator.requestImprovement({
    source: "investigation_promote",
    investigationId: investigation.id,
  });

  assert.equal(result.status, "waiting");
  assert.ok(result.buildRequest);
  assert.equal(result.wait, undefined);

  const stored = await runStore.get(run.id);
  assert.notEqual(
    stored?.status,
    "waiting_tool_rework",
    "without a wait store the run is not parked",
  );
});

test("openWait validates run, build request, and investigation references", async () => {
  const setup = await setupCoordinator();
  await assert.rejects(
    () => setup.coordinator.openWait({ runId: "missing", reason: "x" }),
    /does not match any run/,
  );
  const run = await setup.runStore.create("task");
  await assert.rejects(
    () => setup.coordinator.openWait({ runId: run.id, reason: "x", buildRequestId: "missing" }),
    /buildRequestId does not match/,
  );
  await assert.rejects(
    () => setup.coordinator.openWait({ runId: run.id, reason: "x", investigationId: "missing" }),
    /investigationId does not match/,
  );
});
