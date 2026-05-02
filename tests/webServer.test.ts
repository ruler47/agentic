import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AddressInfo } from "node:net";
import { createWebApp } from "../src/server/http.js";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { InMemoryModelTierSettingsStore } from "../src/settings/modelTierSettings.js";
import { AgentArtifact, AgentEventSink, AgentRunResult, ArtifactCreateInput } from "../src/types.js";
import { UniversalAgent } from "../src/agents/universalAgent.js";
import { LocalArtifactStore } from "../src/artifacts/artifactStore.js";
import { InMemoryToolBuildRequestStore } from "../src/tools/toolBuildRequestStore.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import { ToolBuildWorkflow } from "../src/tools/toolBuildWorkflow.js";

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

  const server = createWebApp({
    agent: new FakeAgent() as unknown as UniversalAgent,
    runStore: new InMemoryRunStore(),
    publicDir,
    artifactStore: new LocalArtifactStore(artifactDir),
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

    assert.equal(createResponse.status, 202);
    assert.equal(input.filename, "input.txt");
    assert.equal(output.filename, "answer.txt");
    assert.equal(outputResponse.headers.get("content-type"), "text/plain");
    assert.equal(await outputResponse.text(), "artifact for hello files");
  } finally {
    await close(server);
    await rm(publicDir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
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

test("web server exposes tool build requests", async () => {
  const publicDir = await mkdtemp(join(tmpdir(), "agentic-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>Agentic</title>");
  const toolBuildRequestStore = new InMemoryToolBuildRequestStore();
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
    const runWorkflowResponse = await fetch(
      `${baseUrl}/api/tool-build-requests/${encodeURIComponent(created.request.id)}/run`,
      { method: "POST" },
    );
    const workflow = await runWorkflowResponse.json();
    const body = await response.json();

    assert.equal(createdResponse.status, 201);
    assert.equal(created.request.contract.toolName, "generated.pdf.report");
    assert.equal(updateResponse.status, 200);
    assert.equal(updated.request.status, "qa_passed");
    assert.equal(updated.request.qaReport.checks.length, 2);
    assert.equal(detail.request.registeredToolName, "generated.pdf.report");
    assert.equal(runWorkflowResponse.status, 200);
    assert.equal(workflow.request.status, "registered");
    assert.equal(response.status, 200);
    assert.equal(body.requests.length, 2);
    assert.deepEqual(
      body.requests.map((request: { capability: string }) => request.capability).sort(),
      ["browser-screenshot", "pdf-report"],
    );
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
