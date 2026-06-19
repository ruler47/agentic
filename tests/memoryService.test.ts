import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySkillMemory } from "../src/memory/skillMemory.js";
import { MemoryService } from "../src/server/modules/memory/memory.service.js";
import type { AuditService } from "../src/server/common/services/audit.service.js";

test("MemoryService supports partial memory updates without clearing required fields", async () => {
  const store = new InMemorySkillMemory();
  const existing = await store.add({
    title: "Reusable preference",
    tags: ["preference"],
    summary: "Remember the concise preference.",
    reusableProcedure: "Use the concise preference when relevant.",
    scope: "group",
    scopeId: "group-local",
    status: "accepted",
    sensitivity: "normal",
    confidence: 0.9,
  });
  const service = new MemoryService(store, { record: async () => undefined } as unknown as AuditService);

  const updated = await service.update(existing.id, { status: "archived" });

  assert.equal(updated.status, "archived");
  assert.equal(updated.title, "Reusable preference");
  assert.equal(updated.summary, "Remember the concise preference.");
  assert.equal(updated.reusableProcedure, "Use the concise preference when relevant.");
});
