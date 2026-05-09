import test from "node:test";
import assert from "node:assert/strict";
import { __testing__ } from "../src/agents/universalAgent.js";
import type { Subtask } from "../src/types.js";
import type { EvidencePattern } from "../src/tools/tool.js";

const { inferTaskIntents, scoreArtifactUrl, selectBestUrlsForArtifact, buildSearchQueries } = __testing__;

function subtask(overrides: Partial<Subtask> = {}): Subtask {
  return {
    id: "sub-1",
    title: "Test subtask",
    role: "researcher",
    prompt: "",
    expectedOutput: "",
    reviewCriteria: [],
    requiredTools: [],
    dependencies: [],
    ...overrides,
  } as Subtask;
}

test("inferTaskIntents always returns [] (no regex) — runtime trusts the classifier", () => {
  // The classifier-resolved intents flow through `runScopedIntents`. The
  // shim in intentInference.ts is intentionally inert so legacy callers
  // (CLI smokes, fixtures without classification) get a defined value
  // and no domain logic fires.
  assert.deepEqual(inferTaskIntents("Find me the cheapest flight from LIS to LAX"), []);
  assert.deepEqual(inferTaskIntents("Подбери ноутбук с GPU для LLM"), []);
  assert.deepEqual(inferTaskIntents("Найди аллерголога в Мадриде"), []);
  assert.deepEqual(inferTaskIntents(""), []);
});

test("scoreArtifactUrl returns 0 for any URL when only the empty built-in seed is in play", () => {
  assert.equal(scoreArtifactUrl("https://www.google.com/travel/flights"), 0);
  assert.equal(scoreArtifactUrl("https://www.doctolib.fr/allergologue/paris"), 0);
  assert.equal(scoreArtifactUrl("https://anything.test/whatever"), 0);
});

test("scoreArtifactUrl honours caller-supplied patterns (tools / memory inject domain knowledge)", () => {
  const patterns: EvidencePattern[] = [
    { intent: "demo-flights", hosts: ["aggregator.example"], score: 100 },
  ];
  assert.equal(
    scoreArtifactUrl("https://aggregator.example/route/lis-lax", ["demo-flights"], patterns),
    100,
  );
  assert.equal(
    scoreArtifactUrl("https://aggregator.example/route/lis-lax", ["other"], patterns),
    0,
  );
});

test("selectBestUrlsForArtifact: with intents but no caller-supplied patterns, returns empty", () => {
  // Keeps the fix that prevents arxiv / sss.gov from leaking into a
  // laptop run: when intent is set and no pattern matches, the runtime
  // gives up cleanly so the LLM ranker layer (the caller) decides.
  const evidenceText = `
1. Random research paper: https://arxiv.org/html/2604.19856v1
2. https://anything.test/x
`;
  const selected = selectBestUrlsForArtifact(
    evidenceText,
    2,
    ["any-intent-the-classifier-might-emit"],
  );
  assert.deepEqual(selected, []);
});

test("selectBestUrlsForArtifact: without intents, legacy fallback returns first non-low-value URLs", () => {
  const evidenceText = `
1. https://www.example-blog.org/post
2. https://www.notebookcheck.net/laptops
`;
  const selected = selectBestUrlsForArtifact(evidenceText, 2, []);
  assert.equal(selected.length > 0, true);
});

test("selectBestUrlsForArtifact: caller-supplied patterns drive ranking when intents match", () => {
  const evidenceText = `
1. Top spec: https://aggregator.example/route/lis-lax
2. Off-topic: https://blog.example/post
3. Filler: https://news.example/article
`;
  const patterns: EvidencePattern[] = [
    { intent: "demo-flights", hosts: ["aggregator.example"], score: 110 },
  ];
  const selected = selectBestUrlsForArtifact(evidenceText, 2, ["demo-flights"], patterns);
  assert.equal(selected[0], "https://aggregator.example/route/lis-lax");
});

test("selectBestUrlsForArtifact: strips trailing backticks and parens from extracted URLs", () => {
  // Markdown-quoted evidence text used to leak ` and ) into candidate
  // URLs and break the LLM ranker's verbatim-match guard.
  const evidenceText = `
1. \`https://www.notebookcheck.net/laptops\`
2. [Click here](https://www.amazon.es/laptops)
3. See https://www.pccomponentes.com/laptops.
`;
  const selected = selectBestUrlsForArtifact(evidenceText, 3, []);
  for (const url of selected) {
    assert.ok(!url.endsWith("`"), `URL kept a trailing backtick: ${url}`);
    assert.ok(!url.endsWith(")"), `URL kept a trailing paren: ${url}`);
    assert.ok(!url.endsWith("."), `URL kept a trailing period: ${url}`);
  }
});

test("buildSearchQueries: laptop subtask with GPU/RAM/EUR does NOT append a parasitic flights query", () => {
  // The original Phase 12 regression: a regex named these tokens IATA
  // codes and tacked on "flights Google Flights Skyscanner Kayak". With
  // the regex removed entirely there is nothing left to trigger the leak.
  const subtaskInput = subtask({
    id: "scenario",
    title: "Scenario Mapping & User Clarification",
    prompt: `Plan technical trade-offs (GPU vs CPU, RAM vs SSD, LLM run cost in EUR).
RTX-class GPU, 32 GB RAM, ~2500 EUR budget.`,
  });
  const queries = buildSearchQueries(
    subtaskInput,
    "найди мне лучший ноутбук, бюджет 2500 евро",
  );
  for (const q of queries) {
    assert.ok(
      !/(flights|skyscanner|kayak|google flights)/i.test(q),
      `parasitic flight fragment leaked into query: ${q}`,
    );
  }
});

test("buildSearchQueries: query is built from planner-produced subtask, no regex source-name expansion", () => {
  const subtaskInput = subtask({
    id: "fly-1",
    title: "Find direct LIS to LAX flights",
    prompt: "Search aggregator sites the user named in their original task and return prices.",
  });
  const queries = buildSearchQueries(subtaskInput, "");
  // The planner-produced title is the dominant signal; the runtime no
  // longer injects "Google Flights Skyscanner Kayak" out of thin air.
  assert.ok(queries[0]?.includes("LIS to LAX flights"));
});
