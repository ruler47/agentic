import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryToolBuildRequestStore } from "../src/tools/toolBuildRequestStore.js";
import { ToolBuildWorkflow } from "../src/tools/toolBuildWorkflow.js";
import { ToolBuildWorker } from "../src/tools/toolBuildWorker.js";

test("ToolBuildWorkflow runs builder, QA, and registrar in order", async () => {
  const calls: string[] = [];
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "browser-screenshot",
    reason: "Need screenshots as output artifacts.",
  });

  const workflow = new ToolBuildWorkflow(
    store,
    {
      async build() {
        calls.push("builder");
        return {
          modulePath: "src/tools/generated/browser-screenshotTool.ts",
          testPath: "tests/generated/browser-screenshotTool.test.ts",
          summary: "Created TypeScript module and tests.",
        };
      },
    },
    {
      async run(_request, output) {
        calls.push(`qa:${output.modulePath}`);
        return {
          ok: true,
          summary: "Automated tests and manual smoke passed.",
          checks: ["npm test passed", "manual screenshot smoke passed"],
        };
      },
    },
    {
      async register(_request, output) {
        calls.push(`registrar:${output.testPath}`);
        return "generated.browser.screenshot";
      },
    },
  );

  const result = await workflow.runOnce(request.id);
  const stored = await store.get(request.id);

  assert.deepEqual(calls, [
    "builder",
    "qa:src/tools/generated/browser-screenshotTool.ts",
    "registrar:tests/generated/browser-screenshotTool.test.ts",
  ]);
  assert.equal(result.registeredToolName, "generated.browser.screenshot");
  assert.equal(stored?.status, "registered");
  assert.equal(stored?.qaReport?.ok, true);
  assert.equal(stored?.registeredToolName, "generated.browser.screenshot");
});

test("ToolBuildWorkflow records code and behavior review gates before registration", async () => {
  const calls: string[] = [];
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "generated-reviewable-tool",
    reason: "Need a generated tool with review gates.",
  });

  const workflow = new ToolBuildWorkflow(
    store,
    {
      async build() {
        calls.push("builder");
        return {
          modulePath: "src/tools/generated/generated-reviewable-toolTool.ts",
          testPath: "tests/generated/generated-reviewable-toolTool.test.ts",
          summary: "Created TypeScript module and tests.",
        };
      },
    },
    {
      async run() {
        calls.push("qa");
        return {
          ok: true,
          summary: "Generated tool tests and TypeScript build passed.",
          checks: ["targeted generated tool tests passed", "TypeScript build passed"],
        };
      },
    },
    {
      async register() {
        calls.push("registrar");
        return "generated.reviewable.tool";
      },
    },
    {
      reviewers: [
        {
          async review() {
            calls.push("code-review");
            return { kind: "code", decision: "pass", summary: "Code contract passed.", findings: [] };
          },
        },
        {
          async review() {
            calls.push("behavior-review");
            return { kind: "behavior", decision: "pass", summary: "Behavior evidence passed.", findings: [] };
          },
        },
      ],
    },
  );

  const result = await workflow.runOnce(request.id);
  const stored = await store.get(request.id);

  assert.deepEqual(calls, ["builder", "qa", "code-review", "behavior-review", "registrar"]);
  assert.equal(result.request.status, "registered");
  assert.deepEqual(
    stored?.qaReport?.reviews?.map((review) => `${review.kind}:${review.decision}`),
    ["code:pass", "behavior:pass"],
  );
  assert.ok(stored?.qaReport?.checks.some((check) => check.includes("code review pass")));
});

