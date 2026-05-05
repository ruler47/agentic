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
