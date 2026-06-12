import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryWorkLedgerStore } from "../src/work-ledger/workLedgerStore.js";
import { InMemoryEvidenceLedgerStore } from "../src/work-ledger/evidenceLedgerStore.js";
import {
  ClaimWorkInput,
  createWorkLedgerClaimCoordinator,
} from "../src/work-ledger/workLedgerClaimCoordinator.js";

function baseClaimInput(overrides: Partial<ClaimWorkInput> = {}): ClaimWorkInput {
  return {
    runId: "run-1",
    threadId: "thread-1",
    ownerSpanId: "span-A",
    kind: "search",
    workKeyParts: { searchQuery: "  Spanish  Doctors  in Berlin  " },
    taskSummary: "Find Spanish-speaking doctors in Berlin.",
    requestedBy: "researcher@worker",
    metadata: { topic: "doctors" },
    ...overrides,
  };
}

test("claim coordinator computes deterministic work keys: same intent → same key", async () => {
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const coordinator = createWorkLedgerClaimCoordinator({ workLedgerStore });

  const a = await coordinator.getDecision(baseClaimInput({
    workKeyParts: { searchQuery: "Schengen visa rules" },
  }));
  const b = await coordinator.getDecision(baseClaimInput({
    workKeyParts: { searchQuery: "  schengen   visa   rules  " },
  }));
  assert.equal(a.computedWorkKey, b.computedWorkKey, "search keys ignore casing/whitespace");

  const aUrl = await coordinator.getDecision(baseClaimInput({
    kind: "url_visit",
    workKeyParts: { url: "HTTPS://Example.COM/Path/?b=2&a=1#frag" },
  }));
  const bUrl = await coordinator.getDecision(baseClaimInput({
    kind: "url_visit",
    workKeyParts: { url: "https://example.com/Path?a=1&b=2" },
  }));
  assert.equal(aUrl.computedWorkKey, bUrl.computedWorkKey, "URL keys normalize host/query/fragment");

  const aTool = await coordinator.getDecision(baseClaimInput({
    kind: "tool_call",
    workKeyParts: { tool: "Browser.Operate", input: { goal: "snap", url: "https://X" } },
  }));
  const bTool = await coordinator.getDecision(baseClaimInput({
    kind: "tool_call",
    workKeyParts: { tool: "browser.operate", input: { url: "https://X", goal: "snap" } },
  }));
  assert.equal(aTool.computedWorkKey, bTool.computedWorkKey, "tool keys normalize name + sort input");
});

test("claim coordinator redacts secret-shaped fields from URLs, params, and metadata", async () => {
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const coordinator = createWorkLedgerClaimCoordinator({ workLedgerStore });

  const claim = await coordinator.claimWork(baseClaimInput({
    kind: "url_visit",
    workKeyParts: { url: "https://api.example.org/v1/items?token=SECRET-CANARY-1&page=2" },
    metadata: { description: "fetch", apiKey: "SECRET-CANARY-2", nested: { authorization: "Bearer x" } },
  }));

  assert.ok(claim.workItem);
  assert.ok(!claim.computedWorkKey.includes("SECRET-CANARY-1"), "url query secrets must not appear in workKey");
  const item = claim.workItem!;
  assert.equal(item.metadata?.apiKey, "[redacted]");
  const nested = item.metadata?.nested as Record<string, unknown> | undefined;
  assert.equal(nested?.authorization, "[redacted]");
  // The api_call workKey path also redacts params:
  const apiClaim = await coordinator.getDecision(baseClaimInput({
    kind: "api_call",
    workKeyParts: { apiProvider: "billing", endpoint: "/charge", method: "POST", params: { amount: 1, secret: "SECRET-CANARY-3" } },
  }));
  assert.ok(!apiClaim.computedWorkKey.includes("SECRET-CANARY-3"), "api params secrets must not appear in workKey");
});

