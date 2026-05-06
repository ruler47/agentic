import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createWebApp } from "../src/server/http.js";
import { InMemoryConversationThreadStore } from "../src/conversations/inMemoryConversationThreadStore.js";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { InMemoryModelTierSettingsStore } from "../src/settings/modelTierSettings.js";
import { InMemoryModelProviderStore } from "../src/settings/modelProviderStore.js";
import { AgentArtifact, AgentEventSink, AgentRunResult, ArtifactCreateInput } from "../src/types.js";
import { UniversalAgent } from "../src/agents/universalAgent.js";
import { LocalArtifactStore } from "../src/artifacts/artifactStore.js";
import { InMemoryToolBuildRequestStore } from "../src/tools/toolBuildRequestStore.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import { InMemoryToolMigrationStore } from "../src/tools/toolMigrationStore.js";
import { InMemoryToolPromotionStore } from "../src/tools/toolPromotionStore.js";
import { ToolBuildWorkflow } from "../src/tools/toolBuildWorkflow.js";
import { InMemoryAuditEventStore } from "../src/audit/inMemoryAuditEventStore.js";
import { InMemoryGroupProfileStore } from "../src/instance/groupProfileStore.js";
import { InMemoryUserStore } from "../src/instance/userStore.js";
import { SkillMemory } from "../src/memory/skillMemory.js";
import { InMemorySecretHandleStore } from "../src/secrets/secretHandleStore.js";
import { ToolServiceSupervisor } from "../src/tools/toolServiceSupervisor.js";
import { InMemoryToolServiceEventStore } from "../src/tools/toolServiceEventStore.js";
import {
  ExternalHttpToolPackageRunner,
  LocalPathToolPackageRunner,
  SourceBundleToolPackageRunner,
} from "../src/tools/toolPackageRunner.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loadGeneratedTools } from "../src/tools/generatedToolLoader.js";

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
  seenThreadArtifacts: AgentArtifact[][] = [];

  async run(task: string, options?: {
    onEvent?: AgentEventSink;
    threadContext?: { summary: string; relevantArtifacts?: AgentArtifact[] };
    saveArtifact?: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>;
  }): Promise<AgentRunResult> {
    this.seenThreadSummaries.push(options?.threadContext?.summary ?? "");
    this.seenThreadArtifacts.push(options?.threadContext?.relevantArtifacts ?? []);
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

    const artifact = await options?.saveArtifact?.({
      filename: `${task.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "answer"}.txt`,
      mimeType: "text/plain",
      content: `evidence for ${task}`,
      description: "thread continuation evidence",
    });

    return {
      finalAnswer: `answer for ${task}`,
      complexity: { mode: "direct", reason: "fake", domains: ["test"], riskLevel: "low" },
      subtasks: [],
      workerResults: [],
      reviews: [],
      artifacts: artifact ? [artifact] : [],
    };
  }
}

class MemoryLearningFakeAgent {
  async run(task: string): Promise<AgentRunResult> {
    return {
      finalAnswer: `answer for ${task}`,
      complexity: { mode: "direct", reason: "fake", domains: ["memory"], riskLevel: "low" },
      subtasks: [],
      workerResults: [],
      reviews: [],
      learnedSkill: {
        id: "memory-from-run",
        title: "Remember cancellation smoke context",
        tags: ["memory", "audit"],
        summary: "The run produced an auditable learned memory.",
        reusableProcedure: "Audit learned memories after the run reaches completed state.",
        scope: "group",
        scopeId: "instance-local",
        status: "proposed",
        confidence: 0.82,
        sensitivity: "normal",
        sourceRunId: "run-memory-audit",
        sourceThreadId: "thread-memory-audit",
        evidence: ["fake agent returned learnedSkill"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
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

test("web server returns parseable run JSON with escaped control characters", async () => {
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
      body: JSON.stringify({ task: "control chars: line one\nline two\u000bafter tab\tend" }),
    });
    const created = (await createResponse.json()) as { run: { id: string } };
    const completed = await waitForRun(baseUrl, created.run.id);
    assert.equal(completed.run.status, "completed");

    const rawResponse = await fetch(`${baseUrl}/api/runs/${created.run.id}`);
    const rawText = await rawResponse.text();
    const parsed = JSON.parse(rawText);
    assert.equal(parsed.run.id, created.run.id);
    assert.match(parsed.run.result.finalAnswer, /line one/);
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

test("web server cancels an active run and ignores late completion", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>test</title>");
  const agent = new DelayedFakeAgent();
  const runStore = new InMemoryRunStore();
  const auditEventStore = new InMemoryAuditEventStore();

  const server = createWebApp({
    agent: agent as unknown as UniversalAgent,
    runStore,
    auditEventStore,
    publicDir,
  });

  try {
    const baseUrl = await listen(server);
    const createResponse = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "long task" }),
    });
    assert.equal(createResponse.status, 202);
    const created = (await createResponse.json()) as { run: { id: string } };

    const cancelResponse = await fetch(`${baseUrl}/api/runs/${created.run.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "manual stop" }),
    });
    assert.equal(cancelResponse.status, 200);
    const cancelled = (await cancelResponse.json()) as { run: { status: string; error?: string } };
    assert.equal(cancelled.run.status, "cancelled");
    assert.equal(cancelled.run.error, "manual stop");

    agent.release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const latest = await (await fetch(`${baseUrl}/api/runs/${created.run.id}`)).json();
    assert.equal(latest.run.status, "cancelled");
    assert.equal(latest.run.result, undefined);
    assert.equal(latest.run.events.length, 0);

    const audit = await (await fetch(`${baseUrl}/api/audit-events`)).json();
    assert.equal(audit.events.some((event: { action: string }) => event.action === "run.cancelled"), true);
  } finally {
    agent.release();
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server audits learned memory emitted by a completed run", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>test</title>");
  const auditEventStore = new InMemoryAuditEventStore();

  const server = createWebApp({
    agent: new MemoryLearningFakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    auditEventStore,
    publicDir,
  });

  try {
    const baseUrl = await listen(server);
    const createResponse = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "learn something" }),
    });
    const created = (await createResponse.json()) as { run: { id: string } };
    const completed = await waitForRun(baseUrl, created.run.id);
    const audit = await (await fetch(`${baseUrl}/api/audit-events`)).json();
    const memoryEvent = audit.events.find(
      (event: { action: string; targetId: string }) =>
        event.action === "memory.created" && event.targetId === "memory-from-run",
    );

    assert.equal(completed.run.status, "completed");
    assert.equal(completed.run.result.learnedSkill.id, "memory-from-run");
    assert.equal(memoryEvent.status, "pending");
    assert.equal(memoryEvent.actorType, "agent");
    assert.equal(memoryEvent.metadata.memoryStatus, "proposed");
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
    const thirdResponse = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "continue from web composer", requesterUserId: "user-admin", channel: "web", threadId }),
    });
    const third = await thirdResponse.json();
    const completedThird = await waitForRun(baseUrl, third.run.id);
    const threadDetail = await (await fetch(`${baseUrl}/api/conversation-threads/${threadId}`)).json();

    assert.equal(firstResponse.status, 202);
    assert.equal(secondResponse.status, 202);
    assert.equal(thirdResponse.status, 202);
    assert.equal(first.run.threadId, threadId);
    assert.equal(completedSecond.run.threadId, threadId);
    assert.equal(completedSecond.run.parentRunId, first.run.id);
    assert.equal(completedThird.run.threadId, threadId);
    assert.equal(completedThird.run.parentRunId, second.run.id);
    assert.match(agent.seenThreadSummaries[1], /first task/);
    assert.match(agent.seenThreadSummaries[2], /continue with correction/);
    assert.equal(threadDetail.thread.messages.length, 6);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server includes previous thread artifacts in continuation context", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  const artifactDir = await mkdtemp(join(tmpdir(), "agentic-artifacts-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const conversationStore = new InMemoryConversationThreadStore();
  const agent = new ThreadAwareFakeAgent();

  const server = createWebApp({
    agent: agent as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    conversationStore,
    artifactStore: new LocalArtifactStore(artifactDir),
  });

  try {
    const baseUrl = await listen(server);
    const firstResponse = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "bitcoin price" }),
    });
    const first = await firstResponse.json();
    const completedFirst = await waitForRun(baseUrl, first.run.id);
    const threadId = completedFirst.run.threadId;

    const secondResponse = await fetch(`${baseUrl}/api/conversation-threads/${threadId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "did it rise or fall" }),
    });
    const second = await secondResponse.json();
    await waitForRun(baseUrl, second.run.id);

