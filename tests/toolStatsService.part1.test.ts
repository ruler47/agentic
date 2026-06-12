import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, rm } from "node:fs/promises";
import { ToolsService } from "../src/server/modules/tools/tools.service.js";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { InMemoryToolCreationStore } from "../src/tools/toolCreationStore.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { WebSearchTool } from "../src/tools/webSearchTool.js";
import { InMemoryToolRuntimeSettingsStore } from "../src/settings/toolRuntimeSettings.js";
import { InMemorySecretHandleStore } from "../src/secrets/secretHandleStore.js";
import {
  loadGeneratedTools,
  MissingToolRuntimeRequirementsError,
  SourceBundleHttpProcessToolPackageRunner,
} from "../src/tools/toolPackageRunner.js";
import type { Tool } from "../src/tools/tool.js";

class FakeAudit {
  events: Array<Record<string, unknown>> = [];
  async record(event: unknown) {
    this.events.push({
      ...(event as Record<string, unknown>),
      id: `audit_${this.events.length + 1}`,
      createdAt: new Date().toISOString(),
      status: (event as { status?: string }).status ?? "success",
    });
  }
  async list(limit = 100) {
    return [...this.events].reverse().slice(0, limit);
  }
}

async function makeService() {
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();
  registry.register(new WebSearchTool());
  await metadata.syncBuiltins(registry.list());
  const audit = new FakeAudit();
  const service = new ToolsService(
    registry,
    metadata,
    undefined,
    undefined,
    undefined,
    audit as never,
  );
  return { metadata, service, audit };
}

function createWidgetApiServer() {
  const widgets = new Map<string, { id: string; name: string }>();
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/widgets") {
      const body = await readJsonBody(request);
      const id = `widget-${widgets.size + 1}`;
      const widget = { id, name: typeof body.name === "string" ? body.name : "Unnamed" };
      widgets.set(id, widget);
      writeJson(response, 201, widget);
      return;
    }
    const match = url.pathname.match(/^\/widgets\/([^/]+)$/);
    if (request.method === "GET" && match?.[1]) {
      const widget = widgets.get(decodeURIComponent(match[1]));
      if (!widget) {
        writeJson(response, 404, { error: "not found" });
        return;
      }
      writeJson(response, 200, widget);
      return;
    }
    writeJson(response, 404, { error: "not found" });
  });
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function widgetOpenApiSpec(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    servers: [{ url: baseUrl }],
    components: {
      schemas: {
        WidgetCreate: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
          },
        },
      },
    },
    paths: {
      "/widgets": {
        post: {
          operationId: "createWidget",
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WidgetCreate" },
                example: { name: "Alpha" },
              },
            },
          },
          responses: {
            "201": {
              content: {
                "application/json": {
                  example: { id: "widget-1", name: "Alpha" },
                },
              },
            },
          },
        },
      },
      "/widgets/{id}": {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        get: {
          operationId: "getWidget",
          responses: {
            "200": {
              content: {
                "application/json": {
                  example: { id: "widget-1", name: "Alpha" },
                },
              },
            },
          },
        },
      },
    },
  };
}

