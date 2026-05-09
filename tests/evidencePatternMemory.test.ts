import test from "node:test";
import assert from "node:assert/strict";
import {
  loadEvidencePatternsFromMemory,
  parseEvidencePatternMemory,
} from "../src/memory/evidencePatternMemory.js";
import { SkillMemoryStore, normalizeEntry } from "../src/memory/skillMemory.js";
import { SkillMemoryEntry } from "../src/types.js";

class InMemoryMemoryStore implements SkillMemoryStore {
  private entries: SkillMemoryEntry[] = [];

  seed(entries: SkillMemoryEntry[]): void {
    this.entries = entries.map(normalizeEntry);
  }

  async list(): Promise<SkillMemoryEntry[]> {
    return [...this.entries];
  }

  async search(): Promise<SkillMemoryEntry[]> {
    return [];
  }

  async add(): Promise<SkillMemoryEntry> {
    throw new Error("not implemented in test fake");
  }
}

function makeMemory(overrides: Partial<SkillMemoryEntry>): SkillMemoryEntry {
  return normalizeEntry({
    id: overrides.id ?? `mem-${Math.random()}`,
    title: overrides.title ?? "Test",
    summary: overrides.summary ?? "",
    reusableProcedure: overrides.reusableProcedure ?? "",
    tags: overrides.tags ?? [],
    scope: overrides.scope ?? "global",
    scopeId: overrides.scopeId,
    status: overrides.status ?? "accepted",
    confidence: overrides.confidence ?? 0.8,
    sensitivity: overrides.sensitivity ?? "normal",
    sourceRunId: overrides.sourceRunId,
    sourceThreadId: overrides.sourceThreadId,
    evidence: overrides.evidence ?? [],
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  });
}

test("parseEvidencePatternMemory: valid host-only pattern", () => {
  const entry = makeMemory({
    id: "mem-1",
    tags: ["evidence-pattern", "intent:product-comparison"],
    reusableProcedure: JSON.stringify({ hosts: ["pccomponentes.com", "amazon.es"], score: 95 }),
  });
  const parsed = parseEvidencePatternMemory(entry);
  assert.ok("pattern" in parsed);
  if ("pattern" in parsed) {
    assert.equal(parsed.pattern.intent, "product-comparison");
    assert.deepEqual(parsed.pattern.hosts, ["pccomponentes.com", "amazon.es"]);
    assert.equal(parsed.pattern.score, 95);
  }
});

test("parseEvidencePatternMemory: missing evidence-pattern tag is rejected", () => {
  const entry = makeMemory({
    tags: ["intent:flight-search"],
    reusableProcedure: JSON.stringify({ hosts: ["x.com"], score: 50 }),
  });
  const parsed = parseEvidencePatternMemory(entry);
  assert.ok("reason" in parsed);
});

test("parseEvidencePatternMemory: missing intent tag is rejected", () => {
  const entry = makeMemory({
    tags: ["evidence-pattern"],
    reusableProcedure: JSON.stringify({ hosts: ["x.com"], score: 50 }),
  });
  const parsed = parseEvidencePatternMemory(entry);
  assert.ok("reason" in parsed);
});

test("parseEvidencePatternMemory: empty body is rejected", () => {
  const entry = makeMemory({
    tags: ["evidence-pattern", "intent:flight-search"],
    reusableProcedure: "",
  });
  const parsed = parseEvidencePatternMemory(entry);
  assert.ok("reason" in parsed);
});

test("parseEvidencePatternMemory: invalid JSON yields a parse error", () => {
  const entry = makeMemory({
    tags: ["evidence-pattern", "intent:flight-search"],
    reusableProcedure: "{not json",
  });
  const parsed = parseEvidencePatternMemory(entry);
  assert.ok("reason" in parsed);
  if ("reason" in parsed) {
    assert.match(parsed.reason, /JSON parse failed/);
  }
});

test("parseEvidencePatternMemory: spec without hosts/urlPatterns/pathPatterns is rejected", () => {
  const entry = makeMemory({
    tags: ["evidence-pattern", "intent:flight-search"],
    reusableProcedure: JSON.stringify({ score: 100, notes: "no patterns provided" }),
  });
  const parsed = parseEvidencePatternMemory(entry);
  assert.ok("reason" in parsed);
});

test("parseEvidencePatternMemory: clamps score to [0,200]", () => {
  const entry = makeMemory({
    tags: ["evidence-pattern", "intent:test"],
    reusableProcedure: JSON.stringify({ hosts: ["x.com"], score: 9999 }),
  });
  const parsed = parseEvidencePatternMemory(entry);
  if ("pattern" in parsed) {
    assert.equal(parsed.pattern.score, 200);
  } else {
    assert.fail("expected pattern");
  }
});

test("parseEvidencePatternMemory: defaults score to 50 when omitted", () => {
  const entry = makeMemory({
    tags: ["evidence-pattern", "intent:test"],
    reusableProcedure: JSON.stringify({ hosts: ["x.com"] }),
  });
  const parsed = parseEvidencePatternMemory(entry);
  if ("pattern" in parsed) {
    assert.equal(parsed.pattern.score, 50);
  } else {
    assert.fail("expected pattern");
  }
});

test("loadEvidencePatternsFromMemory: filters by accepted status and active intents", async () => {
  const store = new InMemoryMemoryStore();
  store.seed([
    makeMemory({
      id: "accepted-flight",
      status: "accepted",
      tags: ["evidence-pattern", "intent:flight-search"],
      reusableProcedure: JSON.stringify({ hosts: ["mycarrier.example"], score: 130 }),
    }),
    makeMemory({
      id: "proposed-flight",
      status: "proposed",
      tags: ["evidence-pattern", "intent:flight-search"],
      reusableProcedure: JSON.stringify({ hosts: ["unreviewed.example"], score: 130 }),
    }),
    makeMemory({
      id: "accepted-other",
      status: "accepted",
      tags: ["evidence-pattern", "intent:product-comparison"],
      reusableProcedure: JSON.stringify({ hosts: ["pccomponentes.com"], score: 95 }),
    }),
    makeMemory({
      id: "regular-memory",
      status: "accepted",
      tags: ["best-practice"],
      reusableProcedure: "Run web.search before browser.operate.",
    }),
  ]);

  const flightOnly = await loadEvidencePatternsFromMemory(store, ["flight-search"]);
  assert.equal(flightOnly.patterns.length, 1);
  assert.deepEqual(flightOnly.patterns[0].hosts, ["mycarrier.example"]);
  assert.equal(flightOnly.errors.length, 0);

  const both = await loadEvidencePatternsFromMemory(store, ["flight-search", "product-comparison"]);
  assert.equal(both.patterns.length, 2);

  const none = await loadEvidencePatternsFromMemory(store, []);
  assert.equal(none.patterns.length, 0);
});

test("loadEvidencePatternsFromMemory: surfaces parse errors only for tagged entries", async () => {
  const store = new InMemoryMemoryStore();
  store.seed([
    makeMemory({
      id: "broken-tagged",
      tags: ["evidence-pattern", "intent:flight-search"],
      reusableProcedure: "{not json",
    }),
    makeMemory({
      id: "untagged-entry",
      tags: ["best-practice"],
      reusableProcedure: "{not json", // not a pattern entry → ignored, not a parse error
    }),
  ]);
  const result = await loadEvidencePatternsFromMemory(store, ["flight-search"]);
  assert.equal(result.patterns.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].memoryId, "broken-tagged");
});
