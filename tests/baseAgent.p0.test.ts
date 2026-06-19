import test from "node:test";
import assert from "node:assert/strict";

import { BaseAgent } from "../src/agents/baseAgent.js";
import type { LlmClient, LlmToolReply, LlmToolSchema } from "../src/llm/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { DataTransformTool } from "../src/tools/dataTransformTool.js";
import type { AgentArtifact, AgentEvent, ArtifactCreateInput, Message } from "../src/types.js";
import {
  RuntimeLedgerCoordinator,
  workKeyForToolCall,
  type RuntimeLedgerEventDraft,
} from "../src/work-ledger/runtimeLedgerCoordinator.js";
import { InMemoryEvidenceLedgerStore } from "../src/work-ledger/evidenceLedgerStore.js";
import { InMemoryWorkLedgerStore } from "../src/work-ledger/workLedgerStore.js";

class SequenceLlm {
  calls = 0;
  messagesByCall: Message[][] = [];

  constructor(private readonly replies: LlmToolReply[]) {}

  async completeWithTools(messages: Message[], _tools: LlmToolSchema[]): Promise<LlmToolReply> {
    this.messagesByCall.push(messages);
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    return reply;
  }
}

test("BaseAgent uses structured proof for API-only tasks without visual proof by default", async () => {
  const registry = new ToolRegistry();
  const httpCalls: unknown[] = [];
  let screenshotCalls = 0;
  const workLedger = new InMemoryWorkLedgerStore();
  const evidenceLedger = new InMemoryEvidenceLedgerStore();
  const ledgerEvents: RuntimeLedgerEventDraft[] = [];
  const ledger = new RuntimeLedgerCoordinator({
    runId: "run_no_screenshot_api",
    threadId: "thread_api",
    instanceId: "instance-local",
    workLedgerStore: workLedger,
    evidenceLedgerStore: evidenceLedger,
    emit: async (event) => {
      ledgerEvents.push(event);
    },
  });
  registry.register({
    name: "http.request",
    version: "0.1.0",
    description: "Generic HTTP JSON API client.",
    capabilities: ["http-json", "external-api", "structured-data"],
    inputSchema: { type: "object", properties: { url: { type: "string" }, method: { type: "string" } }, required: ["url"] },
    async run(input) {
      httpCalls.push(input);
      return {
        ok: true,
        content: "HTTP 200: title=delectus aut autem",
        data: {
          url: "https://jsonplaceholder.typicode.com/todos/1",
          status: 200,
          headers: {
            reportTo: "https://nel.heroku.com/reports?sid=telemetry",
          },
          body: { id: 1, title: "delectus aut autem", completed: false },
        },
      };
    },
  });
  registry.register({
    name: "browser.screenshot",
    version: "0.1.5",
    description: "Captures browser screenshots.",
    capabilities: ["browser-screenshot", "artifact-image"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run() {
      screenshotCalls += 1;
      return { ok: true, content: "screenshot captured" };
    },
  });

  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_http",
          name: "http_request",
          arguments: { url: "https://jsonplaceholder.typicode.com/todos/1", method: "GET" },
        },
      ],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_finish",
          name: "finish",
          arguments: { answer: "title: delectus aut autem. Source: jsonplaceholder." },
        },
      ],
    },
  ]);
  const events: AgentEvent[] = [];
  const artifacts: AgentArtifact[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Прочитай API https://jsonplaceholder.typicode.com/todos/1 и скажи title.", {
    runId: "run_no_screenshot_api",
    ledger,
    runContext: {
      runId: "run_no_screenshot_api",
      threadId: "thread_api",
      instanceId: "instance-local",
    },
    onEvent: (event) => {
      events.push(event);
    },
    saveArtifact: async (artifact: ArtifactCreateInput) => {
      const saved: AgentArtifact = {
        id: `artifact_${artifacts.length + 1}`,
        runId: "run_no_screenshot_api",
        kind: "output",
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: Buffer.isBuffer(artifact.content) ? artifact.content.length : String(artifact.content).length,
        url: `/api/runs/run_no_screenshot_api/artifacts/artifact_${artifacts.length + 1}`,
        description: artifact.description,
        quality: artifact.quality,
        createdAt: new Date().toISOString(),
      };
      artifacts.push(saved);
      return saved;
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(httpCalls.length, 1);
  assert.equal(screenshotCalls, 0);
  assert.match(result.finalAnswer, /delectus aut autem/);
  assert.ok((result.artifacts ?? []).some((artifact) => artifact.filename === "http_request-structured-proof.json"));
  assert.equal(events.some((event) => event.type === "agent-proof-repair-requested"), false);

  const workItems = await workLedger.listByRun("run_no_screenshot_api");
  assert.equal(workItems.length, 1);
  assert.equal(workItems[0]?.kind, "api_call");
  assert.equal(workItems[0]?.status, "completed");
  assert.equal(workItems[0]?.sourceUrls[0], "https://jsonplaceholder.typicode.com/todos/1");
  assert.deepEqual(workItems[0]?.sourceUrls, ["https://jsonplaceholder.typicode.com/todos/1"]);

  const evidence = await evidenceLedger.listByRun("run_no_screenshot_api");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.kind, "api_response");
  assert.equal(evidence[0]?.toolName, "http.request");
  assert.equal(evidence[0]?.workItemId, workItems[0]?.id);
  assert.equal(evidence[0]?.sourceUrl, "https://jsonplaceholder.typicode.com/todos/1");
  assert.equal((await workLedger.get(workItems[0]!.id))?.evidenceIds[0], evidence[0]?.id);
  assert.ok(ledgerEvents.some((event) => event.type === "work-ledger-claim-created"));
  assert.ok(ledgerEvents.some((event) => event.type === "evidence-ledger-recorded"));
});

