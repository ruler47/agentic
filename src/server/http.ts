import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { readFile } from "node:fs/promises";
import { UniversalAgent } from "../agents/universalAgent.js";
import { SkillMemoryStore } from "../memory/skillMemory.js";
import { RunStore } from "../runs/types.js";
import { ToolRegistry } from "../tools/registry.js";

export type WebAppOptions = {
  agent: UniversalAgent;
  runStore: RunStore;
  publicDir: string;
  skillMemory?: SkillMemoryStore;
  toolRegistry?: Pick<ToolRegistry, "list">;
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
    sendJson(response, 200, {
      tools:
        options.toolRegistry?.list().map((tool) => ({
          name: tool.name,
          description: tool.description,
          capabilities: tool.capabilities,
        })) ?? [],
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/runs") {
    const body = await readJsonBody<{ task?: unknown }>(request);
    const task = typeof body.task === "string" ? body.task.trim() : "";

    if (!task) {
      sendJson(response, 400, { error: "Task is required" });
      return;
    }

    const run = await options.runStore.create(task);
    void executeRun(run.id, task, options);
    sendJson(response, 202, { run: await options.runStore.get(run.id) });
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

  if (request.method === "GET") {
    await serveStatic(url.pathname, response, options.publicDir);
    return;
  }

  sendJson(response, 405, { error: "Method not allowed" });
}

async function executeRun(id: string, task: string, options: WebAppOptions): Promise<void> {
  await options.runStore.markRunning(id);

  try {
    const result = await options.agent.run(task, {
      onEvent: (event) => {
        return options.runStore.appendEvent(id, event);
      },
    });
    await options.runStore.complete(id, result);
  } catch (error) {
    await options.runStore.fail(id, error instanceof Error ? error.message : "Unknown run error");
  }
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

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
