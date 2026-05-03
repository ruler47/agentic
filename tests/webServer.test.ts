import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AddressInfo } from "node:net";
import { createWebApp } from "../src/server/http.js";
import { InMemoryConversationThreadStore } from "../src/conversations/inMemoryConversationThreadStore.js";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { InMemoryModelTierSettingsStore } from "../src/settings/modelTierSettings.js";
import { AgentArtifact, AgentEventSink, AgentRunResult, ArtifactCreateInput } from "../src/types.js";
import { UniversalAgent } from "../src/agents/universalAgent.js";
import { LocalArtifactStore } from "../src/artifacts/artifactStore.js";
import { InMemoryToolBuildRequestStore } from "../src/tools/toolBuildRequestStore.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import { ToolBuildWorkflow } from "../src/tools/toolBuildWorkflow.js";
import { InMemoryAuditEventStore } from "../src/audit/inMemoryAuditEventStore.js";
import { InMemoryGroupProfileStore } from "../src/instance/groupProfileStore.js";
import { SkillMemory } from "../src/memory/skillMemory.js";

class FakeAgent {
  async run(task: string, options?: {
    onEvent?: AgentEventSink;
    inputArtifacts?: AgentArtifact[];
    saveArtifact?: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>;
  }): Promise<AgentRunResult> {
    await options?.onEvent?.({
      id: "event-start",
      spanId: "run-span",
      type: "run-started",
      actor: "coordinator",
      activity: "coordination",
      status: "started",
      title: "Fake run started",
      detail: task,
      timestamp: new Date().toISOString(),
    });
    await options?.onEvent?.({
      id: "event-worker",
      spanId: "worker-span",
      parentSpanId: "run-span",
      type: "worker-completed",
      actor: "worker:test",
      activity: "llm",
      status: "completed",
      title: "Fake worker completed",
      detail: "Worker output",
      timestamp: new Date().toISOString(),
      durationMs: 12,
    });

    const outputArtifact = await options?.saveArtifact?.({
      filename: "answer.txt",
      mimeType: "text/plain",
      content: `artifact for ${task}`,
      description: "fake output",
    });

    return {
      finalAnswer: `answer for ${task}`,
      complexity: {
        mode: "delegated",
        reason: "fake multi-step task",
        domains: ["test"],
        riskLevel: "low",
      },
      subtasks: [],
      workerResults: [],
      reviews: [],
      artifacts: [...(options?.inputArtifacts ?? []), ...(outputArtifact ? [outputArtifact] : [])],
    };
  }
}

class ThreadAwareFakeAgent {
  seenThreadSummaries: string[] = [];

  async run(task: string, options?: {
    onEvent?: AgentEventSink;
    threadContext?: { summary: string };
  }): Promise<AgentRunResult> {
    this.seenThreadSummaries.push(options?.threadContext?.summary ?? "");
    await options?.onEvent?.({
      id: `event-${task}`,
      spanId: `span-${task}`,
      type: "run-started",
      actor: "coordinator",
      activity: "coordination",
      status: "started",
      title: "Thread-aware run started",
      detail: task,
      timestamp: new Date().toISOString(),
    });

    return {
      finalAnswer: `answer for ${task}`,
      complexity: { mode: "direct", reason: "fake", domains: ["test"], riskLevel: "low" },
      subtasks: [],
      workerResults: [],
      reviews: [],
    };
  }
}

class DelayedFakeAgent {
  private releaseRun!: () => void;
  readonly ready = new Promise<void>((resolve) => {
    this.releaseRun = resolve;
  });

  release() {
    this.releaseRun();
  }

  async run(task: string, options?: { onEvent?: AgentEventSink }): Promise<AgentRunResult> {
    await this.ready;
    await options?.onEvent?.({
      id: `event-delayed-${Date.now()}`,
      spanId: "delayed-span",
      type: "worker-completed",
      actor: "worker:test",
      activity: "llm",
      status: "completed",
      title: "Delayed worker completed",
      detail: task,
      timestamp: new Date().toISOString(),
    });
    return {
      finalAnswer: `late answer for ${task}`,
      complexity: { mode: "direct", reason: "fake", domains: ["test"], riskLevel: "low" },
      subtasks: [],
      workerResults: [],
      reviews: [],
    };
  }
}

