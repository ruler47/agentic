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
import { ToolVersionLifecycleService } from "../src/server/modules/tools/tool-version-lifecycle.service.js";
import {
  loadGeneratedTools,
  MissingToolRuntimeRequirementsError,
  SourceBundleHttpProcessToolPackageRunner,
} from "../src/tools/toolPackageRunner.js";
import type { Tool } from "../src/tools/tool.js";
import type { AgentEvent } from "../src/types.js";

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

test("ToolVersionLifecycleService accepts completed run-scoped candidate evidence for operator activation", async () => {
  const metadata = new InMemoryToolMetadataStore();
  const runs = new InMemoryRunStore();
  const audit = new FakeAudit();
  const name = "generated.test.candidate-review";
  await metadata.registerGenerated({
    name,
    version: "0.1.0",
    description: "Active baseline.",
    capabilities: ["candidate-review"],
  });
  await metadata.markAvailable(name, "0.1.0");
  await metadata.registerGenerated({
    name,
    version: "0.1.1",
    description: "Run scoped candidate.",
    capabilities: ["candidate-review"],
  });

  const lifecycle = new ToolVersionLifecycleService(
    undefined,
    metadata,
    undefined,
    audit as never,
    undefined,
    runs,
  );
  await assert.rejects(
    () => lifecycle.activateVersion(name, { version: "0.1.1" }),
    /complete a run-scoped candidate run/i,
  );

  const run = await runs.create("Exercise a scoped candidate");
  await runs.markRunning(run.id);
  const timestamp = new Date().toISOString();
  const event: AgentEvent = {
    id: "event_candidate_review",
    spanId: `${run.id}:candidate-review`,
    type: "tool-candidate-manual-review-required",
    actor: name,
    activity: "tool",
    status: "completed",
    title: "Run-scoped tool candidate needs manual review",
    detail: `${name}@0.1.1 completed the run but requires operator promotion.`,
    timestamp,
    completedAt: timestamp,
    payload: {
      toolName: name,
      toolVersion: "0.1.1",
      replacesVersion: "0.1.0",
      promotionPolicy: "manual",
      input: { text: "candidate input" },
      output: { accepted: false, promotionPolicy: "manual" },
    },
  };
  await runs.appendEvent(run.id, event);
  await runs.complete(run.id, {
    finalAnswer: "Candidate version produced the expected answer.",
    complexity: { mode: "direct", reason: "test", domains: [], riskLevel: "low" },
    subtasks: [],
    workerResults: [],
    reviews: [],
  });

  const activated = await lifecycle.activateVersion(name, { version: "0.1.1" });
  assert.equal(activated.version, "0.1.1");
  assert.equal(
    (await metadata.listVersions(name)).find((version) => version.version === "0.1.1")?.status,
    "available",
  );
  const activationAudit = audit.events.find((eventRecord) =>
    eventRecord.action === "tool.version_activated" && eventRecord.targetId === `${name}@0.1.1`);
  const metadataRecord = activationAudit?.metadata as { activationEvidenceType?: string } | undefined;
  assert.equal(metadataRecord?.activationEvidenceType, "run-scoped-candidate-run");
});

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