function authoredUppercasePackage() {
  return {
    readmeMarkdown: "# Authored uppercase tool\n\nLLM-authored source-bundle package fixture.\n",
    dockerfile: [
      "FROM node:22-alpine",
      "WORKDIR /app",
      "COPY package*.json ./",
      "RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi",
      "COPY dist ./dist",
      "EXPOSE 8080",
      "CMD [\"node\", \"dist/runtime/server.js\"]",
      "",
    ].join("\n"),
    files: [
      { path: "index.ts", content: "export { tool } from \"./src/tools/generated/authoredTool.js\";\n" },
      {
        path: "runtime/server.ts",
        content: [
          "import { createServer } from \"node:http\";",
          "import { tool } from \"../index.js\";",
          "const port = Number(process.env.PORT ?? 8080);",
          "const server = createServer(async (request, response) => {",
          "  if (request.method === \"GET\" && request.url === \"/health\") {",
          "    response.writeHead(200, { \"content-type\": \"application/json\" });",
          "    response.end(JSON.stringify(await tool.healthcheck?.() ?? { ok: true, detail: \"ok\" }));",
          "    return;",
          "  }",
          "  if (request.method === \"POST\" && request.url === \"/run\") {",
          "    const input = await readJson(request);",
          "    const result = await tool.run((input as { input?: Record<string, unknown> }).input ?? {});",
          "    response.writeHead(200, { \"content-type\": \"application/json\" });",
          "    response.end(JSON.stringify(result));",
          "    return;",
          "  }",
          "  response.writeHead(404, { \"content-type\": \"application/json\" });",
          "  response.end(JSON.stringify({ ok: false, content: \"not found\" }));",
          "});",
          "server.listen(port, \"0.0.0.0\");",
          "function readJson(request: import(\"node:http\").IncomingMessage): Promise<unknown> {",
          "  return new Promise((resolve, reject) => {",
          "    const chunks: Buffer[] = [];",
          "    request.on(\"data\", (chunk) => chunks.push(Buffer.from(chunk)));",
          "    request.on(\"error\", reject);",
          "    request.on(\"end\", () => resolve(JSON.parse(Buffer.concat(chunks).toString(\"utf8\") || \"{}\")));",
          "  });",
          "}",
          "",
        ].join("\n"),
      },
      {
        path: "src/tools/tool.ts",
        content: [
          "export type ToolInput = Record<string, unknown>;",
          "export type ToolResult = { ok: boolean; content: string; data?: unknown };",
          "export type Tool = {",
          "  name: string;",
          "  version?: string;",
          "  description: string;",
          "  capabilities: string[];",
          "  startupMode?: \"on-demand\";",
          "  inputSchema?: { type: \"object\"; properties: Record<string, unknown>; required?: string[] };",
          "  outputSchema?: { type: \"object\"; properties: Record<string, unknown>; required?: string[] };",
          "  run(input: ToolInput): Promise<ToolResult> | ToolResult;",
          "  healthcheck?(): Promise<{ ok: boolean; detail: string }> | { ok: boolean; detail: string };",
          "};",
          "",
        ].join("\n"),
      },
      {
        path: "src/tools/generated/authoredTool.ts",
        content: [
          "import type { Tool } from \"../tool.js\";",
          "export const tool: Tool = {",
          "  name: \"generated.test.authored\",",
          "  version: \"0.1.0\",",
          "  description: \"Uppercases text.\",",
          "  capabilities: [\"test-authored\"],",
          "  startupMode: \"on-demand\",",
          "  inputSchema: { type: \"object\", properties: { text: { type: \"string\" } }, required: [\"text\"] },",
          "  outputSchema: { type: \"object\", properties: { ok: { type: \"boolean\" }, content: { type: \"string\" } }, required: [\"ok\", \"content\"] },",
          "  healthcheck() { return { ok: true, detail: \"Authored tool loaded.\" }; },",
          "  run(input) {",
          "    const text = typeof input.text === \"string\" ? input.text : \"\";",
          "    if (!text) return { ok: false, content: \"text is required\" };",
          "    return { ok: true, content: text.toUpperCase(), data: { length: text.length } };",
          "  },",
          "};",
          "",
        ].join("\n"),
      },
      {
        path: "tests/generated/authoredTool.test.ts",
        content: [
          "import test from \"node:test\";",
          "import assert from \"node:assert/strict\";",
          "import { tool } from \"../../src/tools/generated/authoredTool.js\";",
          "test(\"uppercases text\", async () => {",
          "  const result = await tool.run({ text: \"ok\" });",
          "  assert.equal(result.ok, true);",
          "  assert.equal(result.content, \"OK\");",
          "});",
          "",
        ].join("\n"),
      },
    ],
  };
}