test("ToolBuildWorkflow activates generated tools before marking request registered", async () => {
  const calls: string[] = [];
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "activated-tool",
    reason: "Need a generated tool that is available immediately after registration.",
  });

  const workflow = new ToolBuildWorkflow(
    store,
    {
      async build() {
        calls.push("builder");
        return {
          modulePath: "src/tools/generated/activated-toolTool.ts",
          testPath: "tests/generated/activated-toolTool.test.ts",
          summary: "Created TypeScript module and tests.",
        };
      },
    },
    {
      async run() {
        calls.push("qa");
        return { ok: true, summary: "QA passed.", checks: ["tests passed"] };
      },
    },
    {
      async register() {
        calls.push("registrar");
        return "generated.activated.tool";
      },
    },
    {
      activationRunner: {
        async activate(_request, _output, registeredToolName) {
          calls.push(`activate:${registeredToolName}`);
          return {
            ok: true,
            summary: "Runtime reload found the generated tool.",
            checks: ["reload completed", "tool health passed"],
          };
        },
      },
    },
  );

  const result = await workflow.runOnce(request.id);
  const stored = await store.get(request.id);

  assert.deepEqual(calls, ["builder", "qa", "registrar", "activate:generated.activated.tool"]);
  assert.equal(result.request.status, "registered");
  assert.equal(result.activationReport?.ok, true);
  assert.match(stored?.statusDetail ?? "", /Registered and activated generated\.activated\.tool/);
  assert.match(stored?.qaReport?.summary ?? "", /Activation passed/);
  assert.ok(stored?.qaReport?.checks.some((check) => check.includes("activation pass: reload completed")));
});

test("ToolBuildWorkflow blocks registered metadata when activation fails", async () => {
  const calls: string[] = [];
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "broken-runtime-tool",
    reason: "Need blocked status if runtime reload fails.",
  });

  const workflow = new ToolBuildWorkflow(
    store,
    {
      async build() {
        calls.push("builder");
        return {
          modulePath: "src/tools/generated/broken-runtime-toolTool.ts",
          testPath: "tests/generated/broken-runtime-toolTool.test.ts",
          summary: "Created TypeScript module and tests.",
        };
      },
    },
    {
      async run() {
        calls.push("qa");
        return { ok: true, summary: "QA passed.", checks: ["tests passed"] };
      },
    },
    {
      async register() {
        calls.push("registrar");
        return "generated.broken.runtime";
      },
    },
    {
      activationRunner: {
        async activate() {
          calls.push("activate");
          throw new Error("runtime reload failed");
        },
        async rollback(_request, _output, registeredToolName, activationReport) {
          calls.push(`rollback:${registeredToolName}:${activationReport.ok}`);
          return {
            ok: true,
            summary: "Previous runtime state restored.",
            checks: ["removed failed runtime version", "old version remains callable"],
          };
        },
      },
    },
  );

  const result = await workflow.runOnce(request.id);
  const stored = await store.get(request.id);

  assert.deepEqual(calls, ["builder", "qa", "registrar", "activate", "rollback:generated.broken.runtime:false"]);
  assert.equal(result.request.status, "blocked");
  assert.equal(result.registeredToolName, "generated.broken.runtime");
  assert.equal(result.activationReport?.ok, false);
  assert.equal(result.activationRollbackReport?.ok, true);
  assert.match(stored?.statusDetail ?? "", /activation failed: runtime reload failed/);
  assert.match(stored?.statusDetail ?? "", /Rollback: Previous runtime state restored/);
  assert.equal(stored?.registeredToolName, "generated.broken.runtime");
  assert.equal(stored?.qaReport?.ok, false);
  assert.ok(stored?.qaReport?.checks.some((check) => check.includes("activation fail")));
  assert.ok(stored?.qaReport?.checks.some((check) => check.includes("activation rollback pass")));
});