    assert.equal(secondResponse.status, 202);
    assert.equal(agent.seenThreadArtifacts[0].length, 0);
    assert.equal(agent.seenThreadArtifacts[1].length, 1);
    assert.equal(agent.seenThreadArtifacts[1][0].filename, "bitcoin-price.txt");
    assert.equal(agent.seenThreadArtifacts[1][0].contentPreview, "evidence for bitcoin price");
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
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

test("web server rejects runs for unknown requester users", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const runStore = new InMemoryRunStore();

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore,
    publicDir,
    userStore: new InMemoryUserStore(),
  });

  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "this should not run",
        requesterUserId: "user-ghost",
      }),
    });
    const body = await response.json();
    const runs = await runStore.list();

    assert.equal(response.status, 400);
    assert.equal(body.error, "Requester user not found: user-ghost");
    assert.equal(runs.length, 0);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server resolves allowed channel identities before creating runs", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const runStore = new InMemoryRunStore();
  const conversationStore = new InMemoryConversationThreadStore();
  const userStore = new InMemoryUserStore({
    defaultUserId: "user-admin",
    users: [
      { id: "user-admin", displayName: "Admin", role: "admin" },
      { id: "user-dima", displayName: "Dima", role: "member" },
    ],
    identities: [
      { provider: "web", providerUserId: "user-admin", userId: "user-admin" },
      { provider: "telegram", providerUserId: "tg-42", userId: "user-dima" },
      { provider: "telegram", providerUserId: "@dima_tag", userId: "user-dima" },
    ],
  });

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore,
    publicDir,
    conversationStore,
    userStore,
  });

  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "telegram mapped task",
        channel: "telegram",
        sourceUserId: "42",
        sourceUserAliases: ["dima_tag", "@dima_tag"],
        sourceChatId: "chat-42",
      }),
    });
    const body = await response.json();
    const completed = await waitForRun(baseUrl, body.run.id);

    assert.equal(response.status, 202);
    assert.equal(body.run.requesterUserId, "user-dima");
    assert.equal(completed.run.requesterUserId, "user-dima");
    assert.equal(body.thread.requesterUserId, "user-dima");
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server rejects unmapped channel identities", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const runStore = new InMemoryRunStore();

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore,
    publicDir,
    userStore: new InMemoryUserStore(),
  });

  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "blocked telegram task",
        channel: "telegram",
        sourceUserId: "tg-unknown",
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 403);
    assert.equal(body.error, "Channel identity is not allowed or not mapped: telegram/tg-unknown");
    assert.equal((await runStore.list()).length, 0);
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
  const serviceTool = {
    name: "web.search",
    version: "1.0.0",
    description: "Searches the web.",
    capabilities: ["web-search"],
    startupMode: "always-on" as const,
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    outputSchema: {
      type: "object" as const,
      properties: {},
    },
    async healthcheck() {
      return { ok: true, detail: "healthy" };
    },
    async run() {
      return { ok: true, content: "ok" };
    },
  };
  const serviceRegistry = {
    list() {
      return [serviceTool];
    },
    get(name: string) {
      return name === serviceTool.name ? serviceTool : undefined;
    },
  };

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
    toolRegistry: serviceRegistry,
    toolServiceSupervisor: new ToolServiceSupervisor(serviceRegistry),
  });

  try {
    const baseUrl = await listen(server);
    const memories = await (await fetch(`${baseUrl}/api/memories`)).json();
    const tools = await (await fetch(`${baseUrl}/api/tools`)).json();
    const health = await (await fetch(`${baseUrl}/api/tools/health`)).json();
    const services = await (await fetch(`${baseUrl}/api/tool-services`)).json();
    const started = await (
      await fetch(`${baseUrl}/api/tool-services/${encodeURIComponent("web.search")}/start`, { method: "POST" })
    ).json();
    const policy = await (
      await fetch(`${baseUrl}/api/tool-services/${encodeURIComponent("web.search")}/restart-policy`, {
        method: "PATCH",
        body: JSON.stringify({
          autoRestartEnabled: false,
          maxAutoRestarts: 1,
          restartBackoffMs: 2500,
          restartBackoffMultiplier: 2,
          restartBackoffMaxMs: 10000,
          restartBackoffJitterRatio: 0.25,
          restartRequiresApproval: true,
        }),
        headers: { "content-type": "application/json" },
      })
    ).json();
    const stopped = await (
      await fetch(`${baseUrl}/api/tool-services/${encodeURIComponent("web.search")}/stop`, { method: "POST" })
    ).json();
    const serviceLogs = await (await fetch(`${baseUrl}/api/tool-services/logs?toolName=web.search`)).json();

    assert.equal(memories.memories[0].title, "Reusable research funnel");
    assert.equal(tools.tools[0].name, "web.search");
    assert.equal(tools.tools[0].version, "1.0.0");
    assert.equal(health.tools[0].ok, true);
    assert.equal(services.services[0].status, "stopped");
    assert.equal(services.services[0].consecutiveFailureCount, 0);
    assert.equal(started.service.status, "running");
    assert.equal(started.service.consecutiveFailureCount, 0);
    assert.equal(policy.service.autoRestartEnabled, false);
    assert.equal(policy.service.maxAutoRestarts, 1);
    assert.equal(policy.service.restartBackoffMs, 2500);
    assert.equal(policy.service.restartBackoffMultiplier, 2);
    assert.equal(policy.service.restartBackoffMaxMs, 10000);
    assert.equal(policy.service.restartBackoffJitterRatio, 0.25);
    assert.equal(policy.service.restartRequiresApproval, true);
    assert.equal(stopped.service.status, "stopped");
    assert.equal(serviceLogs.logs[0].toolName, "web.search");
    assert.match(serviceLogs.logs.map((log: { message: string }) => log.message).join("\n"), /Service stopped/);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server streams tool service lifecycle logs as server-sent events", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const serviceTool = {
    name: "web.search",
    version: "1.0.0",
    description: "Searches the web.",
    capabilities: ["web-search"],
    startupMode: "always-on" as const,
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    outputSchema: {
      type: "object" as const,
      properties: {},
    },
    async healthcheck() {
      return { ok: true, detail: "healthy" };
    },
    async run() {
      return { ok: true, content: "ok" };
    },
  };
  const serviceRegistry = {
    list() {
      return [serviceTool];
    },
    get(name: string) {
      return name === serviceTool.name ? serviceTool : undefined;
    },
  };

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    toolRegistry: serviceRegistry,
    toolServiceSupervisor: new ToolServiceSupervisor(serviceRegistry),
  });

  try {
    const baseUrl = await listen(server);
    const streamResponse = await fetch(`${baseUrl}/api/tool-services/logs/events?toolName=web.search`);
    const eventPromise = readFirstSseEvent(streamResponse);
    await fetch(`${baseUrl}/api/tool-services/${encodeURIComponent("web.search")}/start`, { method: "POST" });
    const event = await eventPromise;

    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(event.event, "service-log");
    assert.equal(event.data.log.toolName, "web.search");
    assert.equal(event.data.log.message, "Service start healthcheck completed.");
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server audits operator approval for pending service restarts", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  let started = 0;
  const serviceTool = {
    name: "service.approval",
    version: "1.0.0",
    description: "Approval-gated service.",
    capabilities: ["service.approval"],
    startupMode: "always-on" as const,
    inputSchema: { type: "object" as const, properties: {} },
    outputSchema: { type: "object" as const, properties: {} },
    async startService() {
      started += 1;
      const instance = started;
      let healthchecks = 0;
      return {
        async healthcheck() {
          healthchecks += 1;
          if (instance === 1 && healthchecks > 1) {
            return { ok: false, detail: "service dependency failed" };
          }
          return { ok: true, detail: `service healthy ${instance}` };
        },
      };
    },
    async run() {
      return { ok: true, content: "ok" };
    },
  };
  const serviceRegistry = {
    list() {
      return [serviceTool];
    },
    get(name: string) {
      return name === serviceTool.name ? serviceTool : undefined;
    },
  };
  const auditEventStore = new InMemoryAuditEventStore();
  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    toolRegistry: serviceRegistry,
    toolServiceSupervisor: new ToolServiceSupervisor(serviceRegistry),
    auditEventStore,
  });

  try {
    const baseUrl = await listen(server);
    await fetch(`${baseUrl}/api/tool-services/service.approval/restart-policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ restartRequiresApproval: true }),
    });
    await fetch(`${baseUrl}/api/tool-services/service.approval/start`, { method: "POST" });
    const pending = await (
      await fetch(`${baseUrl}/api/tool-services/service.approval/heartbeat`, { method: "POST" })
    ).json();
    const restarted = await (
      await fetch(`${baseUrl}/api/tool-services/service.approval/restart`, { method: "POST" })
    ).json();
    const audit = await auditEventStore.list(10);
    const restartAudit = audit.find((event) => event.action === "tool_service.restart");

    assert.equal(pending.service.pendingRestartApproval, true);
    assert.equal(restarted.service.status, "running");
    assert.equal(restarted.service.pendingRestartApproval, false);
    assert.equal(restartAudit?.metadata?.approvedPendingRestart, true);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server records provider-neutral tool service events", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const auditEventStore = new InMemoryAuditEventStore();

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    toolServiceEventStore: new InMemoryToolServiceEventStore(),
    auditEventStore,
  });

  try {
    const baseUrl = await listen(server);
    const created = await (
      await fetch(`${baseUrl}/api/tool-service-events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolName: "generated.bot.demo",
          direction: "inbound",
          status: "received",
          summary: "Demo provider message received",
          sourceUserId: "telegram:42",
          sourceChatId: "chat-1",
          sourceMessageId: "msg-1",
          payload: {
            text: "hello",
            token: "must-not-leak",
          },
        }),
      })
    ).json();
    const listed = await (await fetch(`${baseUrl}/api/tool-service-events?toolName=generated.bot.demo`)).json();
    const audit = await (await fetch(`${baseUrl}/api/audit-events`)).json();

    assert.equal(created.event.toolName, "generated.bot.demo");
    assert.equal(created.event.payload.token, "[redacted]");
    assert.equal(listed.events[0].summary, "Demo provider message received");
    assert.equal(audit.events[0].action, "tool_service.event_recorded");
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server accepts generic always-on inbound events and creates runs", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const serviceTool = {
    name: "generated.bot.demo",
    version: "1.0.0",
    description: "Demo bot service.",
    capabilities: ["inbound-message"],
    startupMode: "always-on" as const,
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    outputSchema: {
      type: "object" as const,
      properties: {},
    },
    async healthcheck() {
      return { ok: true, detail: "healthy" };
    },
    async run() {
      return { ok: true, content: "ok" };
    },
  };
  const serviceRegistry = {
    list() {
      return [serviceTool];
    },
    get(name: string) {
      return name === serviceTool.name ? serviceTool : undefined;
    },
  };
  const runStore = new InMemoryRunStore();
  const eventStore = new InMemoryToolServiceEventStore();
  const userStore = new InMemoryUserStore({
    users: [{ id: "user-channel", displayName: "Channel User" }],
    identities: [
      {
        provider: "generated.bot.demo",
        providerUserId: "external-1",
        userId: "user-channel",
        allowStatus: "allowed",
      },
    ],
  });

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore,
    publicDir,
    conversationStore: new InMemoryConversationThreadStore(),
    userStore,
    toolRegistry: serviceRegistry,
    toolServiceSupervisor: new ToolServiceSupervisor(serviceRegistry),
    toolServiceEventStore: eventStore,
    auditEventStore: new InMemoryAuditEventStore(),
  });

  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/api/tool-services/generated.bot.demo/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Create a short answer from a generic service event",
        sourceUserId: "external-1",
        sourceChatId: "chat-1",
        sourceMessageId: "msg-1",
        apiKey: "must-not-leak",
      }),
    });
    const created = await response.json();
    const completed = await waitForRun(baseUrl, created.run.id);
    const events = await (await fetch(`${baseUrl}/api/tool-service-events?toolName=generated.bot.demo`)).json();
    const outbox = await (await fetch(`${baseUrl}/api/tool-services/generated.bot.demo/outbox`)).json();

    assert.equal(response.status, 202);
    assert.equal(created.run.channel, "generated.bot.demo");
    assert.equal(created.run.requesterUserId, "user-channel");
    assert.equal(created.run.sourceUserId, "external-1");
    assert.equal(created.run.sourceChatId, "chat-1");
    assert.equal(created.event.payload.apiKey, "[redacted]");
    assert.equal(completed.run.status, "completed");
    assert.deepEqual(
      events.events.map((event: { direction: string; status: string }) => `${event.direction}:${event.status}`).sort(),
      ["inbound:received", "outbound:queued", "system:queued"],
    );
    assert.equal(
      events.events.find((event: { direction: string }) => event.direction === "system")?.runId,
      created.run.id,
    );
    const outbound = events.events.find((event: { direction: string }) => event.direction === "outbound");
    assert.equal(outbound?.runId, created.run.id);
    assert.match(outbound?.payload.finalAnswer, /answer for Create a short answer/);
    assert.equal(outbox.events.length, 1);
    assert.equal(outbox.events[0].id, outbound.id);

    const ackResponse = await fetch(`${baseUrl}/api/tool-services/generated.bot.demo/outbox/${outbound.id}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "sent",
        providerMessageId: "provider-msg-1",
        detail: "Delivered by demo adapter.",
        payload: { deliveryToken: "must-not-leak" },
      }),
    });
    const ack = await ackResponse.json();
    const emptyOutbox = await (await fetch(`${baseUrl}/api/tool-services/generated.bot.demo/outbox`)).json();

    assert.equal(ackResponse.status, 201);
    assert.equal(ack.event.status, "sent");
    assert.equal(ack.event.payload.sourceEventId, outbound.id);
    assert.equal(ack.event.payload.providerMessageId, "provider-msg-1");
    assert.equal(ack.event.payload.deliveryToken, "[redacted]");
    assert.deepEqual(emptyOutbox.events, []);

    const followUpResponse = await fetch(`${baseUrl}/api/tool-services/generated.bot.demo/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Continue the previous answer",
        sourceUserId: "external-1",
        sourceChatId: "chat-1",
        sourceMessageId: "msg-2",
        threadId: created.run.threadId,
      }),
    });
    const followUp = await followUpResponse.json();
    const completedFollowUp = await waitForRun(baseUrl, followUp.run.id);

    assert.equal(followUpResponse.status, 202);
    assert.equal(followUp.run.threadId, created.run.threadId);
    assert.equal(completedFollowUp.run.parentRunId, created.run.id);
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
  (skillMemory as SkillMemory & { reembedAll(): Promise<{ updated: number }> }).reembedAll = async () => ({
    updated: 3,
  });
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
    const reviewQueue = await (await fetch(`${baseUrl}/api/memories/review-queue`)).json();
    const acceptResponse = await fetch(`${baseUrl}/api/memories/${encodeURIComponent(created.memory.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "accepted", confidence: 0.95 }),
    });
    const accepted = await acceptResponse.json();
    const evaluationResponse = await fetch(`${baseUrl}/api/memories/evaluate-retrieval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cases: [
          {
            id: "telegram-routing",
            query: "Telegram whitelisted users thread routing",
            expectedMemoryIds: [created.memory.id],
            visibleScopes: [{ scope: "global" }, { scope: "group", scopeId: "group-local" }],
          },
        ],
      }),
    });
    const evaluation = await evaluationResponse.json();
    const editResponse = await fetch(`${baseUrl}/api/memories/${encodeURIComponent(created.memory.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Telegram continuity policy",
        tags: ["telegram", "continuity"],
        summary: "Whitelisted Telegram messages must resolve to the correct user and active thread.",
        reusableProcedure: "Resolve channel identity, then use thread resolution before run creation.",
        scope: "user",
        scopeId: "user-admin",
        status: "proposed",
        confidence: 0.81,
        sensitivity: "private",
        evidence: ["operator edited the scoped memory contract"],
      }),
    });
    const edited = await editResponse.json();
    const reembedResponse = await fetch(`${baseUrl}/api/memories/reembed`, { method: "POST" });
    const reembedded = await reembedResponse.json();
    const groupAccepted = await (await fetch(`${baseUrl}/api/memories?scope=group&scopeId=group-local&status=accepted`)).json();
    const userProposed = await (await fetch(`${baseUrl}/api/memories?scope=user&scopeId=user-admin&status=proposed`)).json();
    const audit = await (await fetch(`${baseUrl}/api/audit-events`)).json();

    assert.equal(createResponse.status, 201);
    assert.equal(created.memory.status, "proposed");
    assert.equal(created.memory.scope, "group");
    assert.equal(proposed.memories.length, 1);
    assert.equal(reviewQueue.summary.total, 1);
    assert.equal(reviewQueue.reviews[0].memoryId, created.memory.id);
    assert.equal(reviewQueue.reviews[0].status, "needs_review");
    assert.equal(
      reviewQueue.reviews[0].findings.some((finding: { code: string }) => finding.code === "missing_source"),
      true,
    );
    assert.equal(acceptResponse.status, 200);
    assert.equal(accepted.memory.status, "accepted");
    assert.equal(accepted.memory.confidence, 0.95);
    assert.equal(evaluationResponse.status, 200);
    assert.equal(evaluation.passed, true);
    assert.equal(evaluation.results[0].topHitMatched, true);
    assert.equal(editResponse.status, 200);
    assert.equal(edited.memory.title, "Telegram continuity policy");
    assert.equal(edited.memory.scope, "user");
    assert.equal(edited.memory.scopeId, "user-admin");
    assert.equal(edited.memory.status, "proposed");
    assert.equal(edited.memory.sensitivity, "private");
    assert.deepEqual(edited.memory.tags, ["telegram", "continuity"]);
    assert.equal(reembedResponse.status, 200);
    assert.equal(reembedded.updated, 3);
    assert.equal(groupAccepted.memories.length, 0);
    assert.equal(userProposed.memories[0].id, created.memory.id);
    assert.equal(audit.events.some((event: { action: string }) => event.action === "memory.created"), true);
    assert.equal(audit.events.some((event: { action: string }) => event.action === "memory.updated"), true);
    assert.equal(
      audit.events.some((event: { action: string }) => event.action === "memory.embeddings_rebuilt"),
      true,
    );
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
        displayName: "PDF Report",
        reason: "Need PDF report artifacts.",
        startupMode: "always-on",
        requiredInputs: ["markdown"],
        requiredOutputs: ["artifact"],
        credentialHandles: ["secret.pdf.vendor"],
        credentialNotes: "api key 12312, secret 8978",
      }),
    });
    const response = await fetch(`${baseUrl}/api/tool-build-requests`);
    const created = await createdResponse.json();
    const sourceRunResponse = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(created.request.sourceRunId)}`);
    const sourceRun = await sourceRunResponse.json();
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
    assert.equal(created.request.displayName, "PDF Report");
    assert.equal(created.request.contract.displayName, "PDF Report");
    assert.equal(created.request.contract.toolName, "generated.pdf.report");
    assert.equal(created.request.contract.startupMode, "always-on");
    assert.equal(sourceRunResponse.status, 200);
    assert.equal(sourceRun.run.status, "completed");
    assert.match(sourceRun.run.result.finalAnswer, /Tool Build request/);
    assert.equal(
      sourceRun.run.events.some((event: { type: string }) => event.type === "tool-build-requested"),
      true,
    );
    assert.deepEqual(created.request.credentialHandles, ["secret.pdf.vendor"]);
    assert.equal(created.request.credentialNotes, "api key 12312, secret 8978");
    assert.ok(
      created.request.contract.builderInstructions.some((instruction: string) => instruction.includes("secret.pdf.vendor")),
    );
    assert.ok(
      created.request.contract.builderInstructions.some((instruction: string) =>
        instruction.includes("Operator supplied credential notes"),
      ),
    );
    assert.equal(updateResponse.status, 200);
    assert.equal(updated.request.status, "qa_passed");
    assert.equal(updated.request.qaReport.checks.length, 2);
    assert.equal(detail.request.registeredToolName, "generated.pdf.report");
    assert.equal(reworkResponse.status, 201);
    assert.equal(rework.request.status, "requested");
    assert.equal(rework.request.reworkOf, created.request.id);
    assert.deepEqual(rework.request.credentialHandles, ["secret.pdf.vendor"]);
    assert.equal(rework.request.credentialNotes, "api key 12312, secret 8978");
    assert.equal(rework.request.displayName, "PDF Report");
    assert.match(rework.request.feedback, /stricter artifact validation/);
    assert.match(rework.request.reason, /Original build context/);
    assert.match(rework.request.reason, /Status detail: Builder tests passed/);
    assert.match(rework.request.reason, /QA checks:\n\n- unit tests passed/);
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

