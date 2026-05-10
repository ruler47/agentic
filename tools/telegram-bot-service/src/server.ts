/**
 * Phase 13 — dockerized telegram.bot tool service skeleton.
 *
 * The full implementation (Telegram long-poll + callback wiring)
 * mirrors src/tools/telegramBotServiceTool.ts; this skeleton ships
 * the standard tool-service envelope so the registry can route to
 * it once the in-process tool is decommissioned. Until then, the
 * in-process tool remains the default and the HttpToolAdapter only
 * activates when TELEGRAM_BOT_RUNNER=docker.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
const VERSION = "1.0.0";

const description = {
  name: "telegram.bot",
  version: VERSION,
  displayName: "Telegram Bot Bridge",
  description: "Receives Telegram bot messages and bridges them to generic Agentic inbound/outbox APIs.",
  capabilities: [
    "messaging-channel",
    "telegram-bridge",
    "background-service",
  ],
  startupMode: "always-on" as const,
  requiredConfigurationKeys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_INSTANCE_ID"],
};

let serviceRunning = false;
let pollAbort: AbortController | undefined;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}
function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "";
  const method = (req.method ?? "GET").toUpperCase();
  try {
    if (method === "GET" && url === "/describe") return send(res, 200, description);
    if (method === "GET" && url === "/health") {
      return send(res, 200, { status: serviceRunning ? "ok" : "degraded", version: VERSION, detail: serviceRunning ? "Polling for updates." : "Service not started." });
    }
    if (method === "POST" && url === "/run") {
      // /run on a service-mode tool is a no-op; the actual work happens in
      // the polling loop spawned by /service/start.
      return send(res, 200, { ok: true, content: "telegram.bot is a service-mode tool; use /service/start." });
    }
    if (method === "POST" && url === "/service/start") {
      const body = (await readJsonBody(req)) as { context?: { configuration?: Record<string, string>; secrets?: Record<string, string>; baseUrl?: string } };
      const token = body?.context?.secrets?.TELEGRAM_BOT_TOKEN ?? body?.context?.configuration?.TELEGRAM_BOT_TOKEN;
      if (!token) {
        return send(res, 400, { ok: false, detail: "TELEGRAM_BOT_TOKEN is required to start telegram.bot service." });
      }
      if (serviceRunning) return send(res, 200, { ok: true, detail: "Service already running." });
      pollAbort = new AbortController();
      serviceRunning = true;
      // Real polling loop intentionally left as TODO — the in-process
      // implementation in src/tools/telegramBotServiceTool.ts has the
      // full Telegram long-poll + callback dispatch; porting it is a
      // mechanical follow-up to this skeleton.
      console.log("telegram.bot service started (skeleton; full polling not implemented yet).");
      return send(res, 200, { ok: true, detail: "telegram.bot service started (skeleton)." });
    }
    if (method === "POST" && url === "/service/stop") {
      pollAbort?.abort();
      serviceRunning = false;
      return send(res, 200, { ok: true, detail: "telegram.bot service stopped." });
    }
    send(res, 404, { error: `Unknown route ${method} ${url}` });
  } catch (error) {
    send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});
server.listen(PORT, () => console.log(`telegram.bot service listening on port ${PORT}`));
