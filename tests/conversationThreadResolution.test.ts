import test from "node:test";
import assert from "node:assert/strict";
import { resolveConversationThread } from "../src/conversations/threadResolution.js";
import { ConversationThreadRecord } from "../src/conversations/types.js";

test("thread resolution keeps follow-up channel messages in the latest matching thread", () => {
  const older = thread({ id: "thread-old", updatedAt: "2026-05-03T10:00:00.000Z" });
  const latest = thread({ id: "thread-latest", updatedAt: "2026-05-03T11:00:00.000Z" });

  const result = resolveConversationThread({
    task: "а теперь добавь туда скриншот и проверь результат",
    requesterUserId: "user-admin",
    channel: "telegram",
    sourceChatId: "chat-1",
    threads: [older, latest],
  });

  assert.equal(result.decision, "continue_thread");
  assert.equal(result.thread?.id, "thread-latest");
  assert.match(result.reason, /continuation/i);
});

test("thread resolution classifies corrections and clarifications separately", () => {
  const existing = thread({ id: "thread-medical" });

  const correction = resolveConversationThread({
    task: "нет, исправь дозировку в прошлом ответе",
    requesterUserId: "user-admin",
    channel: "telegram",
    sourceChatId: "chat-1",
    threads: [existing],
  });
  const clarification = resolveConversationThread({
    task: "почему ты выбрал именно этот источник?",
    requesterUserId: "user-admin",
    channel: "telegram",
    sourceChatId: "chat-1",
    threads: [existing],
  });

  assert.equal(correction.decision, "correction");
  assert.equal(correction.thread?.id, existing.id);
  assert.equal(clarification.decision, "clarification");
  assert.equal(clarification.thread?.id, existing.id);
});

test("thread resolution starts a new task when the message is independent or explicitly new", () => {
  const existing = thread({ id: "thread-existing" });

  const independent = resolveConversationThread({
    task: "найди пять городов Испании по населению",
    requesterUserId: "user-admin",
    channel: "telegram",
    sourceChatId: "chat-1",
    threads: [existing],
  });
  const explicit = resolveConversationThread({
    task: "/new составь отдельный план отпуска",
    requesterUserId: "user-admin",
    channel: "telegram",
    sourceChatId: "chat-1",
    threads: [existing],
  });

  assert.equal(independent.decision, "new_task");
  assert.equal(independent.thread, undefined);
  assert.equal(explicit.decision, "new_task");
  assert.equal(explicit.thread, undefined);
});

function thread(overrides: Partial<ConversationThreadRecord>): ConversationThreadRecord {
  return {
    id: "thread-1",
    status: "active",
    title: "Existing task",
    requesterUserId: "user-admin",
    channel: "telegram",
    sourceChatId: "chat-1",
    sourceThreadId: undefined,
    latestRunId: "run-1",
    summary: "Existing summary.",
    acceptedFacts: [],
    rejectedAttempts: [],
    openQuestions: [],
    artifactIds: [],
    createdAt: "2026-05-03T09:00:00.000Z",
    updatedAt: "2026-05-03T11:00:00.000Z",
    messages: [],
    ...overrides,
  };
}
