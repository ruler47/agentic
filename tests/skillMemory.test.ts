import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillMemory } from "../src/memory/skillMemory.js";

test("SkillMemory stores and finds reusable entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-memory-"));
  const memory = new SkillMemory(join(dir, "skills.json"));

  try {
    const stored = await memory.add({
      title: "Research Spanish cities",
      tags: ["research", "spain", "cities"],
      summary: "Collect comparable city signals before ranking.",
      reusableProcedure: "Gather population, geography, airport access, and community evidence.",
    });

    const results = await memory.search("Spain cities airport ranking");

    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, stored.id);
    assert.equal(results[0]?.title, "Research Spanish cities");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SkillMemory keeps proposed scoped facts out of retrieval until accepted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-memory-"));
  const memory = new SkillMemory(join(dir, "skills.json"));

  try {
    const proposed = await memory.add({
      title: "Family pharmacy preference",
      tags: ["family", "medical"],
      summary: "The group prefers Spanish pharmacy sources first.",
      reusableProcedure: "Search Spanish sources before broad international marketplaces.",
      scope: "group",
      scopeId: "group-local",
      status: "proposed",
      confidence: 0.62,
      evidence: ["source run said Spanish pharmacies should be preferred"],
    });

    assert.deepEqual(await memory.search("Spanish pharmacy sources"), []);

    const accepted = await memory.update(proposed.id, {
      status: "accepted",
      confidence: 0.9,
    });
    const results = await memory.search("Spanish pharmacy sources");
    const groupOnly = await memory.list({ scope: "group", scopeId: "group-local", status: "accepted" });

    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.confidence, 0.9);
    assert.equal(results[0]?.id, proposed.id);
    assert.equal(groupOnly.length, 1);
    assert.equal(groupOnly[0]?.scope, "group");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SkillMemory returns empty list when file does not exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-memory-"));
  const memory = new SkillMemory(join(dir, "missing.json"));

  try {
    assert.deepEqual(await memory.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