test("BaseAgent registers successful file.write output as a downloadable artifact", async () => {
  const registry = new ToolRegistry();
  const writeCalls: unknown[] = [];
  const workLedger = new InMemoryWorkLedgerStore();
  const evidenceLedger = new InMemoryEvidenceLedgerStore();
  const ledger = new RuntimeLedgerCoordinator({
    runId: "run_file_write_artifact",
    threadId: "thread_file",
    instanceId: "instance-local",
    workLedgerStore: workLedger,
    evidenceLedgerStore: evidenceLedger,
  });
  registry.register({
    name: "file.write",
    version: "1.0.0",
    description: "Writes UTF-8 files to the workspace.",
    capabilities: ["file-write", "artifacts"],
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    async run(input) {
      writeCalls.push(input);
      return {
        ok: true,
        content: "Wrote smoke-people.csv.",
        data: { path: "smoke-people.csv", bytes: 30 },
      };
    },
  });

  const csv = "name,age\nBob,42\nAnn,31\nCara,25";
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_write",
          name: "file_write",
          arguments: { path: "smoke-people.csv", content: csv },
        },
      ],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_finish",
          name: "finish",
          arguments: { answer: "Сохранил smoke-people.csv." },
        },
      ],
    },
  ]);
  const artifacts: AgentArtifact[] = [];
  const savedInputs: ArtifactCreateInput[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Сохрани CSV в smoke-people.csv и приложи файл как артефакт.", {
    runId: "run_file_write_artifact",
    ledger,
    runContext: {
      runId: "run_file_write_artifact",
      threadId: "thread_file",
      instanceId: "instance-local",
    },
    saveArtifact: async (artifact: ArtifactCreateInput) => {
      savedInputs.push(artifact);
      const saved: AgentArtifact = {
        id: `artifact_${artifacts.length + 1}`,
        runId: "run_file_write_artifact",
        kind: "output",
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.content.length,
        url: `/api/runs/run_file_write_artifact/artifacts/artifact_${artifacts.length + 1}`,
        description: artifact.description,
        quality: artifact.quality,
        createdAt: new Date().toISOString(),
      };
      artifacts.push(saved);
      return saved;
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(writeCalls.length, 1);
  assert.equal(result.artifacts?.length, 1);
  assert.equal(result.artifacts?.[0]?.filename, "smoke-people.csv");
  assert.equal(result.artifacts?.[0]?.mimeType, "text/csv");
  assert.equal(savedInputs[0]?.description, "File written to workspace path smoke-people.csv");
  assert.equal(savedInputs[0]?.content.toString("utf8"), csv);

  const workItems = await workLedger.listByRun("run_file_write_artifact");
  assert.equal(workItems.length, 1);
  assert.equal(workItems[0]?.kind, "artifact_generation");
  assert.equal(workItems[0]?.status, "completed");
  assert.equal(workItems[0]?.artifactIds[0], result.artifacts?.[0]?.id);

  const evidence = await evidenceLedger.listByRun("run_file_write_artifact");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.kind, "file");
  assert.equal(evidence[0]?.artifactId, result.artifacts?.[0]?.id);
  assert.equal(evidence[0]?.workItemId, workItems[0]?.id);
});

