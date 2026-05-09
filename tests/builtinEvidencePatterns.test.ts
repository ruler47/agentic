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

test("BUILTIN_EVIDENCE_PATTERNS is an empty array (zero domain knowledge in runtime)", () => {
  assert.equal(Array.isArray(BUILTIN_EVIDENCE_PATTERNS), true);
  assert.equal(BUILTIN_EVIDENCE_PATTERNS.length, 0);
});

test("scoreUrlAgainstPatterns: empty patterns or empty intents always returns 0", () => {
  assert.equal(scoreUrlAgainstPatterns("https://anything.test/path", [], []), 0);
  assert.equal(scoreUrlAgainstPatterns("https://anything.test/path", ["x"], []), 0);
});

test("scoreUrlAgainstPatterns: built-in seed scores 0 for any URL (no domain knowledge)", () => {
  assert.equal(
    scoreUrlAgainstPatterns(
      "https://anything.test/path",
      ["any-intent"],
      BUILTIN_EVIDENCE_PATTERNS,
    ),
    0,
  );
});

test("scoreUrlAgainstPatterns: a caller-provided host pattern matches with the right intent", () => {
  const patterns: EvidencePattern[] = [
    { intent: "demo-intent", hosts: ["custom.test"], score: 90 },
  ];
  assert.equal(scoreUrlAgainstPatterns("https://custom.test/page", ["demo-intent"], patterns), 90);
  assert.equal(scoreUrlAgainstPatterns("https://custom.test/page", ["other"], patterns), 0);
});

test("scoreUrlAgainstPatterns: host + path patterns combine via AND", () => {
  const patterns: EvidencePattern[] = [
    { intent: "demo", hosts: ["site.test"], pathPatterns: ["/data"], score: 70 },
  ];
  assert.equal(scoreUrlAgainstPatterns("https://site.test/data/q", ["demo"], patterns), 70);
  // host matches but path does not → no score
  assert.equal(scoreUrlAgainstPatterns("https://site.test/other", ["demo"], patterns), 0);
});

test("scoreUrlAgainstPatterns: highest score wins when multiple patterns match", () => {
  const patterns: EvidencePattern[] = [
    { intent: "demo", hosts: ["a.test"], score: 50 },
    { intent: "demo", hosts: ["a.test"], pathPatterns: ["/x"], score: 90 },
  ];
  assert.equal(scoreUrlAgainstPatterns("https://a.test/x", ["demo"], patterns), 90);
});

test("isGenericLandingUrl: returns false for any URL when patterns are empty (no built-in knowledge)", () => {
  assert.equal(isGenericLandingUrl("https://anything.test/", BUILTIN_EVIDENCE_PATTERNS), false);
});

test("isGenericLandingUrl: returns true only for hosts the caller explicitly listed", () => {
  const patterns: EvidencePattern[] = [
    { intent: "demo", hosts: ["aggregator.test"], score: 90 },
  ];
  assert.equal(isGenericLandingUrl("https://aggregator.test/", patterns), true);
  assert.equal(isGenericLandingUrl("https://aggregator.test/deep/route", patterns), false);
  assert.equal(isGenericLandingUrl("https://other.test/", patterns), false);
});

test("ToolRegistry.evidencePatternsForIntents: collects only matching intent patterns from registered tools", () => {
  const registry = new ToolRegistry();
  registry.register(
    fakeTool("custom.tool", [
      { intent: "demo-a", hosts: ["mycarrier.example"], score: 200 },
      { intent: "demo-b", hosts: ["my-doctor.example"], score: 95 },
    ]),
  );
  registry.register(fakeTool("plain.tool"));

  const onlyA = registry.evidencePatternsForIntents(["demo-a"]);
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0].score, 200);
  assert.deepEqual(onlyA[0].hosts, ["mycarrier.example"]);

  const both = registry.evidencePatternsForIntents(["demo-a", "demo-b"]);
  assert.equal(both.length, 2);

  const none = registry.evidencePatternsForIntents([]);
  assert.equal(none.length, 0);
});

test("Tool patterns drive scoring without any built-in seed", () => {
  const registry = new ToolRegistry();
  registry.register(
    fakeTool("custom.tool", [
      { intent: "x-domain", hosts: ["custom.test"], pathPatterns: ["/data"], score: 200 },
    ]),
  );
  const all = [...BUILTIN_EVIDENCE_PATTERNS, ...registry.evidencePatternsForIntents(["x-domain"])];
  const score = scoreUrlAgainstPatterns("https://custom.test/data/q", ["x-domain"], all);
  assert.equal(score, 200);
});

test("scoreUrlAgainstPatterns: invalid URL returns 0 instead of throwing", () => {
  const patterns: EvidencePattern[] = [{ intent: "x", hosts: ["a.test"], score: 50 }];
  assert.equal(scoreUrlAgainstPatterns("not a url", ["x"], patterns), 0);
  assert.equal(scoreUrlAgainstPatterns("", ["x"], patterns), 0);
});
