import {
  Tool,
  ToolInput,
  ToolResult,
  ToolServiceContext,
  ToolServiceHandle,
} from "./tool.js";

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    message_thread_id?: number;
    text?: string;
    chat?: { id: number | string };
    from?: { id: number | string };
  };
};

type TelegramResponse<T> = {
  ok?: boolean;
  result?: T;
  description?: string;
};

type ServiceEvent = {
  id: string;
  summary: string;
  sourceChatId?: string;
  payload?: {
    finalAnswer?: string;
    error?: string;
  };
};

type TelegramCycleInput = {
  toolName: string;
  token: string;
  baseUrl: string;
  offset: number;
  fetchImpl?: typeof fetch;
  logger?: ToolServiceContext["logger"];
};

export class TelegramBotServiceTool implements Tool {
  readonly name = "channel.telegram.bot";
  readonly displayName = "Telegram bot service";
  readonly version = "1.0.0";
  readonly description = "Receives Telegram bot messages and bridges them to generic Agentic inbound/outbox APIs.";
  readonly capabilities = ["channel", "messaging", "telegram", "inbound-message", "outbound-message"];
  readonly startupMode = "always-on";
  readonly requiredSecretHandles = ["secret.telegram.bot.token"];
  readonly inputSchema = {
    type: "object" as const,
    properties: {},
  };
  readonly outputSchema = {
    type: "object" as const,
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
    },
    required: ["ok", "content"],
  };
  readonly docsMarkdown = [
    "# Telegram bot service",
    "",
    "Provider-neutral always-on service runner for Telegram Bot API.",
    "It polls Telegram updates, forwards user text to `/api/tool-services/:name/inbound`,",
    "polls `/api/tool-services/:name/outbox`, sends answers back to Telegram, and acknowledges delivery.",
    "Telegram user ids must be mapped in `channel_identities` for provider `channel.telegram.bot`.",
    "Token material must be stored in `secret.telegram.bot.token` or the handle configured by `TELEGRAM_BOT_SECRET_HANDLE`.",
  ].join("\n");

  async healthcheck() {
    return {
      ok: true,
      detail: "Telegram service module is installed. Runtime token is checked when the service starts.",
    };
  }

  async startService(context: ToolServiceContext): Promise<ToolServiceHandle> {
    const secretHandle = process.env.TELEGRAM_BOT_SECRET_HANDLE ?? "secret.telegram.bot.token";
    const token = await context.resolveSecret?.(secretHandle);
    if (!token) {
      throw new Error(`Secret handle ${secretHandle} could not be resolved.`);
    }

    const baseUrl = context.baseUrl ?? process.env.AGENTIC_INTERNAL_BASE_URL ?? "http://127.0.0.1:3000";
    const fetchImpl = context.fetch ?? fetch;
    const pollIntervalMs = Math.max(1000, Number(process.env.TELEGRAM_BOT_POLL_INTERVAL_MS ?? "2500"));
    let offset = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const loop = async () => {
      if (stopped || context.signal.aborted) return;
      try {
        const result = await runTelegramBotServiceCycle({
          toolName: context.toolName,
          token,
          baseUrl,
          offset,
          fetchImpl,
          logger: context.logger,
        });
        offset = result.offset;
      } catch (error) {
        context.logger?.error("Telegram service cycle failed.", {
          error: error instanceof Error ? error.message : "unknown error",
        });
      }
      if (!stopped && !context.signal.aborted) {
        timer = setTimeout(loop, pollIntervalMs);
      }
    };

    context.signal.addEventListener("abort", () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    });
    timer = setTimeout(loop, 0);

    return {
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
      healthcheck: async () => {
        const response = await telegramApi<TelegramResponse<{ id: number; username?: string }>>(
          token,
          "getMe",
          {},
          fetchImpl,
        );
        return {
          ok: Boolean(response.ok),
          detail: response.ok
            ? `Telegram bot reachable${response.result?.username ? `: @${response.result.username}` : "."}`
            : response.description ?? "Telegram getMe failed.",
        };
      },
    };
  }

  async run(_input: ToolInput): Promise<ToolResult> {
    return {
      ok: true,
      content: "Telegram bot service is controlled through the always-on service supervisor.",
    };
  }
}

export async function runTelegramBotServiceCycle(input: TelegramCycleInput): Promise<{
  offset: number;
  inboundCount: number;
  deliveredCount: number;
}> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const updatesResponse = await telegramApi<TelegramResponse<TelegramUpdate[]>>(
    input.token,
    "getUpdates",
    {
      offset: input.offset,
      timeout: 0,
      allowed_updates: JSON.stringify(["message"]),
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
    const message = update.message;
    const text = message?.text?.trim();
    const sourceUserId = message?.from?.id === undefined ? undefined : String(message.from.id);
    const sourceChatId = message?.chat?.id === undefined ? undefined : String(message.chat.id);
    if (!text || !sourceUserId || !sourceChatId) continue;

    const response = await fetchImpl(`${trimSlash(input.baseUrl)}/api/tool-services/${encodeURIComponent(input.toolName)}/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        sourceUserId,
        sourceChatId,
        sourceThreadId: message?.message_thread_id === undefined ? undefined : String(message.message_thread_id),
        sourceMessageId: message?.message_id === undefined ? undefined : String(message.message_id),
      }),
    });
    if (response.ok) {
      inboundCount += 1;
    } else {
      input.logger?.warn("Telegram inbound event was rejected by Agentic core.", {
        status: response.status,
        sourceUserId,
        sourceChatId,
      });
    }
  }

  const outboxResponse = await fetchImpl(`${trimSlash(input.baseUrl)}/api/tool-services/${encodeURIComponent(input.toolName)}/outbox?limit=20`, {
    headers: { accept: "application/json" },
  });
  if (!outboxResponse.ok) {
    throw new Error(`Agentic outbox returned HTTP ${outboxResponse.status}.`);
  }
  const outbox = (await outboxResponse.json()) as { events?: ServiceEvent[] };
  let deliveredCount = 0;
  for (const event of outbox.events ?? []) {
    if (!event.sourceChatId) continue;
    const text = event.payload?.finalAnswer ?? event.payload?.error ?? event.summary;
    try {
      const sent = await telegramApi<TelegramResponse<{ message_id?: number }>>(
        input.token,
        "sendMessage",
        {
          chat_id: event.sourceChatId,
          text: truncateTelegramMessage(text),
        },
        fetchImpl,
      );
      if (!sent.ok) throw new Error(sent.description ?? "Telegram sendMessage failed.");
      deliveredCount += 1;
      await ackOutbox(input, event, "sent", sent.result?.message_id === undefined ? undefined : String(sent.result.message_id));
    } catch (error) {
      await ackOutbox(input, event, "failed", undefined, error instanceof Error ? error.message : "unknown error");
    }
  }

  return { offset, inboundCount, deliveredCount };
}

async function ackOutbox(
  input: TelegramCycleInput,
  event: ServiceEvent,
  status: "sent" | "failed",
  providerMessageId?: string,
  detail?: string,
): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${trimSlash(input.baseUrl)}/api/tool-services/${encodeURIComponent(input.toolName)}/outbox/${encodeURIComponent(event.id)}/ack`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status,
        providerMessageId,
        detail,
      }),
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
  const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  return await response.json() as T;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function truncateTelegramMessage(value: string): string {
  if (value.length <= 3900) return value;
  return `${value.slice(0, 3890)}\n...[truncated]`;
}
