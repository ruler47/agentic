import { relative } from "node:path";
import {
  ToolBuildProvider,
  ToolBuildProviderOutput,
  genericToolPackageManifest,
} from "./toolBuildProviders.js";
import { ToolBuildRequest } from "./toolBuildRequestStore.js";
import { ToolExample, ToolSchema, ToolStorageContract } from "./tool.js";

const DEFAULT_SECRET_HANDLE = "secret.telegram.bot.token";

const TELEGRAM_KEYWORDS = /telegram|tg[\.\-_]?bot|@?botfather/i;
const SECONDARY_BOT_KEYWORDS = /\b(bot|messenger|chat|listener|adapter|integration|polling|webhook|always[-\s]?on)\b/i;

/**
 * Tool Build provider that recognizes Telegram bot integration requests and writes a
 * portable, isolated source-bundle package implementing the existing neutral inbound /
 * outbox runtime contract. The generated package is intentionally a sibling of the
 * built-in `channel.telegram.bot` reference: it does NOT replace it and it does NOT
 * import Agentic internals — every dependency goes through `context.resolveSecret`,
 * `context.fetch`, and the documented `/api/tool-services/...` endpoints.
 *
 * Behavior reviewer (`DeterministicToolBehaviorReviewer.requestedProviderBehaviorFinding`)
 * already rejects generated outputs that only declare a generic service bridge for a
 * Telegram-shaped request. This provider's docs/source/capabilities mention the
 * Telegram Bot API surface (`getUpdates`, `sendMessage`, inline keyboard, ack) so the
 * existing reviewer accepts the new artifact while the generic-only output is rejected.
 */
export class TelegramBotToolBuildProvider implements ToolBuildProvider {
  canBuild(request: ToolBuildRequest): boolean {
    const text = [
      request.capability,
      request.contract.capability,
      request.contract.toolName,
      request.contract.displayName,
      request.displayName,
      request.reason,
      request.taskSummary,
      request.contract.integration?.providerHint,
      (request.requiredInputs ?? []).join(" "),
      (request.requiredOutputs ?? []).join(" "),
    ]
      .filter(Boolean)
      .join(" ");
    if (!TELEGRAM_KEYWORDS.test(text)) return false;
    return (
      request.contract.startupMode === "always-on" ||
      SECONDARY_BOT_KEYWORDS.test(text) ||
      /\b(getUpdates|sendMessage|chat[_\s-]?id|allowed[_\s-]?users)\b/i.test(text)
    );
  }

  build(request: ToolBuildRequest): ToolBuildProviderOutput {
    const modulePath = request.contract.modulePath;
    const testPath = request.contract.testPath;
    const toolName = request.contract.toolName;
    const capability = request.capability;
    const version = request.contract.version;
    const description =
      request.contract.description ||
      `Generated Telegram Bot API adapter that bridges Telegram messages to Agentic neutral inbound/outbox endpoints (${toolName}).`;
    const displayName = request.displayName ?? request.contract.displayName ?? "Generated Telegram Bot Adapter";
    const requiredSecretHandles = uniqueNonEmpty([
      ...(request.credentialHandles ?? []),
      DEFAULT_SECRET_HANDLE,
    ]);
    const capabilities = uniqueNonEmpty([
      capability,
      "always-on-service",
      "tool-integration",
      "inbound-event",
      "outbound-event",
      "service-runtime",
      "channel",
      "messaging",
      "telegram",
      "telegram-bot",
      "inbound-message",
      "outbound-message",
      "provider:telegram",
    ]);
    const settingsSchema = telegramSettingsSchema();
    const storage = telegramStorageContract(toolName);
    const inputSchema = telegramInputSchema();
    const outputSchema = telegramOutputSchema();
    const docsMarkdown = telegramDocsMarkdown(toolName, capability, requiredSecretHandles);
    const examples = telegramExamples();

    return {
      modulePath,
      testPath,
      summary:
        `Generated Telegram Bot API adapter ${toolName}. ` +
        `Polls getUpdates, forwards inbound text to /api/tool-services/${toolName}/inbound, ` +
        `delivers outbox replies via sendMessage, splits long messages, attaches a Continue thread inline keyboard, and acks delivery.`,
      displayName,
      capabilities,
      inputSchema,
      outputSchema,
      requiredSecretHandles,
      settingsSchema,
      storage,
      docsMarkdown,
      examples,
      packageManifest: genericToolPackageManifest({
        toolName,
        displayName,
        version,
        description,
        capabilities,
        startupMode: "always-on",
        modulePath,
        inputSchema,
        outputSchema,
        requiredSecretHandles,
        settingsSchema,
        storage,
        docsMarkdown,
        examples,
      }),
      files: [
        { path: modulePath, content: telegramToolSource(toolName, capability, capabilities, requiredSecretHandles, version) },
        { path: testPath, content: telegramToolTestSource(modulePath, toolName) },
      ],
    };
  }
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))];
}