test("web server creates a run and exposes completed trace", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>test</title>");

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
  });

  try {
    const baseUrl = await listen(server);
    const createResponse = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "hello" }),
    });

    assert.equal(createResponse.status, 202);
    const created = (await createResponse.json()) as { run: { id: string } };
    const completed = await waitForRun(baseUrl, created.run.id);
    const listed = await (await fetch(`${baseUrl}/api/runs`)).json();

    assert.equal(completed.run.status, "completed");
    assert.equal(completed.run.result.finalAnswer, "answer for hello");
    assert.equal(completed.run.events.length, 2);
    assert.equal(completed.run.events[1].type, "worker-completed");
    assert.equal(listed.runs[0].id, created.run.id);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server streams run snapshots as server-sent events", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>test</title>");

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
  });

  try {
    const baseUrl = await listen(server);
    const createResponse = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "stream me" }),
    });
    const created = (await createResponse.json()) as { run: { id: string } };
    const streamResponse = await fetch(`${baseUrl}/api/runs/${created.run.id}/events`);
    const event = await readFirstSseEvent(streamResponse);

    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(event.event, "run");
    assert.equal(event.data.run.id, created.run.id);
    assert.ok(["running", "completed"].includes(event.data.run.status));
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server accepts input files and serves output artifacts", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  const artifactDir = await mkdtemp(join(tmpdir(), "agentic-artifacts-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const auditEventStore = new InMemoryAuditEventStore();

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    artifactStore: new LocalArtifactStore(artifactDir),
    auditEventStore,
  });

  try {
    const baseUrl = await listen(server);
    const createResponse = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "hello files",
        attachments: [
          {
            filename: "input.txt",
            mimeType: "text/plain",
            contentBase64: Buffer.from("attached input").toString("base64"),
          },
        ],
      }),
    });
    const created = (await createResponse.json()) as { run: { id: string } };
    const completed = await waitForRun(baseUrl, created.run.id);
    const artifacts = completed.run.result.artifacts;
    const input = artifacts.find((artifact: AgentArtifact) => artifact.kind === "input");
    const output = artifacts.find((artifact: AgentArtifact) => artifact.kind === "output");
    const outputResponse = await fetch(`${baseUrl}${output.url}`);
    const audit = await (await fetch(`${baseUrl}/api/audit-events`)).json();
    const actions = audit.events.map((event: { action: string }) => event.action);

    assert.equal(createResponse.status, 202);
    assert.equal(input.filename, "input.txt");
    assert.equal(output.filename, "answer.txt");
    assert.equal(outputResponse.headers.get("content-type"), "text/plain");
    assert.equal(await outputResponse.text(), "artifact for hello files");
    assert.ok(actions.includes("run.created"));
    assert.ok(actions.includes("run.started"));
    assert.ok(actions.includes("artifact.uploaded"));
    assert.ok(actions.includes("artifact.generated"));
    assert.ok(actions.includes("run.completed"));
    assert.equal(audit.events[0].runId, created.run.id);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("web server creates conversation threads and continues with compact context", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const conversationStore = new InMemoryConversationThreadStore();
  const agent = new ThreadAwareFakeAgent();

  const server = createWebApp({
    agent: agent as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    conversationStore,
  });

  try {
    const baseUrl = await listen(server);
    const firstResponse = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "first task" }),
    });
    const first = await firstResponse.json();
    await waitForRun(baseUrl, first.run.id);

    const threads = await (await fetch(`${baseUrl}/api/conversation-threads`)).json();
    const threadId = threads.threads[0].id;
    const secondResponse = await fetch(`${baseUrl}/api/conversation-threads/${threadId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "continue with correction" }),
    });
    const second = await secondResponse.json();
    const completedSecond = await waitForRun(baseUrl, second.run.id);
    const threadDetail = await (await fetch(`${baseUrl}/api/conversation-threads/${threadId}`)).json();

    assert.equal(firstResponse.status, 202);
    assert.equal(secondResponse.status, 202);
    assert.equal(first.run.threadId, threadId);
    assert.equal(completedSecond.run.threadId, threadId);
    assert.equal(completedSecond.run.parentRunId, first.run.id);
    assert.match(agent.seenThreadSummaries[1], /first task/);
    assert.equal(threadDetail.thread.messages.length, 4);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server resolves channel follow-ups into existing conversation threads", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const conversationStore = new InMemoryConversationThreadStore();
  const agent = new ThreadAwareFakeAgent();

  const server = createWebApp({
    agent: agent as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    conversationStore,
  });

  try {
    const baseUrl = await listen(server);
    const firstResponse = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "найди билеты из Стамбула в Малагу",
        channel: "telegram",
        sourceChatId: "tg-chat-1",
        sourceMessageId: "msg-1",
      }),
    });
    const first = await firstResponse.json();
    await waitForRun(baseUrl, first.run.id);

    const followUpResponse = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "а теперь добавь скриншот результата",
        channel: "telegram",
        sourceChatId: "tg-chat-1",
        sourceMessageId: "msg-2",
      }),
    });
    const followUp = await followUpResponse.json();
    const completedFollowUp = await waitForRun(baseUrl, followUp.run.id);

    const newTaskResponse = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "найди пять городов Испании по населению",
        channel: "telegram",
        sourceChatId: "tg-chat-1",
        sourceMessageId: "msg-3",
      }),
    });
    const newTask = await newTaskResponse.json();
    await waitForRun(baseUrl, newTask.run.id);
    const threads = await (await fetch(`${baseUrl}/api/conversation-threads`)).json();

    assert.equal(firstResponse.status, 202);
    assert.equal(followUpResponse.status, 202);
    assert.equal(newTaskResponse.status, 202);
    assert.equal(followUp.threadResolution.decision, "continue_thread");
    assert.equal(followUp.run.threadId, first.run.threadId);
    assert.equal(completedFollowUp.run.parentRunId, first.run.id);
    assert.equal(newTask.threadResolution.decision, "new_task");
    assert.notEqual(newTask.run.threadId, first.run.threadId);
    assert.equal(threads.threads.length, 2);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server deletes a conversation thread with related runs and trace events", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const conversationStore = new InMemoryConversationThreadStore();
  const runStore = new InMemoryRunStore();
  const auditEventStore = new InMemoryAuditEventStore();

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore,
    publicDir,
    conversationStore,
    auditEventStore,
  });

  try {
    const baseUrl = await listen(server);
    const createResponse = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "temporary thread task" }),
    });
    const created = await createResponse.json();
    const completed = await waitForRun(baseUrl, created.run.id);
    const threadId = completed.run.threadId;

    const deleteResponse = await fetch(
      `${baseUrl}/api/conversation-threads/${encodeURIComponent(threadId)}`,
      { method: "DELETE" },
    );
    const deleted = await deleteResponse.json();
    const runAfterDelete = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(created.run.id)}`);
    const threadAfterDelete = await fetch(
      `${baseUrl}/api/conversation-threads/${encodeURIComponent(threadId)}`,
    );
    const threads = await (await fetch(`${baseUrl}/api/conversation-threads`)).json();
    const audit = await (await fetch(`${baseUrl}/api/audit-events`)).json();

    assert.equal(deleteResponse.status, 200);
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.deletedRuns, 1);
    assert.equal(runAfterDelete.status, 404);
    assert.equal(threadAfterDelete.status, 404);
    assert.equal(threads.threads.length, 0);
    assert.equal(
      audit.events.some(
        (event: { action: string; threadId?: string }) =>
          event.action === "conversation_thread.deleted" && event.threadId === threadId,
      ),
      true,
    );
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server tolerates deleting a thread while its run is still executing", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const agent = new DelayedFakeAgent();

  const server = createWebApp({
    agent: agent as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    conversationStore: new InMemoryConversationThreadStore(),
    auditEventStore: new InMemoryAuditEventStore(),
  });

  try {
    const baseUrl = await listen(server);
    const createResponse = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "delete while running" }),
    });
    const created = await createResponse.json();
    const threadId = created.run.threadId;
    const runId = created.run.id;

    const deleteResponse = await fetch(
      `${baseUrl}/api/conversation-threads/${encodeURIComponent(threadId)}`,
      { method: "DELETE" },
    );
    agent.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const runAfterRelease = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}`);

    assert.equal(createResponse.status, 202);
    assert.equal(deleteResponse.status, 200);
    assert.equal(runAfterRelease.status, 404);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server validates required task and serves static UI", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
  });

  try {
    const baseUrl = await listen(server);
    const badRequest = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "   " }),
    });
    const staticResponse = await fetch(`${baseUrl}/`);

    assert.equal(badRequest.status, 400);
    assert.equal(staticResponse.status, 200);
    assert.match(await staticResponse.text(), /Agentic/);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server exposes memory and tool registries", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    skillMemory: {
      async list() {
        return [
          {
            id: "memory-1",
            title: "Reusable research funnel",
            tags: ["research"],
            summary: "Use staged filtering.",
            reusableProcedure: "Filter, verify, synthesize.",
            createdAt: new Date().toISOString(),
          },
        ];
      },
      async search() {
        return [];
      },
      async add(entry) {
        return { ...entry, id: "memory-2", createdAt: new Date().toISOString() };
      },
    },
    toolRegistry: {
      list() {
        return [
          {
            name: "web.search",
            version: "1.0.0",
            description: "Searches the web.",
            capabilities: ["web-search"],
            startupMode: "always-on",
            inputSchema: {
              type: "object",
              properties: {},
            },
            outputSchema: {
              type: "object",
              properties: {},
            },
            async healthcheck() {
              return { ok: true, detail: "healthy" };
            },
            async run() {
              return { ok: true, content: "ok" };
            },
          },
        ];
      },
    },
  });

  try {
    const baseUrl = await listen(server);
    const memories = await (await fetch(`${baseUrl}/api/memories`)).json();
    const tools = await (await fetch(`${baseUrl}/api/tools`)).json();
    const health = await (await fetch(`${baseUrl}/api/tools/health`)).json();

    assert.equal(memories.memories[0].title, "Reusable research funnel");
    assert.equal(tools.tools[0].name, "web.search");
    assert.equal(tools.tools[0].version, "1.0.0");
    assert.equal(health.tools[0].ok, true);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server supports scoped memory review lifecycle", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  const memoryDir = await mkdtemp(join(tmpdir(), "agentic-memory-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const skillMemory = new SkillMemory(join(memoryDir, "skills.json"));
  const auditEventStore = new InMemoryAuditEventStore();

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    skillMemory,
    auditEventStore,
  });

  try {
    const baseUrl = await listen(server);
    const createResponse = await fetch(`${baseUrl}/api/memories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Telegram family routing",
        tags: ["telegram", "family"],
        summary: "Telegram messages from whitelisted users should stay in their thread.",
        reusableProcedure: "Resolve user identity, then append to the matching conversation thread.",
        scope: "group",
        scopeId: "group-local",
        status: "proposed",
        confidence: 0.7,
        evidence: ["operator described Telegram continuation behavior"],
      }),
    });
    const created = await createResponse.json();
    const proposed = await (await fetch(`${baseUrl}/api/memories?status=proposed`)).json();
    const acceptResponse = await fetch(`${baseUrl}/api/memories/${encodeURIComponent(created.memory.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "accepted", confidence: 0.95 }),
    });
    const accepted = await acceptResponse.json();
    const groupAccepted = await (await fetch(`${baseUrl}/api/memories?scope=group&scopeId=group-local&status=accepted`)).json();
    const audit = await (await fetch(`${baseUrl}/api/audit-events`)).json();

    assert.equal(createResponse.status, 201);
    assert.equal(created.memory.status, "proposed");
    assert.equal(created.memory.scope, "group");
    assert.equal(proposed.memories.length, 1);
    assert.equal(acceptResponse.status, 200);
    assert.equal(accepted.memory.status, "accepted");
    assert.equal(accepted.memory.confidence, 0.95);
    assert.equal(groupAccepted.memories[0].id, created.memory.id);
    assert.equal(audit.events.some((event: { action: string }) => event.action === "memory.created"), true);
    assert.equal(audit.events.some((event: { action: string }) => event.action === "memory.updated"), true);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("web server exposes tool build requests", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const toolBuildRequestStore = new InMemoryToolBuildRequestStore();
  const auditEventStore = new InMemoryAuditEventStore();
  await toolBuildRequestStore.create({
    capability: "browser-screenshot",
    reason: "Need screenshot artifacts.",
    sourceRunId: "run-1",
  });

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    toolBuildRequestStore,
    auditEventStore,
    toolBuildWorkflow: new ToolBuildWorkflow(
      toolBuildRequestStore,
      {
        async build(request) {
          return {
            modulePath: request.contract.modulePath,
            testPath: request.contract.testPath,
            summary: "fake builder output",
          };
        },
      },
      {
        async run() {
          return {
            ok: true,
            summary: "fake QA passed",
            checks: ["fake test passed"],
          };
        },
      },
      {
        async register(request) {
          return request.contract.toolName;
        },
      },
    ),
  });

  try {
    const baseUrl = await listen(server);
    const createdResponse = await fetch(`${baseUrl}/api/tool-build-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "pdf-report",
        reason: "Need PDF report artifacts.",
        requiredInputs: ["markdown"],
        requiredOutputs: ["artifact"],
      }),
    });
    const response = await fetch(`${baseUrl}/api/tool-build-requests`);
    const created = await createdResponse.json();
    const updateResponse = await fetch(
      `${baseUrl}/api/tool-build-requests/${encodeURIComponent(created.request.id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "qa_passed",
          statusDetail: "Builder tests passed.",
          registeredToolName: "generated.pdf.report",
          qaReport: {
            ok: true,
            summary: "Generated tool contract passed automated checks.",
            checks: ["unit tests passed", "manual smoke passed"],
          },
        }),
      },
    );
    const updated = await updateResponse.json();
    const detailResponse = await fetch(
      `${baseUrl}/api/tool-build-requests/${encodeURIComponent(created.request.id)}`,
    );
    const detail = await detailResponse.json();
    const reworkResponse = await fetch(
      `${baseUrl}/api/tool-build-requests/${encodeURIComponent(created.request.id)}/rework`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          feedback: "Regenerate with stricter artifact validation and one extra smoke test.",
        }),
      },
    );
    const rework = await reworkResponse.json();
    const stopResponse = await fetch(
      `${baseUrl}/api/tool-build-requests/${encodeURIComponent(rework.request.id)}/stop`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Operator stopped duplicate revision." }),
      },
    );
    const stopped = await stopResponse.json();
    const runWorkflowResponse = await fetch(
      `${baseUrl}/api/tool-build-requests/${encodeURIComponent(created.request.id)}/run`,
      { method: "POST" },
    );
    const workflow = await runWorkflowResponse.json();
    const body = await response.json();
    const deleteResponse = await fetch(`${baseUrl}/api/tool-build-requests/${encodeURIComponent(rework.request.id)}`, {
      method: "DELETE",
    });
    const deleted = await deleteResponse.json();
    const afterDelete = await (await fetch(`${baseUrl}/api/tool-build-requests`)).json();
    const audit = await (await fetch(`${baseUrl}/api/audit-events`)).json();

    assert.equal(createdResponse.status, 201);
    assert.equal(created.request.contract.toolName, "generated.pdf.report");
    assert.equal(updateResponse.status, 200);
    assert.equal(updated.request.status, "qa_passed");
    assert.equal(updated.request.qaReport.checks.length, 2);
    assert.equal(detail.request.registeredToolName, "generated.pdf.report");
    assert.equal(reworkResponse.status, 201);
    assert.equal(rework.request.status, "requested");
    assert.equal(rework.request.reworkOf, created.request.id);
    assert.match(rework.request.feedback, /stricter artifact validation/);
    assert.equal(stopResponse.status, 200);
    assert.equal(stopped.request.status, "blocked");
    assert.match(stopped.request.statusDetail, /duplicate revision/);
    assert.equal(runWorkflowResponse.status, 200);
    assert.equal(workflow.request.status, "registered");
    assert.equal(response.status, 200);
    assert.equal(body.requests.length, 2);
    assert.deepEqual(
      body.requests.map((request: { capability: string }) => request.capability).sort(),
      ["browser-screenshot", "pdf-report"],
    );
    assert.equal(deleteResponse.status, 200);
    assert.equal(deleted.deleted, true);
    assert.equal(afterDelete.requests.some((request: { id: string }) => request.id === rework.request.id), false);
    assert.equal(audit.events.some((event: { action: string }) => event.action === "tool_build.requested"), true);
    assert.equal(
      audit.events.some((event: { action: string }) => event.action === "tool_build.rework_requested"),
      true,
    );
    assert.equal(audit.events.some((event: { action: string }) => event.action === "tool_build.stopped"), true);
    assert.equal(audit.events.some((event: { action: string }) => event.action === "tool_build.deleted"), true);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server registers generated tool metadata with conflict checks", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const toolMetadataStore = new InMemoryToolMetadataStore();

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    toolMetadataStore,
  });

  try {
    const baseUrl = await listen(server);
    const createResponse = await fetch(`${baseUrl}/api/tools/generated-modules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "generated.browser.screenshot",
        version: "1.0.0",
        description: "Captures browser screenshots.",
        capabilities: ["browser-screenshot", "artifact-generation"],
        startupMode: "on-demand",
        modulePath: "src/tools/generated/browser-screenshotTool.ts",
        testPath: "tests/generated/browser-screenshotTool.test.ts",
      }),
    });
    const createBody = await createResponse.json();
    const conflictResponse = await fetch(`${baseUrl}/api/tools/generated-modules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "generated.browser.screenshot",
        version: "2.0.0",
        description: "Conflicting upgrade.",
        capabilities: ["browser-screenshot"],
        modulePath: "src/tools/generated/browser-screenshotTool.ts",
      }),
    });
    const tools = await (await fetch(`${baseUrl}/api/tools`)).json();

    assert.equal(createResponse.status, 201);
    assert.equal(createBody.tool.status, "disabled");
    assert.equal(conflictResponse.status, 400);
    assert.equal(tools.tools[0].source, "generated");
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server promotes generated tool replacements through explicit version handoff", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const toolMetadataStore = new InMemoryToolMetadataStore();

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    toolMetadataStore,
  });

  try {
    const baseUrl = await listen(server);
    await fetch(`${baseUrl}/api/tools/generated-modules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "generated.browser.screenshot",
        version: "1.0.0",
        description: "Captures browser screenshots.",
        capabilities: ["browser-screenshot"],
        modulePath: "src/tools/generated/browser-screenshotTool.ts",
      }),
    });
    const staleResponse = await fetch(`${baseUrl}/api/tools/generated-modules/generated.browser.screenshot/promote-replacement`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "generated.browser.screenshot",
        version: "1.1.0",
        replacesVersion: "0.9.0",
        description: "Captures browser screenshots with semantic QA.",
        capabilities: ["browser-screenshot", "artifact-generation"],
        modulePath: "src/tools/generated/browser-screenshotTool.ts",
      }),
    });
    const promoteResponse = await fetch(`${baseUrl}/api/tools/generated-modules/generated.browser.screenshot/promote-replacement`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "generated.browser.screenshot",
        version: "1.1.0",
        replacesVersion: "1.0.0",
        description: "Captures browser screenshots with semantic QA.",
        capabilities: ["browser-screenshot", "artifact-generation"],
        modulePath: "src/tools/generated/browser-screenshotTool.ts",
        testPath: "tests/generated/browser-screenshotTool.test.ts",
      }),
    });
    const promoteBody = await promoteResponse.json();

    assert.equal(staleResponse.status, 400);
    assert.equal(promoteResponse.status, 200);
    assert.equal(promoteBody.tool.version, "1.1.0");
    assert.equal(promoteBody.tool.status, "disabled");
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server exposes and updates model tier settings", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    modelTierSettings: new InMemoryModelTierSettingsStore([
      { tier: "S", models: ["small-a"], maxAttempts: 2 },
      { tier: "M", models: ["medium-a"], maxAttempts: 2 },
    ]),
  });

  try {
    const baseUrl = await listen(server);
    const initial = await (await fetch(`${baseUrl}/api/settings/model-tiers`)).json();
    const updateResponse = await fetch(`${baseUrl}/api/settings/model-tiers`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tiers: [
          {
            tier: "S",
            models: ["small-a", "small-b"],
            maxAttempts: 3,
            escalateOnFailure: true,
          },
          {
            tier: "M",
            models: ["medium-a"],
            maxAttempts: 2,
            escalateOnFailure: true,
          },
        ],
      }),
    });
    const updated = await updateResponse.json();

    assert.equal(initial.tiers[0].tier, "S");
    assert.equal(updateResponse.status, 200);
    assert.deepEqual(updated.tiers[0].models, ["small-a", "small-b"]);
    assert.equal(updated.tiers[0].maxAttempts, 3);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server exposes and updates the single-instance group profile", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    groupProfileStore: new InMemoryGroupProfileStore(),
    auditEventStore: new InMemoryAuditEventStore(),
  });

  try {
    const baseUrl = await listen(server);
    const initial = await (await fetch(`${baseUrl}/api/group-profile`)).json();
    const updateResponse = await fetch(`${baseUrl}/api/group-profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Family Ops",
        description: "Russian-speaking family in Spain.",
        preferences: { notes: "Prefer concise answers and cite medical sources." },
      }),
    });
    const updated = await updateResponse.json();
    const audit = await (await fetch(`${baseUrl}/api/audit-events`)).json();

    assert.equal(initial.groupProfile.id, "group-local");
    assert.equal(updateResponse.status, 200);
    assert.equal(updated.groupProfile.name, "Family Ops");
    assert.equal(updated.groupProfile.preferences.notes, "Prefer concise answers and cite medical sources.");
    assert.equal(audit.events[0].action, "group_profile.updated");
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server exposes compact user activity without embedding run traces", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const runStore = new InMemoryRunStore();
  await runStore.create("compact user activity", {
    instanceId: "instance-local",
    requesterUserId: "user-admin",
    channel: "web",
    threadId: "thread-test",
  });

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore,
    publicDir,
  });

  try {
    const baseUrl = await listen(server);
    const body = await (await fetch(`${baseUrl}/api/users`)).json();

    assert.equal(body.users[0].id, "user-admin");
    assert.equal(body.users[0].recentRequests[0].task, "compact user activity");
    assert.equal(body.users[0].recentRequests[0].events, undefined);
    assert.equal(body.users[0].recentRequests[0].result, undefined);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

async function listen(server: ReturnType<typeof createWebApp>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createWebApp>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function waitForRun(baseUrl: string, id: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/runs/${id}`);
    const data = (await response.json()) as { run: { status: string; [key: string]: any } };

    if (data.run.status === "completed" || data.run.status === "failed") {
      return data;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Run did not complete in time");
}

async function readFirstSseEvent(response: Response): Promise<{ event: string; data: any }> {
  assert.ok(response.body);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        const event =
          chunk
            .split("\n")
            .find((line) => line.startsWith("event: "))
            ?.slice("event: ".length) ?? "message";
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice("data: ".length))
          .join("\n");

        return { event, data: JSON.parse(data) };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  throw new Error("SSE stream did not emit an event");
}