test("claim coordinator returns reuse_completed when prior fresh evidence exists", async () => {
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const evidenceLedgerStore = new InMemoryEvidenceLedgerStore();
  const coordinator = createWorkLedgerClaimCoordinator({ workLedgerStore, evidenceLedgerStore });

  const first = await coordinator.claimWork(baseClaimInput());
  assert.equal(first.decision, "created_new");
  const evidence = await evidenceLedgerStore.createEvidence({
    kind: "search_result",
    title: "Source X",
    runId: "run-1",
    workItemId: first.workItem!.id,
    sourceUrl: "https://example.com/source-x",
    summary: "snippet",
  });
  await coordinator.completeWork({
    workItemId: first.workItem!.id,
    outputSummary: "Found 2 candidates",
    confidence: 0.9,
  });
  await coordinator.attachEvidence({ workItemId: first.workItem!.id, evidenceId: evidence.id });

  // Different span asks for the same intent in the same run/thread.
  const second = await coordinator.claimWork(baseClaimInput({ ownerSpanId: "span-B" }));
  assert.equal(second.decision, "reuse_completed");
  assert.equal(second.workItem!.id, first.workItem!.id, "same canonical work item is reused");
  assert.ok(second.reusableEvidence && second.reusableEvidence.length === 1, "evidence is surfaced for reuse");
  assert.equal(second.reusableEvidence![0]?.id, evidence.id);
  assert.equal(second.confidence, 0.9, "reuse keeps the original work confidence");
});

test("claim coordinator returns wait_for_active when another span has an active claim", async () => {
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const coordinator = createWorkLedgerClaimCoordinator({ workLedgerStore });

  const first = await coordinator.claimWork(baseClaimInput({ ownerSpanId: "span-A" }));
  assert.equal(first.decision, "created_new");

  const second = await coordinator.claimWork(baseClaimInput({ ownerSpanId: "span-B" }));
  assert.equal(second.decision, "wait_for_active");
  assert.equal(second.activeWorkItemId, first.workItem!.id, "second claim points at the active item to subscribe to");
  // No duplicate active work item for the same workKey.
  const items = await workLedgerStore.listByWorkKey(first.computedWorkKey!);
  const active = items.filter((item) => item.status === "claimed" || item.status === "running");
  assert.equal(active.length, 1, "exactly one active claim per workKey");
});

test("claim coordinator returns created_new when no prior matching item exists", async () => {
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const coordinator = createWorkLedgerClaimCoordinator({ workLedgerStore });

  const decision = await coordinator.claimWork(baseClaimInput());
  assert.equal(decision.decision, "created_new");
  assert.equal(decision.workItem!.status, "claimed");
  assert.equal(decision.workItem!.kind, "search");
  assert.equal(decision.workItem!.ownerSpanId, "span-A");
  assert.equal(decision.workItem!.title, "Find Spanish-speaking doctors in Berlin.");
  assert.match(decision.computedWorkKey!, /^search:any:any:any:spanish doctors in berlin$/);
});

test("claim coordinator returns revalidate when prior evidence is stale or weak", async () => {
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const coordinator = createWorkLedgerClaimCoordinator({
    workLedgerStore,
    defaultStaleEvidenceWindowMs: 60_000,
    defaultWeakConfidenceThreshold: 0.5,
  });

  // Case A: completed but past freshness expiry → revalidate via existing decideWorkReuse logic.
  const expired = await coordinator.claimWork(baseClaimInput({
    workKeyParts: { searchQuery: "Stale subject A" },
    freshnessExpiresAt: new Date(Date.now() - 1000).toISOString(),
  }));
  await coordinator.completeWork({ workItemId: expired.workItem!.id, outputSummary: "done", confidence: 0.9 });
  const repeatA = await coordinator.claimWork(baseClaimInput({
    workKeyParts: { searchQuery: "Stale subject A" },
    ownerSpanId: "span-Z",
  }));
  assert.equal(repeatA.decision, "revalidate", "explicit freshnessExpiresAt past makes the next claim revalidate");

  // Case B: completed within freshness BUT under coordinator's stale window → revalidate by age.
  const oldComplete = await coordinator.claimWork(baseClaimInput({
    workKeyParts: { searchQuery: "Stale subject B" },
    ownerSpanId: "span-A",
  }));
  await coordinator.completeWork({
    workItemId: oldComplete.workItem!.id,
    outputSummary: "done",
    confidence: 0.95,
  });
  const future = new Date(Date.now() + 5 * 60_000); // 5 minutes later
  const repeatB = await coordinator.claimWork({
    ...baseClaimInput({ workKeyParts: { searchQuery: "Stale subject B" }, ownerSpanId: "span-Z" }),
    now: future,
  });
  assert.equal(repeatB.decision, "revalidate", "completed item older than staleEvidenceWindowMs is revalidated");
  assert.notEqual(repeatB.workItem!.id, oldComplete.workItem!.id, "age-based revalidation creates a new active claim");
  assert.equal(repeatB.workItem!.status, "claimed");
  assert.equal(repeatB.workItem!.parentWorkItemId, oldComplete.workItem!.id);
  assert.equal(repeatB.workItem!.metadata?.revalidatesWorkItemId, oldComplete.workItem!.id);

  // Case C: completed with weak confidence → revalidate.
  const weak = await coordinator.claimWork(baseClaimInput({
    workKeyParts: { searchQuery: "Weak subject" },
    ownerSpanId: "span-A",
  }));
  await coordinator.completeWork({
    workItemId: weak.workItem!.id,
    outputSummary: "uncertain",
    confidence: 0.2,
  });
  const repeatC = await coordinator.claimWork(baseClaimInput({
    workKeyParts: { searchQuery: "Weak subject" },
    ownerSpanId: "span-Z",
  }));
  assert.equal(repeatC.decision, "revalidate", "completed item with confidence below threshold is revalidated");
  assert.notEqual(repeatC.workItem!.id, weak.workItem!.id, "weak-confidence revalidation creates a new active claim");
  assert.equal(repeatC.workItem!.parentWorkItemId, weak.workItem!.id);
});