test("ToolsService.getToolStats derives totals + success rate from metadata store", async () => {
  const { metadata, service } = await makeService();
  await metadata.recordUsage("web.search", "success");
  await metadata.recordUsage("web.search", "success");
  await metadata.recordUsage("web.search", "success");
  await metadata.recordUsage("web.search", "failure");
  const stats = await service.getToolStats("web.search");
  assert.equal(stats.name, "web.search");
  assert.equal(stats.totalRuns, 4);
  assert.equal(stats.successCount, 3);
  assert.equal(stats.failureCount, 1);
  assert.equal(stats.successRate, 0.75);
  assert.ok(stats.lastSuccessAt);
  assert.ok(stats.lastFailureAt);
  assert.ok(Array.isArray(stats.versions));
});

test("ToolsService.getToolStats reports null successRate when no runs recorded", async () => {
  const { service } = await makeService();
  const stats = await service.getToolStats("web.search");
  assert.equal(stats.totalRuns, 0);
  assert.equal(stats.successRate, null);
});

test("ToolsService.exportPackageManifest returns the manifest with a sensible filename", async () => {
  const { metadata, service } = await makeService();
  await metadata.registerGenerated({
    name: "test.tool",
    displayName: "Test Tool",
    version: "1.2.3",
    description: "x",
    capabilities: ["x"],
    startupMode: "on-demand",
    requiredConfigurationKeys: [],
    requiredSecretHandles: [],
    examples: [],
    packageManifest: {
      schemaVersion: "agentic.tool-package.v1",
      name: "test.tool",
      version: "1.2.3",
      description: "x",
      capabilities: ["x"],
      startupMode: "on-demand",
      package: { type: "oci-image", ref: "agentic-tool-test-tool:1.2.3" },
    },
  });
  const exported = await service.exportPackageManifest("test.tool");
  assert.equal((exported.manifest as { name: string }).name, "test.tool");
  assert.equal(exported.filename, "test.tool-1.2.3.tool-package.json");
});

test("ToolsService.setToolStatus disables and re-enables tools through metadata", async () => {
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();
  registry.register(new WebSearchTool());
  await metadata.syncBuiltins(registry.list());
  const audit = new FakeAudit();
  const service = new ToolsService(
    registry,
    metadata,
    undefined,
    undefined,
    undefined,
    audit as never,
  );

  const disabled = await service.setToolStatus("web.search", { status: "disabled" });
  assert.equal(disabled.tool.status, "disabled");
  assert.equal((await metadata.list()).find((tool) => tool.name === "web.search")?.status, "disabled");

  const enabled = await service.setToolStatus("web.search", { status: "available" });
  assert.equal(enabled.tool.status, "available");
  assert.equal((audit.events.at(-1) as { summary?: string }).summary, "Enabled tool: web.search");
});

test("ToolsService.runToolManually returns structured diagnostics for missing runtime requirements", async () => {
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();
  const diagnosticTool: Tool = {
    name: "diagnostic.secret-test",
    version: "0.1.0",
    description: "Test tool that requires runtime values.",
    capabilities: ["diagnostic-test"],
    requiredConfigurationKeys: ["api.baseUrl"],
    requiredSecretHandles: ["secret.api.test"],
    async run() {
      throw new MissingToolRuntimeRequirementsError(["api.baseUrl"], ["secret.api.test"]);
    },
  };
  registry.register(diagnosticTool);
  await metadata.syncBuiltins(registry.list());
  const audit = new FakeAudit();
  const service = new ToolsService(
    registry,
    metadata,
    undefined,
    undefined,
    undefined,
    audit as never,
  );

  const run = await service.runToolManually("diagnostic.secret-test", { input: {} });

  assert.equal(run.result.ok, false);
  assert.equal(run.diagnostic?.type, "missing_runtime_requirements");
  assert.deepEqual(run.diagnostic?.missingConfigurationKeys, ["api.baseUrl"]);
  assert.deepEqual(run.diagnostic?.missingSecretHandles, ["secret.api.test"]);
  assert.match(run.result.content, /Missing required runtime values/);
  assert.deepEqual(
    run.diagnostic?.actions.map((action) => action.kind),
    ["set_runtime_setting", "create_secret_handle"],
  );
  const auditOutput = (audit.events.at(-1) as { metadata?: { output?: { diagnostic?: unknown } } }).metadata?.output;
  assert.ok(auditOutput?.diagnostic);
});

