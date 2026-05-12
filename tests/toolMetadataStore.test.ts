import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import { PostgresToolMetadataStore } from "../src/tools/postgresToolMetadataStore.js";
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