function telegramSettingsSchema(): ToolSchema {
  return {
    type: "object",
    properties: {
      pollIntervalMs: {
        type: "integer",
        description: "Telegram getUpdates polling interval in milliseconds.",
      },
      allowedSourceUserIds: {
        type: "array",
        items: { type: "string" },
        description: "Numeric Telegram user IDs allowed to send messages to this bot. Empty means rely on Agentic channel_identities allowlist.",
      },
      allowedSourceUsernames: {
        type: "array",
        items: { type: "string" },
        description: "Telegram usernames (with or without leading @) allowed to send messages to this bot.",
      },
      allowedChatIds: {
        type: "array",
        items: { type: "string" },
        description: "Telegram chat IDs allowed to interact with this bot. Empty allows any whitelisted user chat.",
      },
      providerLabel: {
        type: "string",
        description: "Human-readable provider label shown in audit metadata (e.g. \"Family Telegram Assistant Bot\").",
      },
    },
  };
}

function telegramStorageContract(toolName: string): ToolStorageContract {
  const schema = `tool_${toolName.replace(/^generated[._-]/, "").replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase()}`.slice(0, 63);
  return {
    schema,
    tables: ["service_offsets", "service_events", "service_delivery_attempts"],
    migrations: ["001_create_telegram_runtime_tables"],
    retention: "Telegram update offsets, normalized inbound/outbound events, and delivery attempts retained per instance audit policy.",
    permissions: ["tool-db:read", "tool-db:write"],
    destructiveCapabilities: [
      "purge stored Telegram update offset only through an approved maintenance capability",
    ],
  };
}

function telegramInputSchema(): ToolSchema {
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["status", "reset-offset"],
      },
    },
  };
}

function telegramOutputSchema(): ToolSchema {
  return {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: { type: "object" },
    },
    required: ["ok", "content"],
  };
}

function telegramDocsMarkdown(toolName: string, capability: string, secretHandles: string[]): string {
  return [
    `# ${toolName}`,
    "",
    `Generated Telegram Bot API adapter for capability \`${capability}\`.`,
    "",
    "## Runtime Contract",
    "",
    "- Implements `Tool.startService(context)` for the always-on supervisor lifecycle.",
    "- Polls Telegram Bot API `getUpdates` with `allowed_updates=[\"message\",\"callback_query\"]`.",
    "- Forwards inbound text messages to `/api/tool-services/${TOOL_NAME}/inbound` with provider metadata:",
    "  - `provider`: generated tool name",
    "  - `sourceChatId`",
    "  - `sourceMessageId`",
    "  - `sourceUserId` (numeric Telegram user id)",
    "  - `sourceUserAliases` (Telegram username and `@username` when available)",
    "- Polls neutral outbox `/api/tool-services/${TOOL_NAME}/outbox`, sends each event via Telegram Bot API `sendMessage`, splits long answers across messages, and attaches an inline keyboard with a `Continue thread` button on the final chunk when thread context exists.",
    "- Acknowledges every outbox event through `/api/tool-services/${TOOL_NAME}/outbox/:eventId/ack`.",
    "",
    "## Secrets",
    "",
    `Bot token must be supplied through the secret handle ${secretHandles.map((handle) => `\`${handle}\``).join(", ")} and is resolved through \`context.resolveSecret\`. The token never appears in logs, audit metadata, prompts, or generated artifacts.`,
    "",
    "## Coexistence",
    "",
    "This generated tool is independent from the built-in `channel.telegram.bot` reference; both can run side by side as separate bots with separate secret handles, allowed users, and Agentic channel identities.",
  ].join("\n");
}