test("ToolBuildWorkflow returns failed review findings to builder before retry", async () => {
  const calls: string[] = [];
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "repairable-tool",
    reason: "Need a repairable generated tool.",
  });

  const workflow = new ToolBuildWorkflow(
    store,
    {
      async build(_request, context) {
        calls.push(`builder:${context?.attempt}:${context?.previousQaReport?.reviews?.[0]?.decision ?? "none"}`);
        return {
          modulePath: "src/tools/generated/repairable-toolTool.ts",
          testPath: "tests/generated/repairable-toolTool.test.ts",
          summary: `attempt ${context?.attempt}`,
        };
      },
    },
    {
      async run() {
        calls.push("qa");
        return {
          ok: true,
          summary: "Generated tool tests and TypeScript build passed.",
          checks: ["targeted generated tool tests passed", "TypeScript build passed"],
        };
      },
    },
    {
      async register() {
        calls.push("registrar");
        return "generated.repairable.tool";
      },
    },
    {
      maxAttempts: 2,
      reviewers: [
        {
          async review(_request, output) {
            const repaired = output.summary.includes("2");
            calls.push(`review:${repaired ? "pass" : "needs_revision"}`);
            return {
              kind: "code",
              decision: repaired ? "pass" : "needs_revision",
              summary: repaired ? "Code repaired." : "Code needs repair.",
              findings: repaired ? [] : ["Missing contract guard."],
            };
          },
        },
      ],
    },
  );

  const result = await workflow.runOnce(request.id);

  assert.deepEqual(calls, [
    "builder:1:none",
    "qa",
    "review:needs_revision",
    "builder:2:needs_revision",
    "qa",
    "review:pass",
    "registrar",
  ]);
  assert.equal(result.request.status, "registered");
  assert.equal(result.request.qaReport?.reviews?.[0]?.decision, "pass");
});

test("ToolBuildWorkflow is idempotent for already registered requests", async () => {
  const calls: string[] = [];
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "browser-screenshot",
    reason: "Need screenshots as output artifacts.",
  });
  const registered = await store.updateStatus(request.id, {
    status: "registered",
    statusDetail: "Already registered by background worker.",
    registeredToolName: "generated.browser.screenshot",
  });

  const workflow = new ToolBuildWorkflow(
    store,
    {
      async build() {
        calls.push("builder");
        throw new Error("builder should not run");
      },
    },
    {
      async run() {
        calls.push("qa");
        throw new Error("qa should not run");
      },
    },
    {
      async register() {
        calls.push("registrar");
        throw new Error("registrar should not run");
      },
    },
  );

  const result = await workflow.runOnce(registered.id);

  assert.deepEqual(calls, []);
  assert.equal(result.request.status, "registered");
  assert.equal(result.registeredToolName, "generated.browser.screenshot");
});

test("ToolBuildWorkflow blocks registration when QA fails", async () => {
  const calls: string[] = [];
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "pdf-report",
    reason: "Need a report artifact generator.",
  });

  const workflow = new ToolBuildWorkflow(
    store,
    {
      async build() {
        calls.push("builder");
        return {
          modulePath: "src/tools/generated/pdf-reportTool.ts",
          testPath: "tests/generated/pdf-reportTool.test.ts",
          summary: "Created draft module.",
        };
      },
    },
    {
      async run() {
        calls.push("qa");
        return {
          ok: false,
          summary: "Manual smoke did not produce a PDF artifact.",
          checks: ["unit tests passed", "manual smoke failed"],
        };
      },
    },
    {
      async register() {
        calls.push("registrar");
        return "generated.pdf.report";
      },
    },
    { maxAttempts: 1 },
  );

  const result = await workflow.runOnce(request.id);
  const stored = await store.get(request.id);

  assert.deepEqual(calls, ["builder", "qa"]);
  assert.equal(result.registeredToolName, undefined);
  assert.equal(stored?.status, "qa_failed");
  assert.equal(stored?.qaReport?.ok, false);
  assert.equal(stored?.registeredToolName, undefined);
});