test("BaseAgent reuses safe http.request evidence across runs through Work Ledger", async () => {
  const registry = new ToolRegistry();
  const workLedger = new InMemoryWorkLedgerStore();
  const evidenceLedger = new InMemoryEvidenceLedgerStore();
  const ledgerEvents: RuntimeLedgerEventDraft[] = [];
  let httpCalls = 0;
  const requestInput = { url: "https://jsonplaceholder.typicode.com/todos/1", method: "GET" };

  registry.register({
    name: "http.request",
    version: "0.1.0",
    description: "Generic HTTP JSON API client.",
    capabilities: ["http-json", "external-api", "structured-data"],
    inputSchema: { type: "object", properties: { url: { type: "string" }, method: { type: "string" } }, required: ["url"] },
    async run() {
      httpCalls += 1;
      return {
        ok: true,
        content: "HTTP 200: title=delectus aut autem",
        data: {
          url: requestInput.url,
          status: 200,
          body: { id: 1, title: "delectus aut autem", completed: false },
        },
      };
    },
  });

  const makeLedger = (runId: string) => new RuntimeLedgerCoordinator({
    runId,
    threadId: "thread_reuse_api",
    instanceId: "instance-local",
    workLedgerStore: workLedger,
    evidenceLedgerStore: evidenceLedger,
    emit: async (event) => {
      ledgerEvents.push(event);
    },
  });
  const makeLlm = () => new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_http", name: "http_request", arguments: requestInput }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_finish", name: "finish", arguments: { answer: "title: delectus aut autem." } }],
    },
  ]);

  const firstAgent = new BaseAgent(makeLlm() as unknown as LlmClient, registry);
  const first = await firstAgent.run("Прочитай API https://jsonplaceholder.typicode.com/todos/1 и скажи title.", {
    runId: "run_reuse_api_1",
    ledger: makeLedger("run_reuse_api_1"),
    runContext: {
      runId: "run_reuse_api_1",
      threadId: "thread_reuse_api",
      instanceId: "instance-local",
    },
  });
  assert.equal(first.runStatus, "completed");
  assert.equal(httpCalls, 1);

  const canonicalWorkKey = workKeyForToolCall("http.request", "api_call", requestInput);
  const reusableIndexItems = await workLedger.listByWorkKey(canonicalWorkKey);
  assert.equal(reusableIndexItems.length, 1);
  assert.equal(reusableIndexItems[0]?.runId, undefined);
  assert.equal(reusableIndexItems[0]?.status, "completed");
  assert.equal(reusableIndexItems[0]?.evidenceIds.length, 1);

  const secondLlm = makeLlm();
  const secondAgent = new BaseAgent(secondLlm as unknown as LlmClient, registry);
  const second = await secondAgent.run("Прочитай API https://jsonplaceholder.typicode.com/todos/1 и скажи title.", {
    runId: "run_reuse_api_2",
    ledger: makeLedger("run_reuse_api_2"),
    runContext: {
      runId: "run_reuse_api_2",
      threadId: "thread_reuse_api",
      instanceId: "instance-local",
    },
  });

  assert.equal(second.runStatus, "completed");
  assert.equal(httpCalls, 1);
  assert.ok(secondLlm.messagesByCall[1]?.some((message) =>
    message.role === "tool" && /Reused passed Work Ledger evidence/i.test(String(message.content))
  ));

  const secondWorkItems = await workLedger.listByRun("run_reuse_api_2");
  assert.equal(secondWorkItems.length, 1);
  assert.equal(secondWorkItems[0]?.status, "completed");
  assert.equal(secondWorkItems[0]?.kind, "api_call");

  const secondEvidence = await evidenceLedger.listByRun("run_reuse_api_2");
  assert.equal(secondEvidence.length, 1);
  assert.equal(secondEvidence[0]?.qaStatus, "passed");
  assert.equal(secondEvidence[0]?.metadata?.reusedFromWorkItemId, reusableIndexItems[0]?.id);
  assert.ok(ledgerEvents.some((event) => event.type === "work-ledger-reuse-available"));
  assert.ok(ledgerEvents.some((event) => event.type === "work-ledger-reuse-applied"));
});

