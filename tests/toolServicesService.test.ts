import assert from "node:assert/strict";
import test from "node:test";
import { filterToolServiceOutboundPayload } from "../src/server/modules/runs/run-agent-runtime-helpers.js";
import { ToolServicesService } from "../src/server/modules/tool-services/tool-services.service.js";
import { InMemoryUserStore } from "../src/instance/userStore.js";
import { InMemoryToolServiceEventStore } from "../src/tools/toolServiceEventStore.js";

function createService(input: {
  runFactory?: (body: unknown) => Promise<{ run: { id: string; threadId?: string }; threadResolution?: { threadId?: string } }>;
} = {}) {
  const events = new InMemoryToolServiceEventStore();
  const users = new InMemoryUserStore();
  const supervisor = {
    list: async () => [{ toolName: "channel.telegram", status: "running", desiredState: "running" }],
    listLogs: async () => [],
    onLog: () => () => undefined,
  };
  const audit = { record: async () => undefined };
  const runs = {
    createAndStart:
      input.runFactory ??
      (async () => ({
        run: { id: "run-from-inbound", threadId: "thread-from-inbound" },
        threadResolution: { threadId: "thread-from-inbound" },
      })),
  };
  return { service: new ToolServicesService(supervisor as never, events, users, audit as never, runs as never), events, users };
}

test("ToolServicesService records a failed system event when inbound cannot create a run", async () => {
  const { service, events } = createService({
    runFactory: async () => {
      throw new Error("Channel identity is not allowed or not mapped");
    },
  });

  await assert.rejects(
    service.inbound("channel.telegram", {
      task: "hello",
      channel: "channel.telegram",
      sourceUserId: "telegram-user",
      sourceChatId: "telegram-chat",
      sourceMessageId: "msg-1",
    }),
  );

  const recorded = await events.list({ toolName: "channel.telegram", limit: 10 });
  assert.equal(recorded.some((event) => event.direction === "inbound" && event.status === "received"), true);
  const failure = recorded.find((event) => event.direction === "system" && event.status === "failed");
  assert.match(failure?.summary ?? "", /did not create a run/);
  assert.equal(failure?.payload?.reason, "Channel identity is not allowed or not mapped");
});

test("ToolServicesService replays an existing inbound event after allowing its identity", async () => {
  const { service, events, users } = createService();
  const inbound = await events.record({
    toolName: "channel.telegram",
    direction: "inbound",
    status: "received",
    summary: "hello from telegram",
    sourceUserId: "38048300",
    sourceChatId: "38048300",
    sourceMessageId: "212",
    payload: {
      task: "hello from telegram",
      channel: "channel.telegram",
      sourceUserId: "38048300",
      sourceUserAliases: ["DimitriyB", "@DimitriyB"],
      sourceChatId: "38048300",
      sourceMessageId: "212",
    },
  });

  const result = await service.allowIdentity(inbound.id);

  assert.equal(result.identities.map((identity) => identity.providerUserId).sort().join(","), "38048300,@DimitriyB,DimitriyB");
  assert.equal((result.run as { id?: string } | undefined)?.id, "run-from-inbound");
  const listed = await users.list();
  assert.equal(
    listed[0]?.identities.filter((identity) => identity.provider === "channel.telegram").length,
    3,
  );
  const replay = (await events.list({ toolName: "channel.telegram", limit: 10 }))
    .find((event) => event.direction === "system" && event.status === "queued");
  assert.equal(replay?.runId, "run-from-inbound");
});

