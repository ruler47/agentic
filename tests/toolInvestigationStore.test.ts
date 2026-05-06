import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryToolInvestigationStore,
  sanitizeContextBundle,
} from "../src/tools/toolInvestigationStore.js";

test("InMemoryToolInvestigationStore creates, lists, gets, and updates investigations", async () => {
  const store = new InMemoryToolInvestigationStore();

  const created = await store.create({
    source: "trace_span",
    title: "browser.screenshot returned a loader page",
    operatorComment: "Looks like a Cloudflare blocker.",
    runId: "run-123",
    spanId: "span-abc",
    toolName: "browser.screenshot",
    toolVersion: "1.0.0",
    artifactIds: ["art-1", "art-1", "art-2"],
    contextBundle: {
      taskPrompt: "Capture proof",
      actor: "browser.screenshot",
      activity: "tool",
      status: "failed",
      error: "Loader page detected",
    },
  });

  assert.match(created.id, /^inv_trace_span_/);
  assert.equal(created.status, "open");
  assert.deepEqual(created.artifactIds, ["art-1", "art-2"]);
  assert.equal(created.toolName, "browser.screenshot");

  const fetched = await store.get(created.id);
  assert.deepEqual(fetched, created);

  const list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, created.id);

  const updated = await store.update(created.id, {
    status: "linked_to_build",
    operatorComment: "Promoted to build request 42",
    linkedBuildRequestId: "toolbuild-42",
  });
  assert.equal(updated.status, "linked_to_build");
  assert.equal(updated.linkedBuildRequestId, "toolbuild-42");
  assert.equal(updated.operatorComment, "Promoted to build request 42");
  assert.notEqual(updated.updatedAt, created.updatedAt);

  const cleared = await store.update(created.id, { linkedBuildRequestId: null });
  assert.equal(cleared.linkedBuildRequestId, undefined);
});

test("InMemoryToolInvestigationStore returns undefined for missing ids and rejects unknown updates", async () => {
  const store = new InMemoryToolInvestigationStore();
  assert.equal(await store.get("missing"), undefined);
  await assert.rejects(() => store.update("missing", { status: "closed" }), /was not found/);
});

test("sanitizeContextBundle redacts secret-shaped keys recursively", () => {
  const bundle = sanitizeContextBundle({
    taskPrompt: "  Use the API safely  ",
    actor: "tool.api",
    inputSummary: "POST /score",
    toolSettingsSummary: {
      baseUrl: "https://api.example",
      apiKey: "VERY-SECRET",
      headers: {
        authorization: "Bearer SECRET",
        "x-trace-id": "trace-1",
      },
      backups: ["plain", { token: "ALSO-SECRET", note: "ok" }],
    },
    extra: {
      nested: {
        password: "hunter2",
        comment: "nothing sensitive",
      },
    },
    relatedArtifactRefs: [
      { id: "art-1", filename: "report.pdf", mimeType: "application/pdf", url: "/artifacts/art-1" },
      { id: "", filename: "", url: "" },
    ],
    notes: ["", "  triage me  "],
  });

  assert.equal(bundle.taskPrompt, "Use the API safely");
  assert.equal(bundle.toolSettingsSummary?.apiKey, "[redacted]");
  assert.equal((bundle.toolSettingsSummary?.headers as { authorization: string }).authorization, "[redacted]");
  assert.equal((bundle.toolSettingsSummary?.headers as { "x-trace-id": string })["x-trace-id"], "trace-1");
  const backups = bundle.toolSettingsSummary?.backups as Array<unknown>;
  assert.equal(backups[0], "plain");
  assert.equal((backups[1] as { token: string; note: string }).token, "[redacted]");
  assert.equal((backups[1] as { token: string; note: string }).note, "ok");
  assert.equal((bundle.extra?.nested as { password: string; comment: string }).password, "[redacted]");
  assert.equal((bundle.extra?.nested as { password: string; comment: string }).comment, "nothing sensitive");
  assert.equal(bundle.relatedArtifactRefs?.length, 1);
  assert.equal(bundle.notes?.length, 1);
  assert.equal(bundle.notes?.[0], "triage me");
});

test("InMemoryToolInvestigationStore strips secrets stored through create", async () => {
  const store = new InMemoryToolInvestigationStore();
  const investigation = await store.create({
    source: "tool_detail",
    title: "API key may be wrong",
    toolName: "generated.api.aml",
    contextBundle: {
      toolSettingsSummary: {
        baseUrl: "https://api.example",
        apiKey: "REAL-KEY-DO-NOT-LEAK",
      },
    },
  });
  assert.equal(investigation.contextBundle.toolSettingsSummary?.apiKey, "[redacted]");
  const serialized = JSON.stringify(investigation);
  assert.doesNotMatch(serialized, /REAL-KEY-DO-NOT-LEAK/);
});
