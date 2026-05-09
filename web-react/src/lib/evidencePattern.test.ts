import { describe, expect, test } from "vitest";
import {
  isEvidencePatternMemory,
  parseEvidencePatternSpec,
  readIntentTag,
  serializeEvidencePatternSpec,
} from "./evidencePattern";

describe("evidencePattern UI helpers", () => {
  test("isEvidencePatternMemory checks tag presence case-insensitively", () => {
    expect(isEvidencePatternMemory(["Evidence-Pattern", "intent:flight-search"])).toBe(true);
    expect(isEvidencePatternMemory(["evidence-pattern"])).toBe(true);
    expect(isEvidencePatternMemory(["best-practice"])).toBe(false);
    expect(isEvidencePatternMemory([])).toBe(false);
    expect(isEvidencePatternMemory(undefined)).toBe(false);
  });

  test("readIntentTag extracts the intent name", () => {
    expect(readIntentTag(["evidence-pattern", "intent:flight-search"])).toBe("flight-search");
    expect(readIntentTag(["intent:Product-Comparison"])).toBe("product-comparison");
    expect(readIntentTag(["intent:"])).toBeUndefined();
    expect(readIntentTag(["other"])).toBeUndefined();
  });

  test("parseEvidencePatternSpec: empty body produces error", () => {
    const r = parseEvidencePatternSpec("");
    expect(r.spec).toBeNull();
    expect(r.errors[0]).toMatch(/empty/i);
  });

  test("parseEvidencePatternSpec: invalid JSON reported", () => {
    const r = parseEvidencePatternSpec("{not json");
    expect(r.spec).toBeNull();
    expect(r.errors[0]).toMatch(/Invalid JSON/);
  });

  test("parseEvidencePatternSpec: requires at least one of hosts/urlPatterns/pathPatterns", () => {
    const r = parseEvidencePatternSpec(JSON.stringify({ score: 60, notes: "x" }));
    expect(r.spec).toBeNull();
    expect(r.errors[0]).toMatch(/at least one/i);
  });

  test("parseEvidencePatternSpec: clamps score and warns", () => {
    const r = parseEvidencePatternSpec(JSON.stringify({ hosts: ["x.com"], score: 9999 }));
    expect(r.spec?.score).toBe(200);
    expect(r.warnings.join("|")).toMatch(/clamped/);
  });

  test("parseEvidencePatternSpec: invalid regex caught for urlPatterns", () => {
    const r = parseEvidencePatternSpec(
      JSON.stringify({ urlPatterns: ["valid", "(unclosed"], score: 60 }),
    );
    expect(r.spec).toBeNull();
    expect(r.errors.find((e) => e.includes("invalid regex"))).toBeTruthy();
  });

  test("parseEvidencePatternSpec: returns spec on a valid object", () => {
    const r = parseEvidencePatternSpec(
      JSON.stringify({
        hosts: ["pccomponentes.com", "amazon.es"],
        pathPatterns: ["laptop"],
        score: 95,
        notes: "EU stockists",
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.spec).toEqual({
      hosts: ["pccomponentes.com", "amazon.es"],
      pathPatterns: ["laptop"],
      score: 95,
      notes: "EU stockists",
    });
  });

  test("serializeEvidencePatternSpec produces stable key order", () => {
    const out = serializeEvidencePatternSpec({
      score: 70,
      notes: "alpha",
      hosts: ["x.com"],
      pathPatterns: ["a"],
      urlPatterns: ["regex"],
    });
    expect(out).toMatch(/"hosts"[\s\S]*"urlPatterns"[\s\S]*"pathPatterns"[\s\S]*"score"[\s\S]*"notes"/);
  });
});
