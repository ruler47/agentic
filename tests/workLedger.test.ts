import test from "node:test";
import assert from "node:assert/strict";
import {
  apiCallWorkKey,
  artifactIntentWorkKey,
  searchQueryWorkKey,
  stableJson,
  toolCallWorkKey,
  urlVisitWorkKey,
} from "../src/work-ledger/workKey.js";
import { decideWorkReuse } from "../src/work-ledger/decideWorkReuse.js";
import { sanitizeForLedger, sanitizeMetadata } from "../src/work-ledger/sanitize.js";
import { InMemoryWorkLedgerStore } from "../src/work-ledger/workLedgerStore.js";
import { InMemoryEvidenceLedgerStore } from "../src/work-ledger/evidenceLedgerStore.js";
import { InMemoryRunRetrospectiveStore } from "../src/work-ledger/runRetrospectiveStore.js";
import { WorkLedgerItem } from "../src/work-ledger/types.js";

test("workKey helpers normalize input deterministically", () => {
  assert.equal(
    searchQueryWorkKey({ query: "  Spanish   IT companies  ", provider: "Web", locale: "EN" }),
    searchQueryWorkKey({ query: "spanish it companies", provider: "WEB", locale: "en" }),
  );

  // URL visit ignores the fragment, lowercases host, sorts query params, and drops
  // trailing slashes to dedupe equivalent crawl targets.
  assert.equal(
    urlVisitWorkKey("https://Example.com/path/?b=2&a=1#section"),
    urlVisitWorkKey("HTTPS://example.com/path?a=1&b=2"),
  );

  // Tool call key is stable regardless of property order in the input dictionary.
  assert.equal(
    toolCallWorkKey("browser.operate", { url: "https://example.com/", waitForSelector: ".buy" }),
    toolCallWorkKey("BROWSER.OPERATE", { waitForSelector: ".buy", url: "https://example.com/" }),
  );

  // Secret-shaped input fields never feed into the work key, so a "same call but with
  // a fresh access token" produces the same dedupe key.
  assert.equal(
    toolCallWorkKey("api.crm", { customer: "alice", apiKey: "AAA" }),
    toolCallWorkKey("api.crm", { customer: "alice", apiKey: "BBB" }),
  );

  // API call key sorts query params and lowercases the endpoint host.
  assert.equal(
    apiCallWorkKey({ provider: "crm", endpoint: "https://api.example.com/v1/customers", method: "get", params: { id: 7 } }),
    apiCallWorkKey({ provider: "CRM", endpoint: "HTTPS://api.example.com/v1/customers", method: "GET", params: { id: 7 } }),
  );

  // Artifact intent collapses whitespace and lowercase descriptors.
  assert.equal(
    artifactIntentWorkKey({ kind: "report", descriptor: "  Q1 Sales Summary  " }),
    artifactIntentWorkKey({ kind: "REPORT", descriptor: "q1 sales summary" }),
  );

  // stableJson is order-independent and stable across nested objects/arrays.
  assert.equal(stableJson({ b: 1, a: { z: [3, 2, 1], y: 5 } }), stableJson({ a: { y: 5, z: [3, 2, 1] }, b: 1 }));
});

test("sanitizeMetadata recursively redacts secret-shaped keys", () => {
  const sanitized = sanitizeMetadata({
    label: "ok",
    apiKey: "should-be-hidden",
    nested: {
      Authorization: "Bearer XYZ",
      detail: { telegram_token: "1234:ABC" },
      list: [{ secret: "no" }, "fine"],
    },
  });
  const json = JSON.stringify(sanitized);
  for (const canary of ["should-be-hidden", "Bearer XYZ", "1234:ABC", "secret\":\"no"]) {
    assert.ok(!json.includes(canary), `secret canary ${canary} must not survive sanitization`);
  }
  assert.ok(json.includes("[redacted]"));
  // Non-record top-level inputs are coerced to undefined so we never persist arrays as
  // metadata.
  assert.equal(sanitizeMetadata([1, 2]), undefined);
  assert.equal(sanitizeMetadata("nope"), undefined);
});

