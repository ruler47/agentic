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

test("SkillMemory filters search by visible scopes and explains matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-memory-"));
  const memory = new SkillMemory(join(dir, "skills.json"));

  try {
    const family = await memory.add({
      title: "Family pharmacy preference",
      tags: ["family", "pharmacy"],
      summary: "Use Spanish pharmacy sources for the family.",
      reusableProcedure: "Prefer AEMPS and Spanish pharmacies before generic marketplaces.",
      scope: "group",
      scopeId: "family-a",
      status: "accepted",
      confidence: 0.9,
    });
    await memory.add({
      title: "Company pharmacy preference",
      tags: ["company", "pharmacy"],
      summary: "Use enterprise procurement sources for the company.",
      reusableProcedure: "Prefer internal vendor systems.",
      scope: "group",
      scopeId: "company-b",
      status: "accepted",
      confidence: 0.9,
    });

    const results = await memory.search("Spanish pharmacy sources", 5, {
      visibleScopes: [{ scope: "global" }, { scope: "group", scopeId: "family-a" }],
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, family.id);
    assert.match(results[0]?.match?.reason ?? "", /Matched/);
    assert.equal(results[0]?.match?.scope, "group");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SkillMemory ranks exact scoped memories above generic global lessons", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-memory-"));
  const memory = new SkillMemory(join(dir, "skills.json"));

  try {
    await memory.add({
      title: "Generic preference planning framework",
      tags: ["preference", "planning", "scenario", "priority", "artifact"],
      summary: "Generic scenario planning should synthesize priorities from artifacts.",
      reusableProcedure: "Use for broad planning tasks when no scoped family fact is available.",
      scope: "global",
      status: "accepted",
      confidence: 0.95,
    });
    const family = await memory.add({
      title: "Family default city for dinner",
      tags: ["malaga", "city", "dinner"],
      summary: "Use Malaga, Spain for family dinner planning when the user omits location.",
      reusableProcedure: "Do not ask for the city again for local dinner tasks.",
      scope: "group",
      scopeId: "family-a",
      status: "accepted",
      confidence: 0.95,
    });

    const results = await memory.search("plan dinner from priority artifact city Malaga", 5, {
      visibleScopes: [{ scope: "global" }, { scope: "group", scopeId: "family-a" }],
    });

    assert.equal(results[0]?.id, family.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SkillMemory does not rank audit evidence text as reusable memory content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-memory-"));
  const memory = new SkillMemory(join(dir, "skills.json"));

  try {
    await memory.add({
      title: "Generic decision workflow",
      tags: ["decision"],
      summary: "Use only for generic decision synthesis.",
      reusableProcedure: "Compare options and cite tradeoffs.",
      scope: "global",
      status: "accepted",
      confidence: 0.95,
      evidence: [
        "Source run task: без внешних источников составь спокойный план ужина город Malaga thread summary",
      ],
    });
    const scoped = await memory.add({
      title: "Family default city for dinner",
      tags: ["malaga", "city", "dinner"],
      summary: "Use Malaga, Spain for family dinner planning when the user omits location.",
      reusableProcedure: "Do not ask for the city again for local dinner tasks.",
      scope: "group",
      scopeId: "family-a",
      status: "accepted",
      confidence: 0.95,
    });

    const results = await memory.search("без внешних источников составь спокойный план ужина город Malaga", 5, {
      visibleScopes: [{ scope: "global" }, { scope: "group", scopeId: "family-a" }],
    });

    assert.equal(results[0]?.id, scoped.id);
    assert.notEqual(results[0]?.title, "Generic decision workflow");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SkillMemory ignores stopword-only overlap so unrelated memories do not enter runtime context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-memory-"));
  const memory = new SkillMemory(join(dir, "skills.json"));

  try {
    await memory.add({
      title: "Structured Clarification via Scenario Mapping",
      tags: ["clarification", "scenario"],
      summary: "When a user request is underspecified, map possible interpretations before answering.",
      reusableProcedure: "Ask for the missing domain-specific detail before guessing intent.",
      scope: "global",
      status: "accepted",
      confidence: 0.95,
    });

    const results = await memory.search("Забронируй столик на ужин сегодня для меня", 5);

    assert.deepEqual(results, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SkillMemory requires exact scope ids for non-global memory visibility", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-memory-"));
  const memory = new SkillMemory(join(dir, "skills.json"));

  try {
    const dima = await memory.add({
      title: "Dima pharmacy preference",
      tags: ["pharmacy", "preference"],
      summary: "Dima wants concise pharmacy answers.",
      reusableProcedure: "Keep pharmacy responses concise for Dima.",
      scope: "user",
      scopeId: "user-dima",
      status: "accepted",
      sensitivity: "private",
    });
    await memory.add({
      title: "Other user pharmacy preference",
      tags: ["pharmacy", "preference"],
      summary: "Another user wants verbose pharmacy answers.",
      reusableProcedure: "Give long pharmacy responses for the other user.",
      scope: "user",
      scopeId: "user-other",
      status: "accepted",
      sensitivity: "private",
    });

    const broadUserScope = await memory.search("pharmacy preference", 5, {
      visibleScopes: [{ scope: "user" }],
    });
    const exactUserScope = await memory.search("pharmacy preference", 5, {
      visibleScopes: [{ scope: "user", scopeId: "user-dima" }],
    });

    assert.deepEqual(broadUserScope, []);
    assert.equal(exactUserScope.length, 1);
    assert.equal(exactUserScope[0]?.id, dima.id);
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
