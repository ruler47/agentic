import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolCallbacksService } from "../src/server/modules/tool-callbacks/tool-callbacks.service.js";
import { ToolCallbackTokenIssuer } from "../src/tools/toolCallbackToken.js";
import { LocalArtifactStore } from "../src/artifacts/artifactStore.js";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { InMemoryWorkLedgerStore } from "../src/work-ledger/workLedgerStore.js";
import { SkillMemory } from "../src/memory/skillMemory.js";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "tool-callbacks-"));
  const artifacts = new LocalArtifactStore(dir);
  const runs = new InMemoryRunStore();
  const memory = new SkillMemory(join(dir, "skills.json"));
  const workLedger = new InMemoryWorkLedgerStore();
  const issuer = new ToolCallbackTokenIssuer({ secret: "test" });
  const service = new ToolCallbacksService(artifacts, runs, memory, workLedger);
  return { dir, artifacts, runs, memory, workLedger, issuer, service };
}

async function cleanup(dir: string) {
  await rm(dir, { recursive: true, force: true });
}

test("ToolCallbacksService.saveArtifact persists via artifact store", async () => {
  const { dir, runs, service, issuer } = await setup();
  try {
    const run = await runs.create("test task");
    const claims = issuer.verify(
      issuer.issue({ runId: run.id, toolName: "test.tool", scope: ["artifacts.save"] }),
    );
    const result = await service.saveArtifact(claims, {
      filename: "result.txt",
      mimeType: "text/plain",
      content: "hello world",
      description: "test artifact",
    });
    assert.equal(result.filename, "result.txt");
    assert.equal(result.mimeType, "text/plain");
    assert.ok(result.url.length > 0);
    assert.ok(result.sizeBytes > 0);
  } finally {
    await cleanup(dir);
  }
});

test("ToolCallbacksService.saveArtifact rejects body without filename", async () => {
  const { dir, runs, service, issuer } = await setup();
  try {
    const run = await runs.create("test");
    const claims = issuer.verify(
      issuer.issue({ runId: run.id, toolName: "test.tool", scope: ["artifacts.save"] }),
    );
    await assert.rejects(
      service.saveArtifact(claims, { mimeType: "text/plain", content: "x" }),
      /filename is required/,
    );
  } finally {
    await cleanup(dir);
  }
});

test("ToolCallbacksService.ledgerClaim creates a ledger item", async () => {
  const { dir, runs, service, issuer } = await setup();
  try {
    const run = await runs.create("test");
    const claims = issuer.verify(
      issuer.issue({ runId: run.id, toolName: "browser.operate", scope: ["ledger.claim"] }),
    );
    const result = await service.ledgerClaim(claims, {
      kind: "tool",
      workKey: "tool:browser.operate:test",
      title: "Run browser.operate test",
      inputSummary: "test input",
    });
    assert.match(result.itemId, /^work_/);
    assert.equal(result.status, "claim_created");
  } finally {
    await cleanup(dir);
  }
});

test("ToolCallbacksService.memorySearch returns memory entries", async () => {
  const { dir, runs, memory, service, issuer } = await setup();
  try {
    const run = await runs.create("test");
    await memory.add({
      title: "Test skill",
      tags: [],
      summary: "How to test things in agentic.",
      reusableProcedure: "Step 1, step 2.",
      scope: "global",
      status: "accepted",
      confidence: 0.8,
      sensitivity: "normal",
      evidence: [],
    });
    const claims = issuer.verify(
      issuer.issue({ runId: run.id, toolName: "any.tool", scope: ["memory.search"] }),
    );
    const result = await service.memorySearch(claims, { query: "test" });
    assert.ok(Array.isArray(result.memories));
    assert.ok(result.memories.length >= 1);
  } finally {
    await cleanup(dir);
  }
});

test("ToolCallbacksService.emitRunEvent appends to run event log", async () => {
  const { dir, runs, service, issuer } = await setup();
  try {
    const run = await runs.create("test");
    const claims = issuer.verify(
      issuer.issue({ runId: run.id, toolName: "browser.operate", scope: ["events.emit"] }),
    );
    const result = await service.emitRunEvent(claims, {
      type: "navigation",
      title: "Navigated to https://example.com",
      detail: "step 1",
      status: "completed",
      payload: { url: "https://example.com" },
    });
    assert.equal(result.ok, true);
    const reloaded = await runs.get(run.id);
    assert.ok(reloaded);
    const tcEvents = (reloaded!.events || []).filter((e) =>
      String(e.type).startsWith("tool-callback:"),
    );
    assert.equal(tcEvents.length, 1);
    assert.equal(tcEvents[0].actor, "tool:browser.operate");
  } finally {
    await cleanup(dir);
  }
});

test("ToolCallbacksService.emitRunEvent rejects when run does not exist", async () => {
  const { dir, service, issuer } = await setup();
  try {
    const claims = issuer.verify(
      issuer.issue({ runId: "nonexistent_run_id", toolName: "x", scope: ["events.emit"] }),
    );
    await assert.rejects(
      service.emitRunEvent(claims, { type: "navigation" }),
      /not found/i,
    );
  } finally {
    await cleanup(dir);
  }
});