test("decideWorkReuse returns deterministic statuses across the lifecycle", () => {
  const completedFresh: WorkLedgerItem = {
    id: "w-completed",
    kind: "search",
    status: "completed",
    workKey: "search:any:any:any:spanish doctors",
    title: "Search done",
    sourceUrls: [],
    artifactIds: [],
    evidenceIds: [],
    createdAt: "2026-05-07T10:00:00.000Z",
    updatedAt: "2026-05-07T10:00:00.000Z",
    freshnessExpiresAt: "2026-05-07T11:00:00.000Z",
  };
  const reuse = decideWorkReuse({
    existingItems: [completedFresh],
    claim: { workKey: completedFresh.workKey, kind: "search" } as never,
    now: new Date("2026-05-07T10:30:00.000Z"),
  });
  assert.equal(reuse.status, "reuse_completed");

  const completedExpired: WorkLedgerItem = {
    ...completedFresh,
    freshnessExpiresAt: "2026-05-07T09:00:00.000Z",
  };
  const expired = decideWorkReuse({
    existingItems: [completedExpired],
    claim: { workKey: completedExpired.workKey, kind: "search" } as never,
    now: new Date("2026-05-07T10:30:00.000Z"),
  });
  assert.equal(expired.status, "create_revalidation");

  const inflight: WorkLedgerItem = {
    ...completedFresh,
    id: "w-running",
    status: "running",
    ownerSpanId: "span-A",
  };
  const wait = decideWorkReuse({
    existingItems: [inflight],
    claim: { workKey: completedFresh.workKey, ownerSpanId: "span-B", kind: "search" } as never,
    now: new Date("2026-05-07T10:30:00.000Z"),
  });
  assert.equal(wait.status, "wait_for_inflight");

  const failed: WorkLedgerItem = {
    ...completedFresh,
    id: "w-failed",
    status: "failed",
    updatedAt: "2026-05-07T10:25:00.000Z",
    freshnessExpiresAt: undefined,
  };
  const blocked = decideWorkReuse({
    existingItems: [failed],
    claim: { workKey: completedFresh.workKey, kind: "search" } as never,
    now: new Date("2026-05-07T10:27:00.000Z"),
  });
  assert.equal(blocked.status, "blocked_by_recent_failure");
  const allowed = decideWorkReuse({
    existingItems: [failed],
    claim: { workKey: completedFresh.workKey, reason: "alternate source", kind: "search" } as never,
    now: new Date("2026-05-07T10:27:00.000Z"),
  });
  assert.equal(allowed.status, "create_new_attempt");

  const stale: WorkLedgerItem = { ...completedFresh, id: "w-stale", status: "stale" };
  const revalidate = decideWorkReuse({
    existingItems: [stale],
    claim: { workKey: completedFresh.workKey, kind: "search" } as never,
    now: new Date("2026-05-07T10:30:00.000Z"),
  });
  assert.equal(revalidate.status, "create_revalidation");

  const fresh = decideWorkReuse({
    existingItems: [],
    claim: { workKey: "search:any:any:any:fresh", kind: "search" } as never,
    now: new Date("2026-05-07T10:30:00.000Z"),
  });
  assert.equal(fresh.status, "create_new_attempt");
});

