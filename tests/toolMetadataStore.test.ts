import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import { PostgresToolMetadataStore } from "../src/tools/postgresToolMetadataStore.js";
import { InMemoryToolBuildRequestStore, createToolBuildContract } from "../src/tools/toolBuildRequestStore.js";
import { Tool } from "../src/tools/tool.js";
import { PgPool } from "../src/db/pool.js";

const tool: Tool = {
  name: "example.tool",
  displayName: "Example Tool",
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
  requiredConfigurationKeys: ["EXAMPLE_BASE_URL"],
  requiredSecretHandles: ["secret.example.api"],
  settingsSchema: {
    type: "object",
    properties: { baseUrl: { type: "string" } },
  },
  storage: {
    schema: "tool_example",
    tables: ["example_cache"],
    migrations: ["001_create_example_cache"],
    permissions: ["select", "insert", "delete"],
  },
  docsMarkdown: "Use this tool for example operations.",
  examples: [{ title: "Echo", input: { value: "hello" }, output: { ok: true } }],
  async run() {
    return { ok: true, content: "ok" };
  },
};

test("InMemoryToolMetadataStore syncs builtin tool contracts", async () => {
  const store = new InMemoryToolMetadataStore();
  const modules = await store.syncBuiltins([tool]);

  assert.equal(modules.length, 1);
  assert.equal(modules[0]?.name, "example.tool");
  assert.equal(modules[0]?.displayName, "Example Tool");
  assert.equal(modules[0]?.version, "1.2.3");
  assert.equal(modules[0]?.source, "builtin");
  assert.equal(modules[0]?.status, "available");
  assert.deepEqual(modules[0]?.capabilities, ["example", "artifact-generation"]);
  assert.equal(modules[0]?.inputSchema?.required?.[0], "value");
  assert.deepEqual(modules[0]?.requiredConfigurationKeys, ["EXAMPLE_BASE_URL"]);
  assert.deepEqual(modules[0]?.requiredSecretHandles, ["secret.example.api"]);
  assert.equal(modules[0]?.storage?.schema, "tool_example");
  assert.equal(modules[0]?.examples[0]?.title, "Echo");
  assert.equal(modules[0]?.successCount, 0);
  assert.equal(modules[0]?.failureCount, 0);
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

test("InMemoryToolMetadataStore records per-tool usage counters", async () => {
  const store = new InMemoryToolMetadataStore();
  await store.syncBuiltins([tool]);
  const successAt = new Date("2026-05-03T10:00:00.000Z");
  const failureAt = new Date("2026-05-03T10:05:00.000Z");

  await store.recordUsage("example.tool", "success", successAt);
  await store.recordUsage("example.tool", "failure", failureAt);
  await store.recordUsage("missing.tool", "failure", failureAt);

  const [module] = await store.list();

  assert.equal(module?.successCount, 1);
  assert.equal(module?.failureCount, 1);
  assert.equal(module?.lastSuccessAt, successAt.toISOString());
  assert.equal(module?.lastFailureAt, failureAt.toISOString());
});

test("InMemoryToolMetadataStore registers generated modules with conflict checks", async () => {
  const store = new InMemoryToolMetadataStore();
  const generated = await store.registerGenerated({
    name: "generated.browser.screenshot",
    displayName: "Browser Screenshot",
    version: "1.0.0",
    description: "Captures browser screenshots.",
    capabilities: ["browser-screenshot", "artifact-generation"],
    startupMode: "on-demand",
    modulePath: "src/tools/generated/browser-screenshotTool.ts",
    testPath: "tests/generated/browser-screenshotTool.test.ts",
    requiredSecretHandles: ["secret.browser.proxy"],
    storage: {
      schema: "tool_browser",
      tables: ["sessions"],
      migrations: ["001_create_sessions"],
      permissions: ["select", "insert", "delete"],
    },
    docsMarkdown: "Capture browser screenshots from arbitrary URLs.",
    promotionEvidence: {
      status: "promoted",
      promotedAt: "2026-05-04T10:00:00.000Z",
      summary: "Initial generated module passed isolated QA.",
      buildRequestId: "tbr-browser-screenshot",
      qaReport: {
        ok: true,
        summary: "QA passed.",
        checks: ["typecheck", "smoke"],
      },
      migrationIds: ["001_create_sessions"],
    },
  });
  await store.registerGenerated({
    name: "generated.browser.screenshot",
    version: "1.0.0",
    description: "Captures browser screenshots.",
    capabilities: ["browser-screenshot"],
    modulePath: "src/tools/generated/browser-screenshotTool.ts",
    changeSummary: "Initial generated browser screenshot module.",
  });

  assert.equal(generated.source, "generated");
  assert.equal(generated.displayName, "Browser Screenshot");
  assert.equal(generated.status, "disabled");
  assert.deepEqual(generated.requiredSecretHandles, ["secret.browser.proxy"]);
  assert.equal(generated.storage?.tables?.[0], "sessions");
  assert.equal(generated.promotionEvidence?.buildRequestId, "tbr-browser-screenshot");
  assert.deepEqual(generated.versions?.[0]?.promotionEvidence?.migrationIds, ["001_create_sessions"]);
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

test("InMemoryToolMetadataStore deletes generated modules but protects builtins", async () => {
  const store = new InMemoryToolMetadataStore();
  await store.syncBuiltins([tool]);
  await store.registerGenerated({
    name: "generated.api.test",
    displayName: "API Test",
    version: "1.0.0",
    description: "Generated API test tool.",
    capabilities: ["api.test"],
    modulePath: "src/tools/generated/api-testTool.ts",
  });

  assert.equal(await store.deleteGenerated("generated.api.test"), true);
  assert.equal(await store.deleteGenerated("generated.api.test"), false);
  await assert.rejects(() => store.deleteGenerated("example.tool"), /Cannot delete builtin tool/);
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

test("InMemoryToolMetadataStore promotes generated replacements only after version checks", async () => {
  const store = new InMemoryToolMetadataStore();
  await store.registerGenerated({
    name: "generated.browser.screenshot",
    version: "1.0.0",
    description: "Captures browser screenshots.",
    capabilities: ["browser-screenshot"],
    modulePath: "src/tools/generated/browser-screenshotTool.ts",
  });

  await assert.rejects(
    () =>
      store.promoteReplacement({
        name: "generated.browser.screenshot",
        version: "1.1.0",
        replacesVersion: "0.9.0",
        description: "Captures browser screenshots with better QA.",
        capabilities: ["browser-screenshot", "artifact-generation"],
        modulePath: "src/tools/generated/browser-screenshotTool.ts",
      }),
    /installed version 1.0.0 does not match expected 0.9.0/,
  );

  const replacement = await store.promoteReplacement({
    name: "generated.browser.screenshot",
    version: "1.1.0",
    replacesVersion: "1.0.0",
    description: "Captures browser screenshots with better QA.",
    capabilities: ["browser-screenshot", "artifact-generation"],
    modulePath: "src/tools/generated/browser-screenshotTool.ts",
    testPath: "tests/generated/browser-screenshotTool.test.ts",
    changeSummary: "Adds stricter artifact QA and screenshot test coverage.",
    promotionEvidence: {
      status: "promoted",
      promotedAt: "2026-05-04T11:00:00.000Z",
      summary: "Replacement passed artifact QA.",
      buildRequestId: "tbr-browser-screenshot-v2",
      packageRef: "generated.browser.screenshot/1.1.0",
    },
  });
  const [stored] = await store.list();

  assert.equal(replacement.version, "1.1.0");
  assert.equal(replacement.status, "disabled");
  assert.equal(stored?.version, "1.1.0");
  assert.equal(stored?.versions?.[0]?.version, "1.1.0");
  assert.equal(stored?.versions?.[0]?.active, true);
  assert.match(stored?.versions?.[0]?.changeSummary ?? "", /stricter artifact QA/);
  assert.equal(stored?.versions?.[0]?.promotionEvidence?.packageRef, "generated.browser.screenshot/1.1.0");
  assert.deepEqual(stored?.versions?.[0]?.capabilities, ["browser-screenshot", "artifact-generation"]);
  assert.deepEqual(await store.listVersions("generated.browser.screenshot"), stored?.versions);
  assert.equal((await store.activateVersion("generated.browser.screenshot", "1.1.0")).version, "1.1.0");
  assert.deepEqual(stored?.capabilities, ["browser-screenshot", "artifact-generation"]);
});

test("InMemoryToolMetadataStore blocks generated replacements for builtin tools", async () => {
  const store = new InMemoryToolMetadataStore();
  await store.syncBuiltins([tool]);

  await assert.rejects(
    () =>
      store.promoteReplacement({
        name: "example.tool",
        version: "1.2.4",
        replacesVersion: "1.2.3",
        description: "Generated replacement.",
        capabilities: ["example"],
        modulePath: "src/tools/generated/exampleTool.ts",
      }),
    /builtin tools cannot be replaced/,
  );
});

test("PostgresToolMetadataStore registerGenerated binds every insert column", async () => {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const rowDate = new Date("2026-05-04T10:00:00.000Z");
  const pool = {
    async query(text: string, params?: unknown[]) {
      queries.push({ text, params });
      if (text.includes("select name") && text.includes("from tool_modules")) {
        return { rows: [] };
      }
      if (text.includes("insert into tool_modules")) {
        assert.match(text, /promotion_evidence, examples, package_manifest, source, status, updated_at/);
        assert.match(text, /\$17,\s*\$18,\s*\$19,\s*'generated',\s*'disabled',\s*\$20/);
        assert.equal(params?.length, 20);
        return {
          rows: [
            {
              name: params?.[0],
              display_name: params?.[1],
              version: params?.[2],
              description: params?.[3],
              capabilities: params?.[4],
              startup_mode: params?.[5],
              input_schema: params?.[6],
              output_schema: params?.[7],
              module_path: params?.[8],
              test_path: params?.[9],
              required_configuration_keys: params?.[10],
              required_secret_handles: params?.[11],
              settings_schema: params?.[12],
              storage_contract: params?.[13],
              docs_markdown: params?.[14],
              change_summary: params?.[15],
              promotion_evidence: params?.[16] ? JSON.parse(String(params?.[16])) : null,
              examples: JSON.parse(String(params?.[17] ?? "[]")),
              package_manifest: params?.[18] ? JSON.parse(String(params?.[18])) : null,
              source: "generated",
              status: "disabled",
              last_health_ok: null,
              last_health_detail: null,
              success_count: 0,
              failure_count: 0,
              last_success_at: null,
              last_failure_at: null,
              updated_at: rowDate,
            },
          ],
        };
      }
      return { rows: [] };
    },
  } as unknown as PgPool;

  const store = new PostgresToolMetadataStore(pool);
  const registered = await store.registerGenerated({
    name: "generated.pdf.report",
    displayName: "PDF Report",
    version: "1.0.0",
    description: "Creates PDF artifacts.",
    capabilities: ["pdf-generation", "artifact-generation"],
    modulePath: "src/tools/generated/pdf-reportTool.ts",
    testPath: "tests/generated/pdf-reportTool.test.ts",
    docsMarkdown: "Use this tool to create a PDF artifact.",
    examples: [{ title: "Report", input: { title: "Hello" } }],
    promotionEvidence: {
      status: "promoted",
      promotedAt: "2026-05-04T10:00:00.000Z",
      summary: "PDF tool passed QA.",
      buildRequestId: "tbr-pdf",
      packageRef: "src/tools/generated/pdf-reportTool.ts",
    },
    packageManifest: {
      schemaVersion: "agentic.tool-package.v1",
      name: "generated.pdf.report",
      version: "1.0.0",
      description: "Creates PDF artifacts.",
      capabilities: ["pdf-generation", "artifact-generation"],
      startupMode: "on-demand",
      package: { type: "local-path", ref: "src/tools/generated/pdf-reportTool.ts" },
    },
  });

  assert.equal(registered.name, "generated.pdf.report");
  assert.equal(registered.displayName, "PDF Report");
  assert.equal(registered.packageManifest?.package.type, "local-path");
  assert.equal(registered.promotionEvidence?.buildRequestId, "tbr-pdf");
  assert.equal(queries.some((query) => query.text === "commit"), true);
});

test("tool build request store creates a reusable builder and QA contract", async () => {
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "browser-screenshot",
    displayName: "Browser Screenshot",
    reason: "The task needs a browser screenshot artifact.",
    sourceRunId: "run-1",
    sourceSpanId: "span-1",
    requiredInputs: ["url"],
    requiredOutputs: ["artifact"],
    credentialHandles: ["secret.browser.proxy"],
    credentialNotes: "Operator supplied proxy credentials.",
  });
  const [stored] = await store.list();

  assert.equal(request.status, "requested");
  assert.equal(request.displayName, "Browser Screenshot");
  assert.equal(request.contract.displayName, "Browser Screenshot");
  assert.equal(request.contract.toolName, "generated.browser.screenshot");
  assert.equal(request.contract.modulePath, "src/tools/generated/browser-screenshotTool.ts");
  assert.equal(request.contract.testPath, "tests/generated/browser-screenshotTool.test.ts");
  assert.deepEqual(request.contract.inputSchema.required, ["url"]);
  assert.deepEqual(request.credentialHandles, ["secret.browser.proxy"]);
  assert.equal(request.credentialNotes, "Operator supplied proxy credentials.");
  assert.ok(request.contract.builderInstructions.some((instruction) => instruction.includes("secret.browser.proxy")));
  assert.ok(request.contract.builderInstructions.some((instruction) => instruction.includes("Operator supplied credential notes")));
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

test("tool build request store preserves rework feedback", async () => {
  const store = new InMemoryToolBuildRequestStore();
  const original = await store.create({
    capability: "channel.telegram.bot",
    reason: "Create a Telegram bot adapter.",
  });
  const rework = await store.create({
    capability: original.capability,
    reason: `${original.reason}\n\nRework feedback: fix inbound thread routing.`,
    desiredToolName: original.desiredToolName,
    reworkOf: original.id,
    feedback: "Fix inbound thread routing and add QA for message-to-thread decisions.",
    qaCriteria: ["feedback is addressed"],
  });
  const stored = await store.get(rework.id);

  assert.equal(stored?.status, "requested");
  assert.equal(stored?.reworkOf, original.id);
  assert.match(stored?.feedback ?? "", /thread routing/);
  assert.deepEqual(stored?.qaCriteria, ["feedback is addressed"]);
});

test("tool build request store creates versioned replacement contracts", async () => {
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "api.gl-aml",
    displayName: "GL AML",
    reason: "Change request: totalFunds is the final score and sources[].funds drives sources.",
    desiredToolName: "generated.api.gl.aml",
    replacesToolName: "generated.api.gl.aml",
    replacesVersion: "1.0.0",
    qaCriteria: ["root totalFunds is returned as score"],
  });

  assert.equal(request.replacesToolName, "generated.api.gl.aml");
  assert.equal(request.replacesVersion, "1.0.0");
  assert.equal(request.contract.version, "1.1.0");
  assert.equal(request.contract.replacesVersion, "1.0.0");
  assert.equal(request.contract.toolName, "generated.api.gl.aml");
  assert.equal(request.contract.modulePath, "src/tools/generated/api-gl-aml-v1-1-0Tool.ts");
  assert.equal(request.contract.testPath, "tests/generated/api-gl-aml-v1-1-0Tool.test.ts");
});

test("tool build request store deletes lifecycle requests", async () => {
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "channel.telegram.bot",
    reason: "Create a Telegram bot adapter.",
  });

  const deleted = await store.delete(request.id);
  const missing = await store.get(request.id);
  const deletedAgain = await store.delete(request.id);

  assert.equal(deleted, true);
  assert.equal(missing, undefined);
  assert.equal(deletedAgain, false);
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

test("createToolBuildContract preserves requested always-on startup mode", () => {
  const contract = createToolBuildContract({
    capability: "messaging.telegram.bot",
    reason: "Create a persistent Telegram bot listener.",
    startupMode: "always-on",
  });

  assert.equal(contract.startupMode, "always-on");
  assert.ok(
    contract.builderInstructions.some((instruction) =>
      instruction.includes('Use startupMode "always-on"'),
    ),
  );
  assert.equal(contract.integration?.kind, "integration");
  assert.equal(contract.integration?.mode, "always-on-service");
  assert.equal(contract.integration?.providerHint, "telegram");
  assert.equal(contract.integration?.inbound.mapsTo, "run");
  assert.ok(contract.builderInstructions.some((instruction) => instruction.includes("Integration contract")));
});
