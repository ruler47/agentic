import test from "node:test";
import assert from "node:assert/strict";
import type { AgentRunResult } from "../src/types.js";
import { InMemoryAuditEventStore } from "../src/audit/inMemoryAuditEventStore.js";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { InMemoryToolReworkWaitStore, type ToolReworkWaitRecord } from "../src/runs/toolReworkWaitStore.js";
import { InMemoryUserStore } from "../src/instance/userStore.js";
import { InMemoryToolBuildRequestStore } from "../src/tools/toolBuildRequestStore.js";
import type { ToolBuildRequestInput } from "../src/tools/toolBuildRequestStore.js";
import { InMemoryToolInvestigationStore } from "../src/tools/toolInvestigationStore.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import { ToolImprovementCoordinator } from "../src/tools/toolImprovementCoordinator.js";
import { ToolReworkAutoRetryCoordinator } from "../src/tools/toolReworkAutoRetryCoordinator.js";
import { ToolReworkRetryCoordinator } from "../src/tools/toolReworkRetryCoordinator.js";
import { RunsService } from "../src/server/modules/runs/runs.service.js";
import { ToolBuildsService } from "../src/server/modules/tool-builds/tool-builds.service.js";
import { AuditService } from "../src/server/common/services/audit.service.js";
import type { ToolReworkCoordinatorService } from "../src/server/common/services/tool-rework-coordinator.service.js";

test("autonomous tool loop waits, promotes, creates retry run, and completes on retry", async () => {
  const harness = createHarness();
  let agentCalls = 0;
  const agent = {
    run: async (_task: string, options: Record<string, unknown>): Promise<AgentRunResult> => {
      agentCalls += 1;
      const runId = String(options.runId);
      const run = await harness.runStore.get(runId);
      const improvement = options.toolImprovementCoordinator as ToolImprovementCoordinator | undefined;
      assert.ok(improvement, "RunsService must pass a tool improvement coordinator to the agent");

      if (!run?.parentRunId) {
        await improvement.requestImprovement({
          source: "agent_runtime",
          runId,
          spanId: "span-chart-tool",
          toolName: "generated.chart",
          toolVersion: "1.0.0",
          title: "Chart tool cannot render requested trend proof",
          operatorComment: "The generated chart tool returned an unusable artifact; build an improved version.",
          contextBundle: {
            taskPrompt: "Create a chart and explain the trend",
            actor: "generated.chart",
            activity: "tool",
            status: "failed",
            inputSummary: "prices=[1,2,3]",
            outputSummary: "Artifact was rejected by QA",
            error: "chart artifact did not satisfy the request",
          },
          buildRequestInput: {
            capability: "chart-generation",
            displayName: "Chart generator",
            reason: "Existing chart tool could not create a useful trend artifact.",
            desiredToolName: "generated.chart",
            replacesToolName: "generated.chart",
            replacesVersion: "1.0.0",
            qaCriteria: ["Generated chart artifact passes semantic artifact QA."],
          },
        });
        return result("This answer must not be finalized while the tool is being rebuilt.");
      }

      return result("Final answer from retry after chart tool v1.1.0 was promoted.");
    },
  };
  harness.service = createRunsService(harness, agent);

  const sourceRun = await harness.runStore.create("Create a chart and explain the trend", {
    instanceId: "instance-local",
    requesterUserId: "user-admin",
    channel: "web",
    threadId: "thread-autonomous-loop",
  });

  await harness.service.executeRun(sourceRun.id, sourceRun.task, [], { threadId: sourceRun.threadId });

  const sourceAfterFirstPass = await harness.runStore.get(sourceRun.id);
  assert.equal(sourceAfterFirstPass?.status, "waiting_tool_rework");
  assert.equal(sourceAfterFirstPass?.result, undefined, "source run must not store a premature final answer");

  const auditAfterFirstPass = await harness.auditStore.list(100);
  assert.ok(
    auditAfterFirstPass.some(
      (event) =>
        event.action === "run.updated" &&
        event.runId === sourceRun.id &&
        event.status === "pending" &&
        (event.metadata as { pendingToolRework?: boolean } | undefined)?.pendingToolRework === true,
    ),
    "source run should be audited as waiting for autonomous tool improvement",
  );
  assert.equal(
    auditAfterFirstPass.some((event) => event.action === "run.completed" && event.runId === sourceRun.id),
    false,
    "source run must not emit run.completed before the retry owns the final answer",
  );

  const build = (await harness.buildStore.list())[0];
  assert.ok(build, "agent-driven improvement should create a Tool Build request");
  const wait = (await harness.waitStore.listByBuildRequest(build.id))[0];
  assert.ok(wait, "agent-driven improvement should open a ToolReworkWait");

  await harness.rework.notifyBuildRegistered(build.id, "generated.chart", "1.1.0", {
    actorId: "tool-build-worker",
    actorType: "agent",
    instanceId: sourceRun.instanceId,
    threadId: sourceRun.threadId,
    requesterUserId: sourceRun.requesterUserId,
    channel: sourceRun.channel,
  });

  const retryRun = await waitFor(async () => {
    const runs = await harness.runStore.list();
    return runs.find((candidate) => candidate.parentRunId === sourceRun.id && candidate.status === "completed");
  });

  assert.equal(retryRun.task, sourceRun.task);
  assert.equal(retryRun.result?.finalAnswer, "Final answer from retry after chart tool v1.1.0 was promoted.");
  assert.equal(agentCalls, 2);

  const sourceAfterRetry = await harness.runStore.get(sourceRun.id);
  assert.equal(
    sourceAfterRetry?.status,
    "failed",
    "source run is retained as failed handoff context after the retry run owns the completed attempt",
  );
  assert.match(sourceAfterRetry?.error ?? "", /Auto retry after tool rework promotion/);

  const waitAfterRetry = await harness.waitStore.get(wait.id);
  assert.equal(waitAfterRetry?.status, "resumed");
  assert.equal(waitAfterRetry?.retryRunId, retryRun.id);
  assert.equal(waitAfterRetry?.promotedVersion, "1.1.0");

  const finalAudit = await harness.auditStore.list(200);
  assert.ok(finalAudit.some((event) => event.action === "tool_rework_wait.auto_retry_decision"));
  assert.ok(finalAudit.some((event) => event.action === "tool_rework_wait.retry_run_created"));
  assert.ok(
    finalAudit.some((event) => event.action === "run.completed" && event.runId === retryRun.id),
    "retry run should emit the final run.completed event",
  );
});

