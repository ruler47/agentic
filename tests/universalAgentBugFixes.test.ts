import test from "node:test";
import assert from "node:assert/strict";
import { __testing__ } from "../src/agents/universalAgent.js";

const {
  guardSearchQueryAgainstUngroundedSpecifics,
  guardDeclaredToolInputAgainstUngroundedSpecifics,
  parseForbiddenTokensFromReviewNotes,
  geoBiasScore,
  getAllWorkerArtifacts,
  getApprovedArtifacts,
  improveDeclaredToolInput,
  isShallowLandingUrl,
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

// Bug 5b: deep-walk ungrounded gate on toolInputs (browser type/text commands).
test("guardDeclaredToolInputAgainstUngroundedSpecifics strips planner-injected specifics from browser type commands", () => {
  const planned = {
    commands: [
      { type: "navigate", url: "https://www.google.com" },
      { type: "type", text: "best portable laptop for local LLM and gaming under 2500 USD RTX 4080 32GB RAM" },
      { type: "pressEnter" },
      { type: "extractText" },
    ],
  };
  const userTask = "найди мне лучший ноутбук для программирования и LLM-разработки";
  const cleaned = guardDeclaredToolInputAgainstUngroundedSpecifics(planned, userTask) as typeof planned;
  // URL is preserved (structural rewrite is improveDeclaredToolInput's job).
  assert.equal(cleaned.commands[0].url, "https://www.google.com");
  // Hallucinated GPU spec stripped from text.
  assert.ok(!/RTX\s*4080/i.test(cleaned.commands[1].text!), `text still has RTX 4080: ${cleaned.commands[1].text}`);
  // Generic vocabulary preserved.
  assert.ok(/laptop/i.test(cleaned.commands[1].text!));
});

test("guardDeclaredToolInputAgainstUngroundedSpecifics is a deep no-op when nothing is ungrounded", () => {
  const planned = {
    commands: [
      { type: "navigate", url: "https://example.com/page" },
      { type: "extractText" },
    ],
  };
  const userTask = "find me a generic page";
  const cleaned = guardDeclaredToolInputAgainstUngroundedSpecifics(planned, userTask) as typeof planned;
  assert.deepEqual(cleaned, planned);
});

// Bug 5c: improveDeclaredToolInput fallback when no pattern matches.
test("improveDeclaredToolInput rewrites homepage navigation to first non-low-value URL when patterns return empty", () => {
  const subtask = {
    id: "discovery",
    title: "Identify candidates",
    role: "researcher",
    prompt: "Search for laptops",
    expectedOutput: "list of candidates",
    reviewCriteria: [],
    requiredTools: [],
    dependencies: [],
  };
  const input = {
    commands: [
      { type: "navigate", url: "https://www.amazon.com" },
      { type: "extractText" },
    ],
  };
  const priorEvidence = [
    "Search results: https://www.tomshardware.com/laptops/best-laptops 'Best Laptops 2026'",
    "Search results: https://www.nytimes.com/wirecutter/reviews/best-laptops 'The 14 Best Laptops of 2026'",
  ];
  const result = improveDeclaredToolInput(
    "browser.operate",
    input,
    subtask as never,
    priorEvidence,
    [],
    ["product-comparison"], // no built-in pattern for this intent → fallback
  ) as typeof input;
  // Should have rewritten to the first non-low-value URL.
  const navigates = result.commands.filter((c) => (c as { type: string }).type === "navigate");
  assert.ok(navigates.length >= 1);
  const newUrl = (navigates[0] as { url: string }).url;
  assert.notEqual(newUrl, "https://www.amazon.com");
  assert.ok(/tomshardware\.com|nytimes\.com/.test(newUrl), `fallback URL should be from priorEvidence: ${newUrl}`);
});

test("isShallowLandingUrl flags root and single-segment paths", () => {
  assert.equal(isShallowLandingUrl("https://www.amazon.com"), true);
  assert.equal(isShallowLandingUrl("https://www.amazon.com/"), true);
  assert.equal(isShallowLandingUrl("https://www.amazon.com/laptops"), true); // 1 segment is still shallow
  assert.equal(isShallowLandingUrl("https://www.amazon.com/laptops/RTX-5050/dp/ABC"), false);
  // Query strings preserve depth.
  assert.equal(isShallowLandingUrl("https://www.amazon.com/?s=laptop"), false);
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