test("BaseAgent skips reusable http.request evidence for current-data tasks", async () => {
  const registry = new ToolRegistry();
  const workLedger = new InMemoryWorkLedgerStore();
  const evidenceLedger = new InMemoryEvidenceLedgerStore();
  const ledgerEvents: RuntimeLedgerEventDraft[] = [];
  let httpCalls = 0;
  const requestInput = { url: "https://api.example.test/btc", method: "GET" };

  registry.register({
    name: "http.request",
    version: "0.1.0",
    description: "Generic HTTP JSON API client.",
    capabilities: ["http-json", "external-api", "structured-data"],
    inputSchema: { type: "object", properties: { url: { type: "string" }, method: { type: "string" } }, required: ["url"] },
    async run() {
      httpCalls += 1;
      return {
        ok: true,
        content: `HTTP 200: price=${httpCalls === 1 ? "70000" : "70111"}`,
        data: {
          url: requestInput.url,
          status: 200,
          body: { symbol: "BTC", price: httpCalls === 1 ? 70000 : 70111 },
        },
      };
    },
  });

  const makeLedger = (runId: string) => new RuntimeLedgerCoordinator({
    runId,
    threadId: "thread_current_api",
    instanceId: "instance-local",
    workLedgerStore: workLedger,
    evidenceLedgerStore: evidenceLedger,
    emit: async (event) => {
      ledgerEvents.push(event);
    },
  });
  const makeLlm = (answer: string) => new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_http", name: "http_request", arguments: requestInput }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_finish", name: "finish", arguments: { answer } }],
    },
  ]);

  const firstAgent = new BaseAgent(makeLlm("BTC price: 70000.") as unknown as LlmClient, registry);
  const first = await firstAgent.run("Прочитай API https://api.example.test/btc и скажи цену BTC.", {
    runId: "run_current_api_1",
    ledger: makeLedger("run_current_api_1"),
    runContext: {
      runId: "run_current_api_1",
      threadId: "thread_current_api",
      instanceId: "instance-local",
    },
  });
  assert.equal(first.runStatus, "completed");
  assert.equal(httpCalls, 1);

  const canonicalWorkKey = workKeyForToolCall("http.request", "api_call", requestInput);
  const reusableIndexItems = await workLedger.listByWorkKey(canonicalWorkKey);
  assert.equal(reusableIndexItems.length, 1);

  const secondAgent = new BaseAgent(makeLlm("BTC price: 70111.") as unknown as LlmClient, registry);
  const second = await secondAgent.run("Какая сейчас цена BTC? Прочитай API https://api.example.test/btc.", {
    runId: "run_current_api_2",
    ledger: makeLedger("run_current_api_2"),
    runContext: {
      runId: "run_current_api_2",
      threadId: "thread_current_api",
      instanceId: "instance-local",
    },
  });

  assert.equal(second.runStatus, "completed");
  assert.equal(httpCalls, 2);
  assert.ok(ledgerEvents.some((event) =>
    event.type === "work-ledger-reuse-skipped" &&
    /current\/fresh data/i.test(event.detail ?? "")
  ));
  assert.equal(ledgerEvents.some((event) => event.type === "work-ledger-reuse-applied"), false);

  const secondEvidence = await evidenceLedger.listByRun("run_current_api_2");
  assert.equal(secondEvidence.length, 1);
  assert.equal(secondEvidence[0]?.metadata?.reusedFromWorkItemId, undefined);
  assert.match(secondEvidence[0]?.summary ?? "", /70111/);
});

