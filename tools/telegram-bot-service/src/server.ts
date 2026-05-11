/**
 * Phase 13 — dockerized telegram.bot tool service.
 *
 * Full port of the in-process long-poll loop. The service listens
 * on the standard tool envelope (/describe /health /run
 * /service/start /service/stop). On /service/start it spawns a
 * polling task that:
 *   1. Calls Telegram getUpdates to drain inbound messages.
 *   2. Forwards each message to the runtime's
 *      /api/tool-services/<name>/inbound endpoint.
 *   3. Polls the runtime's /api/tool-services/<name>/outbox for
 *      replies and dispatches them via Telegram sendMessage.
 *
 * The runtime base URL is supplied via env (AGENTIC_INTERNAL_BASE_URL,
 * defaults to http://app:3000) since the in-process tool used the
 * same. TELEGRAM_BOT_TOKEN comes from the runtime's secret store
 * via the standard /service/start context.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
const VERSION = "1.0.0";
const POLL_INTERVAL_MS = Math.max(1000, Number(process.env.TELEGRAM_BOT_POLL_INTERVAL_MS ?? "2500"));
const RUNTIME_BASE_URL = (process.env.AGENTIC_INTERNAL_BASE_URL ?? "http://app:3000").replace(/\/+$/, "");

const description = {
  name: "telegram.bot",
  version: VERSION,
  displayName: "Telegram Bot Bridge",
  description: "Receives Telegram bot messages and bridges them to generic Agentic inbound/outbox APIs.",
  capabilities: ["messaging-channel", "telegram-bridge", "background-service"],
  startupMode: "always-on" as const,
  requiredConfigurationKeys: [],
  requiredSecretHandles: ["secret.telegram.bot.token"],
};

let serviceRunning = false;
let pollAbort: AbortController | undefined;
let pollerHandle: ReturnType<typeof setTimeout> | undefined;
let serviceToken: string | undefined;
let serviceToolName = "telegram.bot";
const continuationThreads = new Map<string, string>();
let updateOffset = 0;

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    message_thread_id?: number;
    text?: string;
    chat?: { id: number | string };
    from?: { id: number | string; username?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number | string; username?: string };
    message?: { message_id: number; chat?: { id: number | string } };
  };
};

type TelegramResponse<T> = { ok?: boolean; result?: T; description?: string };
type ServiceEvent = {
  id: string;
  summary: string;
  sourceChatId?: string;
  threadId?: string;
  payload?: { finalAnswer?: string; error?: string };
};

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

async function telegramApi<T>(token: string, method: string, params: Record<string, string | number>): Promise<T> {
  const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const response = await fetch(url, { method: "GET", headers: { accept: "application/json" } });
  return (await response.json()) as T;
}

function splitTelegramMessage(value: string): string[] {
  const limit = 3900;
  if (value.length <= limit) return [value];
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n\n", limit);
    if (splitAt < 1000) splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < 1000) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt < 1000) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.map((chunk, i) => chunks.length === 1 ? chunk : `${chunk}\n\n(${i + 1}/${chunks.length})`);
}

function telegramUserAliases(from: { id?: number | string; username?: string } | undefined): string[] {
  const username = from?.username?.trim().replace(/^@+/, "");
  if (!username) return [];
  return [...new Set([username, `@${username}`])];
}
function continuationKey(chatId: string, userId: string): string { return `${chatId}:${userId}`; }

async function handleContinuationCallback(token: string, callback: NonNullable<TelegramUpdate["callback_query"]>) {
  const data = callback.data ?? "";
  const match = data.match(/^continue_thread:(.+)$/);
  const sourceUserId = callback.from?.id === undefined ? undefined : String(callback.from.id);
  const sourceChatId = callback.message?.chat?.id === undefined ? undefined : String(callback.message.chat.id);
  if (match && sourceUserId && sourceChatId) {
    continuationThreads.set(continuationKey(sourceChatId, sourceUserId), match[1]!);
  }
  await telegramApi<TelegramResponse<boolean>>(token, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text: match ? "The next message will continue this thread." : "Button handled.",
  });
}

async function ackOutbox(eventId: string, status: "sent" | "failed", providerMessageId?: string, detail?: string) {
  await fetch(
    `${RUNTIME_BASE_URL}/api/tool-services/${encodeURIComponent(serviceToolName)}/outbox/${encodeURIComponent(eventId)}/ack`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, providerMessageId, detail }),
    },
  ).catch(() => undefined);
}

async function runCycle(token: string) {
  const updatesResponse = await telegramApi<TelegramResponse<TelegramUpdate[]>>(token, "getUpdates", {
    offset: updateOffset,
    timeout: 0,
    allowed_updates: JSON.stringify(["message", "callback_query"]),
  });
  if (!updatesResponse.ok) throw new Error(updatesResponse.description ?? "Telegram getUpdates failed.");

  for (const update of updatesResponse.result ?? []) {
    updateOffset = Math.max(updateOffset, update.update_id + 1);
    if (update.callback_query) {
      await handleContinuationCallback(token, update.callback_query);
      continue;
    }
    const message = update.message;
    const text = message?.text?.trim();
    const sourceUserId = message?.from?.id === undefined ? undefined : String(message.from.id);
    const sourceChatId = message?.chat?.id === undefined ? undefined : String(message.chat.id);
    if (!text || !sourceUserId || !sourceChatId) continue;
    const aliases = telegramUserAliases(message?.from);
    const ckey = continuationKey(sourceChatId, sourceUserId);
    const explicitThreadId = continuationThreads.get(ckey);

    const response = await fetch(
      `${RUNTIME_BASE_URL}/api/tool-services/${encodeURIComponent(serviceToolName)}/inbound`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          sourceUserId,
          sourceUserAliases: aliases,
          sourceChatId,
          threadId: explicitThreadId,
          sourceThreadId: explicitThreadId
            ? undefined
            : message?.message_thread_id === undefined ? undefined : String(message.message_thread_id),
          sourceMessageId: message?.message_id === undefined ? undefined : String(message.message_id),
        }),
      },
    );
    if (response.ok && explicitThreadId) continuationThreads.delete(ckey);
  }

  const outboxResponse = await fetch(
    `${RUNTIME_BASE_URL}/api/tool-services/${encodeURIComponent(serviceToolName)}/outbox?limit=20`,
    { headers: { accept: "application/json" } },
  );
  if (!outboxResponse.ok) throw new Error(`Agentic outbox returned HTTP ${outboxResponse.status}.`);
  const outbox = (await outboxResponse.json()) as { events?: ServiceEvent[] };

  for (const event of outbox.events ?? []) {
    if (!event.sourceChatId) continue;
    const text = event.payload?.finalAnswer ?? event.payload?.error ?? event.summary;
    try {
      const messageIds: string[] = [];
      const chunks = splitTelegramMessage(text);
      for (let i = 0; i < chunks.length; i += 1) {
        const params: Record<string, string | number> = { chat_id: event.sourceChatId, text: chunks[i]! };
        if (event.threadId && i === chunks.length - 1) {
          params.reply_markup = JSON.stringify({
            inline_keyboard: [[{ text: "Continue thread", callback_data: `continue_thread:${event.threadId}` }]],
          });
        }
        const sent = await telegramApi<TelegramResponse<{ message_id?: number }>>(token, "sendMessage", params);
        if (!sent.ok) throw new Error(sent.description ?? "Telegram sendMessage failed.");
        if (sent.result?.message_id !== undefined) messageIds.push(String(sent.result.message_id));
      }
      await ackOutbox(event.id, "sent", messageIds.join(",") || undefined);
    } catch (error) {
      await ackOutbox(event.id, "failed", undefined, error instanceof Error ? error.message : "unknown error");
    }
  }
}

function startPolling() {
  if (!serviceToken) return;
  const tick = async () => {
    if (pollAbort?.signal.aborted || !serviceRunning) return;
    try { await runCycle(serviceToken!); }
    catch (error) {
      console.error("telegram cycle failed:", error instanceof Error ? error.message : error);
    }
    if (serviceRunning && !pollAbort?.signal.aborted) {
      pollerHandle = setTimeout(tick, POLL_INTERVAL_MS);
    }
  };
  pollerHandle = setTimeout(tick, 0);
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "";
  const method = (req.method ?? "GET").toUpperCase();
  try {
    if (method === "GET" && url === "/describe") return send(res, 200, description);
    if (method === "GET" && url === "/health") {
      const detail = serviceRunning ? "Polling for updates." : "Service not started.";
      return send(res, 200, { status: serviceRunning ? "ok" : "degraded", version: VERSION, detail });
    }
    if (method === "POST" && url === "/run") {
      return send(res, 200, { ok: true, content: "telegram.bot is a service-mode tool; use /service/start." });
    }
    if (method === "POST" && url === "/service/start") {
      const body = (await readJsonBody(req)) as { context?: { secrets?: Record<string, string>; configuration?: Record<string, string>; toolName?: string } };
      const token = body?.context?.secrets?.["secret.telegram.bot.token"]
        ?? body?.context?.secrets?.TELEGRAM_BOT_TOKEN
        ?? body?.context?.configuration?.TELEGRAM_BOT_TOKEN;
      if (!token) {
        return send(res, 400, { ok: false, detail: "Telegram token missing in service start context." });
      }
      serviceToken = token;
      if (body?.context?.toolName) serviceToolName = body.context.toolName;
      if (serviceRunning) return send(res, 200, { ok: true, detail: "Service already running." });
      pollAbort = new AbortController();
      serviceRunning = true;
      startPolling();
      return send(res, 200, { ok: true, detail: "telegram.bot service started." });
    }
    if (method === "POST" && url === "/service/stop") {
      pollAbort?.abort();
      if (pollerHandle) clearTimeout(pollerHandle);
      serviceRunning = false;
      serviceToken = undefined;
      return send(res, 200, { ok: true, detail: "telegram.bot service stopped." });
    }
    send(res, 404, { error: `Unknown route ${method} ${url}` });
  } catch (error) {
    send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});
server.listen(PORT, () => console.log(`telegram.bot service listening on port ${PORT}`));
