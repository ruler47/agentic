import test from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "../src/utils/json.js";

test("extractJson parses a plain JSON object", () => {
  const parsed = extractJson<{ ok: boolean }>('{"ok": true}');

  assert.deepEqual(parsed, { ok: true });
});

test("extractJson parses a fenced JSON object from model output", () => {
  const parsed = extractJson<{ mode: string }>(
    'Here is the result:\n```json\n{"mode":"delegated"}\n```',
  );

  assert.deepEqual(parsed, { mode: "delegated" });
});

test("extractJson throws when no object is present", () => {
  assert.throws(() => extractJson("no structured data here"), /Could not find JSON object/);
});

test("extractJson recovers from a bad-escape character (Bug 20 regression)", () => {
  // Iter S4 ETH-chart regression: the council planner produced a JSON
  // object whose `prompt` field embedded a Python regex with a lone
  // backslash, e.g. `"prompt": "use regex \\d+ to match digits"`.
  // Strict JSON.parse fails on the unescaped `\d`. The extractor now
  // double-escapes any backslash that is NOT a valid JSON escape and
  // retries, so the run no longer crashes outright.
  const malformed = '{"prompt": "match \\d+ digits", "ok": true}';
  const parsed = extractJson<{ prompt: string; ok: boolean }>(malformed);
  assert.equal(parsed.ok, true);
  // The recovered prompt preserves the literal backslash-d sequence.
  assert.match(parsed.prompt, /\\d\+/);
});