test("ToolsService.listTools and healthchecks expose runtime readiness", async () => {
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();
  registry.register({
    name: "diagnostic.ready",
    version: "0.1.0",
    description: "Readiness probe.",
    capabilities: ["diagnostic-test"],
    requiredConfigurationKeys: ["api.baseUrl"],
    requiredSecretHandles: ["secret.api.test"],
    async healthcheck() {
      return { ok: true, detail: "package healthy" };
    },
    async run() {
      return { ok: true, content: "ok" };
    },
  });
  await metadata.syncBuiltins(registry.list());
  const settings = new InMemoryToolRuntimeSettingsStore();
  const secrets = new InMemorySecretHandleStore();
  const audit = new FakeAudit();
  const service = new ToolsService(
    registry,
    metadata,
    settings,
    undefined,
    undefined,
    audit as never,
    undefined,
    undefined,
    undefined,
    secrets,
  );

  const blocked = (await service.listTools()).find((tool) => tool.name === "diagnostic.ready");
  assert.equal(blocked?.runtimeReadiness?.ok, false);
  assert.equal(blocked?.runtimeReadiness?.status, "missing_runtime_requirements");
  assert.deepEqual(blocked?.runtimeReadiness?.missingConfigurationKeys, ["api.baseUrl"]);
  assert.deepEqual(blocked?.runtimeReadiness?.missingSecretHandles, ["secret.api.test"]);

  const health = await service.toolHealth();
  const healthEntry = health.find((tool) => tool.name === "diagnostic.ready");
  assert.equal(healthEntry?.ok, false);
  assert.match(healthEntry?.detail ?? "", /Missing required runtime values/);
  assert.equal((await metadata.list()).find((tool) => tool.name === "diagnostic.ready")?.lastHealthOk, false);

  await settings.set({ toolName: "diagnostic.ready", key: "api.baseUrl", value: "https://api.example.test" });
  await secrets.create({
    handle: "secret.api.test",
    label: "API test token",
    provider: "inline",
    secretRef: "redacted-test-token",
  });

  const ready = (await service.listTools()).find((tool) => tool.name === "diagnostic.ready");
  assert.equal(ready?.runtimeReadiness?.ok, true);
  assert.equal(ready?.runtimeReadiness?.status, "ready");
  const readyHealth = (await service.toolHealth()).find((tool) => tool.name === "diagnostic.ready");
  assert.equal(readyHealth?.ok, true);
  assert.equal(readyHealth?.detail, "package healthy");
});