test("claim coordinator records limitation evidence on failWork and on blockWork", async () => {
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const evidenceLedgerStore = new InMemoryEvidenceLedgerStore();
  const coordinator = createWorkLedgerClaimCoordinator({ workLedgerStore, evidenceLedgerStore });

  const first = await coordinator.claimWork(baseClaimInput({
    workKeyParts: { searchQuery: "Provider down" },
  }));
  const failResult = await coordinator.failWork({
    workItemId: first.workItem!.id,
    error: "Provider returned 503",
    limitation: { title: "Provider down", reasons: ["External provider unavailable"] },
  });
  assert.equal(failResult.workItem.status, "failed");
  assert.ok(failResult.limitation, "failWork writes a limitation when one is requested");
  assert.equal(failResult.limitation!.kind, "limitation");
  assert.equal(failResult.limitation!.qaStatus, "failed");
  assert.deepEqual(failResult.limitation!.limitations, ["External provider unavailable"]);
  // Evidence is automatically linked back to the work item.
  const refreshed = await workLedgerStore.get(first.workItem!.id);
  assert.ok(refreshed?.evidenceIds.includes(failResult.limitation!.id));

  // Repeating the same workKey shortly after a failure → blocked.
  const repeat = await coordinator.claimWork(baseClaimInput({
    workKeyParts: { searchQuery: "Provider down" },
    ownerSpanId: "span-Z",
  }));
  assert.equal(repeat.decision, "blocked");

  // After explicit revalidation reason, the same workKey is allowed → revalidate / created_new.
  const reval = await coordinator.claimWork(baseClaimInput({
    workKeyParts: { searchQuery: "Provider down" },
    ownerSpanId: "span-Z",
    reason: "alternate source revalidation",
  }));
  assert.notEqual(reval.decision, "blocked");

  // blockWork on an active item also writes a limitation.
  const blockable = await coordinator.claimWork(baseClaimInput({
    workKeyParts: { searchQuery: "Block subject" },
  }));
  const blockResult = await coordinator.blockWork({
    workItemId: blockable.workItem!.id,
    reason: "External page presented a CAPTCHA wall.",
    limitation: { title: "CAPTCHA wall", reasons: ["CAPTCHA / loader blocker"] },
  });
  assert.equal(blockResult.workItem.status, "failed");
  assert.equal(blockResult.workItem.error, "External page presented a CAPTCHA wall.");
  assert.equal(blockResult.limitation!.qaStatus, "blocked");
});

test("claim coordinator attaches evidence ids idempotently and sanitizes metadata recursively", async () => {
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const coordinator = createWorkLedgerClaimCoordinator({ workLedgerStore });

  const claim = await coordinator.claimWork(baseClaimInput({
    metadata: { topic: "x", credential: "SECRET-CANARY-4", nested: { token: "SECRET-CANARY-5" } },
  }));
  // Initial sanitization:
  assert.equal(claim.workItem!.metadata?.credential, "[redacted]");
  assert.equal((claim.workItem!.metadata?.nested as Record<string, unknown>).token, "[redacted]");

  await coordinator.attachEvidence({ workItemId: claim.workItem!.id, evidenceId: "ev-1" });
  await coordinator.attachEvidence({ workItemId: claim.workItem!.id, evidenceId: "ev-1" });
  await coordinator.attachEvidence({ workItemId: claim.workItem!.id, evidenceId: "ev-2" });
  const item = await workLedgerStore.get(claim.workItem!.id);
  assert.deepEqual(item?.evidenceIds.sort(), ["ev-1", "ev-2"], "evidence ids are appended idempotently");
});

