import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryConversationThreadStore } from "../src/conversations/inMemoryConversationThreadStore.js";

test("conversation threads track continuation context without full transcript replay", async () => {
  const store = new InMemoryConversationThreadStore();
  const thread = await store.create({
    title: "Найди билеты из Стамбула в Малагу",
    requesterUserId: "user-admin",
    channel: "web",
  });

  await store.appendMessage({
    threadId: thread.id,
    runId: "run-1",
    role: "user",
    content: "Найди билеты из Стамбула в Малагу",
  });
  await store.completeRun({
    threadId: thread.id,
    runId: "run-1",
    task: "Найди билеты из Стамбула в Малагу",
    finalAnswer: "Лучший вариант Turkish Airlines, приложен screenshot.",
    artifacts: [
      {
        id: "artifact-1",
        runId: "run-1",
        kind: "output",
        filename: "proof.png",
        mimeType: "image/png",
        sizeBytes: 42,
        url: "/api/runs/run-1/artifacts/artifact-1",
        createdAt: new Date().toISOString(),
      },
    ],
  });

  const updated = await store.get(thread.id);
  assert.equal(updated?.latestRunId, "run-1");
  assert.match(updated?.summary ?? "", /Latest request/);
  assert.match(updated?.summary ?? "", /Turkish Airlines/);
  assert.deepEqual(updated?.artifactIds, ["artifact-1"]);
  assert.equal(updated?.messages?.length, 2);
});

test("conversation threads can be deleted with their message history", async () => {
  const store = new InMemoryConversationThreadStore();
  const thread = await store.create({
    title: "temporary thread",
    requesterUserId: "user-admin",
    channel: "web",
  });

  await store.appendMessage({
    threadId: thread.id,
    runId: "run-1",
    role: "user",
    content: "delete me later",
  });

  assert.equal((await store.get(thread.id))?.messages?.length, 1);
  assert.equal(await store.delete(thread.id), true);
  assert.equal(await store.get(thread.id), undefined);
  assert.equal(await store.delete(thread.id), false);
});