function telegramExamples(): ToolExample[] {
  return [
    {
      title: "Reset Telegram update offset",
      input: { action: "reset-offset" },
      output: { ok: true, content: "Telegram update offset reset to 0." },
    },
    {
      title: "Check Telegram service status",
      input: { action: "status" },
      output: { ok: true, content: "Telegram bot service status: ready." },
    },
  ];
}

function telegramToolSource(
  toolName: string,
  capability: string,
  capabilities: string[],
  secretHandles: string[],
  version: string,
): string {
  const docs = telegramDocsMarkdown(toolName, capability, secretHandles);
  return `import {
  Tool,
  ToolInput,
  ToolResult,
  ToolServiceContext,
  ToolServiceHandle,
} from "../tool.js";

// Generated Telegram Bot API adapter. Mirrors the neutral inbound/outbox contract used
// by the built-in channel.telegram.bot reference, but stays portable: this module never
// imports Agentic internals, every external dependency comes from \`context\` or the
// documented HTTP endpoints, and the bot token is resolved exclusively through
// \`context.resolveSecret\`.

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
    message?: {
      message_id: number;
      chat?: { id: number | string };
    };
  };
};

type TelegramResponse<T> = {
  ok?: boolean;
  result?: T;
  description?: string;
};

type ServiceOutboxEvent = {
  id: string;
  summary: string;
  sourceChatId?: string;
  threadId?: string;
  payload?: { finalAnswer?: string; error?: string };
};

export type TelegramCycleInput = {
  toolName: string;
  token: string;
  baseUrl: string;
  offset: number;
  continuationThreads?: Map<string, string>;
  fetchImpl?: typeof fetch;
  logger?: ToolServiceContext["logger"];
};

export type TelegramCycleResult = {
  offset: number;
  inboundCount: number;
  deliveredCount: number;
};

const requiredSecretHandles: string[] = ${JSON.stringify(secretHandles)};
const defaultSecretHandle = ${JSON.stringify(secretHandles[0] ?? DEFAULT_SECRET_HANDLE)};

const state = {
  startedAt: undefined as string | undefined,
  stoppedAt: undefined as string | undefined,
  lastHeartbeatAt: undefined as string | undefined,
  offset: 0,
  missingSecrets: [] as string[],
};

export const tool: Tool = {
  name: ${JSON.stringify(toolName)},
  version: ${JSON.stringify(version)},
  description: "Generated Telegram Bot API adapter that bridges Telegram messages to Agentic neutral inbound/outbox endpoints.",
  capabilities: ${JSON.stringify(capabilities)},
  startupMode: "always-on",
  requiredSecretHandles,
  settingsSchema: ${JSON.stringify(telegramSettingsSchema(), null, 2)},
  storage: ${JSON.stringify(telegramStorageContract(toolName), null, 2)},
  docsMarkdown: ${JSON.stringify(docs)},
  examples: ${JSON.stringify(telegramExamples(), null, 2)},
  inputSchema: ${JSON.stringify(telegramInputSchema(), null, 2)},
  outputSchema: ${JSON.stringify(telegramOutputSchema(), null, 2)},
  async healthcheck() {
    return {
      ok: state.missingSecrets.length === 0,
      detail:
        state.missingSecrets.length > 0
          ? "Missing required secret handles: " + state.missingSecrets.join(", ")
          : state.startedAt && !state.stoppedAt
            ? "Telegram bot service is running."
            : "Telegram bot service module is importable and ready to start.",
    };
  },
  async startService(context: ToolServiceContext): Promise<ToolServiceHandle> {
    state.missingSecrets = [];
    const secretHandle = (await resolveString(context, "telegramSecretHandle")) ?? defaultSecretHandle;
    const token = await context.resolveSecret?.(secretHandle);
    if (!token) {
      state.missingSecrets.push(secretHandle);
      throw new Error("Secret handle " + secretHandle + " could not be resolved for Telegram bot service.");
    }

    const baseUrl =
      (typeof context.baseUrl === "string" ? context.baseUrl : undefined) ??
      (await resolveString(context, "AGENTIC_INTERNAL_BASE_URL")) ??
      "http://127.0.0.1:3000";
    const fetchImpl = context.fetch ?? fetch;
    const pollIntervalRaw =
      (await resolveString(context, "pollIntervalMs")) ??
      (await resolveString(context, "TELEGRAM_BOT_POLL_INTERVAL_MS")) ??
      "2500";
    const pollIntervalMs = Math.max(1000, Number.parseInt(pollIntervalRaw, 10) || 2500);

    const continuationThreads = new Map<string, string>();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    state.startedAt = context.now.toISOString();
    state.stoppedAt = undefined;
    state.lastHeartbeatAt = state.startedAt;
    context.logger?.info("Telegram bot service started.", { tool: context.toolName, providerHint: "telegram" });

    const loop = async () => {
      if (stopped || context.signal.aborted) return;
      try {
        const result = await runTelegramBotServiceCycle({
          toolName: context.toolName,
          token,
          baseUrl,
          offset: state.offset,
          continuationThreads,
          fetchImpl,
          logger: context.logger,
        });
        state.offset = result.offset;
        state.lastHeartbeatAt = new Date().toISOString();
      } catch (error) {
        context.logger?.error("Telegram bot service cycle failed.", {
          error: error instanceof Error ? error.message : "unknown error",
        });
      }
      if (!stopped && !context.signal.aborted) {
        timer = setTimeout(loop, pollIntervalMs);
        timer.unref?.();
      }
    };

    context.signal.addEventListener(
      "abort",
      () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        state.stoppedAt = new Date().toISOString();
      },
      { once: true },
    );
    timer = setTimeout(loop, 0);
    timer.unref?.();

    return {
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        state.stoppedAt = new Date().toISOString();
      },
      async healthcheck() {
        try {
          const response = await telegramApi<TelegramResponse<{ id: number; username?: string }>>(
            token,
            "getMe",
            {},
            fetchImpl,
          );
          return {
            ok: Boolean(response.ok) && state.missingSecrets.length === 0,
            detail: response.ok
              ? "Telegram bot reachable" + (response.result?.username ? ": @" + response.result.username : ".")
              : response.description ?? "Telegram getMe failed.",
          };
        } catch (error) {
          return {
            ok: false,
            detail: "Telegram getMe failed: " + (error instanceof Error ? error.message : String(error)),
          };
        }
      },
    };
  },
  async run(input: ToolInput): Promise<ToolResult> {
    const action = typeof input.action === "string" ? input.action : "status";
    if (action === "reset-offset") {
      state.offset = 0;
      return { ok: true, content: "Telegram update offset reset to 0." };
    }
    return {
      ok: true,
      content:
        "Telegram bot service status: " +
        (state.startedAt && !state.stoppedAt ? "running" : state.stoppedAt ? "stopped" : "ready") +
        ".",
      data: {
        startedAt: state.startedAt,
        stoppedAt: state.stoppedAt,
        lastHeartbeatAt: state.lastHeartbeatAt,
        missingSecrets: state.missingSecrets,
        offset: state.offset,
      },
    };
  },
};

export default tool;

export async function runTelegramBotServiceCycle(input: TelegramCycleInput): Promise<TelegramCycleResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const updatesResponse = await telegramApi<TelegramResponse<TelegramUpdate[]>>(
    input.token,
    "getUpdates",
    {
      offset: input.offset,
      timeout: 0,
      allowed_updates: JSON.stringify(["message", "callback_query"]),
    },
    fetchImpl,
  );
  if (!updatesResponse.ok) {
    throw new Error(updatesResponse.description ?? "Telegram getUpdates failed.");
  }

  let offset = input.offset;
  let inboundCount = 0;
  for (const update of updatesResponse.result ?? []) {
    offset = Math.max(offset, update.update_id + 1);
    if (update.callback_query) {
      await handleContinuationCallback(input, update.callback_query);
      continue;
    }

    const message = update.message;
    const text = message?.text?.trim();
    const sourceUserId = message?.from?.id === undefined ? undefined : String(message.from.id);
    const sourceChatId = message?.chat?.id === undefined ? undefined : String(message.chat.id);
    if (!text || !sourceUserId || !sourceChatId) continue;
    const sourceUserAliases = telegramUserAliases(message?.from);
    const continuationKey = telegramContinuationKey(sourceChatId, sourceUserId);
    const explicitThreadId = input.continuationThreads?.get(continuationKey);

    const response = await fetchImpl(
      trimSlash(input.baseUrl) + "/api/tool-services/" + encodeURIComponent(input.toolName) + "/inbound",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: input.toolName,
          text,
          sourceUserId,
          sourceUserAliases,
          sourceChatId,
          threadId: explicitThreadId,
          sourceThreadId: explicitThreadId
            ? undefined
            : message?.message_thread_id === undefined
              ? undefined
              : String(message.message_thread_id),
          sourceMessageId: message?.message_id === undefined ? undefined : String(message.message_id),
        }),
      },
    );
    if (response.ok) {
      inboundCount += 1;
      if (explicitThreadId) input.continuationThreads?.delete(continuationKey);
    } else {
      input.logger?.warn("Telegram inbound event was rejected by Agentic core.", {
        status: response.status,
        sourceUserId,
        sourceChatId,
      });
    }
  }

  const outboxResponse = await fetchImpl(
    trimSlash(input.baseUrl) + "/api/tool-services/" + encodeURIComponent(input.toolName) + "/outbox?limit=20",
    { headers: { accept: "application/json" } },
  );
  if (!outboxResponse.ok) {
    throw new Error("Agentic outbox returned HTTP " + outboxResponse.status + ".");
  }
  const outbox = (await outboxResponse.json()) as { events?: ServiceOutboxEvent[] };
  let deliveredCount = 0;
  for (const event of outbox.events ?? []) {
    if (!event.sourceChatId) continue;
    const text = event.payload?.finalAnswer ?? event.payload?.error ?? event.summary;
    try {
      const messageIds: string[] = [];
      const chunks = splitTelegramMessage(text);
      for (let index = 0; index < chunks.length; index += 1) {
        const params: Record<string, string | number> = {
          chat_id: event.sourceChatId,
          text: chunks[index]!,
        };
        if (event.threadId && index === chunks.length - 1) {
          params.reply_markup = JSON.stringify({
            inline_keyboard: [[{ text: "Continue thread", callback_data: "continue_thread:" + event.threadId }]],
          });
        }
        const sent = await telegramApi<TelegramResponse<{ message_id?: number }>>(
          input.token,
          "sendMessage",
          params,
          fetchImpl,
        );
        if (!sent.ok) throw new Error(sent.description ?? "Telegram sendMessage failed.");
        if (sent.result?.message_id !== undefined) messageIds.push(String(sent.result.message_id));
      }
      deliveredCount += 1;
      await ackOutbox(input, event, "sent", messageIds.join(",") || undefined);
    } catch (error) {
      await ackOutbox(input, event, "failed", undefined, error instanceof Error ? error.message : "unknown error");
    }
  }

  return { offset, inboundCount, deliveredCount };
}

async function handleContinuationCallback(
  input: TelegramCycleInput,
  callback: NonNullable<TelegramUpdate["callback_query"]>,
): Promise<void> {
  const data = callback.data ?? "";
  const match = data.match(/^continue_thread:(.+)$/);
  const sourceUserId = callback.from?.id === undefined ? undefined : String(callback.from.id);
  const sourceChatId = callback.message?.chat?.id === undefined ? undefined : String(callback.message.chat.id);
  if (match && sourceUserId && sourceChatId) {
    input.continuationThreads?.set(telegramContinuationKey(sourceChatId, sourceUserId), match[1]!);
  }
  await telegramApi<TelegramResponse<boolean>>(
    input.token,
    "answerCallbackQuery",
    {
      callback_query_id: callback.id,
      text: match ? "The next message will continue this thread." : "Button handled.",
    },
    input.fetchImpl ?? fetch,
  );
}

async function ackOutbox(
  input: TelegramCycleInput,
  event: ServiceOutboxEvent,
  status: "sent" | "failed",
  providerMessageId?: string,
  detail?: string,
): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    trimSlash(input.baseUrl) +
      "/api/tool-services/" +
      encodeURIComponent(input.toolName) +
      "/outbox/" +
      encodeURIComponent(event.id) +
      "/ack",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, providerMessageId, detail }),
    },
  );
  if (!response.ok) {
    input.logger?.warn("Agentic outbox acknowledgement failed.", { status: response.status, eventId: event.id });
  }
}

async function telegramApi<T>(
  token: string,
  method: string,
  params: Record<string, string | number>,
  fetchImpl: typeof fetch,
): Promise<T> {
  const url = new URL("https://api.telegram.org/bot" + token + "/" + method);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" } });
  return (await response.json()) as T;
}

function trimSlash(value: string): string {
  return value.replace(/\\/+$/, "");
}

export function splitTelegramMessage(value: string): string[] {
  const limit = 3900;
  if (value.length <= limit) return [value];
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\\n\\n", limit);
    if (splitAt < 1000) splitAt = remaining.lastIndexOf("\\n", limit);
    if (splitAt < 1000) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt < 1000) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.map((chunk, index) => (chunks.length === 1 ? chunk : chunk + "\\n\\n(" + (index + 1) + "/" + chunks.length + ")"));
}

function telegramUserAliases(from: { id?: number | string; username?: string } | undefined): string[] {
  const username = from?.username?.trim().replace(/^@+/, "");
  if (!username) return [];
  return [...new Set([username, "@" + username])];
}

function telegramContinuationKey(sourceChatId: string, sourceUserId: string): string {
  return sourceChatId + ":" + sourceUserId;
}

async function resolveString(context: ToolServiceContext, key: string): Promise<string | undefined> {
  if (!context.resolveConfiguration) return undefined;
  const value = await context.resolveConfiguration(key, context.toolName);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
`;
}

