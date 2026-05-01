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
