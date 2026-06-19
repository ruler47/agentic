import test from "node:test";
import assert from "node:assert/strict";
import type { SkillMemoryEntry } from "../src/types.js";
import {
  buildMemoryContextView,
  formatMemoryContextForPrompt,
  publicMemoryContextForTrace,
  visibleMemoryScopesForRunContext,
} from "../src/agents/memoryContext.js";

const createdAt = "2026-06-01T00:00:00.000Z";

function memory(overrides: Partial<SkillMemoryEntry>): SkillMemoryEntry {
  return {
    id: overrides.id ?? "memory_1",
    title: overrides.title ?? "Default memory",
    tags: overrides.tags ?? ["default"],
    summary: overrides.summary ?? "Default summary",
    reusableProcedure: overrides.reusableProcedure ?? "Default procedure",
    scope: overrides.scope ?? "global",
    scopeId: overrides.scopeId,
    status: overrides.status ?? "accepted",
    confidence: overrides.confidence ?? 0.8,
    sensitivity: overrides.sensitivity ?? "normal",
    sourceRunId: overrides.sourceRunId,
    sourceThreadId: overrides.sourceThreadId,
    evidence: overrides.evidence ?? [],
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
  };
}

test("memory context exposes the exact visible scopes for a run", () => {
  const scopes = visibleMemoryScopesForRunContext({
    runId: "run_1",
    requesterUserId: "user_1",
    threadId: "thread_1",
    groupProfile: { id: "group_1", name: "Family" },
  });

  assert.deepEqual(scopes, [
    { scope: "global" },
    { scope: "group", scopeId: "group_1" },
    { scope: "user", scopeId: "user_1" },
    { scope: "thread", scopeId: "thread_1" },
    { scope: "run", scopeId: "run_1" },
  ]);
});

test("memory context injects only accepted memories allowed by scope and policy", () => {
  const view = buildMemoryContextView(
    {
      runId: "run_1",
      requesterUserId: "user_1",
      threadId: "thread_1",
      groupProfile: { id: "group_1", name: "Family" },
      acceptedMemories: [
        memory({ id: "global", title: "Global convention", scope: "global" }),
        memory({ id: "group", title: "Group preference", scope: "group", scopeId: "group_1" }),
        memory({ id: "user", title: "Private same user", scope: "user", scopeId: "user_1", sensitivity: "private" }),
        memory({ id: "other-user", title: "Private other user", scope: "user", scopeId: "user_2", sensitivity: "private" }),
        memory({ id: "proposed", title: "Proposed item", scope: "thread", scopeId: "thread_1", status: "proposed" }),
        memory({ id: "sensitive", title: "Sensitive item", scope: "group", scopeId: "group_1", sensitivity: "sensitive" }),
      ],
    },
    new Date("2026-06-19T12:00:00.000Z"),
  );

  assert.deepEqual(view.acceptedLearning.map((entry) => entry.id), ["global", "group", "user"]);
  assert.equal(view.generatedAt, "2026-06-19T12:00:00.000Z");
  const prompt = formatMemoryContextForPrompt(view);
  assert.match(prompt, /Global convention/);
  assert.match(prompt, /Group preference/);
  assert.match(prompt, /Private same user/);
  assert.doesNotMatch(prompt, /Private other user/);
  assert.doesNotMatch(prompt, /Proposed item/);
  assert.doesNotMatch(prompt, /Sensitive item/);

  const trace = publicMemoryContextForTrace(view) as { acceptedLearning?: Array<{ id: string }> };
  assert.deepEqual(trace.acceptedLearning?.map((entry) => entry.id), ["global", "group", "user"]);
});

test("memory context preserves thread artifacts and prior facts for follow-ups", () => {
  const view = buildMemoryContextView({
    runId: "run_1",
    threadId: "thread_1",
    thread: {
      summary: "Asked for the BTC price. Answered with CoinMarketCap.",
      acceptedFacts: ["BTC source was CoinMarketCap"],
      openQuestions: ["User may ask about source"],
      relevantArtifactIds: ["artifact_1"],
      relevantArtifacts: [
        {
          id: "artifact_1",
          runId: "run_source",
          filename: "btc.png",
          mimeType: "image/png",
          sizeBytes: 42,
          description: "BTC price screenshot",
          contentPreview: "BTC price $77,000",
          qualityStatus: "passed",
          qualitySignals: ["contains price"],
        },
      ],
    },
  });

  const prompt = formatMemoryContextForPrompt(view);
  assert.match(prompt, /Thread summary: Asked for the BTC price/);
  assert.match(prompt, /Accepted thread facts: BTC source was CoinMarketCap/);
  assert.match(prompt, /Prior artifact summaries:/);
  assert.match(prompt, /btc\.png/);
  assert.match(prompt, /BTC price \$77,000/);
  assert.match(prompt, /do not repeat identical external\/API tool calls/);
});