test("web server infers tool build capability from human request fields", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const toolBuildRequestStore = new InMemoryToolBuildRequestStore();
  const secretHandleStore = new InMemorySecretHandleStore();
  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    toolBuildRequestStore,
    secretHandleStore,
  });

  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/api/tool-build-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Wallet Risk Lookup",
        reason: "Create a reusable HTTP API tool. Docs: https://provider.example/docs. It accepts chain and wallet address and returns risk score.",
        credentialNotes: "api key 12312",
        qaCriteria: ["schemas validated", "no credential leakage"],
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.request.displayName, "Wallet Risk Lookup");
    assert.equal(body.request.capability, "api.wallet-risk-lookup");
    assert.equal(body.request.contract.toolName, "generated.api.wallet.risk.lookup");
    assert.match(body.request.credentialNotes, /raw operator notes were redacted/);
    assert.doesNotMatch(body.request.credentialNotes, /12312/);
    assert.deepEqual(body.request.credentialHandles, ["secret.api.wallet-risk-lookup"]);
    assert.equal(await secretHandleStore.resolve?.("secret.api.wallet-risk-lookup"), "12312");
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server rejects contextual tool requests that clearly target another installed tool", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const toolBuildRequestStore = new InMemoryToolBuildRequestStore();
  const toolMetadataStore = new InMemoryToolMetadataStore();
  await toolMetadataStore.syncBuiltins([
    {
      name: "browser.operate",
      version: "1.0.0",
      description: "Runs generic browser automation.",
      capabilities: ["browser-operate"],
      async run() {
        return { ok: true, content: "ok" };
      },
    },
    {
      name: "channel.telegram.bot",
      displayName: "Telegram bot service",
      version: "1.0.0",
      description: "Receives Telegram bot messages and bridges them to Agentic.",
      capabilities: ["telegram-bot", "always-on-messaging"],
      startupMode: "always-on",
      async run() {
        return { ok: true, content: "ok" };
      },
    },
  ]);
  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    toolBuildRequestStore,
    toolMetadataStore,
  });

  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/api/tool-build-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "browser-operate",
        displayName: "browser.operate",
        reason:
          "Add Telegram identity canonicalization: allow operator to whitelist @username and persist numeric Telegram from.id.",
        feedback:
          "Telegram inbound updates should map @username aliases to canonical Telegram ids.",
        replacesToolName: "browser.operate",
        replacesVersion: "1.0.0",
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /Selected tool browser\.operate does not appear to match/);
    assert.match(body.error, /closer to channel\.telegram\.bot/);
    assert.equal((await toolBuildRequestStore.list()).length, 0);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server stores only extracted credential material from tool build notes", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const toolBuildRequestStore = new InMemoryToolBuildRequestStore();
  const secretHandleStore = new InMemorySecretHandleStore();
  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    toolBuildRequestStore,
    secretHandleStore,
  });

  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/api/tool-build-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "GL AML",
        reason: "Create a reusable HTTP API tool for Global Ledger AML score.",
        credentialNotes: "Use this as x-api-key: TEST-GL-AML-API-KEY-123. Do not leak it into source or memory.",
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.deepEqual(body.request.credentialHandles, ["secret.api.gl-aml"]);
    assert.match(body.request.credentialNotes, /raw operator notes were redacted/);
    assert.doesNotMatch(body.request.credentialNotes, /TEST-GL-AML-API-KEY-123/);
    assert.equal(await secretHandleStore.resolve?.("secret.api.gl-aml"), "TEST-GL-AML-API-KEY-123");
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
        displayName: "Browser Screenshot",
        version: "1.0.0",
        description: "Captures browser screenshots.",
        capabilities: ["browser-screenshot", "artifact-generation"],
        startupMode: "on-demand",
        modulePath: "src/tools/generated/browser-screenshotTool.ts",
        testPath: "tests/generated/browser-screenshotTool.test.ts",
        changeSummary: "Initial generated screenshot module.",
        promotionEvidence: {
          status: "promoted",
          promotedAt: "2026-05-04T10:00:00.000Z",
          summary: "Initial screenshot QA passed.",
          buildRequestId: "toolbuild-browser-screenshot",
          qaReport: {
            ok: true,
            summary: "QA passed.",
            checks: ["module test", "package manifest"],
          },
          packageRef: "src/tools/generated/browser-screenshotTool.ts",
          migrationIds: [],
        },
        packageManifest: {
          schemaVersion: "agentic.tool-package.v1",
          name: "generated.browser.screenshot",
          displayName: "Browser Screenshot",
          version: "1.0.0",
          description: "Captures browser screenshots.",
          capabilities: ["browser-screenshot", "artifact-generation"],
          startupMode: "on-demand",
          package: { type: "local-path", ref: "src/tools/generated/browser-screenshotTool.ts" },
        },
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
    const versions = await (
      await fetch(`${baseUrl}/api/tools/generated-modules/${encodeURIComponent("generated.browser.screenshot")}/versions`)
    ).json();
    const manifest = await (
      await fetch(
        `${baseUrl}/api/tools/generated-modules/${encodeURIComponent("generated.browser.screenshot")}/package-manifest`,
      )
    ).json();
    const deleteResponse = await fetch(
      `${baseUrl}/api/tools/generated-modules/${encodeURIComponent("generated.browser.screenshot")}`,
      { method: "DELETE" },
    );
    const afterDelete = await (await fetch(`${baseUrl}/api/tools`)).json();

    assert.equal(createResponse.status, 201);
    assert.equal(createBody.tool.status, "disabled");
    assert.equal(createBody.tool.displayName, "Browser Screenshot");
    assert.equal(conflictResponse.status, 400);
    assert.equal(tools.tools[0].source, "generated");
    assert.equal(tools.tools[0].packageManifest.package.type, "local-path");
    assert.equal(tools.tools[0].promotionEvidence.buildRequestId, "toolbuild-browser-screenshot");
    assert.equal(versions.versions[0].version, "1.0.0");
    assert.match(versions.versions[0].changeSummary, /Initial generated screenshot/);
    assert.equal(versions.versions[0].promotionEvidence.summary, "Initial screenshot QA passed.");
    assert.equal(manifest.manifest.name, "generated.browser.screenshot");
    assert.equal(deleteResponse.status, 200);
    assert.equal(afterDelete.tools.length, 0);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server imports portable tool package manifests without executable source", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  const toolMetadataStore = new InMemoryToolMetadataStore();

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    toolMetadataStore,
    auditEventStore: new InMemoryAuditEventStore(),
  });

  try {
    const baseUrl = await listen(server);
    const importResponse = await fetch(`${baseUrl}/api/tools/package-manifests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        manifest: {
          schemaVersion: "agentic.tool-package.v1",
          name: "generated.remote.normalize",
          displayName: "Remote Normalizer",
          version: "1.0.0",
          description: "Portable package reference for a remote text normalizer.",
          capabilities: ["text-normalization"],
          startupMode: "on-demand",
          package: { type: "external-package", ref: "npm:@agentic-tools/remote-normalize@1.0.0" },
          requiredSecretHandles: ["secret.remote.normalize"],
          qa: {
            summary: "Imported package has external QA evidence.",
            checks: ["package manifest validated"],
          },
        },
      }),
    });
    const importBody = await importResponse.json();
    const tools = await (await fetch(`${baseUrl}/api/tools`)).json();
    const manifest = await (
      await fetch(
        `${baseUrl}/api/tools/generated-modules/${encodeURIComponent("generated.remote.normalize")}/package-manifest`,
      )
    ).json();

    assert.equal(importResponse.status, 201);
    assert.equal(importBody.tool.name, "generated.remote.normalize");
    assert.equal(importBody.tool.modulePath, undefined);
    assert.equal(importBody.tool.packageManifest.package.type, "external-package");
    assert.equal(tools.tools[0].requiredSecretHandles[0], "secret.remote.normalize");
    assert.equal(manifest.manifest.package.ref, "npm:@agentic-tools/remote-normalize@1.0.0");
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server exposes installed tool package runners", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    toolPackageRunners: [
      new LocalPathToolPackageRunner(),
      new SourceBundleToolPackageRunner("portable-tools"),
    ],
  });

  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/api/tool-package-runners`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(
      body.runners.map((runner: { type: string }) => runner.type),
      ["local-path", "source-bundle"],
    );
    assert.deepEqual(
      body.runners.map((runner: { name: string }) => runner.name),
      ["Local compiled module runner", "Source bundle in-process runner"],
    );
    assert.equal(body.runners[1].root, "portable-tools");
    assert.deepEqual(body.runners[1].supportedPackageTypes, ["source-bundle"]);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server imports and reloads loadable source-bundle package manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-source-web-"));
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  const toolMetadataStore = new InMemoryToolMetadataStore();
  const toolRegistry = new ToolRegistry();
  const runners = [new SourceBundleToolPackageRunner("tool-packages")];
  let server: ReturnType<typeof createWebApp> | undefined;

  try {
    await mkdir(join(root, "tool-packages/normalize/dist"), { recursive: true });
    await writeFile(
      join(root, "tool-packages/normalize/dist/index.js"),
      `
        export default {
          name: "generated.bundle.webnormalize",
          version: "1.0.0",
          description: "Web import source bundle.",
          capabilities: ["text-normalization"],
          async healthcheck() { return { ok: true, detail: "web bundle healthy" }; },
          async run(input) { return { ok: true, content: String(input.text ?? "").trim() }; }
        };
      `,
    );

    server = createWebApp({
      agent: new FakeAgent() as unknown as UniversalAgent,
      runStore: new InMemoryRunStore(),
      publicDir,
      toolRegistry,
      toolMetadataStore,
      toolPackageRunners: runners,
      reloadGeneratedTools: async () => {
        await loadGeneratedTools(toolRegistry, toolMetadataStore, root, runners);
      },
    });

    const baseUrl = await listen(server);
    const importResponse = await fetch(`${baseUrl}/api/tools/package-manifests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.bundle.webnormalize",
        version: "1.0.0",
        description: "Web import source bundle.",
        capabilities: ["text-normalization"],
        startupMode: "on-demand",
        package: { type: "source-bundle", ref: "normalize" },
      }),
    });
    const body = await importResponse.json();
    const tools = await (await fetch(`${baseUrl}/api/tools`)).json();
    const output = await toolRegistry.get("generated.bundle.webnormalize")?.run({ text: " bundle loaded " });

    assert.equal(importResponse.status, 201);
    assert.equal(body.tool.status, "available");
    assert.equal(body.tool.lastHealthDetail, "web bundle healthy");
    assert.equal(tools.tools[0].status, "available");
    assert.equal(output?.content, "bundle loaded");
  } finally {
    if (server) await close(server);
    await rm(root, { recursive: true, force: true });
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server imports and reloads external HTTP package manifests", async () => {
  const runtimeServer = createHttpServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ ok: true, detail: "external web runtime healthy" }));
      return;
    }
    if (request.url === "/run") {
      response.end(JSON.stringify({ ok: true, content: `web:${body.input.text}` }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  const runtimeUrl = await listenHttp(runtimeServer);
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  const toolMetadataStore = new InMemoryToolMetadataStore();
  const toolRegistry = new ToolRegistry();
  const runners = [new ExternalHttpToolPackageRunner()];
  let server: ReturnType<typeof createWebApp> | undefined;

  try {
    server = createWebApp({
      agent: new FakeAgent() as unknown as UniversalAgent,
      runStore: new InMemoryRunStore(),
      publicDir,
      toolRegistry,
      toolMetadataStore,
      toolPackageRunners: runners,
      reloadGeneratedTools: async () => {
        await loadGeneratedTools(toolRegistry, toolMetadataStore, process.cwd(), runners);
      },
    });
    const baseUrl = await listen(server);
    const importResponse = await fetch(`${baseUrl}/api/tools/package-manifests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.external.webecho",
        version: "1.0.0",
        description: "External HTTP package echo.",
        capabilities: ["external-echo"],
        startupMode: "on-demand",
        package: { type: "external-package", ref: runtimeUrl },
      }),
    });
    const body = await importResponse.json();
    const output = await toolRegistry.get("generated.external.webecho")?.run({ text: "loaded" });

    assert.equal(importResponse.status, 201);
    assert.equal(body.tool.status, "available");
    assert.equal(body.tool.lastHealthDetail, "external web runtime healthy");
    assert.equal(output?.content, "web:loaded");
  } finally {
    if (server) await close(server);
    await closeHttp(runtimeServer);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server reloads generated tools on operator request", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  const toolMetadataStore = new InMemoryToolMetadataStore();
  const auditEventStore = new InMemoryAuditEventStore();
  let reloads = 0;
  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    toolMetadataStore,
    auditEventStore,
    reloadGeneratedTools: async () => {
      reloads += 1;
    },
  });

  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/api/tools/reload-generated`, { method: "POST" });
    const body = await response.json();
    const auditEvents = await auditEventStore.list(10);

    assert.equal(response.status, 200);
    assert.equal(reloads, 1);
    assert.deepEqual(body.tools, []);
    assert.equal(auditEvents[0]?.action, "tool.generated_reload");
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server records tool migration metadata with audit events", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const toolMigrationStore = new InMemoryToolMigrationStore();
  const auditEventStore = new InMemoryAuditEventStore();

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    toolMigrationStore,
    auditEventStore,
  });

  try {
    const baseUrl = await listen(server);
    const createResponse = await fetch(`${baseUrl}/api/tool-migrations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        toolName: "generated.api.client",
        toolVersion: "1.2.0",
        migrationId: "001_create_cache",
        checksum: "sha256:test",
        status: "applied",
        appliedAt: "2026-05-03T10:00:00.000Z",
        appliedByActor: "tool-registrar",
        qaReport: { ok: true, checks: ["idempotent"] },
      }),
    });
    const created = await createResponse.json();
    const listed = await (await fetch(`${baseUrl}/api/tool-migrations?toolName=generated.api.client`)).json();
    const audit = await (await fetch(`${baseUrl}/api/audit-events`)).json();

    assert.equal(createResponse.status, 201);
    assert.equal(created.migration.status, "applied");
    assert.equal(listed.migrations.length, 1);
    assert.equal(listed.migrations[0].migrationId, "001_create_cache");
    assert.equal(audit.events.some((event: { action: string }) => event.action === "tool_migration.recorded"), true);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server exposes tool promotion journal entries", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const toolPromotionStore = new InMemoryToolPromotionStore();
  await toolPromotionStore.create({
    toolName: "generated.api.client",
    toolVersion: "1.2.0",
    promotedAt: new Date("2026-05-04T10:00:00.000Z"),
    buildRequestId: "toolbuild-1",
    qaReport: { ok: true, checks: ["isolated build"] },
    packageRef: "generated.api.client/1.2.0",
    migrationIds: ["001_create_cache"],
    summary: "Generated API client passed QA.",
  });

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    toolPromotionStore,
  });

  try {
    const baseUrl = await listen(server);
    const listed = await (await fetch(`${baseUrl}/api/tool-promotions?toolName=generated.api.client`)).json();

    assert.equal(listed.promotions.length, 1);
    assert.equal(listed.promotions[0].buildRequestId, "toolbuild-1");
    assert.deepEqual(listed.promotions[0].migrationIds, ["001_create_cache"]);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server manages secret handles without accepting raw secret values", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const secretHandleStore = new InMemorySecretHandleStore();
  const auditEventStore = new InMemoryAuditEventStore();

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    secretHandleStore,
    auditEventStore,
  });

  try {
    const baseUrl = await listen(server);
    const rejectedResponse = await fetch(`${baseUrl}/api/secret-handles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "Telegram bot",
        provider: "env",
        secretRef: "TELEGRAM_BOT_TOKEN",
        token: "raw-value-should-not-enter-the-system",
      }),
    });
    const createResponse = await fetch(`${baseUrl}/api/secret-handles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: "secret.telegram.bot",
        label: "Telegram bot",
        provider: "env",
        secretRef: "TELEGRAM_BOT_TOKEN",
        scopes: ["instance-local", "tool:channel.telegram.bot"],
      }),
    });
    const created = await createResponse.json();
    const listed = await (await fetch(`${baseUrl}/api/secret-handles`)).json();
    const detail = await (await fetch(`${baseUrl}/api/secret-handles/secret.telegram.bot`)).json();
    const deleteResponse = await fetch(`${baseUrl}/api/secret-handles/secret.telegram.bot`, { method: "DELETE" });
    const deleted = await deleteResponse.json();
    const audit = await (await fetch(`${baseUrl}/api/audit-events`)).json();

    assert.equal(rejectedResponse.status, 400);
    assert.equal(createResponse.status, 201);
    assert.equal(created.secretHandle.handle, "secret.telegram.bot");
    assert.equal(created.secretHandle.secretRef, "TELEGRAM_BOT_TOKEN");
    assert.equal(JSON.stringify(created).includes("raw-value-should-not-enter-the-system"), false);
    assert.equal(listed.secretHandles.length, 1);
    assert.deepEqual(detail.secretHandle.scopes, ["instance-local", "tool:channel.telegram.bot"]);
    assert.equal(deleteResponse.status, 200);
    assert.equal(deleted.deleted, true);
    assert.equal(audit.events.some((event: { action: string }) => event.action === "secret_handle.created"), true);
    assert.equal(audit.events.some((event: { action: string }) => event.action === "secret_handle.deleted"), true);
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
    const activateResponse = await fetch(
      `${baseUrl}/api/tools/generated-modules/generated.browser.screenshot/activate-version`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "1.1.0" }),
      },
    );
    const activateBody = await activateResponse.json();

    assert.equal(staleResponse.status, 400);
    assert.equal(promoteResponse.status, 200);
    assert.equal(promoteBody.tool.version, "1.1.0");
    assert.equal(promoteBody.tool.status, "disabled");
    assert.equal(activateResponse.status, 200);
    assert.equal(activateBody.tool.version, "1.1.0");
    assert.equal(activateBody.tool.versions[0].active, true);
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
    modelProviderStore: new InMemoryModelProviderStore([
      {
        id: "test-chat",
        label: "Test chat",
        kind: "chat",
        providerType: "openai-compatible",
        baseUrl: "http://localhost:1234/v1",
        modelIds: ["small-a"],
      },
    ]),
  });

  try {
    const baseUrl = await listen(server);
    const initial = await (await fetch(`${baseUrl}/api/settings/model-tiers`)).json();
    const catalog = await (await fetch(`${baseUrl}/api/models/catalog`)).json();
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
    assert.equal(catalog.chat.defaultModel, process.env.LLM_MODEL ?? "google/gemma-4-26b-a4b");
    assert.equal(catalog.providers[0].id, "test-chat");
    assert.equal(Array.isArray(catalog.chat.models), true);
    assert.equal(catalog.embedding.dimensions, Number(process.env.MEMORY_EMBEDDING_DIMENSIONS ?? "128"));
    assert.equal(updateResponse.status, 200);
    assert.deepEqual(updated.tiers[0].models, ["small-a", "small-b"]);
    assert.equal(updated.tiers[0].maxAttempts, 3);
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("web server manages model provider registry", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    modelProviderStore: new InMemoryModelProviderStore([]),
    auditEventStore: new InMemoryAuditEventStore(),
  });

  try {
    const baseUrl = await listen(server);
    const createResponse = await fetch(`${baseUrl}/api/model-providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "Remote GPT",
        kind: "chat",
        providerType: "openai-compatible",
        baseUrl: "https://api.example.test/v1",
        modelIds: ["gpt-x"],
        apiKeySecretHandle: "remote-gpt-key",
      }),
    });
    const created = await createResponse.json();
    const updateResponse = await fetch(`${baseUrl}/api/model-providers/${created.provider.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "disabled", modelIds: ["gpt-x", "gpt-y"] }),
    });
    const updated = await updateResponse.json();
    const list = await (await fetch(`${baseUrl}/api/model-providers`)).json();
    const deleteResponse = await fetch(`${baseUrl}/api/model-providers/${created.provider.id}`, {
      method: "DELETE",
    });

    assert.equal(createResponse.status, 201);
    assert.equal(created.provider.id, "remote-gpt");
    assert.equal(updated.provider.status, "disabled");
    assert.equal(updated.provider.apiKeySecretHandle, "remote-gpt-key");
    assert.deepEqual(updated.provider.modelIds, ["gpt-x", "gpt-y"]);
    assert.equal(list.providers.length, 1);
    assert.equal(deleteResponse.status, 200);
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
    userStore: new InMemoryUserStore(),
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

