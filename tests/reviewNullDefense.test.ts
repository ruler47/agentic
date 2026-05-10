import test from "node:test";
import assert from "node:assert/strict";
import { __testing__ } from "../src/agents/universalAgent.js";

const { parseForbiddenTokensFromReviewNotes } = __testing__;

test("parseForbiddenTokensFromReviewNotes handles null notes gracefully", () => {
  // LLM occasionally emits `notes: null` in the review JSON; was crashing
  // the run with "Cannot read properties of null (reading 'trim')".
  const out = parseForbiddenTokensFromReviewNotes(null as unknown as string);
  assert.deepEqual(out, []);
});

test("parseForbiddenTokensFromReviewNotes handles undefined notes", () => {
  const out = parseForbiddenTokensFromReviewNotes(undefined as unknown as string);
  assert.deepEqual(out, []);
});

test("parseForbiddenTokensFromReviewNotes handles non-string types", () => {
  const out = parseForbiddenTokensFromReviewNotes(42 as unknown as string);
  assert.deepEqual(out, []);
});

test("parseForbiddenTokensFromReviewNotes still parses well-formed review notes", () => {
  const notes =
    "Output names specifics that are NOT in tool evidence or the task: RTX 4080, MacBook Pro M3, $2499. Re-ground.";
  const out = parseForbiddenTokensFromReviewNotes(notes);
  assert.deepEqual(out, ["RTX 4080", "MacBook Pro M3", "$2499"]);
});