test("claim coordinator attaches artifact ids idempotently without touching artifact payloads", async () => {
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const coordinator = createWorkLedgerClaimCoordinator({ workLedgerStore });

  const claim = await coordinator.claimWork(baseClaimInput({
    kind: "artifact_generation",
    workKeyParts: { artifactKind: "chart", descriptor: "BTC vs USD 30d" },
  }));
  await coordinator.attachArtifact({ workItemId: claim.workItem!.id, artifactId: "artifact-1" });
  await coordinator.attachArtifact({ workItemId: claim.workItem!.id, artifactId: "artifact-1" });
  await coordinator.attachArtifact({ workItemId: claim.workItem!.id, artifactId: "artifact-2" });
  const item = await workLedgerStore.get(claim.workItem!.id);
  assert.deepEqual(item?.artifactIds.sort(), ["artifact-1", "artifact-2"], "artifact ids are appended idempotently");
});

test("claim coordinator deduplicates near-simultaneous claims for the same workKey", async () => {
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const coordinator = createWorkLedgerClaimCoordinator({ workLedgerStore });

  const inputs = [
    baseClaimInput({ ownerSpanId: "span-A", workKeyParts: { searchQuery: "Concurrent X" } }),
    baseClaimInput({ ownerSpanId: "span-B", workKeyParts: { searchQuery: "Concurrent X" } }),
    baseClaimInput({ ownerSpanId: "span-C", workKeyParts: { searchQuery: "Concurrent X" } }),
  ];
  const results = await Promise.all(inputs.map((input) => coordinator.claimWork(input)));
  const decisions = results.map((result) => result.decision).sort();
  assert.deepEqual(decisions, ["created_new", "wait_for_active", "wait_for_active"]);

  const items = await workLedgerStore.listByWorkKey(results[0].computedWorkKey!);
  const active = items.filter((item) => item.status === "claimed" || item.status === "running");
  assert.equal(active.length, 1, "concurrent claims do not create duplicate active items");
});

test("claim coordinator returns audit-ready output without depending on an audit store", async () => {
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const coordinator = createWorkLedgerClaimCoordinator({ workLedgerStore });

  const decision = await coordinator.claimWork(baseClaimInput());

  // The decision shape is documented and stable: callers can use it to write audit/trace
  // events without the coordinator pulling an audit-store dependency itself.
  assert.equal(typeof decision.decision, "string");
  assert.equal(typeof decision.reason, "string");
  assert.equal(typeof decision.confidence, "number");
  assert.equal(typeof decision.computedWorkKey, "string");
  assert.equal(typeof decision.storeDecision, "string");
  assert.ok(decision.workItem);
  assert.equal(typeof decision.workItem!.id, "string");
  assert.equal(typeof decision.workItem!.kind, "string");
  assert.equal(typeof decision.workItem!.status, "string");
  assert.equal(typeof decision.workItem!.workKey, "string");
  assert.ok(decision.workItem!.createdAt);
});

test("claim coordinator getDecision is a dry-run and does not create a new claim", async () => {
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const coordinator = createWorkLedgerClaimCoordinator({ workLedgerStore });

  const dry = await coordinator.getDecision(baseClaimInput());
  assert.equal(dry.decision, "created_new");
  // No items exist yet — getDecision is read-only.
  const beforeAny = await workLedgerStore.listByWorkKey(dry.computedWorkKey!);
  assert.equal(beforeAny.length, 0, "getDecision did not write a work item");
});

test("claim coordinator maps coordinator kinds to the persisted WorkLedgerKind enum", async () => {
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const coordinator = createWorkLedgerClaimCoordinator({ workLedgerStore });

  const screenshot = await coordinator.claimWork(baseClaimInput({
    kind: "browser_screenshot",
    workKeyParts: { tool: "browser.screenshot", input: { url: "https://example.com" } },
  }));
  assert.equal(screenshot.workItem!.kind, "screenshot");

  const fileRead = await coordinator.claimWork(baseClaimInput({
    kind: "file_read",
    workKeyParts: { freeform: "/tmp/data.csv" },
  }));
  assert.equal(fileRead.workItem!.kind, "data_fetch");

  const fileWrite = await coordinator.claimWork(baseClaimInput({
    kind: "file_write",
    workKeyParts: { freeform: "/tmp/output.svg" },
  }));
  assert.equal(fileWrite.workItem!.kind, "artifact_generation");
});
