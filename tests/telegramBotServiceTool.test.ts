import test from "node:test";
import assert from "node:assert/strict";
import { runTelegramBotServiceCycle, TelegramBotServiceTool } from "../src/tools/telegramBotServiceTool.js";

test("TelegramBotServiceTool exposes a provider-neutral always-on contract", async () => {
  const tool = new TelegramBotServiceTool();

  assert.equal(tool.name, "channel.telegram.bot");
  assert.equal(tool.startupMode, "always-on");
  assert.deepEqual(tool.requiredSecretHandles, ["secret.telegram.bot.token"]);
  assert.ok(tool.capabilities.includes("inbound-message"));
  assert.ok(tool.capabilities.includes("outbound-message"));
  assert.match((await tool.run({})).content, /service supervisor/);
});

test("Telegram service cycle forwards inbound messages and acknowledges delivered outbox", async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });

    if (url.includes("/getUpdates")) {
      return jsonResponse({
        ok: true,
        result: [
          {
            update_id: 123,
            message: {
              message_id: 10,
              text: "hello agent",
              chat: { id: 777 },
              from: { id: 42, username: "dima_tag" },
            },
          },
        ],
      });
    }

    if (url.endsWith("/api/tool-services/channel.telegram.bot/inbound")) {
      assert.equal(body.text, "hello agent");
      assert.equal(body.sourceUserId, "42");
      assert.deepEqual(body.sourceUserAliases, ["dima_tag", "@dima_tag"]);
      assert.equal(body.sourceChatId, "777");
      assert.equal(body.sourceThreadId, undefined);
      assert.equal(body.sourceMessageId, "10");
      return jsonResponse({ run: { id: "run-1" } }, 202);
    }

    if (url.includes("/api/tool-services/channel.telegram.bot/outbox?")) {
      return jsonResponse({
        events: [
          {
            id: "outbox-1",
            summary: "answer ready",
            sourceChatId: "777",
            threadId: "thread-1",
            payload: { finalAnswer: "pong" },
          },
        ],
      });
    }

    if (url.includes("/sendMessage")) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("chat_id"), "777");
      assert.equal(parsed.searchParams.get("text"), "pong");
      assert.deepEqual(JSON.parse(parsed.searchParams.get("reply_markup") ?? "{}"), {
        inline_keyboard: [[{ text: "Continue thread", callback_data: "continue_thread:thread-1" }]],
      });
      return jsonResponse({ ok: true, result: { message_id: 99 } });
    }

    if (url.endsWith("/api/tool-services/channel.telegram.bot/outbox/outbox-1/ack")) {
      assert.equal(body.status, "sent");
      assert.equal(body.providerMessageId, "99");
      assert.equal(body.detail, undefined);
      return jsonResponse({ event: { id: "ack-1" } }, 201);
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  const result = await runTelegramBotServiceCycle({
    toolName: "channel.telegram.bot",
    token: "test-token",
    baseUrl: "http://agentic.local",
    offset: 0,
    fetchImpl: fakeFetch,
  });

  assert.equal(result.offset, 124);
  assert.equal(result.inboundCount, 1);
  assert.equal(result.deliveredCount, 1);
  assert.equal(calls.some((call) => call.url.includes("/getUpdates")), true);
  assert.equal(calls.some((call) => call.url.includes("/sendMessage")), true);
});

test("Telegram service cycle splits long outbound answers instead of truncating", async () => {
  const sentTexts: string[] = [];
  const longAnswer = "A".repeat(8200);
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;

    if (url.includes("/getUpdates")) return jsonResponse({ ok: true, result: [] });

    if (url.includes("/api/tool-services/channel.telegram.bot/outbox?")) {
      return jsonResponse({
        events: [
          {
            id: "outbox-long",
            summary: "long answer",
            sourceChatId: "777",
            payload: { finalAnswer: longAnswer },
          },
        ],
      });
    }

    if (url.includes("/sendMessage")) {
      const parsed = new URL(url);
      const text = parsed.searchParams.get("text") ?? "";
      sentTexts.push(text);
      assert.equal(text.includes("[truncated]"), false);
      assert.ok(text.length <= 4096);
      return jsonResponse({ ok: true, result: { message_id: sentTexts.length } });
    }

    if (url.endsWith("/api/tool-services/channel.telegram.bot/outbox/outbox-long/ack")) {
      assert.equal(body.status, "sent");
      assert.equal(body.providerMessageId, "1,2,3");
      return jsonResponse({ event: { id: "ack-long" } }, 201);
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  const result = await runTelegramBotServiceCycle({
    toolName: "channel.telegram.bot",
    token: "test-token",
    baseUrl: "http://agentic.local",
    offset: 0,
    fetchImpl: fakeFetch,
  });

  assert.equal(result.deliveredCount, 1);
  assert.equal(sentTexts.length, 3);
  assert.match(sentTexts[0]!, /\(1\/3\)$/);
  assert.match(sentTexts[2]!, /\(3\/3\)$/);
});

test("Telegram service cycle maps continue-thread callbacks to the next message", async () => {
  let answeredCallback = false;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;

    if (url.includes("/getUpdates")) {
      return jsonResponse({
        ok: true,
        result: [
          {
            update_id: 200,
            callback_query: {
              id: "callback-1",
              data: "continue_thread:thread-abc",
              from: { id: 42, username: "dima_tag" },
              message: { message_id: 88, chat: { id: 777 } },
            },
          },
          {
            update_id: 201,
            message: {
              message_id: 89,
              text: "follow up",
              chat: { id: 777 },
              from: { id: 42, username: "dima_tag" },
            },
          },
        ],
      });
    }

    if (url.includes("/answerCallbackQuery")) {
      answeredCallback = true;
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("callback_query_id"), "callback-1");
      return jsonResponse({ ok: true, result: true });
    }

    if (url.endsWith("/api/tool-services/channel.telegram.bot/inbound")) {
      assert.equal(body.text, "follow up");
      assert.equal(body.threadId, "thread-abc");
      assert.equal(body.sourceThreadId, undefined);
      assert.deepEqual(body.sourceUserAliases, ["dima_tag", "@dima_tag"]);
      return jsonResponse({ run: { id: "run-follow-up" } }, 202);
    }

    if (url.includes("/api/tool-services/channel.telegram.bot/outbox?")) {
      return jsonResponse({ events: [] });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  const result = await runTelegramBotServiceCycle({
    toolName: "channel.telegram.bot",
    token: "test-token",
    baseUrl: "http://agentic.local",
    offset: 0,
    continuationThreads: new Map(),
    fetchImpl: fakeFetch,
  });

  assert.equal(answeredCallback, true);
  assert.equal(result.inboundCount, 1);
  assert.equal(result.offset, 202);
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
