import test from "node:test";
import assert from "node:assert/strict";
import {
  createDeterministicTextEmbedding,
  formatPgVector,
  memoryEmbeddingText,
} from "../src/memory/textEmbedding.js";

test("deterministic text embeddings are stable normalized pgvector payloads", () => {
  const first = createDeterministicTextEmbedding("Concise practical Spain household answers");
  const second = createDeterministicTextEmbedding("Concise practical Spain household answers");

  assert.equal(first.dimensions, 128);
  assert.deepEqual(first.values, second.values);
  assert.match(formatPgVector(first), /^\[-?[0-9.,-]+/);
  assert.equal(first.values.some((value) => value !== 0), true);
  const magnitude = Math.sqrt(first.values.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(magnitude - 1) < 0.00001);
});

test("memory embedding text includes tags and evidence", () => {
  const text = memoryEmbeddingText({
    title: "Short Spanish answers",
    tags: ["preference", "spain"],
    summary: "User wants concise answers.",
    reusableProcedure: "Keep replies practical.",
    evidence: ["Requested in a completed run."],
  });

  assert.match(text, /preference spain/);
  assert.match(text, /Requested in a completed run/);
});
