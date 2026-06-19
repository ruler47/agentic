import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryGroupProfileStore } from "../src/instance/groupProfileStore.js";
import { InMemoryUserStore } from "../src/instance/userStore.js";
import { InMemorySkillMemory } from "../src/memory/skillMemory.js";
import { RunAgentRuntimeHelpers } from "../src/server/modules/runs/run-agent-runtime-helpers.js";
import type { AuditService } from "../src/server/common/services/audit.service.js";
import type { AppEnv } from "../src/server/config/env.js";
import type { AgentRunRecord } from "../src/runs/types.js";

test("RunAgentRuntimeHelpers injects accepted visible memory into BaseAgent run context", async () => {
  const memory = new InMemorySkillMemory();
  await memory.add({
    title: "Household language preference",
    tags: ["language"],
    summary: "Use Russian for default household answers.",
    reusableProcedure: "Answer in Russian unless the user asks otherwise.",
    scope: "group",
    scopeId: "group-local",
    status: "accepted",
    sensitivity: "normal",
    confidence: 0.92,
    evidence: ["operator accepted memory"],
  });
  await memory.add({
    title: "Draft preference",
    tags: ["draft"],
    summary: "This proposed memory must not be injected.",
    reusableProcedure: "Do not use.",
    scope: "group",
    scopeId: "group-local",
    status: "proposed",
    sensitivity: "normal",
  });

  const helpers = new RunAgentRuntimeHelpers(
    new InMemoryUserStore(),
    new InMemoryGroupProfileStore({
      id: "group-local",
      name: "Family HQ",
      preferences: { language: "ru" },
    }),
    { agentTimeZone: "Europe/Madrid" } as AppEnv,
    undefined,
    undefined,
    {} as AuditService,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    memory,
  );

  const run: AgentRunRecord = {
    id: "run_memory",
    task: "",
    status: "running",
    instanceId: "instance-local",
    requesterUserId: "user-admin",
    channel: "web",
    threadId: "thread_memory",
    createdAt: "2026-06-19T10:00:00.000Z",
    updatedAt: "2026-06-19T10:00:00.000Z",
    events: [],
  };

  const context = await helpers.buildBaseAgentRunContext(run, "Ответь на бытовой вопрос", [], {
    summary: "User is asking in Russian.",
    acceptedFacts: [],
    rejectedAttempts: [],
    openQuestions: [],
    relevantArtifactIds: [],
  });

  assert.equal(context.groupProfile?.name, "Family HQ");
  assert.deepEqual(context.acceptedMemories?.map((entry) => entry.title), [
    "Household language preference",
  ]);
});

test("RunAgentRuntimeHelpers ranks exact scoped memory above noisy global memories", async () => {
  const memory = new InMemorySkillMemory();
  for (let index = 0; index < 12; index += 1) {
    await memory.add({
      title: `Generic tool advice ${index}`,
      tags: ["memory", "tools", "answer"],
      summary: "Generic advice about answering questions from memory with tools.",
      reusableProcedure: "This is broad background and should not beat exact scoped memory.",
      scope: "global",
      status: "accepted",
      sensitivity: "normal",
      confidence: 1,
    });
  }
  await memory.add({
    title: "Runtime marker memory-smoke-exact-42",
    tags: ["memory-smoke-exact-42"],
    summary: "The exact answer for memory-smoke-exact-42 is EXACT_MEMORY_OK.",
    reusableProcedure: "Answer EXACT_MEMORY_OK when asked about memory-smoke-exact-42.",
    scope: "group",
    scopeId: "group-local",
    status: "accepted",
    sensitivity: "normal",
    confidence: 0.99,
  });

  const helpers = new RunAgentRuntimeHelpers(
    new InMemoryUserStore(),
    new InMemoryGroupProfileStore({ id: "group-local", name: "Family HQ" }),
    { agentTimeZone: "Europe/Madrid" } as AppEnv,
    undefined,
    undefined,
    {} as AuditService,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    memory,
  );

  const context = await helpers.buildBaseAgentRunContext(
    {
      id: "run_exact_memory",
      task: "",
      status: "running",
      requesterUserId: "user-admin",
      threadId: "thread_exact_memory",
      createdAt: "2026-06-19T10:00:00.000Z",
      updatedAt: "2026-06-19T10:00:00.000Z",
      events: [],
    },
    "Что означает memory-smoke-exact-42 в нашей памяти?",
    [],
    undefined,
  );

  assert.equal(context.acceptedMemories?.[0]?.title, "Runtime marker memory-smoke-exact-42");
});
