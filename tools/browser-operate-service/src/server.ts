/**
 * Phase 13 — HTTP server for browser.operate dockerized tool service.
 *
 * Implements the standard tool-service contract:
 *   GET  /describe        → tool metadata
 *   GET  /health          → service health
 *   POST /run             → execute browser commands
 *   POST /service/start   → no-op (browser is on-demand)
 *   POST /service/stop    → no-op
 *
 * Uses plain Node http module to avoid an Express dep — keeps the
 * container small.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { runBrowserOperate } from "./browser.ts";

const PORT = Number(process.env.PORT ?? 8080);
const VERSION = "1.0.0";

const description = {
  name: "browser.operate",
  version: VERSION,
  displayName: "Browser Operate",
  description:
    "Runs a generic Playwright browser command sequence and returns DOM text plus screenshot artifacts.",
  capabilities: [
    "browser-operate",
    "browser-automation",
    "browser-navigation",
    "dom-extraction",
    "browser-screenshot",
    "artifact-generation",
  ],
  startupMode: "on-demand" as const,
};

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "";
  const method = (req.method ?? "GET").toUpperCase();

  try {
    if (method === "GET" && url === "/describe") {
      return sendJson(res, 200, description);
    }
    if (method === "GET" && url === "/health") {
      return sendJson(res, 200, { status: "ok", version: VERSION });
    }
    if (method === "POST" && url === "/run") {
      const body = (await readJsonBody(req)) as { input?: unknown; context?: unknown };
      const result = await runBrowserOperate(body?.input);
      return sendJson(res, 200, result);
    }
    if (method === "POST" && (url === "/service/start" || url === "/service/stop")) {
      return sendJson(res, 200, { ok: true, detail: "browser.operate is on-demand; no service lifecycle." });
    }
    sendJson(res, 404, { error: `Unknown route ${method} ${url}` });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`browser.operate service listening on port ${PORT}`);
});
