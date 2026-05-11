import test from "node:test";
import assert from "node:assert/strict";
import { __testing__ } from "../src/agents/universalAgent.js";

const {
  parseFlexibleNumber,
  extractNumericValuesFromEvidence,
  isCurrencyAmountGroundedNumerically,
  findUngroundedSpecificsInText,
} = __testing__ as {
  parseFlexibleNumber: (raw: string) => number | undefined;
  extractNumericValuesFromEvidence: (evidence: string) => number[];
  isCurrencyAmountGroundedNumerically: (token: string, evidenceNumbers: number[]) => boolean;
  findUngroundedSpecificsInText: (output: string, evidenceText: string) => string[];
};

test("parseFlexibleNumber strips currency symbols and spaces", () => {
  assert.equal(parseFlexibleNumber("$79,581"), 79581);
  assert.equal(parseFlexibleNumber("€68 819,0591"), 68819.0591);
  assert.equal(parseFlexibleNumber("£1.234,56"), 1234.56);
  assert.equal(parseFlexibleNumber("¥1000"), 1000);
});

test("parseFlexibleNumber handles English thousands+decimal", () => {
  assert.equal(parseFlexibleNumber("79,581.42"), 79581.42);
  assert.equal(parseFlexibleNumber("1,000,000"), 1000000);
});

test("parseFlexibleNumber handles European thousands+decimal", () => {
  assert.equal(parseFlexibleNumber("79.581,42"), 79581.42);
});

test("parseFlexibleNumber returns undefined for non-numeric input", () => {
  assert.equal(parseFlexibleNumber("not a number"), undefined);
  assert.equal(parseFlexibleNumber("$"), undefined);
  assert.equal(parseFlexibleNumber(""), undefined);
});

test("extractNumericValuesFromEvidence captures CSV-like price data", () => {
  const evidence = `bitcoin price was 79581.42 last week, climbed to 81234.56 today, and 1,000,000 traders watched.`;
  const nums = extractNumericValuesFromEvidence(evidence);
  assert.ok(nums.includes(79581.42), `expected 79581.42 in ${nums}`);
  assert.ok(nums.includes(81234.56), `expected 81234.56 in ${nums}`);
  assert.ok(nums.includes(1000000), `expected 1000000 in ${nums}`);
});

test("isCurrencyAmountGroundedNumerically accepts close match within 1%", () => {
  const evidenceNums = [79581.42, 1000000];
  assert.equal(isCurrencyAmountGroundedNumerically("$79,581", evidenceNums), true, "$79,581 ≈ 79581.42");
  assert.equal(isCurrencyAmountGroundedNumerically("$79,500", evidenceNums), true, "$79,500 within 1% of 79581");
  assert.equal(isCurrencyAmountGroundedNumerically("$1,000,000", evidenceNums), true, "exact match");
});

test("isCurrencyAmountGroundedNumerically rejects fabricated amounts", () => {
  const evidenceNums = [79581.42];
  assert.equal(isCurrencyAmountGroundedNumerically("$50", evidenceNums), false, "$50 nowhere near 79581");
  assert.equal(isCurrencyAmountGroundedNumerically("$200000", evidenceNums), false);
});

test("isCurrencyAmountGroundedNumerically handles thousand-rounded shorthand", () => {
  // Synthesizer often rounds "$79,581.42" to "$81" meaning 81 thousand.
  // The 1000x scaling fallback should accept that.
  const evidenceNums = [81234.56];
  assert.equal(
    isCurrencyAmountGroundedNumerically("$81", evidenceNums),
    true,
    "$81 (thousand-rounded) should match 81234.56 in evidence",
  );
});

test("isCurrencyAmountGroundedNumerically returns false for non-currency tokens", () => {
  assert.equal(isCurrencyAmountGroundedNumerically("RTX 4080", [4080]), false);
  assert.equal(isCurrencyAmountGroundedNumerically("M3 Pro", []), false);
});

// Integration: full guard against a realistic CSV-style evidence corpus.
test("findUngroundedSpecificsInText accepts currency that was rounded from real evidence", () => {
  const evidence = `
    Fetched 366 bitcoin/USD market points from CoinGecko for the last 365 day(s).
    First close: 79581.42 USD on 2025-05-10.
    Last close: 104630.18 USD on 2026-05-10.
  `;
  // Synthesizer wrote "$79,581" — should now be grounded.
  const ungrounded = findUngroundedSpecificsInText("Bitcoin started at $79,581 last year.", evidence);
  assert.ok(
    !ungrounded.includes("$79,581"),
    `$79,581 should be grounded by 79581.42 in evidence; got ungrounded=${JSON.stringify(ungrounded)}`,
  );
});

test("findUngroundedSpecificsInText still rejects fabricated currency amounts", () => {
  const evidence = "Fetched 366 bitcoin/USD market points. First close: 79581.42 USD.";
  const ungrounded = findUngroundedSpecificsInText("It traded at $1,234,567 yesterday.", evidence);
  assert.ok(
    ungrounded.some((t) => t.startsWith("$1")),
    `$1,234,567 should remain ungrounded; got ungrounded=${JSON.stringify(ungrounded)}`,
  );
});