test("ToolsService.createToolVersion creates a QA'd edited version with trace history", async () => {
  const workspaceRoot = `.tmp-tool-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
      name: "generated.test.editable",
      version: "0.1.0",
      description: "Editable echo package.",
      request: "Create an echo tool for edit tests.",
      capabilities: ["test-editable"],
      behaviorExamples: [
        {
          title: "Echo returns submitted text",
          input: { text: "before edit" },
          expectedContent: "before edit",
        },
      ],
    });
    assert.equal(created.tool.version, "0.1.0");

    const edited = await service.createToolVersion("generated.test.editable", {
      source: "agent",
      sourceRunId: "run_parent_edit_test",
      instanceId: "instance-test",
      requesterUserId: "user-test",
      threadId: "thread-test",
      baseVersion: "0.1.0",
      version: "0.1.1",
      customLabel: "experiment 1",
      changeDescription: "Description-only edit experiment",
      request: "Keep echo behavior and update the package description for a versioned edit.",
      description: "Edited echo package.",
      kind: "echo",
      docsUrls: ["https://example.test/docs"],
      documentation: ["# Extra edit docs\n\nThe edited version must preserve echo behavior."],
      behaviorExamples: [
        {
          title: "Edited version still echoes submitted text",
          input: { text: "after edit" },
          expectedContent: "after edit",
        },
      ],
    });

    assert.equal(edited.qa.ok, true, JSON.stringify(edited.qa, null, 2));
    assert.equal(edited.tool.name, "generated.test.editable");
    assert.equal(edited.tool.version, "0.1.1");
    assert.equal(edited.tool.status, "disabled");
    assert.equal(edited.tool.versions, undefined);
    assert.equal(edited.creation?.status, "registered");
    assert.equal(edited.creation?.source, "agent");
    assert.equal(edited.creation?.kind, "echo-edit");
    assert.match(edited.creation?.request ?? "", /Edit generated\.test\.editable@0\.1\.0/);
    assert.match(edited.creation?.request ?? "", /Custom label: experiment 1/);
    assert.match(edited.creation?.request ?? "", /Preserve inherited package context/);
    assert.ok(edited.creation?.strategy?.implementationNotes.some((note) => note.includes("Agent change request")));
    assert.ok(edited.creation?.strategy?.implementationNotes.some((note) => note.includes("Operator custom label: experiment 1")));
    assert.equal(edited.creation?.strategy?.behaviorExamples?.length, 1);
    assert.ok(edited.runId);
    assert.equal(edited.creation?.runId, edited.runId);
    assert.equal(edited.package.packageRef, "generated.test.editable/0.1.1");

    const versions = await service.listVersions("generated.test.editable");
    assert.deepEqual(versions.map((version) => version.version), ["0.1.1", "0.1.0"]);
    assert.equal(versions.find((version) => version.version === "0.1.1")?.active, false);
    assert.match(versions.find((version) => version.version === "0.1.1")?.changeSummary ?? "", /\[experiment 1\]/);
    assert.equal(versions.find((version) => version.version === "0.1.0")?.active, true);

    const activeBeforePromotion = await service.runToolManually("generated.test.editable", {
      input: { text: "active original" },
    });
    assert.equal(activeBeforePromotion.tool.version, "0.1.0");
    assert.equal(activeBeforePromotion.result.ok, true);
    assert.equal(activeBeforePromotion.result.content, "active original");

    await assert.rejects(
      () => service.activateVersion("generated.test.editable", { version: "0.1.1" }),
      /run this exact version manually/i,
    );

    const pinnedCandidate = await service.runToolVersionManually("generated.test.editable", "0.1.1", {
      input: { text: "pinned candidate" },
    });
    assert.equal(pinnedCandidate.tool.version, "0.1.1");
    assert.equal(pinnedCandidate.tool.active, false);
    assert.equal(pinnedCandidate.result.ok, true);
    assert.equal(pinnedCandidate.result.content, "pinned candidate");
    assert.equal(
      (await service.listVersions("generated.test.editable"))
        .find((version) => version.version === "0.1.0")?.active,
      true,
    );
    const evidenceAfterPinnedRun = (await service.listVersions("generated.test.editable"))
      .find((version) => version.version === "0.1.1")?.manualRunEvidence;
    assert.equal(evidenceAfterPinnedRun?.successCount, 1);
    assert.ok(evidenceAfterPinnedRun?.latestSuccess);
    const lifecycleAfterPinnedRun = (await service.listVersions("generated.test.editable"))
      .find((version) => version.version === "0.1.1")?.lifecycleEvents ?? [];
    assert.ok(lifecycleAfterPinnedRun.some((event) => event.type === "created" && event.traceRunId === edited.runId));
    assert.ok(lifecycleAfterPinnedRun.some((event) => event.type === "manual_run" && event.status === "success"));

    await service.activateVersion("generated.test.editable", { version: "0.1.1" });
    assert.equal(
      (await service.listVersions("generated.test.editable"))
        .find((version) => version.version === "0.1.1")?.status,
      "available",
    );
    const result = await service.runToolManually("generated.test.editable", {
      input: { text: "after edit" },
    });
    assert.equal(result.tool.version, "0.1.1");
    assert.equal(result.result.ok, true);
    assert.equal(result.result.content, "after edit");
    const lifecycleAfterActivation = (await service.listVersions("generated.test.editable"))
      .find((version) => version.version === "0.1.1")?.lifecycleEvents ?? [];
    assert.ok(lifecycleAfterActivation.some((event) => event.type === "activated" && event.status === "success"));

    const rejectedEdit = await service.createToolVersion("generated.test.editable", {
      source: "operator",
      version: "0.1.2",
      request: "Create a deliberately rejected candidate for lifecycle review.",
      description: "Rejected echo package.",
      kind: "echo",
      behaviorExamples: [
        {
          title: "Rejected version still echoes submitted text",
          input: { text: "reject me" },
          expectedContent: "reject me",
        },
      ],
    });
    await service.rejectVersion(
      "generated.test.editable",
      "0.1.2",
      { reason: "Candidate does not satisfy review expectations." },
    );
    const rejectedVersion = (await service.listVersions("generated.test.editable"))
      .find((version) => version.version === "0.1.2");
    assert.equal(rejectedVersion?.reviewStatus, "rejected");
    assert.ok(rejectedVersion?.lifecycleEvents?.some((event) => event.type === "rejected"));
    await assert.rejects(
      () => service.activateVersion("generated.test.editable", { version: "0.1.2" }),
      /candidate version was rejected/i,
    );
    await assert.rejects(
      () => service.loadToolVersionForAgent("generated.test.editable", "0.1.2"),
      /candidate version was rejected/i,
    );
    const rejectedRun = await runs.get(rejectedEdit.runId!);
    const rejectedLifecycle = rejectedRun?.events.find((event) => event.type === "tool-version-rejected");
    assert.equal(rejectedLifecycle?.parentSpanId, `${rejectedEdit.runId}:tool-creation`);
    assert.equal((rejectedLifecycle?.payload as { output?: { rejected?: boolean } } | undefined)?.output?.rejected, true);

    const editRun = await runs.get(edited.runId!);
    assert.equal(editRun?.status, "completed");
    assert.equal(editRun?.instanceId, "instance-test");
    assert.equal(editRun?.requesterUserId, "user-test");
    assert.equal(editRun?.threadId, "thread-test");
    assert.equal(editRun?.parentRunId, "run_parent_edit_test");
    const editStarted = editRun?.events.find((event) => event.type === "tool-creation-started");
    assert.equal((editStarted?.payload as { source?: string } | undefined)?.source, "agent");
    assert.ok(editRun?.events.some((event) => event.type === "tool-creation-started"));
    assert.ok(editRun?.events.some((event) => event.type === "tool-creation-reloaded"));
    assert.ok(editRun?.events.some((event) => event.title === "Tool edit completed"));
    const editDiscovery = editRun?.events.find((event) => event.type === "tool-creation-discovery-completed");
    const editStrategy = editRun?.events.find((event) => event.type === "tool-creation-strategy-selected");
    const editAuthoring = editRun?.events.find((event) => event.type === "tool-creation-authoring-completed");
    const editQa = editRun?.events.find((event) => event.type === "tool-creation-package-qa-completed");
    const editRegistered = editRun?.events.find((event) => event.type === "tool-creation-registered");
    const editReload = editRun?.events.find((event) => event.type === "tool-creation-reloaded");
    const editCompleted = editRun?.events.find((event) => event.type === "tool-creation-completed");
    const manualRunLifecycle = editRun?.events.find((event) => event.type === "tool-version-manual-run");
    const activatedLifecycle = editRun?.events.find((event) => event.type === "tool-version-activated");
    assert.equal(editDiscovery?.parentSpanId, editStarted?.spanId);
    assert.equal(editStrategy?.parentSpanId, editDiscovery?.spanId);
    assert.equal(editAuthoring?.parentSpanId, editStrategy?.spanId);
    assert.equal(editQa?.parentSpanId, editAuthoring?.spanId);
    assert.equal(editRegistered?.parentSpanId, editQa?.spanId);
    assert.equal(editReload?.parentSpanId, editRegistered?.spanId);
    assert.equal(editCompleted?.parentSpanId, editReload?.spanId);
    assert.equal((editRegistered?.payload as { output?: { toolVersion?: string } } | undefined)?.output?.toolVersion, "0.1.1");
    assert.equal(manualRunLifecycle?.parentSpanId, editStarted?.spanId);
    assert.equal(activatedLifecycle?.parentSpanId, editStarted?.spanId);
    assert.equal((manualRunLifecycle?.payload as { output?: { ok?: boolean } } | undefined)?.output?.ok, true);
    assert.equal((activatedLifecycle?.payload as { output?: { toolVersion?: string } } | undefined)?.output?.toolVersion, "0.1.1");
    assert.match(editRun?.result?.finalAnswer ?? "", /generated\.test\.editable@0\.1\.1/);

    await service.deleteVersion("generated.test.editable", "0.1.0");
    const initialRun = await runs.get(created.runId!);
    const deletedLifecycle = initialRun?.events.find((event) => event.type === "tool-version-deleted");
    assert.equal(deletedLifecycle?.parentSpanId, `${created.runId}:tool-creation`);
    assert.equal((deletedLifecycle?.payload as { output?: { deleted?: boolean } } | undefined)?.output?.deleted, true);

    const versionCreatedAudit = audit.events.find((event) =>
      (event as { action?: string }).action === "tool.version_created"
    );
    assert.ok(versionCreatedAudit);
    const pinnedRunAudit = audit.events.find((event) =>
      (event as { targetId?: string }).targetId === "generated.test.editable@0.1.1"
    );
    assert.ok(pinnedRunAudit);
  } finally {
    if (previousRoot === undefined) delete process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
    else process.env.TOOL_PACKAGE_WORKSPACE_ROOT = previousRoot;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ToolsService.createToolPackage can mark a generated tool available after successful QA", async () => {
  const workspaceRoot = `.tmp-tool-auto-available-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
      name: "generated.test.auto.available",
      version: "0.1.0",
      description: "Auto-available echo package.",
      request: "Create an echo tool for agent availability tests.",
      capabilities: ["test-echo"],
      activationPolicy: "available_on_success",
      behaviorExamples: [
        {
          title: "Echo returns submitted text",
          input: { text: "auto available" },
          expectedContent: "auto available",
        },
      ],
    });

    assert.equal(created.qa.ok, true, JSON.stringify(created.qa, null, 2));
    assert.equal(created.tool.name, "generated.test.auto.available");
    assert.equal(created.tool.status, "available");
    assert.equal(
      (await metadata.list()).find((tool) => tool.name === "generated.test.auto.available")?.status,
      "available",
    );
    const creationRun = await runs.get(created.runId!);
    assert.equal(
      creationRun?.events.some((event) => event.type === "tool-version-marked-available"),
      true,
    );
  } finally {
    if (previousRoot === undefined) delete process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
    else process.env.TOOL_PACKAGE_WORKSPACE_ROOT = previousRoot;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ToolsService.createToolPackage builds an OpenAPI client and proves it with chained behavior QA", async () => {
  const api = createWidgetApiServer();
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const workspaceRoot = `.tmp-tool-openapi-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
    const openApiSpec = widgetOpenApiSpec(baseUrl);
    const created = await service.createToolPackage({
      source: "operator",
      name: "widgets.api",
      version: "0.1.0",
      description: "Widget API client generated from OpenAPI docs.",
      request: "Create a portable API tool from this OpenAPI documentation. It must create a widget and read it back by id.",
      openApiSpec,
    });

    assert.equal(created.qa.ok, true, JSON.stringify(created.qa, null, 2));
    assert.match(created.qa.summary, /behavior QA/);
    assert.ok(created.qa.checks.some((check) => check.includes("package behavior scenario step passed")));
    assert.ok(created.qa.checks.some((check) => check.includes("package behavior scenario passed")));
    assert.equal(created.tool.name, "widgets.api");
    assert.equal(created.tool.status, "disabled");
    assert.equal(created.creation?.status, "registered");
    assert.equal(created.creation?.strategy?.kind, "external-api");
    assert.equal(created.creation?.strategy?.integrationContract?.mode, "run-on-demand");
    assert.equal(created.creation?.strategy?.behaviorExamples?.[0]?.steps?.length, 2);
    assert.equal(created.creation?.strategy?.discoveryEvidence?.some((item) => item.provider === "openapi"), true);

    const createRun = await service.runToolManually("widgets.api", {
      input: {
        operationId: "createWidget",
        baseUrl,
        body: { name: "Beta" },
      },
    });
    assert.equal(createRun.result.ok, true);
    assert.equal((createRun.result.data as { id?: string }).id, "widget-2");

    const readRun = await service.runToolManually("widgets.api", {
      input: {
        operationId: "getWidget",
        baseUrl,
        pathParams: { id: "widget-2" },
      },
    });
    assert.equal(readRun.result.ok, true);
    assert.match(readRun.result.content, /Beta/);

    const creationRun = await runs.get(created.runId!);
    const qaEvent = creationRun?.events.find((event) => event.type === "tool-creation-package-qa-completed");
    assert.equal((qaEvent?.payload as { output?: { ok?: boolean } } | undefined)?.output?.ok, true);
    assert.equal(
      ((qaEvent?.payload as { output?: { checks?: string[] } } | undefined)?.output?.checks ?? [])
        .some((check) => check.includes("OpenAPI scenario POST /widgets -> GET /widgets/{id}")),
      true,
    );
  } finally {
    if (previousRoot === undefined) delete process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
    else process.env.TOOL_PACKAGE_WORKSPACE_ROOT = previousRoot;
    await rm(workspaceRoot, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  }
});

test("ToolsService.createToolPackage can use guarded LLM-authored package snapshots", async () => {
  const workspaceRoot = `.tmp-tool-author-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const previousRoot = process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
  process.env.TOOL_PACKAGE_WORKSPACE_ROOT = workspaceRoot;
  const metadata = new InMemoryToolMetadataStore();
  const creations = new InMemoryToolCreationStore();
  const registry = new ToolRegistry();
  const audit = new FakeAudit();
  const runner = new SourceBundleHttpProcessToolPackageRunner({
    enabled: true,
    packageRoot: workspaceRoot,
    startupTimeoutMs: 5_000,
    pollIntervalMs: 50,
    callTimeoutMs: 5_000,
  });
  const fakeLlm = {
    async complete() {
      return JSON.stringify(authoredUppercasePackage());
    },
  };
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
    fakeLlm as never,
  );

  try {
    const created = await service.createToolPackage({
      name: "generated.test.authored",
      version: "0.1.0",
      description: "Authored package test.",
      request: "Create a tool that uppercases text.",
      capabilities: ["test-authored"],
      authoringMode: "llm",
    });

    assert.equal(created.qa.ok, true, JSON.stringify(created.qa, null, 2));
    assert.equal(created.creation?.strategy?.implementationNotes.some((note) => note.includes("LLM authored")), true);
    const result = await service.runToolManually("generated.test.authored", {
      input: { text: "hello authored" },
    });
    assert.equal(result.result.ok, true);
    assert.equal(result.result.content, "HELLO AUTHORED");
  } finally {
    if (previousRoot === undefined) delete process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
    else process.env.TOOL_PACKAGE_WORKSPACE_ROOT = previousRoot;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
