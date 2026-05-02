import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { readFile } from "node:fs/promises";
import { ArtifactStore } from "../artifacts/artifactStore.js";
import { UniversalAgent } from "../agents/universalAgent.js";
import { SkillMemoryStore } from "../memory/skillMemory.js";
import { RunStore } from "../runs/types.js";
import { ModelTierSettingsStore } from "../settings/modelTierSettings.js";
import { ToolSchema, ToolStartupMode } from "../tools/tool.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolBuildRequestStore } from "../tools/toolBuildRequestStore.js";
import { ToolBuildWorkflow } from "../tools/toolBuildWorkflow.js";
import { ToolMetadataStore, toolToMetadata } from "../tools/toolMetadataStore.js";
import { AgentArtifact, ArtifactUploadInput } from "../types.js";

export type WebAppOptions = {
  agent: UniversalAgent;
  runStore: RunStore;
  publicDir: string;
  skillMemory?: SkillMemoryStore;
  toolRegistry?: Pick<ToolRegistry, "list">;
  toolMetadataStore?: ToolMetadataStore;
  toolBuildRequestStore?: ToolBuildRequestStore;
  toolBuildWorkflow?: ToolBuildWorkflow;
  reloadGeneratedTools?: () => Promise<void>;
  modelTierSettings?: ModelTierSettingsStore;
  artifactStore?: ArtifactStore;
};

