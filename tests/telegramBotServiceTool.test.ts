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
              from: { id: 42 },
            },
          },
        ],
      });
    }

    if (url.endsWith("/api/tool-services/channel.telegram.bot/inbound")) {
      assert.equal(body.text, "hello agent");
      assert.equal(body.sourceUserId, "42");
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
            payload: { finalAnswer: "pong" },
          },
        ],
      });
    }

    if (url.includes("/sendMessage")) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("chat_id"), "777");
      assert.equal(parsed.searchParams.get("text"), "pong");
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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
