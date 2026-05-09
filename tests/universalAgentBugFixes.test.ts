import test from "node:test";
import assert from "node:assert/strict";
import { __testing__ } from "../src/agents/universalAgent.js";

const {
  guardSearchQueryAgainstUngroundedSpecifics,
  parseForbiddenTokensFromReviewNotes,
  geoBiasScore,
  getAllWorkerArtifacts,
  getApprovedArtifacts,
} = __testing__;

// Bug 2: pre-call ungrounded-gate on search query.
test("guardSearchQueryAgainstUngroundedSpecifics strips planner-injected hallucinated specifics", () => {
  const query = "best laptop RTX 4080 with 12GB VRAM under 2500 USD for LLM development";
  const userTask = "найди мне лучший ноутбук с бюджетом в 2500 долларов для LLM-разработки в Испании";
  const cleaned = guardSearchQueryAgainstUngroundedSpecifics(query, userTask);
  assert.ok(!/RTX\s*4080/i.test(cleaned), `RTX 4080 should be stripped: ${cleaned}`);
  // Generic terms remain.
  assert.ok(/laptop/i.test(cleaned));
  assert.ok(/LLM/i.test(cleaned));
});

test("guardSearchQueryAgainstUngroundedSpecifics keeps the query untouched when nothing is ungrounded", () => {
  const query = "best laptop for LLM development under 2500 USD in Spain";
  const userTask = "best laptop for LLM development under 2500 USD in Spain";
  assert.equal(guardSearchQueryAgainstUngroundedSpecifics(query, userTask), query);
});

// Bug 4: parse forbidden tokens out of review notes for the retry prompt.
test("parseForbiddenTokensFromReviewNotes extracts comma-separated tokens", () => {
  const notes =
    "Output names specifics that are NOT in tool evidence or the task: RTX 4080, ROG Zephyrus G14, $2500. The worker must ground every model number...";
  const tokens = parseForbiddenTokensFromReviewNotes(notes);
  assert.deepEqual(tokens, ["RTX 4080", "ROG Zephyrus G14", "$2500"]);
});

test("parseForbiddenTokensFromReviewNotes returns [] for non-grounding notes", () => {
  const notes = "Output describes weak or unusable browser/artifact evidence, such as a blank page.";
  assert.deepEqual(parseForbiddenTokensFromReviewNotes(notes), []);
});

// Bug 1: geo-anchor URL bias.
test("geoBiasScore boosts URLs containing the anchor token", () => {
  assert.equal(geoBiasScore("https://amazon.es/laptop", ["Spain"]), 0); // "spain" not in URL
  assert.equal(geoBiasScore("https://www.spain.shop", ["Spain"]), 1);
  assert.equal(geoBiasScore("https://amazon.es/laptop", ["es"]), 1);
  // Multiple anchors stack up to cap of 2.
  assert.equal(geoBiasScore("https://madrid-spain.shop", ["Spain", "Madrid"]), 2);
  // No anchors → no bonus.
  assert.equal(geoBiasScore("https://amazon.es", []), 0);
  // Accent-insensitive match.
  assert.equal(geoBiasScore("https://espana-tech.com", ["España"]), 1);
});

// Bug 3: artifact propagation to run-completed.
test("getAllWorkerArtifacts returns artifacts from EVERY worker, even failed reviews", () => {
  const reviewed = [
    {
      workerResult: {
        subtask: { id: "s1" } as never,
        output: "ok",
        artifacts: [
          { id: "a1", filename: "ok.png", url: "/a/1", mimeType: "image/png" } as never,
        ],
      },
      review: { subtaskId: "s1", verdict: "pass" as const, notes: "" },
      attempts: [],
      reviews: [],
    },
    {
      workerResult: {
        subtask: { id: "s2" } as never,
        output: "blocked",
        artifacts: [
          { id: "a2", filename: "blocked-page.png", url: "/a/2", mimeType: "image/png" } as never,
        ],
      },
      review: { subtaskId: "s2", verdict: "needs_revision" as const, notes: "blocker" },
      attempts: [],
      reviews: [],
    },
  ];
  const all = getAllWorkerArtifacts(reviewed as never);
  const approved = getApprovedArtifacts(reviewed as never);
  assert.equal(all.length, 2, "all artifacts collected");
  assert.equal(approved.length, 1, "only the passed worker's artifact is approved");
  assert.equal(approved[0].id, "a1");
});