test("InMemoryWorkLedgerStore persists items, claims, and link operations", async () => {
  const store = new InMemoryWorkLedgerStore();
  const created = await store.createItem({
    kind: "search",
    workKey: "search:any:any:any:topic",
    title: "Initial search",
    threadId: "thread-1",
    runId: "run-1",
    metadata: { topic: "spanish-doctors", apiKey: "should-not-survive" },
  });
  assert.equal(created.kind, "search");
  assert.equal((created.metadata as Record<string, unknown>).apiKey, "[redacted]");

  const fetched = await store.get(created.id);
  assert.deepEqual(fetched, created);

  const updated = await store.updateItemStatus(created.id, {
    status: "completed",
    outputSummary: "Found 3 candidates",
    sourceUrls: ["https://example.com/1", "https://example.com/2"],
  });
  assert.equal(updated.status, "completed");
  assert.equal(updated.sourceUrls.length, 2);

  const sameKey = await store.claimWork({
    workKey: created.workKey,
    kind: "search",
    title: "Sibling tries the same search",
  });
  assert.equal(sameKey.decision.status, "reuse_completed");
  assert.equal(sameKey.item.id, created.id);

  const newKey = await store.claimWork({
    workKey: "search:any:any:any:other",
    kind: "search",
    title: "Different topic",
    ownerSpanId: "span-A",
  });
  assert.equal(newKey.decision.status, "create_new_attempt");
  assert.equal(newKey.item.status, "claimed");
  assert.equal(newKey.item.ownerSpanId, "span-A");

  const linked = await store.appendEvidenceLink(created.id, "ev-1");
  assert.deepEqual(linked.evidenceIds, ["ev-1"]);
  const linkedAgain = await store.appendArtifactLink(created.id, "art-1");
  assert.deepEqual(linkedAgain.artifactIds, ["art-1"]);

  const byThread = await store.listByThread("thread-1");
  assert.ok(byThread.some((item) => item.id === created.id));
  const byRun = await store.listByRun("run-1");
  assert.ok(byRun.some((item) => item.id === created.id));
  const byKey = await store.listByWorkKey(created.workKey);
  assert.equal(byKey.length, 1);
});

test("InMemoryEvidenceLedgerStore filters by run/thread/work-item/artifact/sourceUrl", async () => {
  const store = new InMemoryEvidenceLedgerStore();
  const evidence = await store.createEvidence({
    kind: "source_url",
    title: "Source page",
    sourceUrl: "https://example.com/article",
    runId: "run-1",
    threadId: "thread-1",
    workItemId: "work-1",
    artifactId: "artifact-1",
    metadata: { snapshot: "ok", token: "leak-me" },
  });
  assert.equal(evidence.qaStatus, "unchecked");
  assert.equal((evidence.metadata as Record<string, unknown>).token, "[redacted]");

  assert.equal((await store.listByThread("thread-1")).length, 1);
  assert.equal((await store.listByRun("run-1")).length, 1);
  assert.equal((await store.listByWorkItem("work-1")).length, 1);
  assert.equal((await store.listByArtifact("artifact-1")).length, 1);
  assert.equal((await store.listBySourceUrl("https://example.com/article")).length, 1);
});

test("InMemoryRunRetrospectiveStore tracks proposals and status updates", async () => {
  const store = new InMemoryRunRetrospectiveStore();
  const created = await store.create({
    runId: "run-1",
    threadId: "thread-1",
    runOutcome: "failed",
    suspectedRootCauses: ["Browser blocker"],
    weakTools: ["browser.operate@1.0.0"],
  });
  assert.equal(created.status, "proposed");
  assert.deepEqual(created.suspectedRootCauses, ["Browser blocker"]);

  const linked = await store.appendLinkedProposal(created.id, "memory", "memory-1");
  assert.deepEqual(linked.proposedMemoryIds, ["memory-1"]);
  const linkedTool = await store.appendLinkedProposal(created.id, "tool_follow_up", "inv-1");
  assert.deepEqual(linkedTool.proposedToolFollowUpIds, ["inv-1"]);

  const reviewed = await store.updateStatus(created.id, {
    status: "reviewed",
    summary: "Reviewed by operator.",
  });
  assert.equal(reviewed.status, "reviewed");
  assert.equal(reviewed.summary, "Reviewed by operator.");

  assert.equal((await store.listByRun("run-1")).length, 1);
  assert.equal((await store.listByThread("thread-1")).length, 1);
});

test("sanitizeForLedger preserves arrays while still redacting nested keys", () => {
  const result = sanitizeForLedger([{ apiKey: "X", note: "fine" }]);
  assert.deepEqual(result, [{ apiKey: "[redacted]", note: "fine" }]);
});
