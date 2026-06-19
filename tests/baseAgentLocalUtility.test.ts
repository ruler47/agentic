import test from "node:test";
import assert from "node:assert/strict";

import { BaseAgent } from "../src/agents/baseAgent.js";
import type { LlmClient, LlmToolReply, LlmToolSchema } from "../src/llm/client.js";
import { DataTransformTool } from "../src/tools/dataTransformTool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentArtifact, AgentEvent, ArtifactCreateInput, Message } from "../src/types.js";
import {
  RuntimeLedgerCoordinator,
  type RuntimeLedgerEventDraft,
} from "../src/work-ledger/runtimeLedgerCoordinator.js";
import { InMemoryEvidenceLedgerStore } from "../src/work-ledger/evidenceLedgerStore.js";
import { InMemoryWorkLedgerStore } from "../src/work-ledger/workLedgerStore.js";

class SequenceLlm {
  calls = 0;

  constructor(private readonly replies: LlmToolReply[]) {}

  async completeWithTools(_messages: Message[], _tools: LlmToolSchema[]): Promise<LlmToolReply> {
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    return reply;
  }
}

test("local utility fast path writes inline JSON transforms as downloadable artifacts", async () => {
  const registry = new ToolRegistry();
  registry.register(new DataTransformTool());
  const writeCalls: unknown[] = [];
  registry.register({
    name: "file.write",
    version: "1.0.0",
    description: "Writes files.",
    capabilities: ["file-write", "artifacts"],
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    async run(input) {
      writeCalls.push(input);
      return { ok: true, content: `Wrote ${String(input.path)}.`, data: { path: input.path, bytes: String(input.content ?? "").length } };
    },
  });

  const workLedger = new InMemoryWorkLedgerStore();
  const evidenceLedger = new InMemoryEvidenceLedgerStore();
  const ledgerEvents: RuntimeLedgerEventDraft[] = [];
  const artifacts: AgentArtifact[] = [];
  const savedInputs: ArtifactCreateInput[] = [];
  const llm = new SequenceLlm([{ content: "should not be used", toolCalls: [], finishReason: "stop" }]);
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run(
    'Преобразуй JSON [{"name":"Ann","age":31},{"name":"Bob","age":42}] в CSV, отсортируй по age по убыванию и сохрани в people.csv.',
    {
      runId: "run_local_inline_write",
      ledger: new RuntimeLedgerCoordinator({
        runId: "run_local_inline_write",
        threadId: "thread_local_inline_write",
        instanceId: "instance-local",
        workLedgerStore: workLedger,
        evidenceLedgerStore: evidenceLedger,
        emit: async (event) => {
          ledgerEvents.push(event);
        },
      }),
      runContext: {
        runId: "run_local_inline_write",
        threadId: "thread_local_inline_write",
        instanceId: "instance-local",
      },
      onEvent: (event) => {
        events.push(event);
      },
      saveArtifact: async (artifact) => {
        savedInputs.push(artifact);
        const saved: AgentArtifact = {
          id: `artifact_${artifacts.length + 1}`,
          runId: "run_local_inline_write",
          kind: "output",
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.content.length,
          url: `/api/runs/run_local_inline_write/artifacts/artifact_${artifacts.length + 1}`,
          description: artifact.description,
          quality: artifact.quality,
          createdAt: new Date().toISOString(),
        };
        artifacts.push(saved);
        return saved;
      },
    },
  );

  assert.equal(result.runStatus, "completed");
  assert.equal(llm.calls, 0);
  assert.equal(writeCalls.length, 1);
  assert.deepEqual(writeCalls[0], { path: "people.csv", content: "name,age\nBob,42\nAnn,31" });
  assert.equal(result.artifacts?.[0]?.filename, "people.csv");
  assert.equal(savedInputs[0]?.content.toString("utf8"), "name,age\nBob,42\nAnn,31");
  assert.match(result.finalAnswer, /people\.csv/);
  assert.ok(events.some((event) => event.type === "local-utility-fast-path-selected"));
  assert.equal(events.some((event) => event.activity === "llm"), false);

  const workItems = await workLedger.listByRun("run_local_inline_write");
  assert.equal(workItems.length, 2);
  const artifactWork = workItems.find((item) => item.kind === "artifact_generation");
  assert.equal(artifactWork?.artifactIds[0], result.artifacts?.[0]?.id);
  const evidence = await evidenceLedger.listByRun("run_local_inline_write");
  assert.equal(evidence.length, 2);
  assert.ok(evidence.some((record) => record.toolName === "data.transform"));
  assert.ok(evidence.some((record) => record.toolName === "file.write" && record.kind === "file" && record.artifactId === result.artifacts?.[0]?.id));
  assert.ok(ledgerEvents.some((event) => event.type === "work-ledger-claim-created"));
});

test("local utility fast path chains file.read through data.transform into file.write", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "file.read",
    version: "1.0.0",
    description: "Reads files.",
    capabilities: ["file-read"],
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async run(input) {
      assert.deepEqual(input, { path: "people.json" });
      return { ok: true, content: '[{"name":"Ann","age":31},{"name":"Bob","age":42}]', data: { path: "people.json" } };
    },
  });
  registry.register(new DataTransformTool());
  const writeCalls: unknown[] = [];
  registry.register({
    name: "file.write",
    version: "1.0.0",
    description: "Writes files.",
    capabilities: ["file-write", "artifacts"],
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    async run(input) {
      writeCalls.push(input);
      return { ok: true, content: `Wrote ${String(input.path)}.`, data: { path: input.path, bytes: String(input.content ?? "").length } };
    },
  });

  const llm = new SequenceLlm([{ content: "should not be used", toolCalls: [], finishReason: "stop" }]);
  const workLedger = new InMemoryWorkLedgerStore();
  const evidenceLedger = new InMemoryEvidenceLedgerStore();
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Прочитай people.json, отсортируй по age по убыванию и сохрани в people.csv.", {
    runId: "run_local_file_chain",
    ledger: new RuntimeLedgerCoordinator({
      runId: "run_local_file_chain",
      threadId: "thread_local_file_chain",
      instanceId: "instance-local",
      workLedgerStore: workLedger,
      evidenceLedgerStore: evidenceLedger,
    }),
    runContext: {
      runId: "run_local_file_chain",
      threadId: "thread_local_file_chain",
      instanceId: "instance-local",
    },
    saveArtifact: async (artifact) => ({
      id: "artifact_file_chain",
      runId: "run_local_file_chain",
      kind: "output",
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.content.length,
      url: "/api/runs/run_local_file_chain/artifacts/artifact_file_chain",
      description: artifact.description,
      quality: artifact.quality,
      createdAt: new Date().toISOString(),
    }),
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(llm.calls, 0);
  assert.deepEqual(writeCalls[0], { path: "people.csv", content: "name,age\nBob,42\nAnn,31" });
  assert.equal(result.artifacts?.[0]?.filename, "people.csv");
  assert.match(result.finalAnswer, /people\.csv/);
  const workItems = await workLedger.listByRun("run_local_file_chain");
  assert.equal(workItems.length, 3);
  assert.ok(workItems.some((item) => item.kind === "artifact_generation" && item.artifactIds[0] === result.artifacts?.[0]?.id));
  const evidence = await evidenceLedger.listByRun("run_local_file_chain");
  assert.deepEqual(new Set(evidence.map((record) => record.toolName)), new Set(["file.read", "data.transform", "file.write"]));
});