test("ToolBuildWorkflow retries builder with failed QA report before registering", async () => {
  const calls: string[] = [];
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "browser-screenshot",
    reason: "Need screenshots as output artifacts.",
  });
  const workflow = new ToolBuildWorkflow(
    store,
    {
      async build(_request, context) {
        calls.push(`builder:${context?.attempt}:${context?.previousQaReport?.ok ?? "none"}`);
        return {
          modulePath: "src/tools/generated/browser-screenshotTool.ts",
          testPath: "tests/generated/browser-screenshotTool.test.ts",
          summary: `attempt ${context?.attempt}`,
        };
      },
    },
    {
      async run(_request, output) {
        const isSecondAttempt = output.summary.includes("2");
        calls.push(`qa:${isSecondAttempt ? "pass" : "fail"}`);
        return {
          ok: isSecondAttempt,
          summary: isSecondAttempt ? "QA passed after repair." : "QA found a missing smoke check.",
          checks: [isSecondAttempt ? "repair passed" : "repair needed"],
        };
      },
    },
    {
      async register() {
        calls.push("registrar");
        return "generated.browser.screenshot";
      },
    },
    { maxAttempts: 2 },
  );

  const result = await workflow.runOnce(request.id);
  const stored = await store.get(request.id);

  assert.deepEqual(calls, [
    "builder:1:none",
    "qa:fail",
    "builder:2:false",
    "qa:pass",
    "registrar",
  ]);
  assert.equal(result.request.status, "registered");
  assert.equal(stored?.qaReport?.ok, true);
});

test("ToolBuildWorkflow marks unsupported builder errors as blocked", async () => {
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "unknown-capability",
    reason: "No builder can satisfy this.",
  });
  const workflow = new ToolBuildWorkflow(
    store,
    {
      async build() {
        throw new Error("No provider found.");
      },
    },
    {
      async run() {
        return { ok: true, summary: "should not run", checks: [] };
      },
    },
    {
      async register() {
        return "generated.unknown";
      },
    },
  );

  const result = await workflow.runOnce(request.id);

  assert.equal(result.request.status, "blocked");
  assert.match(result.request.statusDetail ?? "", /No provider found/);
});

test("ToolBuildRequestStore atomically claims requested work oldest first", async () => {
  const store = new InMemoryToolBuildRequestStore();
  const first = await store.create({ capability: "first-tool", reason: "first" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await store.create({ capability: "second-tool", reason: "second" });

  const claimedFirst = await store.claimNextRequested("claimed by test");
  const claimedSecond = await store.claimNextRequested("claimed by test");
  const noMore = await store.claimNextRequested("claimed by test");

  assert.equal(claimedFirst?.id, first.id);
  assert.equal(claimedFirst?.status, "building");
  assert.equal(claimedFirst?.statusDetail, "claimed by test");
  assert.equal(claimedSecond?.id, second.id);
  assert.equal(noMore, undefined);
});

test("ToolBuildWorker claims requested builds and reloads registered tools", async () => {
  const calls: string[] = [];
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "browser-screenshot",
    reason: "Need screenshot artifacts.",
  });
  const workflow = new ToolBuildWorkflow(
    store,
    {
      async build(claimed) {
        calls.push(`build:${claimed.status}`);
        return {
          modulePath: claimed.contract.modulePath,
          testPath: claimed.contract.testPath,
          summary: "built by worker",
        };
      },
    },
    {
      async run() {
        calls.push("qa");
        return { ok: true, summary: "QA passed.", checks: ["targeted test passed"] };
      },
    },
    {
      async register() {
        calls.push("register");
        return "generated.browser.screenshot";
      },
    },
  );
  const events: string[] = [];
  let reloads = 0;
  const worker = new ToolBuildWorker(workflow, store, {
    reloadGeneratedTools: async () => {
      reloads += 1;
    },
    onEvent(event) {
      if (event.type !== "idle") events.push(`${event.type}:${event.status ?? ""}`);
    },
  });

  const tick = await worker.tick();
  const stored = await store.get(request.id);

  assert.deepEqual(calls, ["build:building", "qa", "register"]);
  assert.equal(tick.claimed.length, 1);
  assert.equal(tick.results[0].request.status, "registered");
  assert.equal(stored?.status, "registered");
  assert.equal(reloads, 1);
  assert.deepEqual(events, ["claimed:building", "completed:registered"]);
});