test("web server manages users and channel identities with audit events", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const auditEventStore = new InMemoryAuditEventStore();

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    userStore: new InMemoryUserStore(),
    auditEventStore,
  });

  try {
    const baseUrl = await listen(server);
    const createdResponse = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "user-family",
        displayName: "Family Member",
        roles: ["member", "viewer"],
      }),
    });
    const created = await createdResponse.json();
    const identityResponse = await fetch(`${baseUrl}/api/users/user-family/channel-identities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "telegram",
        providerUserId: "tg-family",
      }),
    });
    const identity = await identityResponse.json();
    const blockedResponse = await fetch(
      `${baseUrl}/api/channel-identities/${encodeURIComponent(identity.identity.id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowStatus: "blocked" }),
      },
    );
    const users = await (await fetch(`${baseUrl}/api/users`)).json();
    const audit = await (await fetch(`${baseUrl}/api/audit-events`)).json();

    assert.equal(createdResponse.status, 201);
    assert.equal(created.user.id, "user-family");
    assert.equal(identityResponse.status, 201);
    assert.equal(blockedResponse.status, 200);
    assert.equal(users.users.find((user: any) => user.id === "user-family").identities[0].allowStatus, "blocked");
    assert.deepEqual(
      audit.events.slice(0, 3).map((event: any) => event.action).sort(),
      ["channel_identity.created", "channel_identity.updated", "user.created"].sort(),
    );
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

async function listenHttp(server: ReturnType<typeof createHttpServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeHttp(server: ReturnType<typeof createHttpServer>): Promise<void> {
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

    if (data.run.status === "completed" || data.run.status === "failed" || data.run.status === "cancelled") {
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
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
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
        if (!data) {
          boundary = buffer.indexOf("\n\n");
          continue;
        }

        return { event, data: JSON.parse(data) };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  throw new Error("SSE stream did not emit an event");
}
