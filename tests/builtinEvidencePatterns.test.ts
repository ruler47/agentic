import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_EVIDENCE_PATTERNS,
  isGenericLandingUrl,
  scoreUrlAgainstPatterns,
} from "../src/tools/builtinEvidencePatterns.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { Tool, EvidencePattern } from "../src/tools/tool.js";

function fakeTool(name: string, evidencePatterns?: EvidencePattern[]): Tool {
  return {
    name,
    description: `fake tool ${name}`,
    capabilities: [],
    evidencePatterns,
    async run() {
      return { ok: true, content: "noop" };
    },
  };
}

test("scoreUrlAgainstPatterns: empty patterns or empty intents always returns 0", () => {
  assert.equal(scoreUrlAgainstPatterns("https://www.example.com/", [], BUILTIN_EVIDENCE_PATTERNS), 0);
  assert.equal(scoreUrlAgainstPatterns("https://www.example.com/", ["flight-search"], []), 0);
});

test("scoreUrlAgainstPatterns: built-in flight pattern matches google.com/travel/flights with flight-search intent", () => {
  const score = scoreUrlAgainstPatterns(
    "https://www.google.com/travel/flights?tfs=abc",
    ["flight-search"],
    BUILTIN_EVIDENCE_PATTERNS,
  );
  assert.equal(score, 120);
});

test("scoreUrlAgainstPatterns: same URL scores 0 with medical-lookup intent only", () => {
  const score = scoreUrlAgainstPatterns(
    "https://www.google.com/travel/flights",
    ["medical-lookup"],
    BUILTIN_EVIDENCE_PATTERNS,
  );
  assert.equal(score, 0);
});

test("scoreUrlAgainstPatterns: skyscanner routes URL scores 110 (host + path AND match)", () => {
  const ok = scoreUrlAgainstPatterns(
    "https://www.skyscanner.net/routes/lis/lax",
    ["flight-search"],
    BUILTIN_EVIDENCE_PATTERNS,
  );
  assert.equal(ok, 110);
  // skyscanner.net homepage has no path match → 0
  const home = scoreUrlAgainstPatterns(
    "https://www.skyscanner.net/",
    ["flight-search"],
    BUILTIN_EVIDENCE_PATTERNS,
  );
  assert.equal(home, 0);
});

test("scoreUrlAgainstPatterns: doctolib scores 90 with medical-lookup intent (host-only pattern)", () => {
  assert.equal(
    scoreUrlAgainstPatterns(
      "https://www.doctolib.fr/allergologue/paris",
      ["medical-lookup"],
      BUILTIN_EVIDENCE_PATTERNS,
    ),
    90,
  );
});

test("scoreUrlAgainstPatterns: highest score wins when multiple patterns match", () => {
  // path-pattern doctor (70) and host doctolib (90) both match — should return 90
  const result = scoreUrlAgainstPatterns(
    "https://www.doctolib.fr/find-a-doctor/paris",
    ["medical-lookup"],
    BUILTIN_EVIDENCE_PATTERNS,
  );
  assert.equal(result, 90);
});

test("isGenericLandingUrl: bare aggregator host is generic", () => {
  assert.equal(isGenericLandingUrl("https://www.skyscanner.net/", BUILTIN_EVIDENCE_PATTERNS), true);
  assert.equal(isGenericLandingUrl("https://www.kayak.com", BUILTIN_EVIDENCE_PATTERNS), true);
  assert.equal(isGenericLandingUrl("https://www.google.com/travel/flights", BUILTIN_EVIDENCE_PATTERNS), true);
});

test("isGenericLandingUrl: deep-linked aggregator route is NOT generic", () => {
  assert.equal(
    isGenericLandingUrl("https://www.skyscanner.net/routes/lis/lax", BUILTIN_EVIDENCE_PATTERNS),
    false,
  );
});

test("isGenericLandingUrl: unknown host is never generic", () => {
  assert.equal(isGenericLandingUrl("https://www.example.com/", BUILTIN_EVIDENCE_PATTERNS), false);
});

test("ToolRegistry.evidencePatternsForIntents: collects only matching intent patterns from registered tools", () => {
  const registry = new ToolRegistry();
  registry.register(
    fakeTool("custom.flight", [
      { intent: "flight-search", hosts: ["mycarrier.example"], score: 200 },
      { intent: "medical-lookup", hosts: ["my-doctor.example"], score: 95 },
    ]),
  );
  registry.register(fakeTool("plain.tool"));

  const flightOnly = registry.evidencePatternsForIntents(["flight-search"]);
  assert.equal(flightOnly.length, 1);
  assert.equal(flightOnly[0].score, 200);
  assert.deepEqual(flightOnly[0].hosts, ["mycarrier.example"]);

  const both = registry.evidencePatternsForIntents(["flight-search", "medical-lookup"]);
  assert.equal(both.length, 2);

  const none = registry.evidencePatternsForIntents([]);
  assert.equal(none.length, 0);
});

test("ToolRegistry pattern beats built-in for the same URL when score is higher", () => {
  // Combined pattern list (built-in + a tool with stronger override)
  const registry = new ToolRegistry();
  registry.register(
    fakeTool("custom.flight", [
      { intent: "flight-search", hosts: ["google.com"], pathPatterns: ["/travel/flights"], score: 200 },
    ]),
  );
  const all = [...BUILTIN_EVIDENCE_PATTERNS, ...registry.evidencePatternsForIntents(["flight-search"])];
  const score = scoreUrlAgainstPatterns(
    "https://www.google.com/travel/flights",
    ["flight-search"],
    all,
  );
  assert.equal(score, 200);
});

test("scoreUrlAgainstPatterns: invalid URL returns 0 instead of throwing", () => {
  assert.equal(scoreUrlAgainstPatterns("not a url", ["flight-search"], BUILTIN_EVIDENCE_PATTERNS), 0);
  assert.equal(scoreUrlAgainstPatterns("", ["flight-search"], BUILTIN_EVIDENCE_PATTERNS), 0);
});
