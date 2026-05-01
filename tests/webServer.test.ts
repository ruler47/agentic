import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AddressInfo } from "node:net";
import { createWebApp } from "../src/server/http.js";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { AgentEventSink, AgentRunResult } from "../src/types.js";
import { UniversalAgent } from "../src/agents/universalAgent.js";

class FakeAgent {
  async run(task: string, options?: { onEvent?: AgentEventSink }): Promise<AgentRunResult> {
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
