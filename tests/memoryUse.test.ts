import test from "node:test";
import assert from "node:assert/strict";

import { buildMemoryUseRecords } from "../src/agents/memoryUse.js";
import type { BaseAgentRunContext } from "../src/agents/baseAgent.js";
import { buildMemoryContextView } from "../src/agents/memoryContext.js";

test("memory-use projection marks thread context and accepted memory as used for thread-context answers", () => {
  const context: BaseAgentRunContext = {
    runId: "run-memory-use",
    threadId: "thread-memory-use",
    requester: {
      id: "user-admin",
      displayName: "Dimitrii",
      role: "admin",
      roles: ["admin"],
    },
    groupProfile: {
      id: "group-local",
      name: "Local Group",
      preferenceKeys: ["language"],
    },
    thread: {
      summary: "Answered: Bitcoin price came from CoinMarketCap.",
      acceptedFacts: ["Source: https://coinmarketcap.com/currencies/bitcoin/"],
      relevantArtifactIds: ["artifact-btc"],
    },
    acceptedMemories: [
      {
        id: "memory-russian",
        title: "Preferred language",
        tags: ["language"],
        summary: "Answer in concise Russian.",
        reusableProcedure: "Use Russian by default.",
        scope: "user",
        scopeId: "user-admin",
        status: "accepted",
        confidence: 0.9,
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    ],
  };
  context.memory = buildMemoryContextView(context, new Date("2026-06-22T10:00:00.000Z"));

  const records = buildMemoryUseRecords({
    runContext: context,
    taskFrame: {
      mode: "thread_context_answer",
      reason: "follow-up",
      researchDepth: "none",
      sourcePolicy: { externalResearch: "forbidden", reason: "no external research" },
      idealOutcome: "Answer from thread context.",
      userSuccessCriteria: [],
      likelyFailureModes: [],
      exceedExpectations: [],
      requiredEvidence: [],
      researchPlan: [],
      answerContract: { mustDo: [], mustAvoid: [], finalAnswerShape: [], proofStrategy: "thread" },
      researchContract: {
        minResearchToolCalls: 0,
        minIndependentSourceUrls: 0,
        minSourceReadToolCalls: 0,
        mustCheckFreshness: false,
        requiresClaimBasedProof: false,
      },
    },
  });

  assert.equal(records.find((record) => record.source === "thread")?.status, "used");
  assert.equal(records.find((record) => record.source === "accepted_memory")?.status, "used");
  assert.equal(records.find((record) => record.source === "user_profile")?.status, "used");
  assert.equal(records.find((record) => record.source === "group_profile")?.status, "used");
});

test("memory-use projection marks prior evidence stale for fresh/current tasks", () => {
  const context: BaseAgentRunContext = {
    runId: "run-current",
    threadId: "thread-current",
    priorWork: {
      decision: {
        decision: "refresh",
        reason: "The task asks for current/fresh data.",
        evidenceIds: [],
        artifactIds: [],
        sourceUrls: [],
        limitations: [],
        retryExclusions: [],
      },
      recentArtifacts: ["artifact-old"],
      successfulEvidence: [
        {
          id: "evidence-old",
          kind: "source_url",
          qaStatus: "passed",
          title: "Old BTC source",
          sourceUrl: "https://example.test/btc",
          limitations: [],
          createdAt: "2026-06-21T00:00:00.000Z",
        },
      ],
      rejectedEvidence: [],
      externalActionBlockers: [],
      retryExclusions: [],
      generatedAt: "2026-06-22T10:00:00.000Z",
    },
  };
  context.memory = buildMemoryContextView(context, new Date("2026-06-22T10:00:00.000Z"));

  const records = buildMemoryUseRecords({ runContext: context });

  assert.equal(records.find((record) => record.source === "work_ledger")?.status, "stale");
  assert.equal(records.find((record) => record.source === "evidence_ledger")?.status, "stale");
  assert.match(records.find((record) => record.source === "evidence_ledger")?.reason ?? "", /fresh|current/i);
});

test("memory-use projection marks parent-thread context used even when framing stays direct", () => {
  const context: BaseAgentRunContext = {
    runId: "run-follow-up",
    parentRunId: "run-parent",
    threadId: "thread-follow-up",
    thread: {
      summary: "Latest request: remember task08-ascii-memory.\nAnswered: task08-ascii-memory.",
      acceptedFacts: ["Latest completed task: remember task08-ascii-memory."],
      relevantArtifactIds: [],
    },
  };
  context.memory = buildMemoryContextView(context, new Date("2026-06-22T10:00:00.000Z"));

  const records = buildMemoryUseRecords({
    runContext: context,
    taskFrame: {
      mode: "direct_fact",
      reason: "narrow question",
      researchDepth: "none",
      sourcePolicy: { externalResearch: "allowed", reason: "external research is optional" },
      idealOutcome: "Answer directly.",
      userSuccessCriteria: [],
      likelyFailureModes: [],
      exceedExpectations: [],
      requiredEvidence: [],
      researchPlan: [],
      answerContract: { mustDo: [], mustAvoid: [], finalAnswerShape: [], proofStrategy: "none" },
      researchContract: {
        minResearchToolCalls: 0,
        minIndependentSourceUrls: 0,
        minSourceReadToolCalls: 0,
        mustCheckFreshness: false,
        requiresClaimBasedProof: false,
      },
    },
  });

  assert.equal(records.find((record) => record.source === "thread")?.status, "used");
});
