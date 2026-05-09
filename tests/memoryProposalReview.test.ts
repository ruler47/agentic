import test from "node:test";
import assert from "node:assert/strict";
import { reviewMemoryProposal, reviewMemoryProposals } from "../src/memory/memoryProposalReview.js";

test("memory proposal review blocks unsafe scopes before accept", () => {
  const review = reviewMemoryProposal({
    id: "memory-unsafe",
    title: "Private group note",
    tags: ["privacy"],
    summary: "A private fact was scoped too broadly.",
    reusableProcedure: "Do not accept until scoped to the user.",
    scope: "group",
    status: "proposed",
    sensitivity: "private",
    confidence: 0.4,
    createdAt: new Date().toISOString(),
  });

  assert.equal(review.status, "blocked");
  assert.ok(review.findings.some((finding) => finding.code === "missing_scope_id"));
  assert.ok(review.findings.some((finding) => finding.code === "private_scope_mismatch"));
  assert.ok(review.findings.some((finding) => finding.code === "missing_evidence"));
});

test("memory proposal review marks sourced normal memories ready", () => {
  const review = reviewMemoryProposal({
    id: "memory-ready",
    title: "Thread routing",
    tags: ["threads"],
    summary: "Keep follow-ups in the same thread.",
    reusableProcedure: "Resolve the source chat before creating a new task.",
    scope: "group",
    scopeId: "instance-local",
    status: "proposed",
    sensitivity: "normal",
    confidence: 0.9,
    sourceRunId: "run-1",
    evidence: ["operator accepted this behavior"],
    createdAt: new Date().toISOString(),
  });

  assert.equal(review.status, "ready");
  assert.deepEqual(review.findings, []);
});

test("memory proposal review warns about same-scope duplicates and conflicts", () => {
  const createdAt = new Date().toISOString();
  const accepted = {
    id: "memory-accepted",
    title: "Telegram thread routing",
    tags: ["telegram"],
    summary: "Telegram messages from whitelisted users should stay in the active thread.",
    reusableProcedure: "Resolve the channel identity and append follow-ups to the existing thread.",
    scope: "group" as const,
    scopeId: "group-local",
    status: "accepted" as const,
    sensitivity: "normal" as const,
    confidence: 0.9,
    sourceRunId: "run-1",
    evidence: ["accepted by operator"],
    createdAt,
  };
  const duplicate = {
    ...accepted,
    id: "memory-duplicate",
    status: "proposed" as const,
    sourceRunId: "run-2",
  };
  const conflict = {
    ...accepted,
    id: "memory-conflict",
    status: "proposed" as const,
    summary: "Telegram messages should always start a new task without thread context.",
    reusableProcedure: "Create a fresh run and ignore earlier thread artifacts.",
    sourceRunId: "run-3",
  };

  const reviews = reviewMemoryProposals([duplicate, conflict], [accepted, duplicate, conflict]);

  assert.equal(reviews[0]?.status, "needs_review");
  assert.ok(reviews[0]?.findings.some((finding) => finding.code === "possible_duplicate"));
  assert.equal(reviews[1]?.status, "needs_review");
  assert.ok(reviews[1]?.findings.some((finding) => finding.code === "possible_conflict"));
});

test("memory proposal review warns when same title falls into similarity gray zone", () => {
  const createdAt = new Date().toISOString();
  const accepted = {
    id: "memory-accepted",
    title: "Dinner planning defaults",
    tags: ["planning"],
    summary: "Use Malaga as the default city for family dinner plans.",
    reusableProcedure: "When location is omitted, use the group profile city.",
    scope: "group" as const,
    scopeId: "group-local",
    status: "accepted" as const,
    sensitivity: "normal" as const,
    confidence: 0.9,
    sourceRunId: "run-1",
    evidence: ["accepted by operator"],
    createdAt,
  };
  const proposed = {
    ...accepted,
    id: "memory-proposed",
    status: "proposed" as const,
    summary: "Use Malaga as the default city for family restaurant and evening plans.",
    reusableProcedure: "When the task omits location, use the group city before asking.",
    sourceRunId: "run-2",
  };

  const review = reviewMemoryProposal(proposed, [accepted, proposed]);

  assert.equal(review.status, "needs_review");
  assert.ok(review.findings.some((finding) => finding.code === "possible_duplicate"));
});