function telegramToolTestSource(modulePath: string, toolName: string): string {
  const importPath = relative("tests/generated", modulePath).replace(/\\/g, "/").replace(/\.ts$/, ".js");
  const importSpec = importPath.startsWith(".") ? importPath : `./${importPath}`;
  return `import test from "node:test";
import assert from "node:assert/strict";
import { tool, runTelegramBotServiceCycle, splitTelegramMessage } from "${importSpec}";

type FakeFetchCall = {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
};

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  }) as unknown as Response;
}

test("${toolName} exposes a generated Telegram-shaped Tool contract", () => {
  assert.equal(tool.name, ${JSON.stringify(toolName)});
  assert.equal(tool.startupMode, "always-on");
  assert.equal(typeof tool.startService, "function");
  assert.ok(tool.capabilities.includes("telegram"));
  assert.ok(tool.capabilities.includes("provider:telegram"));
  assert.ok(tool.capabilities.includes("inbound-message"));
  assert.ok(tool.capabilities.includes("outbound-message"));
  assert.ok((tool.requiredSecretHandles ?? []).length >= 1);
  assert.match(tool.docsMarkdown ?? "", /Telegram Bot API/);
  assert.match(tool.docsMarkdown ?? "", /sendMessage/);
  assert.match(tool.docsMarkdown ?? "", /getUpdates/);
});

test("${toolName} polls getUpdates, forwards inbound message, and acks outbox via sendMessage", async () => {
  const calls: FakeFetchCall[] = [];
  let outboxServed = false;

  const fakeFetch = (async (url: URL | string, init?: RequestInit) => {
    const target = typeof url === "string" ? url : url.toString();
    const initRecord = (init ?? {}) as FakeFetchCall["init"];
    calls.push({ url: target, init: initRecord });
    if (target.includes("/getUpdates")) {
      return jsonResponse({
        ok: true,
        result: [
          {
            update_id: 100,
            message: {
              message_id: 7,
              text: "Hello from telegram smoke test",
              chat: { id: 555 },
              from: { id: 42, username: "alice" },
            },
          },
        ],
      });
    }
    if (target.endsWith("/inbound")) {
      return jsonResponse({ ok: true });
    }
    if (target.includes("/outbox") && !target.includes("/ack")) {
      if (outboxServed) return jsonResponse({ events: [] });
      outboxServed = true;
      return jsonResponse({
        events: [
          {
            id: "evt-1",
            summary: "smoke",
            sourceChatId: "555",
            threadId: "thread-xyz",
            payload: { finalAnswer: "Smoke answer." },
          },
        ],
      });
    }
    if (target.includes("/sendMessage")) {
      return jsonResponse({ ok: true, result: { message_id: 999 } });
    }
    if (target.endsWith("/ack")) {
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;

  const result = await runTelegramBotServiceCycle({
    toolName: ${JSON.stringify(toolName)},
    token: "FAKE-TOKEN-FOR-TESTS",
    baseUrl: "http://fake-agentic.invalid",
    offset: 0,
    fetchImpl: fakeFetch,
  });

  assert.equal(result.inboundCount, 1, "exactly one inbound event forwarded");
  assert.equal(result.deliveredCount, 1, "exactly one outbox event delivered");
  assert.ok(result.offset > 100, "offset advanced past the consumed update");

  const inbound = calls.find((call) => call.url.endsWith("/inbound"));
  assert.ok(inbound, "inbound POST was issued");
  const inboundBody = JSON.parse(inbound!.init?.body ?? "{}") as Record<string, unknown>;
  assert.equal(inboundBody.text, "Hello from telegram smoke test");
  assert.equal(inboundBody.sourceChatId, "555");
  assert.equal(inboundBody.sourceUserId, "42");
  assert.deepEqual(inboundBody.sourceUserAliases, ["alice", "@alice"]);
  assert.equal(inboundBody.provider, ${JSON.stringify(toolName)});

  const sendMessage = calls.find((call) => call.url.includes("/sendMessage"));
  assert.ok(sendMessage, "sendMessage was called against the Telegram Bot API");
  assert.match(sendMessage!.url, /chat_id=555/);
  assert.match(sendMessage!.url, /text=Smoke/);

  const ack = calls.find((call) => call.url.endsWith("/ack"));
  assert.ok(ack, "outbox ack was sent");
  const ackBody = JSON.parse(ack!.init?.body ?? "{}") as { status?: string };
  assert.equal(ackBody.status, "sent");
});

test("${toolName} splits long answers across messages and attaches Continue thread on final chunk", async () => {
  const calls: FakeFetchCall[] = [];
  const long = "A".repeat(8000) + "\\n\\n" + "B".repeat(2000);
  let outboxServed = false;

  const fakeFetch = (async (url: URL | string, init?: RequestInit) => {
    const target = typeof url === "string" ? url : url.toString();
    calls.push({ url: target, init: init as FakeFetchCall["init"] });
    if (target.includes("/getUpdates")) return jsonResponse({ ok: true, result: [] });
    if (target.includes("/outbox") && !target.includes("/ack")) {
      if (outboxServed) return jsonResponse({ events: [] });
      outboxServed = true;
      return jsonResponse({
        events: [
          {
            id: "evt-long",
            summary: "long",
            sourceChatId: "777",
            threadId: "thread-long",
            payload: { finalAnswer: long },
          },
        ],
      });
    }
    if (target.includes("/sendMessage")) {
      return jsonResponse({ ok: true, result: { message_id: Math.floor(Math.random() * 1000) } });
    }
    if (target.endsWith("/ack")) return jsonResponse({ ok: true });
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;

  await runTelegramBotServiceCycle({
    toolName: ${JSON.stringify(toolName)},
    token: "FAKE-TOKEN",
    baseUrl: "http://fake-agentic.invalid",
    offset: 0,
    fetchImpl: fakeFetch,
  });

  const sends = calls.filter((call) => call.url.includes("/sendMessage"));
  assert.ok(sends.length >= 2, "long answers must split into multiple sendMessage calls");
  assert.ok(
    !sends.slice(0, -1).some((call) => /reply_markup/.test(call.url)),
    "intermediate chunks must NOT carry inline keyboards",
  );
  const last = sends.at(-1)!;
  assert.match(last.url, /reply_markup/, "the final chunk attaches the inline keyboard");
  assert.match(last.url, /continue_thread%3Athread-long/, "the inline keyboard carries the continue_thread payload");

  const chunks = splitTelegramMessage(long);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 4000));
});
`;
}
