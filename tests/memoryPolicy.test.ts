import test from "node:test";
import assert from "node:assert/strict";
import { SkillMemoryEntry } from "../src/types.js";
import { evaluateMemoryPolicy } from "../src/memory/memoryPolicy.js";

function memory(overrides: Partial<SkillMemoryEntry> = {}): SkillMemoryEntry {
  return {
    id: "memory-1",
    title: "Preferred pharmacy sources",
    tags: ["pharmacy"],
    summary: "Use Spanish pharmacy sources first.",
    reusableProcedure: "Prefer AEMPS and local pharmacies before generic marketplaces.",
    scope: "group",
    scopeId: "group-local",
    status: "accepted",
    sensitivity: "normal",
    confidence: 0.9,
    createdAt: "2026-05-03T10:00:00.000Z",
    ...overrides,
  };
}

test("evaluateMemoryPolicy allows accepted normal memory with exact visible scope", () => {
  const decision = evaluateMemoryPolicy(memory(), {
    visibleScopes: [{ scope: "global" }, { scope: "group", scopeId: "group-local" }],
    requesterUserId: "user-admin",
  });

  assert.equal(decision.status, "allowed");
  assert.equal(decision.matchedScope?.scope, "group");
  assert.match(decision.reasons.join("\n"), /Exact group scope id group-local/);
});

test("evaluateMemoryPolicy blocks non-accepted memory before scope injection", () => {
  const decision = evaluateMemoryPolicy(memory({ status: "proposed" }), {
    visibleScopes: [{ scope: "group", scopeId: "group-local" }],
  });

  assert.equal(decision.status, "blocked");
  assert.match(decision.reasons.join("\n"), /only accepted memories/);
});

test("evaluateMemoryPolicy blocks non-global memory without exact scope id", () => {
  const decision = evaluateMemoryPolicy(memory({ scopeId: "group-a" }), {
    visibleScopes: [{ scope: "global" }, { scope: "group", scopeId: "group-b" }],
  });

  assert.equal(decision.status, "blocked");
  assert.equal(decision.matchedScope, undefined);
  assert.match(decision.reasons.join("\n"), /does not include exact group scope id group-a/);
});

test("evaluateMemoryPolicy keeps private user memory scoped to the requester", () => {
  const sameRequester = evaluateMemoryPolicy(
    memory({ scope: "user", scopeId: "user-dima", sensitivity: "private" }),
    {
      visibleScopes: [{ scope: "user", scopeId: "user-dima" }],
      requesterUserId: "user-dima",
    },
  );
  const otherRequester = evaluateMemoryPolicy(
    memory({ scope: "user", scopeId: "user-dima", sensitivity: "private" }),
    {
      visibleScopes: [{ scope: "user", scopeId: "user-dima" }],
      requesterUserId: "user-admin",
    },
  );

  assert.equal(sameRequester.status, "allowed");
  assert.equal(otherRequester.status, "blocked");
  assert.match(otherRequester.reasons.join("\n"), /same requester user scope/);
});

test("evaluateMemoryPolicy marks sensitive memory as review-needed without explicit grant", () => {
  const needsReview = evaluateMemoryPolicy(memory({ sensitivity: "sensitive" }), {
    visibleScopes: [{ scope: "group", scopeId: "group-local" }],
  });
  const allowed = evaluateMemoryPolicy(memory({ sensitivity: "sensitive" }), {
    visibleScopes: [{ scope: "group", scopeId: "group-local" }],
    allowSensitive: true,
  });

  assert.equal(needsReview.status, "needs_review");
  assert.match(needsReview.reasons.join("\n"), /explicit sensitive-memory grant/);
  assert.equal(allowed.status, "allowed");
});