export function createWebApp(options: WebAppOptions) {
  return createServer(async (request, response) => {
    try {
      await routeRequest(request, response, options);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Unknown server error",
      });
    }
  });
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WebAppOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/runs") {
    sendJson(response, 200, { runs: await options.runStore.list() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/memories") {
    sendJson(response, 200, { memories: options.skillMemory ? await options.skillMemory.list() : [] });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tools") {
    const tools = options.toolRegistry?.list() ?? [];
    const metadata = options.toolMetadataStore
      ? await options.toolMetadataStore.list()
      : tools.map((tool) => toolToMetadata(tool));

    sendJson(response, 200, {
      tools: metadata,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/generated-modules") {
    if (!options.toolMetadataStore) {
      sendJson(response, 503, { error: "Tool metadata store is not configured" });
      return;
    }

    try {
      const input = parseGeneratedToolModuleInput(await readJsonBody<unknown>(request));
      sendJson(response, 201, { tool: await options.toolMetadataStore.registerGenerated(input) });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid generated tool module",
      });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tools/health") {
    const tools = options.toolRegistry?.list() ?? [];
    const health = await Promise.all(
      tools.map(async (tool) => {
        const result = tool.healthcheck
          ? await tool.healthcheck()
          : { ok: true, detail: "No healthcheck registered." };
        await options.toolMetadataStore?.updateHealth(tool.name, result);
        return { name: tool.name, ...result };
      }),
    );

    sendJson(response, 200, { tools: health });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tool-build-requests") {
    sendJson(response, 200, {
      requests: options.toolBuildRequestStore ? await options.toolBuildRequestStore.list() : [],
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tool-build-requests") {
    if (!options.toolBuildRequestStore) {
      sendJson(response, 503, { error: "Tool build request store is not configured" });
      return;
    }

    try {
      const requestInput = parseToolBuildRequestInput(await readJsonBody<unknown>(request));
      sendJson(response, 201, { request: await options.toolBuildRequestStore.create(requestInput) });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid tool build request",
      });
    }
    return;
  }

  const toolBuildRequestMatch = url.pathname.match(/^\/api\/tool-build-requests\/([^/]+)$/);
  if (request.method === "GET" && toolBuildRequestMatch) {
    if (!options.toolBuildRequestStore) {
      sendJson(response, 503, { error: "Tool build request store is not configured" });
      return;
    }

    const buildRequest = await options.toolBuildRequestStore.get(
      decodeURIComponent(toolBuildRequestMatch[1] ?? ""),
    );
    if (!buildRequest) {
      sendJson(response, 404, { error: "Tool build request not found" });
      return;
    }

    sendJson(response, 200, { request: buildRequest });
    return;
  }

  if (request.method === "PATCH" && toolBuildRequestMatch) {
    if (!options.toolBuildRequestStore) {
      sendJson(response, 503, { error: "Tool build request store is not configured" });
      return;
    }

    try {
      const update = parseToolBuildRequestStatusUpdate(await readJsonBody<unknown>(request));
      const buildRequest = await options.toolBuildRequestStore.updateStatus(
        decodeURIComponent(toolBuildRequestMatch[1] ?? ""),
        update,
      );
      sendJson(response, 200, { request: buildRequest });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid tool build request update";
      sendJson(response, message.includes("was not found") ? 404 : 400, { error: message });
    }
    return;
  }

  const toolBuildRunMatch = url.pathname.match(/^\/api\/tool-build-requests\/([^/]+)\/run$/);
  if (request.method === "POST" && toolBuildRunMatch) {
    if (!options.toolBuildWorkflow) {
      sendJson(response, 503, { error: "Tool build workflow is not configured" });
      return;
    }

    const result = await options.toolBuildWorkflow.runOnce(
      decodeURIComponent(toolBuildRunMatch[1] ?? ""),
    );
    if (result.request.status === "registered") {
      await options.reloadGeneratedTools?.();
    }
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/settings/model-tiers") {
    sendJson(response, 200, {
      tiers: options.modelTierSettings ? await options.modelTierSettings.list() : [],
    });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/settings/model-tiers") {
    if (!options.modelTierSettings) {
      sendJson(response, 503, { error: "Model tier settings are not configured" });
      return;
    }

    const body = await readJsonBody<{ tiers?: unknown }>(request);
    if (!Array.isArray(body.tiers)) {
      sendJson(response, 400, { error: "tiers must be an array" });
      return;
    }

    let parsedTiers;
    try {
      parsedTiers = body.tiers.map((item) => parseTierSettingsInput(item));
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid model tier settings",
      });
      return;
    }

    const tiers = await options.modelTierSettings.replace(parsedTiers);
    sendJson(response, 200, { tiers });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/runs") {
    const body = await readJsonBody<{ task?: unknown; attachments?: unknown }>(request);
    const task = typeof body.task === "string" ? body.task.trim() : "";

    if (!task) {
      sendJson(response, 400, { error: "Task is required" });
      return;
    }

    const run = await options.runStore.create(task);
    let inputArtifacts: AgentArtifact[] = [];
    try {
      inputArtifacts = options.artifactStore
        ? await Promise.all(
            parseAttachmentInputs(body.attachments).map((attachment) =>
              options.artifactStore!.saveUpload(run.id, attachment),
            ),
          )
        : [];
    } catch (error) {
      await options.runStore.fail(
        run.id,
        error instanceof Error ? error.message : "Failed to save attachments",
      );
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Failed to save attachments",
      });
      return;
    }

    void executeRun(run.id, task, options, inputArtifacts);
    sendJson(response, 202, { run: await options.runStore.get(run.id) });
    return;
  }

  const runEventsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (request.method === "GET" && runEventsMatch) {
    await streamRunEvents(request, response, options, decodeURIComponent(runEventsMatch[1] ?? ""));
    return;
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (request.method === "GET" && runMatch) {
    const run = await options.runStore.get(runMatch[1] ?? "");

    if (!run) {
      sendJson(response, 404, { error: "Run not found" });
      return;
    }

    sendJson(response, 200, { run });
    return;
  }

  const artifactMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)$/);
  if (request.method === "GET" && artifactMatch) {
    if (!options.artifactStore) {
      sendJson(response, 503, { error: "Artifact store is not configured" });
      return;
    }

    const stored = await options.artifactStore.read(
      decodeURIComponent(artifactMatch[1] ?? ""),
      decodeURIComponent(artifactMatch[2] ?? ""),
    );
    if (!stored) {
      sendJson(response, 404, { error: "Artifact not found" });
      return;
    }

    response.writeHead(200, {
      "content-type": stored.artifact.mimeType,
      "content-length": String(stored.artifact.sizeBytes),
      "content-disposition": `inline; filename="${stored.artifact.filename.replace(/"/g, "")}"`,
      "cache-control": "no-store",
    });
    response.end(await readFile(stored.path));
    return;
  }

  if (request.method === "GET") {
    await serveStatic(url.pathname, response, options.publicDir);
    return;
  }

  sendJson(response, 405, { error: "Method not allowed" });
}