test("tool build workflow registration triggers the same autonomous retry handoff", async () => {
  const harness = createHarness();
  const sourceRun = await harness.runStore.create("Use chart tool after build workflow registration", {
    instanceId: "instance-local",
    requesterUserId: "user-admin",
    channel: "web",
    threadId: "thread-workflow-registration",
  });
  const improvement = await harness.rework
    .createImprovementCoordinator({
      actorId: "coordinator",
      actorType: "agent",
      instanceId: sourceRun.instanceId,
      threadId: sourceRun.threadId,
      requesterUserId: sourceRun.requesterUserId,
      channel: sourceRun.channel,
    })
    .requestImprovement({
      source: "agent_runtime",
      runId: sourceRun.id,
      spanId: "span-chart-build-run",
      toolName: "generated.chart",
      toolVersion: "1.0.0",
      title: "Chart tool build workflow needs retry",
      operatorComment: "Build workflow registered a better chart tool.",
      contextBundle: { status: "failed" },
      buildRequestInput: {
        capability: "chart-generation",
        displayName: "Chart generator",
        reason: "Existing chart tool needs a workflow-built replacement.",
        desiredToolName: "generated.chart",
        replacesToolName: "generated.chart",
        replacesVersion: "1.0.0",
      },
    });
  assert.equal((await harness.runStore.get(sourceRun.id))?.status, "waiting_tool_rework");
  const buildRequest = improvement.buildRequest;
  assert.ok(buildRequest, "improvement should create a build request");

  const executedRetries: string[] = [];
  const builds = new ToolBuildsService(
    harness.buildStore,
    {
      runOnce: async (id: string) => {
        const request = await harness.buildStore.updateStatus(id, {
          status: "registered",
          registeredToolName: "generated.chart",
        });
        return { request, registeredToolName: "generated.chart" };
      },
    } as never,
    async () => undefined,
    harness.audit,
    { finalize: async (input: ToolBuildRequestInput) => input } as never,
    harness.rework as unknown as ToolReworkCoordinatorService,
    {
      get: () => ({
        executeRun: async (id: string) => {
          executedRetries.push(id);
        },
      }),
    } as never,
  );

  await builds.run(buildRequest.id);

  const waitAfterRun = await harness.waitStore.get(improvement.wait?.id ?? "");
  assert.equal(waitAfterRun?.status, "resumed");
  assert.match(waitAfterRun?.retryRunId ?? "", /^run_/);
  assert.deepEqual(executedRetries, [waitAfterRun?.retryRunId]);
});

function createHarness() {
  const runStore = new InMemoryRunStore();
  const auditStore = new InMemoryAuditEventStore();
  const audit = new AuditService(auditStore);
  const buildStore = new InMemoryToolBuildRequestStore();
  const investigationStore = new InMemoryToolInvestigationStore();
  const waitStore = new InMemoryToolReworkWaitStore();
  const metadataStore = new InMemoryToolMetadataStore([
    {
      name: "generated.chart",
      displayName: "Chart generator",
      version: "1.0.0",
      description: "Reusable chart artifact generator.",
      capabilities: ["chart-generation"],
      startupMode: "on-demand",
      requiredConfigurationKeys: [],
      requiredSecretHandles: [],
      examples: [],
      successCount: 0,
      failureCount: 0,
      source: "generated",
      status: "available",
      updatedAt: new Date().toISOString(),
    },
  ]);
  const userStore = new InMemoryUserStore();
  const rework = new TestReworkCoordinatorService({
    runStore,
    audit,
    buildStore,
    investigationStore,
    waitStore,
    metadataStore,
  });
  return {
    runStore,
    auditStore,
    audit,
    buildStore,
    investigationStore,
    waitStore,
    metadataStore,
    userStore,
    rework,
    service: undefined as RunsService | undefined,
  };
}