test("ToolBuildWorker does not double-reload when workflow activation already ran", async () => {
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "activated-by-workflow",
    reason: "Workflow activation should own runtime reload.",
  });
  const workflow = new ToolBuildWorkflow(
    store,
    {
      async build(claimed) {
        return {
          modulePath: claimed.contract.modulePath,
          testPath: claimed.contract.testPath,
          summary: "built by worker",
        };
      },
    },
    {
      async run() {
        return { ok: true, summary: "QA passed.", checks: ["targeted test passed"] };
      },
    },
    {
      async register() {
        return "generated.activated.by.workflow";
      },
    },
    {
      activationRunner: {
        async activate() {
          return { ok: true, summary: "Workflow reload passed.", checks: ["workflow reload"] };
        },
      },
    },
  );
  let workerReloads = 0;
  const worker = new ToolBuildWorker(workflow, store, {
    reloadGeneratedTools: async () => {
      workerReloads += 1;
    },
  });

  const tick = await worker.tick();
  const stored = await store.get(request.id);

  assert.equal(tick.results[0].request.status, "registered");
  assert.equal(stored?.status, "registered");
  assert.equal(workerReloads, 0);
  assert.equal(tick.results[0].activationReport?.ok, true);
});

test("ToolBuildWorker invokes onAfterCompleted with the workflow result for handoff", async () => {
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "background-handoff",
    reason: "Verify post-registration callback fires.",
  });
  const workflow = new ToolBuildWorkflow(
    store,
    {
      async build(claimed) {
        return {
          modulePath: claimed.contract.modulePath,
          testPath: claimed.contract.testPath,
          summary: "built",
        };
      },
    },
    {
      async run() {
        return { ok: true, summary: "QA passed.", checks: ["ok"] };
      },
    },
    {
      async register() {
        return "generated.background.handoff";
      },
    },
  );
  const seen: Array<{ requestId: string; status: string; registeredToolName?: string }> = [];
  const worker = new ToolBuildWorker(workflow, store, {
    onAfterCompleted: async (workflowResult) => {
      seen.push({
        requestId: workflowResult.request.id,
        status: workflowResult.request.status,
        registeredToolName: workflowResult.registeredToolName,
      });
    },
  });

  await worker.tick();

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.requestId, request.id);
  assert.equal(seen[0]?.status, "registered");
  assert.equal(seen[0]?.registeredToolName, "generated.background.handoff");
});

test("ToolBuildWorker setOnAfterCompleted late-binds the post-completion callback", async () => {
  const store = new InMemoryToolBuildRequestStore();
  await store.create({
    capability: "late-bind",
    reason: "Verify setter replaces constructor callback.",
  });
  const workflow = new ToolBuildWorkflow(
    store,
    {
      async build(claimed) {
        return { modulePath: claimed.contract.modulePath, testPath: claimed.contract.testPath, summary: "built" };
      },
    },
    {
      async run() {
        return { ok: true, summary: "ok", checks: ["ok"] };
      },
    },
    {
      async register() {
        return "generated.late.bind";
      },
    },
  );
  const seen: string[] = [];
  const worker = new ToolBuildWorker(workflow, store);
  worker.setOnAfterCompleted(async (workflowResult) => {
    seen.push(workflowResult.request.status);
  });
  await worker.tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0], "registered");
});