async function streamRunEvents(
  request: IncomingMessage,
  response: ServerResponse,
  options: WebAppOptions,
  id: string,
): Promise<void> {
  const initialRun = await options.runStore.get(id);
  if (!initialRun) {
    sendJson(response, 404, { error: "Run not found" });
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  let closed = false;
  let lastSignature = "";
  let pollTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;

  const close = () => {
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  };

  const writeRun = async () => {
    if (closed) return;

    const run = await options.runStore.get(id);
    if (!run) {
      response.write(`event: error\ndata: ${JSON.stringify({ error: "Run not found" })}\n\n`);
      close();
      response.end();
      return;
    }

    const signature = runStreamSignature(run);
    if (signature === lastSignature) return;

    lastSignature = signature;
    response.write(`event: run\ndata: ${JSON.stringify({ run })}\n\n`);

    if (run.status === "completed" || run.status === "failed") {
      close();
      response.end();
    }
  };

  pollTimer = setInterval(() => {
    void writeRun().catch((error) => {
      if (closed) return;
      response.write(
        `event: error\ndata: ${JSON.stringify({
          error: error instanceof Error ? error.message : "Run stream failed",
        })}\n\n`,
      );
      close();
      response.end();
    });
  }, 650);

  heartbeatTimer = setInterval(() => {
    if (!closed) response.write(": heartbeat\n\n");
  }, 15000);

  request.on("close", close);
  await writeRun();
}

function runStreamSignature(run: {
  status: string;
  updatedAt: string;
  events: unknown[];
  result?: unknown;
  error?: string;
}) {
  return [
    run.status,
    run.updatedAt,
    run.events.length,
    run.result ? "result" : "",
    run.error ?? "",
  ].join(":");
}

async function executeRun(
  id: string,
  task: string,
  options: WebAppOptions,
  inputArtifacts: AgentArtifact[] = [],
): Promise<void> {
  await options.runStore.markRunning(id);

  try {
    const result = await options.agent.run(task, {
      inputArtifacts,
      saveArtifact: options.artifactStore
        ? (artifact) => options.artifactStore!.saveGenerated(id, artifact)
        : undefined,
      requestToolBuild: options.toolBuildRequestStore
        ? async (request) => {
            const buildRequest = await options.toolBuildRequestStore!.create({ ...request, sourceRunId: id });
            if (!options.toolBuildWorkflow) return buildRequest;

            const result = await options.toolBuildWorkflow.runOnce(buildRequest.id);
            if (result.request.status === "registered") {
              await options.reloadGeneratedTools?.();
            }
            return result.request;
          }
        : undefined,
      onEvent: (event) => {
        return options.runStore.appendEvent(id, event);
      },
    });
    await options.runStore.complete(id, result);
  } catch (error) {
    await options.runStore.fail(id, error instanceof Error ? error.message : "Unknown run error");
  }
}

function parseAttachmentInputs(value: unknown): ArtifactUploadInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("attachments must be an array");
  }

  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("attachments must contain objects");
    }

    const candidate = item as Record<string, unknown>;
    if (typeof candidate.filename !== "string" || candidate.filename.trim() === "") {
      throw new Error("attachment filename is required");
    }
    if (typeof candidate.contentBase64 !== "string" || candidate.contentBase64.trim() === "") {
      throw new Error("attachment contentBase64 is required");
    }

    return {
      filename: candidate.filename,
      mimeType: typeof candidate.mimeType === "string" ? candidate.mimeType : undefined,
      contentBase64: candidate.contentBase64,
      description: typeof candidate.description === "string" ? candidate.description : undefined,
    };
  });
}

function parseToolBuildRequestInput(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("tool build request must be an object");
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.capability !== "string" || candidate.capability.trim() === "") {
    throw new Error("capability is required");
  }
  if (typeof candidate.reason !== "string" || candidate.reason.trim() === "") {
    throw new Error("reason is required");
  }

  return {
    capability: candidate.capability.trim(),
    reason: candidate.reason.trim(),
    sourceRunId: typeof candidate.sourceRunId === "string" ? candidate.sourceRunId : undefined,
    sourceSpanId: typeof candidate.sourceSpanId === "string" ? candidate.sourceSpanId : undefined,
    taskSummary: typeof candidate.taskSummary === "string" ? candidate.taskSummary : undefined,
    desiredToolName: typeof candidate.desiredToolName === "string" ? candidate.desiredToolName : undefined,
    requiredInputs: parseOptionalStringArray(candidate.requiredInputs, "requiredInputs"),
    requiredOutputs: parseOptionalStringArray(candidate.requiredOutputs, "requiredOutputs"),
    qaCriteria: parseOptionalStringArray(candidate.qaCriteria, "qaCriteria"),
  };
}