function createRunsService(
  harness: ReturnType<typeof createHarness>,
  agent: { run(task: string, options: Record<string, unknown>): Promise<AgentRunResult> },
): RunsService {
  return new RunsService(
    harness.runStore,
    agent as never,
    undefined,
    undefined,
    undefined,
    harness.userStore,
    harness.buildStore,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    harness.audit,
    { finalize: async (input: ToolBuildRequestInput) => input } as never,
    harness.rework as unknown as ToolReworkCoordinatorService,
  );
}

class TestReworkCoordinatorService {
  private onWaitPromoted?: (wait: ToolReworkWaitRecord) => Promise<void> | void;

  constructor(
    private readonly deps: {
      runStore: InMemoryRunStore;
      audit: AuditService;
      buildStore: InMemoryToolBuildRequestStore;
      investigationStore: InMemoryToolInvestigationStore;
      waitStore: InMemoryToolReworkWaitStore;
      metadataStore: InMemoryToolMetadataStore;
    },
  ) {}

  createImprovementCoordinator(
    context: {
      actorId: string;
      actorType: "user" | "agent" | "system" | "tool";
      instanceId?: string;
      threadId?: string;
      requesterUserId?: string;
      channel?: string;
    },
    onWaitPromoted?: (wait: ToolReworkWaitRecord) => Promise<void> | void,
  ): ToolImprovementCoordinator {
    this.onWaitPromoted = onWaitPromoted;
    return new ToolImprovementCoordinator({
      toolInvestigationStore: this.deps.investigationStore,
      toolBuildRequestStore: this.deps.buildStore,
      toolReworkWaitStore: this.deps.waitStore,
      toolMetadataStore: this.deps.metadataStore,
      runStore: this.deps.runStore,
      audit: (event) =>
        this.deps.audit.record({
          instanceId: context.instanceId ?? "instance-local",
          actorId: context.actorId,
          actorType: context.actorType,
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          status: event.status,
          runId: event.runId,
          threadId: context.threadId,
          requesterUserId: context.requesterUserId,
          channel: context.channel,
          summary: event.summary,
          metadata: event.metadata,
        }),
      onWaitPromoted,
    });
  }

  createAutoRetryCoordinator(context: {
    actorId: string;
    actorType: "user" | "agent" | "system" | "tool";
    instanceId?: string;
    threadId?: string;
    requesterUserId?: string;
    channel?: string;
  }): ToolReworkAutoRetryCoordinator {
    const retry = new ToolReworkRetryCoordinator({
      toolReworkWaitStore: this.deps.waitStore,
      runStore: this.deps.runStore,
      audit: (event) =>
        this.deps.audit.record({
          instanceId: context.instanceId ?? "instance-local",
          actorId: context.actorId,
          actorType: context.actorType,
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          status: event.status,
          runId: event.runId,
          threadId: context.threadId,
          requesterUserId: context.requesterUserId,
          channel: context.channel,
          summary: event.summary,
          metadata: event.metadata,
        }),
    });
    return new ToolReworkAutoRetryCoordinator({
      toolReworkWaitStore: this.deps.waitStore,
      runStore: this.deps.runStore,
      retryCoordinator: retry,
      policy: { enabled: true, maxAutoRetriesPerRootRun: 1 },
      audit: (event) =>
        this.deps.audit.record({
          instanceId: context.instanceId ?? "instance-local",
          actorId: context.actorId,
          actorType: context.actorType,
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          status: event.status,
          runId: event.runId,
          threadId: context.threadId,
          requesterUserId: context.requesterUserId,
          channel: context.channel,
          summary: event.summary,
          metadata: event.metadata,
        }),
    });
  }

  async notifyBuildRegistered(
    buildRequestId: string,
    registeredToolName?: string,
    promotedVersion?: string,
    context: {
      actorId: string;
      actorType: "user" | "agent" | "system" | "tool";
      instanceId?: string;
      threadId?: string;
      requesterUserId?: string;
      channel?: string;
    } = { actorId: "tool-build-worker", actorType: "agent" },
    onWaitPromoted?: (wait: ToolReworkWaitRecord) => Promise<void> | void,
  ): Promise<void> {
    await this.createImprovementCoordinator(context, onWaitPromoted ?? this.onWaitPromoted).notifyBuildRegistered(
      buildRequestId,
      registeredToolName,
      promotedVersion,
    );
  }
}

function result(finalAnswer: string): AgentRunResult {
  return {
    finalAnswer,
    complexity: {
      mode: "direct",
      reason: "test",
      domains: ["tools"],
      riskLevel: "low",
    },
    subtasks: [],
    workerResults: [],
    reviews: [],
    artifacts: [],
  };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 1000): Promise<T> {
  const started = Date.now();
  let last: T | undefined;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last !== undefined) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for autonomous tool loop retry run to complete");
}