test("ToolsService.createToolPackage writes, QAs, registers, and reloads an agent-requested echo source-bundle", async () => {
  const workspaceRoot = `.tmp-tool-create-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const previousRoot = process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
  process.env.TOOL_PACKAGE_WORKSPACE_ROOT = workspaceRoot;
  const metadata = new InMemoryToolMetadataStore();
  const creations = new InMemoryToolCreationStore();
  const registry = new ToolRegistry();
  const runs = new InMemoryRunStore();
  const audit = new FakeAudit();
  const runner = new SourceBundleHttpProcessToolPackageRunner({
    enabled: true,
    packageRoot: workspaceRoot,
    startupTimeoutMs: 5_000,
    pollIntervalMs: 50,
    callTimeoutMs: 5_000,
  });
  const service = new ToolsService(
    registry,
    metadata,
    undefined,
    [runner],
    async () => {
      await loadGeneratedTools(registry, metadata, process.cwd(), [runner]);
    },
    audit as never,
    creations,
    undefined,
    runs,
  );

  try {
    const created = await service.createToolPackage({
      source: "agent",
      sourceRunId: "run_parent_test",
      instanceId: "instance-test",
      requesterUserId: "user-test",
      threadId: "thread-test",
      name: "generated.test.echo",
      version: "0.1.0",
      description: "Echo test package.",
      request: "Create an echo tool for tests.",
      capabilities: ["test-echo"],
      behaviorExamples: [
        {
          title: "Echo returns submitted text",
          input: { text: "hello package" },
          expectedContent: "hello package",
        },
      ],
    });

    assert.equal(created.qa.ok, true, JSON.stringify(created.qa, null, 2));
    assert.match(created.qa.summary, /behavior QA/);
    assert.ok(created.qa.checks.some((check) => check.includes("package behavior example passed")));
    assert.match(created.package.manifestPath, /tool\.package\.json$/);
    assert.equal(created.tool.name, "generated.test.echo");
    assert.equal(created.tool.status, "disabled");
    assert.match(created.tool.changeSummary ?? "", /from agent request/);
    assert.equal(created.creation?.status, "registered");
    assert.equal(created.creation?.source, "agent");
    assert.ok(created.runId);
    assert.equal(created.creation?.runId, created.runId);
    assert.equal(created.creation?.packageRef, "generated.test.echo/0.1.0");
    assert.deepEqual(created.creation?.dependencies, []);
    assert.equal(created.creation?.strategy?.kind, "custom-typescript");
    assert.equal(created.creation?.strategy?.behaviorExamples?.length, 1);
    assert.ok(created.creation?.strategy?.candidates.length);

    const result = await service.runToolManually("generated.test.echo", {
      input: { text: "hello package" },
    });
    assert.equal(result.result.ok, true);
    assert.equal(result.result.content, "hello package");

    const records = await service.listToolCreations({ toolName: "generated.test.echo" });
    assert.equal(records.length, 1);
    assert.equal(records[0].status, "registered");
    assert.equal(records[0].runId, created.runId);

    const creationRun = await runs.get(created.runId!);
    assert.equal(creationRun?.status, "completed");
    assert.equal(creationRun?.instanceId, "instance-test");
    assert.equal(creationRun?.requesterUserId, "user-test");
    assert.equal(creationRun?.threadId, "thread-test");
    assert.equal(creationRun?.parentRunId, "run_parent_test");
    const started = creationRun?.events.find((event) => event.type === "tool-creation-started");
    assert.equal((started?.payload as { source?: string } | undefined)?.source, "agent");
    assert.equal((started?.payload as { output?: { runId?: string } } | undefined)?.output?.runId, created.runId);
    assert.ok(creationRun?.events.some((event) => event.type === "tool-creation-started"));
    assert.ok(creationRun?.events.some((event) => event.type === "tool-creation-strategy-selected"));
    assert.ok(creationRun?.events.some((event) => event.type === "tool-creation-package-qa-completed"));
    assert.ok(creationRun?.events.some((event) => event.type === "tool-creation-registered"));
    assert.ok(creationRun?.events.some((event) => event.type === "tool-creation-reloaded"));
    const discovery = creationRun?.events.find((event) => event.type === "tool-creation-discovery-completed");
    const strategy = creationRun?.events.find((event) => event.type === "tool-creation-strategy-selected");
    const authoring = creationRun?.events.find((event) => event.type === "tool-creation-authoring-completed");
    const qaEvent = creationRun?.events.find((event) => event.type === "tool-creation-package-qa-completed");
    const registeredEvent = creationRun?.events.find((event) => event.type === "tool-creation-registered");
    const reloadEvent = creationRun?.events.find((event) => event.type === "tool-creation-reloaded");
    const completedEvent = creationRun?.events.find((event) => event.type === "tool-creation-completed");
    assert.equal(discovery?.parentSpanId, started?.spanId);
    assert.equal(strategy?.parentSpanId, discovery?.spanId);
    assert.equal(authoring?.parentSpanId, strategy?.spanId);
    assert.equal(qaEvent?.parentSpanId, authoring?.spanId);
    assert.equal(registeredEvent?.parentSpanId, qaEvent?.spanId);
    assert.equal(reloadEvent?.parentSpanId, registeredEvent?.spanId);
    assert.equal(completedEvent?.parentSpanId, reloadEvent?.spanId);
    assert.ok((strategy?.payload as { input?: unknown; output?: unknown } | undefined)?.input);
    assert.ok((strategy?.payload as { input?: unknown; output?: unknown } | undefined)?.output);
    assert.equal((qaEvent?.payload as { output?: { ok?: boolean } } | undefined)?.output?.ok, true);
    assert.match(creationRun?.result?.finalAnswer ?? "", /generated\.test\.echo@0\.1\.0/);

    const exported = await service.exportSourceBundle("generated.test.echo");
    assert.equal((exported.manifest as { name: string }).name, "generated.test.echo");
    assert.ok(exported.files.some((file) => file.path === "package.json"));

    const importRoot = `${workspaceRoot}-imported`;
    const previousImportRoot = process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
    process.env.TOOL_PACKAGE_WORKSPACE_ROOT = importRoot;
    const importedMetadata = new InMemoryToolMetadataStore();
    const importedRegistry = new ToolRegistry();
    const importedCreations = new InMemoryToolCreationStore();
    const importedRunner = new SourceBundleHttpProcessToolPackageRunner({
      enabled: true,
      packageRoot: importRoot,
      startupTimeoutMs: 5_000,
      pollIntervalMs: 50,
      callTimeoutMs: 5_000,
    });
    const importService = new ToolsService(
      importedRegistry,
      importedMetadata,
      undefined,
      [importedRunner],
      async () => {
        await loadGeneratedTools(importedRegistry, importedMetadata, process.cwd(), [importedRunner]);
      },
      audit as never,
      importedCreations,
    );
    try {
      const imported = await importService.importSourceBundle(exported);
      assert.equal(imported.tool.name, "generated.test.echo");
      assert.equal(imported.tool.status, "disabled");
      assert.equal(imported.creation?.source, "import");
      assert.equal(imported.creation?.status, "registered");
      assert.equal(imported.creation?.strategy?.kind, "imported-source-bundle");
      const importedRun = await importService.runToolManually("generated.test.echo", {
        input: { text: "hello import" },
      });
      assert.equal(importedRun.result.ok, true);
      assert.equal(importedRun.result.content, "hello import");
    } finally {
      if (previousImportRoot === undefined) delete process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
      else process.env.TOOL_PACKAGE_WORKSPACE_ROOT = previousImportRoot;
      await rm(importRoot, { recursive: true, force: true });
    }
  } finally {
    if (previousRoot === undefined) delete process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
    else process.env.TOOL_PACKAGE_WORKSPACE_ROOT = previousRoot;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ToolsService.createToolPackage stores onboarding credentials as tool-scoped handles", async () => {
  const workspaceRoot = `.tmp-tool-secret-create-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const previousRoot = process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
  process.env.TOOL_PACKAGE_WORKSPACE_ROOT = workspaceRoot;
  const metadata = new InMemoryToolMetadataStore();
  const creations = new InMemoryToolCreationStore();
  const registry = new ToolRegistry();
  const audit = new FakeAudit();
  const secrets = new InMemorySecretHandleStore();
  const service = new ToolsService(
    registry,
    metadata,
    undefined,
    [],
    async () => {},
    audit as never,
    creations,
    undefined,
    undefined,
    secrets,
  );

  try {
    const created = await service.createToolPackage({
      name: "generated.test.secreted",
      version: "0.1.0",
      kind: "echo",
      description: "Echo package with an onboarded credential.",
      request: "Create an echo tool for secret onboarding tests.",
      credentials: {
        apiKey: "live_SERVICE_key_123456789abcdef",
      },
      behaviorExamples: [
        {
          title: "Echo still works with credential metadata",
          input: { text: "hello secret" },
          expectedContent: "hello secret",
        },
      ],
    });

    assert.equal(created.qa.ok, true, JSON.stringify(created.qa, null, 2));
    assert.deepEqual(created.tool.requiredSecretHandles, [
      "secret.tool.generated.test.secreted.api-key",
    ]);
    assert.equal(
      await secrets.resolve?.("secret.tool.generated.test.secreted.api-key"),
      "live_SERVICE_key_123456789abcdef",
    );
    assert.equal(created.creation?.request?.includes("live_SERVICE_key_123456789abcdef"), false);
    assert.ok(
      created.creation?.strategy?.implementationNotes.some((note) =>
        note.includes("secret.tool.generated.test.secreted.api-key"),
      ),
    );
  } finally {
    process.env.TOOL_PACKAGE_WORKSPACE_ROOT = previousRoot;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ToolsService.createToolPackage can build a browser screenshot artifact tool", async () => {
  const workspaceRoot = `.tmp-tool-screenshot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const previousRoot = process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
  process.env.TOOL_PACKAGE_WORKSPACE_ROOT = workspaceRoot;
  const metadata = new InMemoryToolMetadataStore();
  const creations = new InMemoryToolCreationStore();
  const registry = new ToolRegistry();
  const runs = new InMemoryRunStore();
  const audit = new FakeAudit();
  const runner = new SourceBundleHttpProcessToolPackageRunner({
    enabled: true,
    packageRoot: workspaceRoot,
    startupTimeoutMs: 5_000,
    pollIntervalMs: 50,
    callTimeoutMs: 5_000,
  });
  const service = new ToolsService(
    registry,
    metadata,
    undefined,
    [runner],
    async () => {
      await loadGeneratedTools(registry, metadata, process.cwd(), [runner]);
    },
    audit as never,
    creations,
    undefined,
    runs,
  );

  try {
    const created = await service.createToolPackage({
      name: "browser.screenshot",
      version: "0.1.0",
      description: "Captures a URL as a PNG screenshot artifact.",
      request: "Create a browser screenshot tool that opens a web page URL and returns a PNG artifact.",
      capabilities: ["browser-screenshot", "browser-automation", "artifact-image"],
    });

    assert.equal(created.qa.ok, true, JSON.stringify(created.qa, null, 2));
    assert.equal(created.tool.name, "browser.screenshot");
    assert.equal(created.tool.status, "disabled");
    const fullPageDefault = (created.tool.inputSchema as { properties?: Record<string, { default?: unknown }> }).properties?.fullPage?.default;
    assert.equal(fullPageDefault, false);
    assert.ok((created.tool.inputSchema as { properties?: Record<string, unknown> }).properties?.focusText);
    assert.ok((created.tool.inputSchema as { properties?: Record<string, unknown> }).properties?.selector);
    assert.equal(created.creation?.status, "registered");
    assert.equal(created.creation?.strategy?.kind, "browser-automation");
    assert.deepEqual(created.creation?.dependencies, [
      { name: "playwright-core", versionRange: "^1.56.1" },
    ]);
    assert.ok(created.package.files.some((file) => file.endsWith("browser-screenshotTool.ts")));
    const screenshotSourcePath = created.package.files.find((file) => file.endsWith("browser-screenshotTool.ts"));
    assert.ok(screenshotSourcePath);
    const screenshotSource = await readFile(screenshotSourcePath, "utf8");
    assert.match(screenshotSource, /page\.frames\(\)/);
    assert.match(screenshotSource, /getByRole\("button", \{ name: label \}\)/);
    assert.match(screenshotSource, /принять\|принять все/);
    assert.match(screenshotSource, /отклонить\|отклонить все/);

    const invalid = await service.runToolManually("browser.screenshot", {
      input: { url: "file:///tmp/nope.html" },
    });
    assert.equal(invalid.result.ok, false);
    assert.match(invalid.result.content, /http or https/);

    const creationRun = await runs.get(created.runId!);
    assert.equal(creationRun?.status, "completed");
    assert.ok(creationRun?.events.some((event) => event.type === "tool-creation-completed"));
  } finally {
    if (previousRoot === undefined) delete process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
    else process.env.TOOL_PACKAGE_WORKSPACE_ROOT = previousRoot;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
