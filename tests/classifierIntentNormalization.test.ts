import test from "node:test";
import assert from "node:assert/strict";
import { classifyPrompt } from "../src/agents/prompts.js";
import type { SkillMemoryEntry } from "../src/types.js";

/**
 * Phase 12 Slice A (full): the classifier prompt now asks for an `intent`
 * array and warns the LLM not to base it on superficial token overlap. We
 * cannot test the LLM itself in unit suite (no model), but we can pin the
 * prompt contract so a regression in prompt template fails the build.
 */

test("classifyPrompt: schema asks for intent array", () => {
  const prompt = classifyPrompt("test task", []);
  assert.match(prompt, /"intent":\s*\["semantic-intent-label"\]/);
});

test("classifyPrompt: warns LLM against token-overlap intent", () => {
  const prompt = classifyPrompt("test", []);
  assert.match(prompt, /superficial token overlap/i);
  assert.match(prompt, /GPU\/RAM\/CPU/);
  assert.match(prompt, /"product-comparison"/);
  assert.match(prompt, /"flight-search"/);
});

test("classifyPrompt: uses empty array convention for no domain", () => {
  const prompt = classifyPrompt("anything", []);
  assert.match(prompt, /empty array \[\]/);
});

test("classifyPrompt: accepts memories array shape", () => {
  const fakeMemory: SkillMemoryEntry = {
    id: "x",
    title: "Memory",
    summary: "test",
    reusableProcedure: "",
    tags: [],
    scope: "global",
    status: "accepted",
    confidence: 0.5,
    sensitivity: "normal",
    evidence: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const prompt = classifyPrompt("task", [fakeMemory]);
  assert.match(prompt, /test task|task/);
  assert.match(prompt, /Memory/);
});