test("BaseAgent reuses deterministic data.transform evidence across runs", async () => {
  const registry = new ToolRegistry();
  const workLedger = new InMemoryWorkLedgerStore();
  const evidenceLedger = new InMemoryEvidenceLedgerStore();
  const ledgerEvents: RuntimeLedgerEventDraft[] = [];
  let transformCalls = 0;
  const transformInput = {
    input: "[{\"name\":\"Ann\",\"age\":31},{\"name\":\"Bob\",\"age\":42}]",
    operations: [{ type: "sort", path: "age", direction: "desc" }],
    outputFormat: "csv",
  };

  registry.register({
    name: "data.transform",
    version: "1.0.0",
    description: "Transforms JSON and CSV deterministically.",
    capabilities: ["data-transform", "json-transform", "csv-transform"],
    inputSchema: { type: "object", properties: { input: {}, operations: { type: "array" }, outputFormat: { type: "string" } } },
    async run() {
      transformCalls += 1;
      return {
        ok: true,
        content: "name,age\nBob,42\nAnn,31",
        data: {
          value: [
            { name: "Bob", age: 42 },
            { name: "Ann", age: 31 },
          ],
          operationsApplied: ["sort"],
          outputFormat: "csv",
        },
      };
    },
  });

  const makeLedger = (runId: string) => new RuntimeLedgerCoordinator({
    runId,
    threadId: "thread_transform_reuse",
    instanceId: "instance-local",
    workLedgerStore: workLedger,
    evidenceLedgerStore: evidenceLedger,
    emit: async (event) => {
      ledgerEvents.push(event);
    },
  });
  const makeLlm = () => new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_transform", name: "data_transform", arguments: transformInput }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_finish", name: "finish", arguments: { answer: "Готово: Bob,42; Ann,31." } }],
    },
  ]);

  const firstEvents: AgentEvent[] = [];
  const firstAgent = new BaseAgent(makeLlm() as unknown as LlmClient, registry);
  const first = await firstAgent.run("Преобразуй JSON в CSV и отсортируй по age по убыванию.", {
    runId: "run_reuse_transform_1",
    ledger: makeLedger("run_reuse_transform_1"),
    onEvent: (event) => {
      firstEvents.push(event);
    },
    runContext: {
      runId: "run_reuse_transform_1",
      threadId: "thread_transform_reuse",
      instanceId: "instance-local",
    },
  });
  assert.equal(first.runStatus, "completed");
  assert.equal(transformCalls, 1);
  const frameEvent = firstEvents.find((event) => event.type === "agent-task-framed");
  assert.equal((frameEvent?.payload as { taskFrame?: { mode?: string } } | undefined)?.taskFrame?.mode, "local_utility");

  const canonicalWorkKey = workKeyForToolCall("data.transform", "analysis", transformInput);
  const reusableIndexItems = await workLedger.listByWorkKey(canonicalWorkKey);
  assert.equal(reusableIndexItems.length, 1);
  assert.equal(reusableIndexItems[0]?.runId, undefined);
  assert.equal(reusableIndexItems[0]?.kind, "analysis");

  const secondLlm = makeLlm();
  const secondAgent = new BaseAgent(secondLlm as unknown as LlmClient, registry);
  const second = await secondAgent.run("Преобразуй тот же JSON в CSV и отсортируй по age по убыванию.", {
    runId: "run_reuse_transform_2",
    ledger: makeLedger("run_reuse_transform_2"),
    runContext: {
      runId: "run_reuse_transform_2",
      threadId: "thread_transform_reuse",
      instanceId: "instance-local",
    },
  });

  assert.equal(second.runStatus, "completed");
  assert.equal(transformCalls, 1);
  assert.ok(secondLlm.messagesByCall[1]?.some((message) =>
    message.role === "tool" && /Reused passed Work Ledger evidence/i.test(String(message.content))
  ));
  assert.ok(ledgerEvents.some((event) => event.type === "work-ledger-reuse-available"));
  assert.ok(ledgerEvents.some((event) => event.type === "work-ledger-reuse-applied"));
  const secondEvidence = await evidenceLedger.listByRun("run_reuse_transform_2");
  assert.equal(secondEvidence.length, 1);
  assert.equal(secondEvidence[0]?.metadata?.reusedFromWorkItemId, reusableIndexItems[0]?.id);
});