function parseToolBuildRequestStatusUpdate(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("tool build request update must be an object");
  }

  const candidate = value as Record<string, unknown>;
  const status = String(candidate.status ?? "");
  if (!["requested", "building", "qa_failed", "qa_passed", "registered", "blocked"].includes(status)) {
    throw new Error("status is invalid");
  }

  return {
    status: status as "requested" | "building" | "qa_failed" | "qa_passed" | "registered" | "blocked",
    statusDetail: typeof candidate.statusDetail === "string" ? candidate.statusDetail.trim() : undefined,
    registeredToolName:
      typeof candidate.registeredToolName === "string" ? candidate.registeredToolName.trim() : undefined,
    qaReport: parseOptionalQaReport(candidate.qaReport),
  };
}

function parseOptionalQaReport(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("qaReport must be an object");
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.ok !== "boolean") {
    throw new Error("qaReport.ok must be a boolean");
  }
  if (typeof candidate.summary !== "string" || candidate.summary.trim() === "") {
    throw new Error("qaReport.summary is required");
  }

  return {
    ok: candidate.ok,
    summary: candidate.summary.trim(),
    checks: parseRequiredStringArray(candidate.checks, "qaReport.checks"),
    artifacts: parseOptionalStringArray(candidate.artifacts, "qaReport.artifacts"),
  };
}

function parseGeneratedToolModuleInput(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("generated tool module must be an object");
  }

  const candidate = value as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const version = typeof candidate.version === "string" ? candidate.version.trim() : "";
  const description = typeof candidate.description === "string" ? candidate.description.trim() : "";
  if (!/^[a-z][a-z0-9.-]{1,80}$/i.test(name)) {
    throw new Error("name must be a stable tool id such as generated.browser.screenshot");
  }
  if (!version) throw new Error("version is required");
  if (!description) throw new Error("description is required");

  return {
    name,
    version,
    description,
    capabilities: parseRequiredStringArray(candidate.capabilities, "capabilities"),
    startupMode: parseStartupMode(candidate.startupMode),
    inputSchema: parseOptionalToolSchema(candidate.inputSchema, "inputSchema"),
    outputSchema: parseOptionalToolSchema(candidate.outputSchema, "outputSchema"),
    modulePath: parseRequiredPath(candidate.modulePath, "modulePath"),
    testPath: parseOptionalPath(candidate.testPath, "testPath"),
  };
}

function parseRequiredPath(value: unknown, name: string): string {
  const parsed = parseOptionalPath(value, name);
  if (!parsed) throw new Error(`${name} is required`);
  return parsed;
}

function parseOptionalPath(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.includes("..") || trimmed.startsWith("/") || trimmed.includes("\\")) {
    throw new Error(`${name} must be a relative project path`);
  }
  return trimmed;
}

function parseRequiredStringArray(value: unknown, name: string): string[] {
  const parsed = parseOptionalStringArray(value, name);
  if (!parsed?.length) throw new Error(`${name} must contain at least one value`);
  return parsed;
}

function parseStartupMode(value: unknown): ToolStartupMode | undefined {
  if (value === undefined) return undefined;
  if (value === "always-on" || value === "on-demand" || value === "ephemeral") return value;
  throw new Error("startupMode is invalid");
}

function parseOptionalToolSchema(value: unknown, name: string): ToolSchema | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "object" || !candidate.properties || typeof candidate.properties !== "object") {
    throw new Error(`${name} must be a ToolSchema object`);
  }

  return candidate as ToolSchema;
}

function parseOptionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item) => String(item).trim()).filter(Boolean);
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return {} as T;

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

async function serveStatic(pathname: string, response: ServerResponse, publicDir: string): Promise<void> {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentType(filePath),
      "cache-control": "no-store",
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function parseTierSettingsInput(item: unknown) {
  if (!item || typeof item !== "object") {
    throw new Error("Invalid tier settings item");
  }

  const candidate = item as {
    tier?: unknown;
    models?: unknown;
    maxAttempts?: unknown;
    escalateOnFailure?: unknown;
  };

  if (!["S", "M", "L", "XL"].includes(String(candidate.tier))) {
    throw new Error("Invalid model tier");
  }

  if (!Array.isArray(candidate.models)) {
    throw new Error("models must be an array");
  }

  return {
    tier: candidate.tier as "S" | "M" | "L" | "XL",
    models: candidate.models.map((model) => String(model)),
    maxAttempts:
      typeof candidate.maxAttempts === "number" ? candidate.maxAttempts : undefined,
    escalateOnFailure:
      typeof candidate.escalateOnFailure === "boolean"
        ? candidate.escalateOnFailure
        : undefined,
  };
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
