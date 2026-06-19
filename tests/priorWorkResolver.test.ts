import test from "node:test";
import assert from "node:assert/strict";

import { resolvePriorWorkContext } from "../src/work-ledger/priorWorkResolver.js";
import { InMemoryEvidenceLedgerStore } from "../src/work-ledger/evidenceLedgerStore.js";
import { InMemoryWorkLedgerStore } from "../src/work-ledger/workLedgerStore.js";

test("prior work resolver reuses passed source evidence for source follow-ups", async () => {
  const work = new InMemoryWorkLedgerStore();
  const evidence = new InMemoryEvidenceLedgerStore();
  const item = await work.createItem({
    threadId: "thread-btc",
    runId: "run-prior",
    kind: "url_visit",
    status: "completed",
    workKey: "url_visit:web.read:btc",
    title: "Read BTC source",
    sourceUrls: ["https://coinmarketcap.com/currencies/bitcoin/"],
  });
  const record = await evidence.createEvidence({
    threadId: "thread-btc",
    runId: "run-prior",
    workItemId: item.id,
    kind: "source_url",
    sourceUrl: "https://coinmarketcap.com/currencies/bitcoin/",
    toolName: "web.read",
    title: "CoinMarketCap Bitcoin",
    summary: "Prior BTC price source.",
    qaStatus: "passed",
    confidence: 0.9,
  });
  await work.appendEvidenceLink(item.id, record.id);

  const context = await resolvePriorWorkContext({
    task: "какой источник ты использовал для цены биткоина в предыдущем ответе?",
    threadId: "thread-btc",
    runId: "run-follow-up",
    workLedgerStore: work,
    evidenceLedgerStore: evidence,
  });

  assert.equal(context.decision.decision, "reuse");
  assert.equal(context.decision.workItemId, item.id);
  assert.deepEqual(context.decision.evidenceIds, [record.id]);
  assert.deepEqual(context.decision.sourceUrls, ["https://coinmarketcap.com/currencies/bitcoin/"]);
  assert.equal(context.rejectedEvidence.length, 0);
});

test("prior work resolver does not reuse failed evidence and exposes retry exclusions", async () => {
  const work = new InMemoryWorkLedgerStore();
  const evidence = new InMemoryEvidenceLedgerStore();
  const failed = await work.createItem({
    threadId: "thread-booking",
    runId: "run-prior",
    kind: "screenshot",
    status: "failed",
    workKey: "screenshot:blocked",
    title: "Blocked provider screenshot",
    sourceUrls: ["https://example.test/blocked-provider"],
    error: "Blocked by anti-bot wall.",
  });
  await evidence.createEvidence({
    threadId: "thread-booking",
    runId: "run-prior",
    workItemId: failed.id,
    kind: "screenshot",
    sourceUrl: "https://example.test/blocked-provider",
    title: "Rejected screenshot",
    summary: "Blocked by anti-bot wall.",
    qaStatus: "failed",
    confidence: 0.1,
    limitations: ["anti-bot blocker"],
  });

  const context = await resolvePriorWorkContext({
    task: "попробуй еще раз подготовить запись",
    threadId: "thread-booking",
    runId: "run-retry",
    workLedgerStore: work,
    evidenceLedgerStore: evidence,
  });

  assert.equal(context.decision.decision, "retry_excluding");
  assert.deepEqual(context.retryExclusions, ["https://example.test/blocked-provider"]);
  assert.deepEqual(context.decision.retryExclusions, ["https://example.test/blocked-provider"]);
  assert.equal(context.successfulEvidence.length, 0);
});

test("prior work resolver refreshes instead of reusing when the task asks for current data", async () => {
  const work = new InMemoryWorkLedgerStore();
  const evidence = new InMemoryEvidenceLedgerStore();
  const item = await work.createItem({
    threadId: "thread-btc",
    runId: "run-prior",
    kind: "url_visit",
    status: "completed",
    workKey: "url_visit:web.read:btc",
    title: "Read BTC source",
    sourceUrls: ["https://coinmarketcap.com/currencies/bitcoin/"],
  });
  const record = await evidence.createEvidence({
    threadId: "thread-btc",
    runId: "run-prior",
    workItemId: item.id,
    kind: "source_url",
    sourceUrl: "https://coinmarketcap.com/currencies/bitcoin/",
    title: "CoinMarketCap Bitcoin",
    summary: "Prior BTC price source.",
    qaStatus: "passed",
    confidence: 0.9,
  });
  await work.appendEvidenceLink(item.id, record.id);

  const context = await resolvePriorWorkContext({
    task: "какая сейчас актуальная цена биткоина?",
    threadId: "thread-btc",
    runId: "run-current",
    workLedgerStore: work,
    evidenceLedgerStore: evidence,
  });

  assert.equal(context.decision.decision, "refresh");
  assert.deepEqual(context.decision.evidenceIds, []);
  assert.equal(context.successfulEvidence.length, 1);
});