test("ToolBuildWorker does not double-claim overlapping ticks and queues scheduleImmediate follow-up", async () => {
  const store = new InMemoryToolBuildRequestStore();
  await store.create({ capability: "concurrency", reason: "concurrency probe 1" });
  await store.create({ capability: "concurrency", reason: "concurrency probe 2" });
  const claimedRequestIds: string[] = [];
  const builderStarted: Array<() => void> = [];
  const builderResume: Array<Promise<void>> = [];
  const builderResumeResolvers: Array<() => void> = [];
  // Builder blocks until the test releases it, so we can hold the worker mid-tick and
  // attempt to start a second tick while the first is still in flight.
  for (let index = 0; index < 4; index += 1) {
    builderResume.push(new Promise<void>((resolve) => {
      builderResumeResolvers.push(resolve);
    }));
    builderStarted.push(() => undefined);
  }
  let builderCallIndex = 0;
  const workflow = new ToolBuildWorkflow(
    store,
    {
      async build(claimed) {
        claimedRequestIds.push(claimed.id);
        const myIndex = builderCallIndex;
        builderCallIndex += 1;
        await builderResume[myIndex];
        return { modulePath: claimed.contract.modulePath, testPath: claimed.contract.testPath, summary: "built" };
      },
    },
    {
      async run() {
        return { ok: true, summary: "ok", checks: ["ok"] };
      },
    },
    {
      async register() {
        return "generated.concurrency";
      },
    },
  );
  const worker = new ToolBuildWorker(workflow, store);
  const firstTick = worker.tick();
  // Second tick fires before the first releases the builder. It must join the pending
  // tick (or no-op) instead of double-claiming the same request.
  const secondTick = worker.tick();
  // scheduleImmediate is stronger than a plain overlapping tick: it queues one follow-up
  // tick after the current one finishes, so freshly-created handoff requests do not wait
  // for the next interval.
  const scheduled = worker.scheduleImmediate();

  // Release builder for first request only.
  builderResumeResolvers[0]?.();
  await Promise.all([firstTick, secondTick]);

  assert.equal(claimedRequestIds.length, 1, "plain overlapping ticks must not double-claim");

  builderResumeResolvers[1]?.();
  const scheduledResult = await scheduled;

  assert.equal(scheduledResult.claimed.length, 1, "scheduleImmediate should run one queued follow-up tick");
  assert.equal(claimedRequestIds.length, 2);
  assert.equal(new Set(claimedRequestIds).size, 2, "each request should be claimed once");
  const remaining = (await store.list()).filter((req) => req.status === "requested");
  assert.equal(remaining.length, 0);
});

test("ToolBuildWorker scheduleImmediate catches requests created after an in-flight idle claim", async () => {
  const store = new InMemoryToolBuildRequestStore();
  let releaseFirstClaim: (() => void) | undefined;
  const firstClaimStarted = new Promise<void>((resolve) => {
    const originalClaim = store.claimNextRequested.bind(store);
    let claimCalls = 0;
    store.claimNextRequested = async (statusDetail?: string) => {
      claimCalls += 1;
      if (claimCalls === 1) {
        resolve();
        await new Promise<void>((release) => {
          releaseFirstClaim = release;
        });
        return undefined;
      }
      return originalClaim(statusDetail);
    };
  });
  const workflow = new ToolBuildWorkflow(
    store,
    {
      async build(claimed) {
        return { modulePath: claimed.contract.modulePath, testPath: claimed.contract.testPath, summary: "built" };
      },
    },
    {
      async run() {
        return { ok: true, summary: "ok", checks: ["ok"] };
      },
    },
    {
      async register() {
        return "generated.immediate";
      },
    },
  );
  const worker = new ToolBuildWorker(workflow, store);

  const firstTick = worker.tick();
  await firstClaimStarted;
  const request = await store.create({
    capability: "immediate-after-idle-claim",
    reason: "Created while an idle tick is already in flight.",
  });
  const scheduled = worker.scheduleImmediate();
  releaseFirstClaim?.();
  const [firstResult, scheduledResult] = await Promise.all([firstTick, scheduled]);

  assert.equal(firstResult.claimed.length, 0, "the in-flight tick already missed the new request");
  assert.equal(scheduledResult.claimed.length, 1, "scheduleImmediate must queue a follow-up claim");
  assert.equal(scheduledResult.claimed[0]?.id, request.id);
  assert.equal((await store.get(request.id))?.status, "registered");
});