test("BaseAgent handles explicit inline JSON transforms through local utility fast path", async () => {
  const registry = new ToolRegistry();
  registry.register(new DataTransformTool());
  const workLedger = new InMemoryWorkLedgerStore();
  const evidenceLedger = new InMemoryEvidenceLedgerStore();
  const ledgerEvents: RuntimeLedgerEventDraft[] = [];
  const makeLedger = (runId: string) => new RuntimeLedgerCoordinator({
    runId,
    threadId: "thread_inline_transform",
    instanceId: "instance-local",
    workLedgerStore: workLedger,
    evidenceLedgerStore: evidenceLedger,
    emit: async (event) => {
      ledgerEvents.push(event);
    },
  });
  const task = 'Преобразуй JSON [{"name":"Ann","age":31},{"name":"Bob","age":42}] в CSV, отсортируй по age по убыванию и дай результат текстом.';
  const expectedToolInput = {
    input: '[{"name":"Ann","age":31},{"name":"Bob","age":42}]',
    format: "json",
    operations: [{ type: "sort", path: "age", direction: "desc" }],
    outputFormat: "csv",
  };

  const firstLlm = new SequenceLlm([{ content: "should not be used", toolCalls: [], finishReason: "stop" }]);
  const firstEvents: AgentEvent[] = [];
  const firstAgent = new BaseAgent(firstLlm as unknown as LlmClient, registry);
  const first = await firstAgent.run(task, {
    runId: "run_inline_transform_1",
    ledger: makeLedger("run_inline_transform_1"),
    runContext: {
      runId: "run_inline_transform_1",
      threadId: "thread_inline_transform",
      instanceId: "instance-local",
    },
    onEvent: (event) => {
      firstEvents.push(event);
    },
  });

  assert.equal(first.runStatus, "completed");
  assert.equal(firstLlm.calls, 0);
  assert.match(first.finalAnswer, /Bob,42/);
  assert.match(first.finalAnswer, /Ann,31/);
  assert.ok(firstEvents.some((event) => event.type === "local-utility-fast-path-selected"));
  assert.ok(firstEvents.some((event) => event.type === "tool-completed" && event.actor === "data.transform"));
  assert.equal(firstEvents.some((event) => event.activity === "llm"), false);

  const canonicalWorkKey = workKeyForToolCall("data.transform", "analysis", expectedToolInput);
  const reusableIndexItems = await workLedger.listByWorkKey(canonicalWorkKey);
  assert.equal(reusableIndexItems.length, 1);

  const secondLlm = new SequenceLlm([{ content: "should not be used", toolCalls: [], finishReason: "stop" }]);
  const secondAgent = new BaseAgent(secondLlm as unknown as LlmClient, registry);
  const second = await secondAgent.run(task, {
    runId: "run_inline_transform_2",
    ledger: makeLedger("run_inline_transform_2"),
    runContext: {
      runId: "run_inline_transform_2",
      threadId: "thread_inline_transform",
      instanceId: "instance-local",
    },
  });

  assert.equal(second.runStatus, "completed");
  assert.equal(secondLlm.calls, 0);
  assert.match(second.finalAnswer, /Work Ledger/);
  assert.match(second.finalAnswer, /Bob,42/);
  assert.ok(ledgerEvents.some((event) => event.type === "work-ledger-reuse-applied"));
});

test("BaseAgent frames prior-answer source questions as thread-context answers", async () => {
  const registry = new ToolRegistry();
  let searchCalls = 0;
  registry.register({
    name: "web.search",
    version: "0.1.0",
    description: "Search the web.",
    capabilities: ["web-search"],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run() {
      searchCalls += 1;
      return { ok: true, content: "fresh search result" };
    },
  });

  const llm = new SequenceLlm([
    {
      content: "В предыдущем ответе источник был CoinMarketCap.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("какой источник ты использовал для цены биткоина в предыдущем ответе?", {
    runId: "run_thread_source_followup",
    onEvent: (event) => {
      events.push(event);
    },
    runContext: {
      threadId: "thread_btc",
      thread: {
        summary: "Answered: current Bitcoin price was sourced from CoinMarketCap.",
        acceptedFacts: ["Prior source URL: https://coinmarketcap.com/currencies/bitcoin/"],
      },
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(searchCalls, 0);
  assert.match(result.finalAnswer, /CoinMarketCap/i);
  const frameEvent = events.find((event) => event.type === "agent-task-framed");
  assert.equal((frameEvent?.payload as { taskFrame?: { mode?: string } } | undefined)?.taskFrame?.mode, "thread_context_answer");
});
