import test from "node:test";
import assert from "node:assert/strict";
import { reviewMemoryProposal } from "../src/memory/memoryProposalReview.js";

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
