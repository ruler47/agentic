import test from "node:test";
import assert from "node:assert/strict";
import { __testing__ } from "../src/agents/universalAgent.js";
import type { Subtask } from "../src/types.js";

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

test("inferTaskIntents: laptop research with GPU/RAM/CPU/LLM does not match flight-search or medical-lookup", () => {
  const text = `найди мне лучший ноутбук для работы программистом и развлечений, в том числе чтобы LLM нормальную можно было развернуть и в путешествия взять.
бюджет до 2500 евро
GPU RTX 4080, 32 GB RAM, fast SSD, EUR price`;
  assert.deepEqual(inferTaskIntents(text), []);
});

test("inferTaskIntents: real flight task matches flight-search", () => {
  const text = "Find me the cheapest flight from LIS to LAX next week";
  assert.deepEqual(inferTaskIntents(text), ["flight-search"]);
});

test("inferTaskIntents: russian flight phrasing matches", () => {
  const text = "Подбери авиабилеты Москва - Стамбул на ноябрь, ищу прямой перелёт";
  assert.deepEqual(inferTaskIntents(text), ["flight-search"]);
});

test("inferTaskIntents: medical query matches medical-lookup", () => {
  const text = "Найди аллерголога-иммунолога в Мадриде с приёмом на эту неделю";
  assert.deepEqual(inferTaskIntents(text), ["medical-lookup"]);
});

test("inferTaskIntents: 'domain specialist' tech context does not trigger medical-lookup", () => {
  const text = "Plan how to bring a domain specialist into the architecture review for the runtime services team";
  assert.deepEqual(inferTaskIntents(text), []);
});

test("scoreArtifactUrl: google.com/travel/flights scores 0 without flight-search intent", () => {
  assert.equal(scoreArtifactUrl("https://www.google.com/travel/flights?tfs=abc"), 0);
  assert.equal(scoreArtifactUrl("https://www.google.com/travel/flights", []), 0);
});

test("scoreArtifactUrl: google.com/travel/flights scores 120 with flight-search intent", () => {
  assert.equal(scoreArtifactUrl("https://www.google.com/travel/flights", ["flight-search"]), 120);
});

test("scoreArtifactUrl: doctolib scores 0 without medical-lookup intent", () => {
  assert.equal(scoreArtifactUrl("https://www.doctolib.fr/allergologue/paris", []), 0);
});

test("scoreArtifactUrl: doctolib scores 90 with medical-lookup intent", () => {
  assert.equal(scoreArtifactUrl("https://www.doctolib.fr/allergologue/paris", ["medical-lookup"]), 90);
});

test("selectBestUrlsForArtifact: laptop intent rejects flights URL even when present in evidence text", () => {
  const evidenceText = `
1. PCComponentes top picks: https://www.pccomponentes.com/laptops
2. Amazon ES catalog: https://www.amazon.es/laptops
3. Polluting flight result: https://www.google.com/travel/flights
`;
  const selected = selectBestUrlsForArtifact(evidenceText, 2, []);
  assert.ok(!selected.includes("https://www.google.com/travel/flights"),
    `expected flight URL to lose to non-flight URLs, got: ${selected.join(", ")}`);
  assert.ok(selected.length > 0);
});

test("selectBestUrlsForArtifact: real flight intent keeps google.com/travel/flights on top", () => {
  const evidenceText = `
1. Flight aggregator: https://www.google.com/travel/flights
2. Random news article: https://www.bbc.com/news
3. Skyscanner: https://www.skyscanner.net/routes/lis/lax
`;
  const selected = selectBestUrlsForArtifact(evidenceText, 2, ["flight-search"]);
  assert.equal(selected[0], "https://www.google.com/travel/flights");
});

test("buildSearchQueries: laptop subtask with GPU/RAM/EUR does NOT append a parasitic flights query", () => {
  const subtaskInput = subtask({
    id: "scenario-mapping",
    title: "Scenario Mapping & User Clarification",
    prompt: `Present these scenarios in Russian to the user, explain technical trade-offs (GPU vs CPU, RAM vs SSD, LLM run cost in EUR), then ask them to select one.
RTX-class GPU, 32 GB RAM, ~2500 EUR budget.`,
  });
  const queries = buildSearchQueries(subtaskInput, "найди мне лучший ноутбук для работы программистом и развлечений, бюджет до 2500 евро");
  for (const q of queries) {
    assert.ok(
      !/flights|skyscanner|kayak|google flights/i.test(q),
      `parasitic flight fragment leaked into query: ${q}`,
    );
  }
});

test("buildSearchQueries: real flight subtask still emits the IATA-derived query", () => {
  const subtaskInput = subtask({
    id: "fly-1",
    title: "Find flight LIS to LAX",
    prompt: `Find the cheapest direct flight from LIS to LAX departing next Monday.
Compare Skyscanner, Google Flights, Kayak.`,
  });
  const queries = buildSearchQueries(subtaskInput, "Find me the cheapest flight from LIS to LAX next week");
  assert.ok(
    queries.some((q) => /LIS .*LAX.*flights/i.test(q) || /LAX .*LIS.*flights/i.test(q)),
    `expected an IATA-style flight query, got: ${queries.join(" | ")}`,
  );
});

test("buildSearchQueries: medical subtask still emits medical seed query when context hints fire", () => {
  const subtaskInput = subtask({
    id: "doc-1",
    title: "Find allergologist Madrid",
    prompt: "Find a paediatric allergologist accepting new patients in Madrid this week.",
  });
  const queries = buildSearchQueries(subtaskInput, "find me an allergologist in Madrid Spain for my child");
  assert.ok(
    queries.some((q) => /Doctolib|Jameda|OneDoc|doctor directory/i.test(q)),
    `expected a doctor-directory query, got: ${queries.join(" | ")}`,
  );
});
