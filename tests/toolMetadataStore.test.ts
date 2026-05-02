import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import { InMemoryToolBuildRequestStore, createToolBuildContract } from "../src/tools/toolBuildRequestStore.js";
import { Tool } from "../src/tools/tool.js";

const tool: Tool = {
  name: "example.tool",
  version: "1.2.3",
  description: "Example reusable tool",
  capabilities: ["example", "artifact-generation"],
  startupMode: "on-demand",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
  outputSchema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
  },
  async run() {
    return { ok: true, content: "ok" };
  },
};

test("InMemoryToolMetadataStore syncs builtin tool contracts", async () => {
  const store = new InMemoryToolMetadataStore();
  const modules = await store.syncBuiltins([tool]);

  assert.equal(modules.length, 1);
  assert.equal(modules[0]?.name, "example.tool");
  assert.equal(modules[0]?.version, "1.2.3");
  assert.equal(modules[0]?.source, "builtin");
  assert.equal(modules[0]?.status, "available");
  assert.deepEqual(modules[0]?.capabilities, ["example", "artifact-generation"]);
  assert.equal(modules[0]?.inputSchema?.required?.[0], "value");
});

test("InMemoryToolMetadataStore keeps health status for synced modules", async () => {
  const store = new InMemoryToolMetadataStore();
  await store.syncBuiltins([tool]);
  await store.updateHealth("example.tool", { ok: false, detail: "Dependency unavailable" });

  const [module] = await store.list();

  assert.equal(module?.status, "failed");
  assert.equal(module?.lastHealthOk, false);
  assert.equal(module?.lastHealthDetail, "Dependency unavailable");
});

test("InMemoryToolMetadataStore registers generated modules with conflict checks", async () => {
  const store = new InMemoryToolMetadataStore();
  const generated = await store.registerGenerated({
    name: "generated.browser.screenshot",
    version: "1.0.0",
    description: "Captures browser screenshots.",
    capabilities: ["browser-screenshot", "artifact-generation"],
    startupMode: "on-demand",
    modulePath: "src/tools/generated/browser-screenshotTool.ts",
    testPath: "tests/generated/browser-screenshotTool.test.ts",
  });
  await store.registerGenerated({
    name: "generated.browser.screenshot",
    version: "1.0.0",
    description: "Captures browser screenshots.",
    capabilities: ["browser-screenshot"],
    modulePath: "src/tools/generated/browser-screenshotTool.ts",
  });

  assert.equal(generated.source, "generated");
  assert.equal(generated.status, "disabled");
  await assert.rejects(
    () =>
      store.registerGenerated({
        name: "generated.browser.screenshot",
        version: "2.0.0",
        description: "Conflicting upgrade.",
        capabilities: ["browser-screenshot"],
        modulePath: "src/tools/generated/browser-screenshotTool.ts",
      }),
    /existing version 1.0.0 differs from 2.0.0/,
  );
});

test("InMemoryToolMetadataStore rejects generated modules that reuse builtin names", async () => {
  const store = new InMemoryToolMetadataStore();
  await store.syncBuiltins([tool]);

  await assert.rejects(
    () =>
      store.registerGenerated({
        name: "example.tool",
        version: "1.0.0",
        description: "Name collision.",
        capabilities: ["example"],
        modulePath: "src/tools/generated/exampleTool.ts",
      }),
    /builtin tool already uses that name/,
  );
});

test("tool build request store creates a reusable builder and QA contract", async () => {
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "browser-screenshot",
    reason: "The task needs a browser screenshot artifact.",
    sourceRunId: "run-1",
    sourceSpanId: "span-1",
    requiredInputs: ["url"],
    requiredOutputs: ["artifact"],
  });
  const [stored] = await store.list();

  assert.equal(request.status, "requested");
  assert.equal(request.contract.toolName, "generated.browser.screenshot");
  assert.equal(request.contract.modulePath, "src/tools/generated/browser-screenshotTool.ts");
  assert.equal(request.contract.testPath, "tests/generated/browser-screenshotTool.test.ts");
  assert.deepEqual(request.contract.inputSchema.required, ["url"]);
  assert.ok(request.contract.qaCriteria.some((criterion) => criterion.includes("Manual smoke check")));
  assert.equal(stored?.id, request.id);
});

test("tool build request store tracks builder and QA lifecycle", async () => {
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "web-screenshot",
    reason: "Need a reusable browser screenshot module.",
  });

  const building = await store.updateStatus(request.id, {
    status: "building",
    statusDetail: "Builder agent claimed the request.",
  });
  const qaPassed = await store.updateStatus(request.id, {
    status: "qa_passed",
    statusDetail: "Automated tests and manual smoke passed.",
    qaReport: {
      ok: true,
      summary: "The generated tool produces an artifact for a local page.",
      checks: ["npm test passed", "manual screenshot smoke passed"],
      artifacts: ["/artifacts/browser-screenshot.svg"],
    },
  });
  const registered = await store.updateStatus(request.id, {
    status: "registered",
    registeredToolName: "generated.web.screenshot",
  });
  const stored = await store.get(request.id);

  assert.equal(building.status, "building");
  assert.equal(qaPassed.qaReport?.ok, true);
  assert.equal(qaPassed.qaReport?.checks.length, 2);
  assert.equal(registered.registeredToolName, "generated.web.screenshot");
  assert.equal(stored?.status, "registered");
});

test("createToolBuildContract derives safe generic paths from arbitrary capabilities", () => {
  const contract = createToolBuildContract({
    capability: "PDF report / screenshot bundle",
    reason: "Need a generated artifact bundle.",
  });

  assert.equal(contract.toolName, "generated.pdf.report.screenshot.bundle");
  assert.equal(contract.modulePath, "src/tools/generated/pdf-report-screenshot-bundleTool.ts");
  assert.equal(contract.startupMode, "on-demand");
  assert.ok(contract.acceptanceCriteria.every((criterion) => criterion.length > 0));
});