test("ToolServicesService resolves inbound replies to prior outbound provider messages", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const { service, events } = createService({
    runFactory: async (body) => {
      capturedBody = body as Record<string, unknown>;
      return {
        run: { id: "run-follow-up", threadId: String(capturedBody.threadId) },
        threadResolution: { threadId: String(capturedBody.threadId) },
      };
    },
  });
  await events.record({
    toolName: "channel.telegram",
    direction: "outbound",
    status: "sent",
    summary: "Telegram message sent",
    sourceUserId: "38048300",
    sourceChatId: "38048300",
    sourceMessageId: "user-message-1",
    threadId: "thread-original",
    runId: "run-original",
    payload: { providerMessageId: "bot-message-236" },
  });

  const result = await service.inbound("channel.telegram", {
    task: "арендуй мне виллу и свяжись с шефом, или в агенство напиши",
    channel: "channel.telegram",
    sourceUserId: "38048300",
    sourceChatId: "38048300",
    sourceMessageId: "user-message-2",
    replyToProviderMessageId: "bot-message-236",
  });

  assert.equal(result.run?.threadId, "thread-original");
  assert.equal(capturedBody?.threadId, "thread-original");
  assert.equal(capturedBody?.parentRunId, "run-original");
  const systemEvent = (await events.list({ toolName: "channel.telegram", limit: 10 }))
    .find((event) => event.direction === "system" && event.status === "queued");
  assert.equal(systemEvent?.payload?.replyResolution && typeof systemEvent.payload.replyResolution === "object", true);
});

test("ToolServicesService can allow an inbound event for a selected local user", async () => {
  const { service, events, users } = createService();
  const target = await users.create({ id: "user-family", displayName: "Family Member", role: "member" });
  const inbound = await events.record({
    toolName: "channel.telegram",
    direction: "inbound",
    status: "ignored",
    summary: "hello from telegram",
    sourceUserId: "telegram-user-2",
    sourceChatId: "telegram-chat-2",
    sourceMessageId: "msg-2",
    payload: { task: "hello from telegram", sourceUserAliases: ["family_handle"] },
  });

  const result = await service.allowIdentity(inbound.id, { userId: target.id });

  assert.equal(result.user.id, "user-family");
  const listed = await users.list();
  const family = listed.find((user) => user.id === "user-family");
  assert.deepEqual(
    family?.identities.map((identity) => identity.providerUserId).sort(),
    ["family_handle", "telegram-user-2"],
  );
});

test("ToolServicesService can create a user while allowing an inbound event", async () => {
  const { service, events, users } = createService();
  const inbound = await events.record({
    toolName: "channel.telegram",
    direction: "inbound",
    status: "ignored",
    summary: "hello from new telegram user",
    sourceUserId: "telegram-user-3",
    sourceChatId: "telegram-chat-3",
    sourceMessageId: "msg-3",
  });

  const result = await service.allowIdentity(inbound.id, {
    createUser: { displayName: "New Telegram User", role: "member" },
  });

  assert.equal(result.user.displayName, "New Telegram User");
  const listed = await users.list();
  const created = listed.find((user) => user.id === result.user.id);
  assert.equal(created?.identities[0]?.providerUserId, "telegram-user-3");
});

test("ToolServicesService redacts provider tokens from outbound ack detail", async () => {
  const { service, events } = createService();
  const queued = await events.record({
    toolName: "channel.telegram",
    direction: "outbound",
    status: "queued",
    summary: "Run completed",
    sourceUserId: "38048300",
    sourceChatId: "38048300",
    runId: "run-1",
  });

  const ack = await service.ackOutbox("channel.telegram", queued.id, {
    status: "failed",
    detail: "POST https://api.telegram.org/bot12345678:ABCDEF012345678901234567890/sendMessage failed: 400",
  });

  assert.doesNotMatch(JSON.stringify(ack), /12345678:ABCDEF/);
  assert.match(String(ack.payload?.detail), /\[redacted-token\]/);
});

test("filterToolServiceOutboundPayload keeps failed QA artifacts out of channel delivery", () => {
  const payload = filterToolServiceOutboundPayload({
    finalAnswer: "done",
    artifacts: [
      { id: "failed", quality: { status: "failed" } },
      { id: "passed", quality: { status: "passed" } },
      { id: "legacy-no-quality" },
    ],
  });

  assert.deepEqual(
    (payload.artifacts as Array<{ id: string }>).map((artifact) => artifact.id),
    ["passed", "legacy-no-quality"],
  );
  assert.deepEqual(payload.withheldArtifacts, { count: 1, reason: "quality_failed" });
});
