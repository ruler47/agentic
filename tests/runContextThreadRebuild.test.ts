import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryConversationThreadStore } from "../src/conversations/inMemoryConversationThreadStore.js";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { InMemoryUserStore } from "../src/instance/userStore.js";
import { RunContextResolver } from "../src/server/modules/runs/run-context-resolver.js";

// Regression: restart/resume started runs with only threadId — the agent
// got no thread summary/facts and answered follow-ups with amnesia
// (live: thread_1781286352553_ti7u2zbn).
test("threadContextForThreadId rebuilds summary, facts, and artifacts for restart paths", async () => {
  const runs = new InMemoryRunStore();
  const threads = new InMemoryConversationThreadStore();
  const users = new InMemoryUserStore();
  const resolver = new RunContextResolver(runs, threads, users);

  const thread = await threads.create({
    title: "Подбор ноутбука",
    requesterUserId: "user-admin",
    channel: "web",
  });
  await threads.completeRun({
    threadId: thread.id,
    runId: "run_prior",
    task: "найди мне лучший ноутбук до 2500 долларов",
    finalAnswer: "Рекомендую ASUS ROG Zephyrus G14 и MacBook Pro 14.",
    artifacts: [],
  });

  const context = await resolver.threadContextForThreadId(thread.id);
  assert.ok(context, "context must be rebuilt from the thread record");
  assert.match(context.summary ?? "", /ASUS ROG Zephyrus G14/);
  assert.ok((context.acceptedFacts ?? []).some((fact) => fact.includes("ноутбук")));

  assert.equal(await resolver.threadContextForThreadId("missing-thread"), undefined);
});
