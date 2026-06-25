import test from "node:test";
import assert from "node:assert/strict";

import { RuntimeLedgerCoordinator } from "../src/work-ledger/runtimeLedgerCoordinator.js";
import { InMemoryWorkLedgerStore } from "../src/work-ledger/workLedgerStore.js";
import { InMemoryEvidenceLedgerStore } from "../src/work-ledger/evidenceLedgerStore.js";
import { completeBaseAgentToolWork } from "../src/agents/baseAgentToolLedger.js";
import { isSecretKey, sanitizeForLedger } from "../src/work-ledger/sanitize.js";
import { sanitizeObject } from "../src/server/common/parsers.js";
import type { Tool, ToolResult } from "../src/tools/tool.js";

const tool: Tool = {
  name: "http.request",
  version: "1.0.0",
  description: "fixture",
  capabilities: ["http-request"],
  async run(): Promise<ToolResult> {
    return { ok: true, content: "" };
  },
};

test("durable ledger evidence redacts secret content and strips credential URL params", async () => {
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const evidenceLedgerStore = new InMemoryEvidenceLedgerStore();
  const coordinator = new RuntimeLedgerCoordinator({
    runId: "run-redact-1",
    threadId: "thread-redact",
    workLedgerStore,
    evidenceLedgerStore,
    emit: async () => {},
  });

  const item = await workLedgerStore.createItem({
    kind: "api_call",
    status: "claimed",
    workKey: "api_call:http.request:redact",
    title: "redaction smoke",
  });

  const secretUrl = "https://api.example.com/data?api_key=SUPERSECRETKEY&page=2";
  await completeBaseAgentToolWork({
    ledger: coordinator,
    claim: { workItemId: item.id, startedArtifactCount: 0, kind: "api_call" },
    tool,
    toolInput: { url: secretUrl },
    result: { ok: true, content: "Response 200. token=SECRETTOKENVALUE12345 page rendered.", data: {} },
    preview: "Response 200. token=SECRETTOKENVALUE12345 page rendered.",
    artifacts: [],
    toolSpanId: "span-redact",
    durationMs: 5,
  });

  const records = await evidenceLedgerStore.listByWorkItem(item.id);
  assert.ok(records.length > 0, "an evidence record was written");
  const blob = JSON.stringify(records);
  assert.ok(!blob.includes("SECRETTOKENVALUE12345"), "secret token must not be persisted");
  assert.ok(!blob.includes("SUPERSECRETKEY"), "credential URL param must be stripped");
  assert.ok(blob.includes("page=2"), "benign query params are preserved");

  const completed = await workLedgerStore.get(item.id);
  assert.ok(!(completed?.outputSummary ?? "").includes("SECRETTOKENVALUE12345"));
  assert.ok(!(completed?.sourceUrls ?? []).join(" ").includes("SUPERSECRETKEY"));
});

test("secret-key predicates redact cookie / authorization / credential", () => {
  for (const key of ["cookie", "Cookie", "set-cookie", "authorization", "x-credential", "auth"]) {
    assert.equal(isSecretKey(key), true, `isSecretKey should flag ${key}`);
  }
  const ledgerSan = sanitizeForLedger({ cookie: "abc", authorization: "Bearer x", note: "ok" }) as Record<string, unknown>;
  assert.equal(ledgerSan.cookie, "[redacted]");
  assert.equal(ledgerSan.authorization, "[redacted]");
  assert.equal(ledgerSan.note, "ok");

  const auditSan = sanitizeObject({ cookie: "abc", credential: "x", authorization: "y", keep: "v" });
  assert.equal(auditSan.cookie, "[redacted]");
  assert.equal(auditSan.credential, "[redacted]");
  assert.equal(auditSan.authorization, "[redacted]");
  assert.equal(auditSan.keep, "v");
});
