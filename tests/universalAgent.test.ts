import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UniversalAgent } from "../src/agents/universalAgent.js";
import { LlmClient } from "../src/llm/client.js";
import { SkillMemory } from "../src/memory/skillMemory.js";
import { AgentArtifact, AgentEvent, ArtifactCreateInput, Message } from "../src/types.js";
import { ToolBuildRequestInput } from "../src/tools/toolBuildRequestStore.js";
import { InMemoryToolBuildRequestStore } from "../src/tools/toolBuildRequestStore.js";
import { InMemoryToolInvestigationStore } from "../src/tools/toolInvestigationStore.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import { InMemoryToolReworkWaitStore } from "../src/runs/toolReworkWaitStore.js";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { ToolImprovementCoordinator } from "../src/tools/toolImprovementCoordinator.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { Tool } from "../src/tools/tool.js";
import { InMemoryWorkLedgerStore } from "../src/work-ledger/workLedgerStore.js";
import { InMemoryEvidenceLedgerStore } from "../src/work-ledger/evidenceLedgerStore.js";
import { InMemoryRunRetrospectiveStore } from "../src/work-ledger/runRetrospectiveStore.js";
import { PNG } from "pngjs";

class FakeLlm {
  private index = 0;

  constructor(private readonly responses: string[]) {}

  async complete(_messages: Message[]): Promise<string> {
    const response = this.responses[this.index];
    this.index += 1;

    if (response === undefined) {
      throw new Error("FakeLlm received more calls than expected");
    }

    return response;
  }

  get callCount(): number {
    return this.index;
  }
}

class RoutingFakeLlm {
  async complete(messages: Message[]): Promise<string> {
    const text = messages.map((message) => message.content).join("\n");

    if (text.includes("Classify this single user task")) {
      return '{"mode":"delegated","reason":"needs split work","domains":["test"],"riskLevel":"medium"}';
    }

    if (text.includes("Create a delegation plan")) {
      return JSON.stringify({
        subtasks: [
          {
            id: "fast",
            title: "Fast branch",
            role: "researcher",
            prompt: "Fast worker prompt.",
            expectedOutput: "Fast output.",
            reviewCriteria: ["Reviewed"],
          },
          {
            id: "slow",
            title: "Slow branch",
            role: "analyst",
            prompt: "Slow worker prompt.",
            expectedOutput: "Slow output.",
            reviewCriteria: ["Reviewed"],
          },
        ],
      });
    }

    if (text.includes('"title": "Slow branch"') && text.includes("focused worker agent")) {
      await delay(80);
      return "Slow worker result.";
    }

    if (text.includes('"title": "Fast branch"') && text.includes("focused worker agent")) {
      return "Fast worker result.";
    }

    if (text.includes("You are a reviewer agent")) {
      const subtaskId = text.includes('"id": "slow"') ? "slow" : "fast";
      return JSON.stringify({ subtaskId, verdict: "pass", notes: "Reviewed." });
    }

    if (text.includes("Synthesize the final answer")) {
      return "Final answer.";
    }

    if (text.includes("Extract one reusable skill-memory entry")) {
      return '{"shouldStore":false}';
    }

    throw new Error(`Unexpected fake LLM prompt: ${text.slice(0, 160)}`);
  }
}

class DependencyFakeLlm {
  dependentWorkerPrompt = "";

  async complete(messages: Message[]): Promise<string> {
    const text = messages.map((message) => message.content).join("\n");

    if (text.includes("Classify this single user task")) {
      return '{"mode":"delegated","reason":"requires sequential evidence","domains":["test"],"riskLevel":"medium"}';
    }

    if (text.includes("Create a delegation plan")) {
      return JSON.stringify({
        subtasks: [
          {
            id: "source",
            title: "Collect source evidence",
            role: "researcher",
            prompt: "Produce source evidence.",
            expectedOutput: "Source evidence.",
            reviewCriteria: ["Evidence is usable"],
          },
          {
            id: "dependent",
            title: "Use reviewed evidence",
            role: "analyst",
            prompt: "Use the reviewed source evidence.",
            expectedOutput: "Analysis based on source evidence.",
            reviewCriteria: ["Uses dependency output"],
            dependsOn: ["source"],
          },
        ],
      });
    }

    if (text.includes('"title": "Collect source evidence"') && text.includes("focused worker agent")) {
      return "Source worker result.";
    }

    if (text.includes('"title": "Use reviewed evidence"') && text.includes("focused worker agent")) {
      this.dependentWorkerPrompt = text;
      return "Dependent worker result using source evidence.";
    }

    if (text.includes("You are a reviewer agent")) {
      const subtaskId = text.includes('"id": "dependent"') ? "dependent" : "source";
      return JSON.stringify({ subtaskId, verdict: "pass", notes: "Reviewed." });
    }

    if (text.includes("Synthesize the final answer")) {
      return "Final answer with dependency-aware analysis.";
    }

    if (text.includes("Extract one reusable skill-memory entry")) {
      return '{"shouldStore":false}';
    }

    throw new Error(`Unexpected fake LLM prompt: ${text.slice(0, 160)}`);
  }
}

class WorkerFailingLlm {
  async complete(messages: Message[]): Promise<string> {
    const text = messages.map((message) => message.content).join("\n");

    if (text.includes("Classify this single user task")) {
      return '{"mode":"delegated","reason":"needs a worker","domains":["test"],"riskLevel":"medium"}';
    }

    if (text.includes("Create a delegation plan")) {
      return JSON.stringify({
        subtasks: [
          {
            id: "research",
            title: "Research large context",
            role: "researcher",
            prompt: "Research with too much source evidence.",
            expectedOutput: "Usable summary.",
            reviewCriteria: ["No context overflow"],
          },
        ],
      });
    }

    if (text.includes("focused worker agent")) {
      throw new Error("n_keep exceeds context length");
    }

    throw new Error(`Unexpected fake LLM prompt: ${text.slice(0, 160)}`);
  }
}

class CapturingFakeLlm {
  prompts: string[] = [];

  async complete(messages: Message[]): Promise<string> {
    const text = messages.map((message) => message.content).join("\n");
    this.prompts.push(text);

    if (text.includes("Classify this single user task")) {
      return '{"mode":"direct","reason":"date-sensitive request","domains":["time"],"riskLevel":"low"}';
    }
    if (text.includes("Synthesize the final answer")) {
      return "Current-date-aware answer.";
    }
    if (text.includes("Extract one reusable skill-memory entry")) {
      return '{"shouldStore":false}';
    }

    throw new Error(`Unexpected fake LLM prompt: ${text.slice(0, 160)}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usefulPngBuffer(): Buffer {
  const png = new PNG({ width: 360, height: 220 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (png.width * y + x) << 2;
      const stripe = Math.floor(y / 18) % 2 === 0 || Math.floor(x / 48) % 2 === 0;
      png.data[offset] = stripe ? 245 : 35;
      png.data[offset + 1] = stripe ? 248 : 45;
      png.data[offset + 2] = stripe ? 250 : 55;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

test("UniversalAgent answers direct tasks without creating subtasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"direct","reason":"small definition task","domains":["ai"],"riskLevel":"low"}',
    "A universal agent coordinates tools and specialist agents to complete one concrete task.",
    '{"shouldStore":false}',
  ]);
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory);
  const events: AgentEvent[] = [];

  try {
    const result = await agent.run("Define universal agent in one sentence", {
      onEvent: (event) => {
        events.push(event);
      },
    });

    assert.equal(result.complexity.mode, "direct");
    assert.equal(result.subtasks.length, 0);
    assert.match(result.finalAnswer, /coordinates/);
    assert.equal(fakeLlm.callCount, 3);
    const strategyEvent = events.find((event) => event.type === "agent-strategy-selected");
    assert.equal((strategyEvent?.payload as any).primary, "direct_answer");
    assert.deepEqual((strategyEvent?.payload as any).actions, ["self_check_return", "answer_directly"]);
    const invocationEvent = events.find((event) => event.type === "agent-invocation-created");
    assert.equal((invocationEvent?.payload as any).localTask, "Define universal agent in one sentence");
    assert.equal((invocationEvent?.payload as any).outputContract.requiresSelfCheck, true);
    assert.equal((invocationEvent?.payload as any).strategy, "direct_answer");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent injects group and requester context into runtime prompts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new CapturingFakeLlm();
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory);

  try {
    await agent.run("Забронируй столик на вечер", {
      instanceContext: {
        groupProfile: {
          id: "group-local",
          instanceId: "instance-local",
          name: "Family Ops",
          description: "Family living in Spain.",
          preferences: { city: "Malaga", language: "ru" },
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        requesterUser: {
          id: "user-admin",
          displayName: "Admin",
          role: "admin",
          roles: ["admin"],
          identities: [],
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      },
    });

    const joined = fakeLlm.prompts.join("\n\n---\n\n");
    assert.match(joined, /Instance and requester context/);
    assert.match(joined, /Group profile: Family Ops/);
    assert.match(joined, /city: Malaga/);
    assert.match(joined, /Requester: Admin/);
    assert.match(joined, /Use this context as default task context/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent plans council invocation contracts for high-risk broad tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"delegated","reason":"high-stakes decision across domains","domains":["medical","legal","financial"],"riskLevel":"high"}',
    JSON.stringify({
      subtasks: [
        {
          id: "risk",
          title: "Risk summary",
          role: "analyst",
          prompt: "Summarize risks.",
          expectedOutput: "Risk summary.",
          reviewCriteria: ["Risks are explicit"],
        },
      ],
    }),
    "Risk summary output.",
    '{"subtaskId":"risk","verdict":"pass","notes":"Risks are explicit."}',
    "Final high-level answer.",
    '{"shouldStore":false}',
  ]);
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory);
  const events: AgentEvent[] = [];

  try {
    await agent.run("Compare medical, legal, and financial risks and choose a strategy.", {
      onEvent: (event) => {
        events.push(event);
      },
    });

    const strategyEvent = events.find((event) => event.type === "agent-strategy-selected");
    assert.equal((strategyEvent?.payload as any).primary, "council");

    const invocationEvent = events.find((event) => event.type === "agent-invocation-created");
    assert.equal((invocationEvent?.payload as any).outputContract.format, "plan");
    assert.equal((invocationEvent?.payload as any).reviewStrictness, "council");

    const councilEvent = events.find((event) => event.type === "agent-council-planned");
    const councilPayload = councilEvent?.payload as any;
    assert.ok(councilPayload);
    assert.ok(councilPayload.councilInvocations.length >= 3);
    assert.ok(councilPayload.councilInvocations.some((invocation: any) => invocation.modelTier === "XL"));
    assert.ok(
      councilPayload.councilInvocations.every((invocation: any) =>
        invocation.parentInvocationId === councilPayload.rootInvocation.id && invocation.status === "planned",
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent records a tool build request when a required capability is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"direct","reason":"small artifact task","domains":["visualization"],"riskLevel":"low"}',
    "I cannot attach a chart because the tool is missing.",
    '{"shouldStore":false}',
  ]);
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory);
  const requestedBuilds: ToolBuildRequestInput[] = [];
  const events: string[] = [];

  try {
    await agent.run('Построй график по данным {"history":[{"date":"2026-01-01","value":1},{"date":"2026-01-02","value":2}]}', {
      saveArtifact: async (artifact: ArtifactCreateInput): Promise<AgentArtifact> => ({
        id: "artifact-1",
        runId: "run-1",
        kind: "output",
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: 1,
        url: "/artifact",
        createdAt: new Date().toISOString(),
      }),
      requestToolBuild: async (request) => {
        requestedBuilds.push(request);
        return {
          ...request,
          id: "toolbuild-1",
          status: "requested",
          contract: {
            toolName: "generated.chart.generation",
            version: "1.0.0",
            modulePath: "src/tools/generated/chart-generationTool.ts",
            testPath: "tests/generated/chart-generationTool.test.ts",
            capability: request.capability,
            description: "Generated chart tool",
            startupMode: "on-demand",
            inputSchema: { type: "object", properties: {}, required: [] },
            outputSchema: { type: "object", properties: {}, required: [] },
            acceptanceCriteria: ["works"],
            qaCriteria: ["tested"],
            builderInstructions: ["build"],
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    assert.equal(requestedBuilds.length, 1);
    assert.equal(requestedBuilds[0]?.capability, "chart-generation");
    assert.ok(events.includes("tool-missing"));
    assert.ok(events.includes("tool-build-requested"));
    assert.equal(fakeLlm.callCount, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent requests a versioned tool rework when an existing generated artifact tool is insufficient", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"direct","reason":"small artifact task","domains":["visualization"],"riskLevel":"low"}',
    "I tried to attach a chart, but the current tool could not parse the data.",
    '{"shouldStore":false}',
  ]);
  const registry = new ToolRegistry();
  registry.register({
    name: "generated.chart.generation",
    version: "1.0.0",
    description: "Generated chart tool with insufficient behavior.",
    capabilities: ["chart-generation"],
    async run() {
      return { ok: false, content: "Could not parse arbitrary series data." };
    },
  });
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);
  const requestedBuilds: ToolBuildRequestInput[] = [];
  const events: AgentEvent[] = [];

  try {
    await agent.run('Построй график по данным {"series":[{"x":"2026-01-01","y":1}]}', {
      saveArtifact: async (artifact: ArtifactCreateInput): Promise<AgentArtifact> => ({
        id: "artifact-1",
        runId: "run-1",
        kind: "output",
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: 1,
        url: "/artifact",
        createdAt: new Date().toISOString(),
      }),
      requestToolBuild: async (request) => {
        requestedBuilds.push(request);
        return {
          ...request,
          id: "toolbuild-rework-1",
          status: "requested",
          contract: {
            toolName: request.desiredToolName ?? "generated.chart.generation",
            version: "1.1.0",
            modulePath: "src/tools/generated/chart-generation-v1-1-0Tool.ts",
            testPath: "tests/generated/chart-generation-v1-1-0Tool.test.ts",
            capability: request.capability,
            description: "Generated chart tool rework",
            startupMode: "on-demand",
            inputSchema: { type: "object", properties: {}, required: [] },
            outputSchema: { type: "object", properties: {}, required: [] },
            acceptanceCriteria: ["works"],
            qaCriteria: ["tested"],
            builderInstructions: ["build"],
            replacesVersion: request.replacesVersion,
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    assert.equal(requestedBuilds.length, 1);
    assert.equal(requestedBuilds[0]?.capability, "chart-generation");
    assert.equal(requestedBuilds[0]?.desiredToolName, "generated.chart.generation");
    assert.equal(requestedBuilds[0]?.replacesToolName, "generated.chart.generation");
    assert.equal(requestedBuilds[0]?.replacesVersion, "1.0.0");
    assert.match(requestedBuilds[0]?.reason ?? "", /Could not parse arbitrary series data/);
    assert.ok(events.some((event) => event.type === "tool-build-requested" && event.title.includes("Tool rework")));
    assert.equal(fakeLlm.callCount, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent retries an artifact tool once when a reworked version is immediately available", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"direct","reason":"small artifact task","domains":["visualization"],"riskLevel":"low"}',
    "График приложен.",
    '{"shouldStore":false}',
  ]);
  const registry = new ToolRegistry();
  registry.register({
    name: "generated.chart.generation",
    version: "1.0.0",
    description: "Generated chart tool with insufficient behavior.",
    capabilities: ["chart-generation"],
    async run() {
      return { ok: false, content: "Could not parse arbitrary series data." };
    },
  });
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);
  const requestedBuilds: ToolBuildRequestInput[] = [];
  const savedArtifacts: ArtifactCreateInput[] = [];
  const events: AgentEvent[] = [];

  try {
    const result = await agent.run('Построй график по данным {"series":[{"x":"2026-01-01","y":1},{"x":"2026-01-02","y":3}]}', {
      saveArtifact: async (artifact: ArtifactCreateInput): Promise<AgentArtifact> => {
        savedArtifacts.push(artifact);
        return {
          id: `artifact-${savedArtifacts.length}`,
          runId: "run-1",
          kind: "output",
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          sizeBytes: Buffer.byteLength(artifact.content),
          url: `/artifact-${savedArtifacts.length}`,
          createdAt: new Date().toISOString(),
        };
      },
      requestToolBuild: async (request) => {
        requestedBuilds.push(request);
        registry.register({
          name: "generated.chart.generation",
          version: "1.1.0",
          description: "Generated chart tool with corrected behavior.",
          capabilities: ["chart-generation"],
          async run() {
            return {
              ok: true,
              content: "Generated corrected chart.",
              data: {
                artifact: {
                  filename: "corrected-chart.svg",
                  mimeType: "image/svg+xml",
                  content: "<svg><text>corrected</text></svg>",
                },
                points: 2,
              },
            };
          },
        });
        return {
          ...request,
          id: "toolbuild-rework-1",
          status: "registered",
          contract: {
            toolName: request.desiredToolName ?? "generated.chart.generation",
            version: "1.1.0",
            modulePath: "src/tools/generated/chart-generation-v1-1-0Tool.ts",
            testPath: "tests/generated/chart-generation-v1-1-0Tool.test.ts",
            capability: request.capability,
            description: "Generated chart tool rework",
            startupMode: "on-demand",
            inputSchema: { type: "object", properties: {}, required: [] },
            outputSchema: { type: "object", properties: {}, required: [] },
            acceptanceCriteria: ["works"],
            qaCriteria: ["tested"],
            builderInstructions: ["build"],
            replacesVersion: request.replacesVersion,
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    assert.equal(requestedBuilds.length, 1);
    assert.equal(requestedBuilds[0]?.replacesVersion, "1.0.0");
    assert.equal(savedArtifacts.length, 1);
    assert.equal(savedArtifacts[0]?.filename, "corrected-chart.svg");
    assert.equal(result.artifacts?.length, 1);
    assert.ok(events.some((event) => event.title === "Retrying with reworked tool: generated.chart.generation"));
    assert.equal(fakeLlm.callCount, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent records external screenshot blockers without requesting tool rework", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"direct","reason":"small proof task","domains":["browser"],"riskLevel":"low"}',
    "Не удалось получить полезный скриншот: страница показывает внешний blocker.",
    '{"shouldStore":false}',
  ]);
  const registry = new ToolRegistry();
  registry.register({
    name: "generated.browser.screenshot",
    version: "1.0.0",
    description: "Fake generated screenshot tool.",
    capabilities: ["browser-screenshot", "artifact-generation"],
    async run() {
      return {
        ok: true,
        content: "Captured https://www.instagram.com/, page text: Instagram from Meta loading.",
        data: {
          artifact: {
            filename: "proof-instagram.png",
            mimeType: "image/png",
            contentBase64: usefulPngBuffer().toString("base64"),
            description: "Browser screenshot captured from Instagram from Meta loading page.",
          },
          url: "https://www.instagram.com/",
        },
      };
    },
  });
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);
  const requestedBuilds: ToolBuildRequestInput[] = [];
  const events: AgentEvent[] = [];

  try {
    const result = await agent.run("Сделай скриншот доказательства профиля Instagram deadp47: https://www.instagram.com/deadp47/.", {
      saveArtifact: async (artifact: ArtifactCreateInput): Promise<AgentArtifact> => ({
        id: "artifact-should-not-save",
        runId: "run-1",
        kind: "output",
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: 1,
        url: "/artifact",
        createdAt: new Date().toISOString(),
      }),
      requestToolBuild: async (request) => {
        requestedBuilds.push(request);
        throw new Error("external blockers should not create tool rework requests");
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    assert.equal(requestedBuilds.length, 0);
    assert.equal(result.artifacts?.length ?? 0, 0);
    assert.ok(events.some((event) => event.title === "External artifact blocker detected"));
    assert.ok(events.some((event) => event.status === "failed" && /semantic QA/.test(event.title)));
    const blockerMemory = await memory.search("instagram external proof blocker", 5);
    assert.equal(blockerMemory.length, 1);
    assert.equal(blockerMemory[0]?.status, "accepted");
    assert.equal(blockerMemory[0]?.scope, "global");
    assert.match(blockerMemory[0]?.reusableProcedure ?? "", /Do not request a tool rebuild solely/);
    assert.equal(fakeLlm.callCount, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent can use a newly built screenshot tool in the same run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"direct","reason":"small screenshot artifact task","domains":["browser"],"riskLevel":"low"}',
    "Скриншот приложен.",
    '{"shouldStore":false}',
  ]);
  const registry = new ToolRegistry();
  const screenshotTool: Tool = {
    name: "generated.browser.screenshot",
    version: "1.0.0",
    description: "Fake screenshot tool",
    capabilities: ["browser-screenshot", "artifact-generation"],
    startupMode: "on-demand",
    async run() {
      return {
        ok: true,
        content: "Captured screenshot.",
        data: {
          artifact: {
            filename: "page-screenshot.png",
            mimeType: "image/png",
            contentBase64: usefulPngBuffer().toString("base64"),
            description: "fake screenshot",
          },
        },
      };
    },
  };
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);
  const savedArtifacts: ArtifactCreateInput[] = [];
  const events: string[] = [];

  try {
    const result = await agent.run("Сделай скриншот https://example.com страницы", {
      saveArtifact: async (artifact: ArtifactCreateInput): Promise<AgentArtifact> => {
        savedArtifacts.push(artifact);
        return {
          id: "artifact-1",
          runId: "run-1",
          kind: "output",
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          sizeBytes: Buffer.isBuffer(artifact.content) ? artifact.content.byteLength : artifact.content.length,
          url: "/screenshot",
          createdAt: new Date().toISOString(),
        };
      },
      requestToolBuild: async (request) => {
        registry.register(screenshotTool);
        return {
          ...request,
          id: "toolbuild-1",
          status: "registered",
          registeredToolName: screenshotTool.name,
          contract: {
            toolName: screenshotTool.name,
            version: "1.0.0",
            modulePath: "src/tools/generated/browser-screenshotTool.ts",
            testPath: "tests/generated/browser-screenshotTool.test.ts",
            capability: request.capability,
            description: "Generated screenshot tool",
            startupMode: "on-demand",
            inputSchema: { type: "object", properties: {}, required: [] },
            outputSchema: { type: "object", properties: {}, required: [] },
            acceptanceCriteria: ["works"],
            qaCriteria: ["tested"],
            builderInstructions: ["build"],
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    assert.equal(savedArtifacts.length, 1);
    assert.equal(savedArtifacts[0]?.filename, "page-screenshot.png");
    assert.equal(savedArtifacts[0]?.mimeType, "image/png");
    assert.ok(events.includes("tool-build-requested"));
    assert.ok(events.includes("artifact-created"));
    assert.match(result.finalAnswer, /\/screenshot/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent executes required screenshot artifacts inside delegated subtasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"delegated","reason":"needs proof artifact","domains":["browser"],"riskLevel":"medium"}',
    JSON.stringify({
      subtasks: [
        {
          id: "proof",
          title: "Capture proof screenshot",
          role: "browser-operator",
          prompt: "Capture proof from https://example.com and report the saved artifact URL.",
          expectedOutput: "Screenshot artifact URL and short notes.",
          reviewCriteria: ["A real saved screenshot artifact URL is present"],
          requiredTools: ["browser-screenshot"],
          requiredArtifacts: [
            {
              kind: "screenshot",
              capability: "browser-screenshot",
              description: "Proof screenshot",
              required: true,
            },
          ],
        },
      ],
    }),
    "Captured the page and saved proof at /artifacts/proof.png.",
    '{"subtaskId":"proof","verdict":"pass","notes":"Real artifact was created and cited."}',
    "Final answer cites /artifacts/proof.png.",
    '{"shouldStore":false}',
  ]);
  const registry = new ToolRegistry();
  const screenshotInputs: unknown[] = [];
  registry.register({
    name: "browser.screenshot.fake",
    description: "Fake delegated screenshot tool",
    capabilities: ["browser-screenshot"],
    async run(input) {
      screenshotInputs.push(input);
      return {
        ok: true,
        content: "Captured screenshot.",
        data: {
          artifact: {
            filename: "proof.png",
            mimeType: "image/png",
            contentBase64: usefulPngBuffer().toString("base64"),
            description: "Proof screenshot",
          },
        },
      };
    },
  });
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);
  const savedArtifacts: ArtifactCreateInput[] = [];
  const events: string[] = [];

  try {
    const result = await agent.run("Find proof at https://example.com and include a screenshot.", {
      saveArtifact: async (artifact): Promise<AgentArtifact> => {
        savedArtifacts.push(artifact);
        return {
          id: "artifact-1",
          runId: "run-1",
          kind: "output",
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          sizeBytes: Buffer.isBuffer(artifact.content) ? artifact.content.byteLength : artifact.content.length,
          url: "/artifacts/proof.png",
          createdAt: new Date().toISOString(),
        };
      },
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    assert.equal(screenshotInputs.length, 1);
    assert.deepEqual(screenshotInputs[0], { url: "https://example.com", fullPage: true });
    assert.equal(savedArtifacts.length, 1);
    assert.equal(result.workerResults[0]?.artifacts?.[0]?.url, "/artifacts/proof.png");
    assert.equal(result.artifacts?.some((artifact) => artifact.url === "/artifacts/proof.png"), true);
    assert.ok(events.includes("artifact-created"));
    assert.equal(fakeLlm.callCount, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent executes market time-series tools inside delegated subtasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"delegated","reason":"needs structured market data","domains":["market"],"riskLevel":"medium"}',
    JSON.stringify({
      subtasks: [
        {
          id: "market-data",
          title: "Collect BTC market time-series data",
          role: "researcher",
          prompt: "Collect BTC price history.",
          expectedOutput: "Structured BTC market data artifact and trend notes.",
          reviewCriteria: ["Uses real structured market data"],
          requiredTools: ["market-timeseries"],
        },
      ],
    }),
    "BTC market data was collected and saved as /artifacts/bitcoin.csv.",
    '{"subtaskId":"market-data","verdict":"pass","notes":"Structured market data artifact is present."}',
    "Final answer cites /artifacts/bitcoin.csv.",
    '{"shouldStore":false}',
  ]);
  const registry = new ToolRegistry();
  const marketInputs: unknown[] = [];
  registry.register({
    name: "market.timeseries",
    version: "1.0.0",
    description: "Fake market time-series tool",
    capabilities: ["market-timeseries", "crypto-timeseries", "structured-market-data"],
    async run(input) {
      marketInputs.push(input);
      return {
        ok: true,
        content: "Fetched 2 bitcoin/USD points from CoinGecko.",
        data: {
          source: "coingecko",
          symbol: "BTC",
          coinId: "bitcoin",
          vsCurrency: "usd",
          days: 30,
          points: [
            { timestamp: "2026-05-01T00:00:00.000Z", value: 90000 },
            { timestamp: "2026-05-02T00:00:00.000Z", value: 91000 },
          ],
          artifact: {
            filename: "bitcoin-usd-30d-timeseries.csv",
            mimeType: "text/csv",
            content: "timestamp,value\n2026-05-01T00:00:00.000Z,90000\n2026-05-02T00:00:00.000Z,91000\n",
            description: "BTC/USD time-series data from CoinGecko.",
          },
        },
      };
    },
  });
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);
  const savedArtifacts: ArtifactCreateInput[] = [];
  const events: AgentEvent[] = [];

  try {
    const result = await agent.run("Собери BTC market data за 2 дня и дай краткий анализ тренда.", {
      saveArtifact: async (artifact): Promise<AgentArtifact> => {
        savedArtifacts.push(artifact);
        return {
          id: "artifact-market-data",
          runId: "run-1",
          kind: "output",
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          sizeBytes: Buffer.isBuffer(artifact.content) ? artifact.content.byteLength : artifact.content.length,
          url: "/artifacts/bitcoin.csv",
          description: artifact.description,
          createdAt: new Date().toISOString(),
        };
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    assert.equal(marketInputs.length, 1);
    assert.equal((marketInputs[0] as { symbol?: string }).symbol, "BTC");
    assert.equal((marketInputs[0] as { vsCurrency?: string }).vsCurrency, "usd");
    assert.equal((marketInputs[0] as { days?: number }).days, 2);
    assert.equal(savedArtifacts.length, 1);
    assert.equal(savedArtifacts[0]?.filename, "bitcoin-usd-30d-timeseries.csv");
    assert.equal(savedArtifacts[0]?.quality?.checks[0]?.name, "tool-output-contract-qa");
    assert.equal(result.workerResults[0]?.artifacts?.[0]?.url, "/artifacts/bitcoin.csv");
    assert.match(result.workerResults[0]?.toolEvidence?.join("\n") ?? "", /market\.timeseries/);
    assert.ok(events.some((event) => event.type === "tool-completed" && event.actor === "market.timeseries"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent auto-routes AML address requests to registered API JSON tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"direct","reason":"looks like a short lookup","domains":["crypto"],"riskLevel":"low"}',
    JSON.stringify({
      subtasks: [
        {
          id: "aml",
          title: "Lookup wallet AML risk",
          role: "researcher",
          prompt: "Get the AML score for the Ethereum address.",
          expectedOutput: "AML score evidence.",
          reviewCriteria: ["Uses registered tool evidence"],
        },
      ],
    }),
    "AML score evidence: score 42.",
    JSON.stringify({ subtaskId: "aml", verdict: "pass", notes: "Uses tool evidence." }),
    "Final AML answer with score 42.",
    '{"shouldStore":false}',
  ]);
  const registry = new ToolRegistry();
  let capturedInput: Record<string, unknown> | undefined;
  const savedArtifacts: ArtifactCreateInput[] = [];
  registry.register({
    name: "generated.api.gl.aml",
    displayName: "GL AML",
    version: "1.0.0",
    description: "Global Ledger AML score API for wallet address and transaction risk.",
    capabilities: ["api.gl-aml", "api-http-json", "http-api-call"],
    requiredSecretHandles: ["secret.api.gl-aml"],
    async run(input, context) {
      capturedInput = input;
      await context?.artifacts?.saveGenerated({
        filename: "aml-score.json",
        mimeType: "application/json",
        content: JSON.stringify({ score: 42 }),
        description: "AML score evidence payload.",
      });
      return {
        ok: true,
        content: "API call succeeded with HTTP 200; score: 42.",
        data: {
          status: 200,
          url: "https://eth.glprotocol.com/api/report/address/0x9B43b2F8aa3217F3F3947C750d58A50ac24aFfD2",
          provider: "glprotocol",
          score: 42,
          json: { score: 42 },
        },
      };
    },
  });
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);
  const toolEvents: AgentEvent[] = [];

  try {
    const result = await agent.run(
      "Дай амл скор адреса в эфире 0x9B43b2F8aa3217F3F3947C750d58A50ac24aFfD2",
      {
        onEvent: (event) => {
          if (event.activity === "tool") toolEvents.push(event);
        },
        toolExecutionContext: {
          resolveSecret: async (handle) => handle === "secret.api.gl-aml" ? "test-token" : undefined,
        },
        saveArtifact: async (artifact): Promise<AgentArtifact> => {
          savedArtifacts.push(artifact);
          return {
            id: "artifact-aml-score",
            runId: "run-aml",
            kind: "output",
            filename: artifact.filename,
            mimeType: artifact.mimeType,
            sizeBytes: Buffer.isBuffer(artifact.content) ? artifact.content.byteLength : artifact.content.length,
            url: "/artifacts/aml-score.json",
            description: artifact.description,
            createdAt: new Date().toISOString(),
          };
        },
      },
    );

    assert.equal(result.complexity.mode, "delegated");
    assert.equal(capturedInput?.network, "ethereum");
    assert.equal(capturedInput?.address, "0x9B43b2F8aa3217F3F3947C750d58A50ac24aFfD2");
    assert.equal(capturedInput?.secretHandle, "secret.api.gl-aml");
    assert.equal(savedArtifacts.length, 1);
    assert.equal(savedArtifacts[0]?.filename, "aml-score.json");
    assert.equal(savedArtifacts[0]?.mimeType, "application/json");
    assert.ok(toolEvents.some((event) => event.title === "Tool: generated.api.gl.aml" && event.status === "completed"));
    assert.match(result.workerResults[0]?.toolEvidence?.join("\n") ?? "", /Structured tool data/);
    assert.match(result.workerResults[0]?.toolEvidence?.join("\n") ?? "", /score: 42/);
    assert.match(result.finalAnswer, /42/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent executes declared browser operate tool inputs and saves screenshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"delegated","reason":"needs browser operation","domains":["browser"],"riskLevel":"medium"}',
    JSON.stringify({
      subtasks: [
        {
          id: "operate",
          title: "Operate browser and capture proof",
          role: "browser-operator",
          prompt: "Run the declared browser command sequence.",
          expectedOutput: "Extracted text and screenshot artifact URL.",
          reviewCriteria: ["Browser evidence exists"],
          requiredTools: ["browser-operate"],
          toolInputs: {
            "browser.operate": {
              commands: [
                { type: "navigate", url: "https://www.skyscanner.com/routes/agp/ista/malaga-to-istanbul.html" },
                { type: "extractText", label: "page" },
                { type: "screenshot", label: "proof" },
              ],
            },
          },
          requiredArtifacts: [
            {
              kind: "screenshot",
              capability: "browser-screenshot",
              description: "Proof screenshot",
              required: true,
            },
          ],
        },
      ],
    }),
    "Browser evidence says Example Domain and screenshot is /artifacts/browser-proof.png.",
    '{"subtaskId":"operate","verdict":"pass","notes":"Browser evidence exists."}',
    "Final answer cites https://api.runs.example.com/artifacts/browser-proof.png.",
    '{"shouldStore":false}',
  ]);
  const registry = new ToolRegistry();
  const toolInputs: unknown[] = [];
  const toolContexts: unknown[] = [];
  registry.register({
    name: "browser.operate",
    description: "Fake browser operate tool",
    capabilities: ["browser-operate", "browser-screenshot", "artifact-generation"],
    async run(input, context) {
      toolInputs.push(input);
      toolContexts.push(context);
      return {
        ok: true,
        content: "Executed browser commands.",
        data: {
          finalUrl: "https://www.skyscanner.com/routes/agp/ista/malaga-to-istanbul.html",
          title: "Example Domain",
          extractedText: [{ label: "page", text: "Example Domain" }],
          screenshots: [
            {
              filename: "browser-proof.png",
              mimeType: "image/png",
              content: usefulPngBuffer(),
              description:
                "Browser screenshot captured from https://www.skyscanner.com/routes/agp/ista/malaga-to-istanbul.html.",
            },
          ],
          steps: [{ index: 0, type: "navigate", status: "completed", summary: "ok", durationMs: 1 }],
        },
      };
    },
  });
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);
  const savedArtifacts: AgentArtifact[] = [];

  try {
    const result = await agent.run("Use browser operation for proof.", {
      runId: "run-context-test",
      requesterUserId: "user-admin",
      threadId: "thread-context-test",
      saveArtifact: async (artifact): Promise<AgentArtifact> => {
        const saved = {
          id: "artifact-browser-proof",
          runId: "run-1",
          kind: "output" as const,
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          sizeBytes: Buffer.isBuffer(artifact.content) ? artifact.content.byteLength : artifact.content.length,
          url: "/artifacts/browser-proof.png",
          description: artifact.description,
          createdAt: new Date().toISOString(),
        };
        savedArtifacts.push(saved);
        return saved;
      },
    });

    assert.equal(toolInputs.length, 1);
    assert.equal((toolContexts[0] as any).runId, "run-context-test");
    assert.equal((toolContexts[0] as any).requesterUserId, "user-admin");
    assert.equal((toolContexts[0] as any).threadId, "thread-context-test");
    assert.equal((toolContexts[0] as any).toolName, "browser.operate");
    assert.equal(savedArtifacts.length, 1);
    assert.equal(result.workerResults[0]?.artifacts?.[0]?.url, "/artifacts/browser-proof.png");
    assert.match(result.workerResults[0]?.toolEvidence?.join("\n") ?? "", /Example Domain/);
    assert.match(result.finalAnswer, /\/artifacts\/browser-proof\.png/);
    assert.doesNotMatch(result.finalAnswer, /api\.runs\.example\.com/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent stores blocker memory for rejected declared browser screenshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"delegated","reason":"needs browser operation","domains":["browser"],"riskLevel":"medium"}',
    JSON.stringify({
      subtasks: [
        {
          id: "operate",
          title: "Capture blocked provider proof",
          role: "browser-operator",
          prompt: "Capture proof from https://www.instagram.com/deadp47/.",
          expectedOutput: "Useful screenshot evidence or a clear external blocker.",
          reviewCriteria: ["Browser evidence is useful or blocker is explicit"],
          requiredTools: ["browser-operate"],
          toolInputs: {
            "browser.operate": {
              commands: [
                { type: "navigate", url: "https://www.instagram.com/deadp47/" },
                { type: "extractText", label: "page" },
                { type: "screenshot", label: "proof" },
              ],
            },
          },
        },
      ],
    }),
    "Instagram only returned a loading page, so no useful screenshot proof was produced.",
    '{"subtaskId":"operate","verdict":"pass","notes":"The blocker was reported explicitly."}',
    "Final answer reports the external blocker.",
    '{"shouldStore":false}',
  ]);
  const registry = new ToolRegistry();
  registry.register({
    name: "browser.operate",
    description: "Fake browser operate tool",
    capabilities: ["browser-operate", "browser-screenshot", "artifact-generation"],
    async run() {
      return {
        ok: true,
        content: "Executed browser commands. Page text: Instagram from Meta loading.",
        data: {
          finalUrl: "https://www.instagram.com/deadp47/",
          title: "Instagram",
          extractedText: [{ label: "page", text: "Instagram from Meta loading." }],
          screenshots: [
            {
              filename: "instagram-loader.png",
              mimeType: "image/png",
              content: usefulPngBuffer(),
              description: "Browser screenshot captured from https://www.instagram.com/deadp47/. Instagram from Meta loading.",
            },
          ],
          steps: [{ index: 0, type: "navigate", status: "completed", summary: "ok", durationMs: 1 }],
        },
      };
    },
  });
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);
  const events: AgentEvent[] = [];
  const savedArtifacts: ArtifactCreateInput[] = [];

  try {
    const result = await agent.run("Capture provider proof from browser.operate.", {
      onEvent: (event) => {
        events.push(event);
      },
      saveArtifact: async (artifact): Promise<AgentArtifact> => {
        savedArtifacts.push(artifact);
        return {
          id: "artifact-should-not-save",
          runId: "run-1",
          kind: "output",
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          sizeBytes: 1,
          url: "/artifact",
          createdAt: new Date().toISOString(),
        };
      },
    });

    assert.equal(savedArtifacts.length, 0);
    assert.equal(result.workerResults[0]?.artifacts?.length ?? 0, 0);
    assert.ok(events.some((event) => event.title === "External artifact blocker detected"));
    const blockerMemory = await memory.search("instagram external proof blocker browser", 5);
    assert.equal(blockerMemory.length, 1);
    assert.match(blockerMemory[0]?.summary ?? "", /provider returned a blocker or loader/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent collects browser discovery evidence from search URLs for directory-style candidate tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"delegated","reason":"needs directory discovery","domains":["research"],"riskLevel":"medium"}',
    JSON.stringify({
      subtasks: [
        {
          id: "candidates",
          title: "Identify specialist candidates from medical directories",
          role: "researcher",
          prompt: "Find candidate doctors from professional directory profile pages.",
          expectedOutput: "Candidate names with source evidence.",
          reviewCriteria: ["Uses directory source evidence"],
          requiredTools: ["web-search"],
        },
      ],
    }),
    "Candidate Dr Example found in browser-extracted directory evidence.",
    '{"subtaskId":"candidates","verdict":"pass","notes":"Browser directory evidence was used."}',
    "Final answer names Dr Example with source evidence.",
    '{"shouldStore":false}',
  ]);
  const searchInputs: unknown[] = [];
  const browserInputs: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "web.search",
    description: "Fake web search",
    capabilities: ["web-search"],
    async run(input) {
      searchInputs.push(input);
      return {
        ok: true,
        content:
          "1. Specialist directory\nhttps://clinic.example.org/doctors/immunology\nFind specialist doctor profiles and clinic pages.",
      };
    },
  });
  registry.register({
    name: "browser.operate",
    description: "Fake browser extraction",
    capabilities: ["browser-operate", "dom-extraction"],
    async run(input) {
      browserInputs.push(input);
      return {
        ok: true,
        content: "Executed browser extraction.",
        data: {
          finalUrl: "https://clinic.example.org/doctors/immunology",
          title: "Specialist directory",
          extractedText: [{ label: "directory", text: "Dr Example - allergy and immunology specialist" }],
          extractedLinks: [],
          screenshots: [],
          steps: [],
        },
      };
    },
  });
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);

  try {
    const result = await agent.run("Find a specialist from professional directory pages in the Schengen area.");

    assert.match(JSON.stringify(searchInputs), /Schengen Europe/);
    assert.match(JSON.stringify(searchInputs), /Doctolib Jameda OneDoc/);
    assert.equal(browserInputs.length, 1);
    assert.match(JSON.stringify(browserInputs[0]), /clinic\.example\.org/);
    assert.equal(result.reviews[0]?.verdict, "pass");
    assert.equal(fakeLlm.callCount, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent rewrites brittle browser form automation to direct source URLs from search evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const directUrl = "https://www.google.com/travel/flights/flights-from-istanbul-to-malaga.html";
  const kayakUrl = "https://www.kayak.com/flight-routes/Istanbul-IST/Malaga-AGP";
  const fakeLlm = new FakeLlm([
    '{"mode":"delegated","reason":"needs live browser proof","domains":["travel"],"riskLevel":"medium"}',
    JSON.stringify({
      subtasks: [
        {
          id: "flight-data",
          title: "Collect flight proof",
          role: "researcher",
          prompt: "Search Istanbul to Malaga flights and capture screenshot proof.",
          expectedOutput: "Flight price evidence with screenshot.",
          reviewCriteria: ["Real route source was used", "Use at least 2 different aggregators"],
          requiredTools: ["web-search", "browser-operate"],
          toolInputs: {
            "browser.operate": {
              commands: [
                { type: "navigate", url: "https://www.google.com/flights" },
                { type: "type", selector: "[aria-label='Where from?']", text: "Istanbul" },
                { type: "type", selector: "[aria-label='Where to?']", text: "Malaga" },
                { type: "screenshot", label: "proof" },
              ],
            },
          },
          requiredArtifacts: [
            {
              kind: "screenshot",
              capability: "browser-screenshot",
              description: "Flight proof screenshot",
              required: true,
            },
          ],
        },
      ],
    }),
    "Google Flights evidence shows €193 Lufthansa and saved proof /artifacts/flight-proof.png.",
    '{"subtaskId":"flight-data","verdict":"pass","notes":"Direct route source and screenshot were used."}',
    "Final answer cites €193 and /artifacts/flight-proof.png.",
    '{"shouldStore":false}',
  ]);
  const registry = new ToolRegistry();
  const browserInputs: unknown[] = [];
  registry.register({
    name: "web.search",
    description: "Fake web search",
    capabilities: ["web-search"],
    async run() {
      return {
        ok: true,
        content: `Find Cheap Flights from Istanbul to Málaga - Google Flights\n${directUrl}\nUse Google Flights to find cheap flights from Istanbul to Málaga.\n\n$86 CHEAP FLIGHTS from Istanbul to Málaga | KAYAK\n${kayakUrl}\nKAYAK searches hundreds of travel sites.`,
        data: [
          { title: "Google Flights route", url: directUrl },
          { title: "KAYAK route", url: kayakUrl },
        ],
      };
    },
  });
  registry.register({
    name: "browser.operate",
    description: "Fake browser operate",
    capabilities: ["browser-operate", "browser-screenshot", "artifact-generation"],
    async run(input) {
      browserInputs.push(input);
      return {
        ok: true,
        content: "Executed browser commands.",
        data: {
          finalUrl: directUrl,
          title: "Find Cheap Flights from Istanbul to Málaga - Google Flights",
          extractedText: [{ label: "source-page", text: "Cheapest round-trip flights €193 Lufthansa" }],
          extractedLinks: [],
          screenshots: [
            {
              filename: "flight-proof.png",
              mimeType: "image/png",
              content: usefulPngBuffer(),
              description: `Browser screenshot captured from ${directUrl}.`,
            },
          ],
          steps: [{ index: 0, type: "navigate", status: "completed", summary: "ok", durationMs: 1 }],
        },
      };
    },
  });
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);

  try {
    const result = await agent.run("Find Istanbul to Malaga flight proof.", {
      saveArtifact: async (artifact): Promise<AgentArtifact> => ({
        id: "artifact-flight-proof",
        runId: "run-1",
        kind: "output",
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: Buffer.isBuffer(artifact.content) ? artifact.content.byteLength : artifact.content.length,
        url: "/artifacts/flight-proof.png",
        description: artifact.description,
        createdAt: new Date().toISOString(),
      }),
    });

    const browserInput = browserInputs[0] as { commands?: Array<{ type: string; url?: string; selector?: string }> };
    assert.equal(browserInput.commands?.[0]?.url, directUrl);
    assert.equal(browserInput.commands?.some((command) => command.url === kayakUrl), true);
    assert.equal(browserInput.commands?.some((command) => command.selector === "[aria-label='Where from?']"), false);
    assert.match(result.workerResults[0]?.toolEvidence?.join("\n") ?? "", /€193 Lufthansa/);
    assert.equal(result.workerResults[0]?.artifacts?.[0]?.url, "/artifacts/flight-proof.png");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent rewrites placeholder browser navigation to real evidence URLs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const directoryUrl = "https://www.doctolib.de/allergologie/madrid";
  const fakeLlm = new FakeLlm([
    '{"mode":"delegated","reason":"needs direct directory extraction","domains":["research"],"riskLevel":"medium"}',
    JSON.stringify({
      subtasks: [
        {
          id: "directory-extract",
          title: "Extract doctors from a directory",
          role: "researcher",
          prompt: "Use the directory URL from previous evidence and extract profile text.",
          expectedOutput: "Doctor profile evidence from a real source URL.",
          reviewCriteria: ["Uses a real directory URL"],
          requiredTools: ["web-search", "browser-operate"],
          toolInputs: {
            "browser.operate": {
              commands: [
                { type: "navigate", url: "URL_FROM_PREVIOUS_STEP" },
                { type: "extractText", label: "directory" },
                { type: "screenshot", label: "directory-proof" },
              ],
            },
          },
        },
      ],
    }),
    "Directory evidence found Dr Example from the executed browser evidence.",
    '{"subtaskId":"directory-extract","verdict":"pass","notes":"A real directory URL was used."}',
    "Final answer cites Dr Example.",
    '{"shouldStore":false}',
  ]);
  const browserInputs: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "web.search",
    description: "Fake web search",
    capabilities: ["web-search"],
    async run() {
      return {
        ok: true,
        content: `Doctolib allergy specialist directory\n${directoryUrl}\nSpecialist profiles and booking links.`,
      };
    },
  });
  registry.register({
    name: "browser.operate",
    description: "Fake browser extraction",
    capabilities: ["browser-operate", "dom-extraction"],
    async run(input) {
      browserInputs.push(input);
      return {
        ok: true,
        content: "Executed browser extraction.",
        data: {
          finalUrl: directoryUrl,
          title: "Directory",
          extractedText: [{ label: "directory", text: "Dr Example - allergology and immunology" }],
          extractedLinks: [],
          screenshots: [],
          steps: [],
        },
      };
    },
  });
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);

  try {
    await agent.run("Find specialists from the directory URL.");

    const browserInput = browserInputs[0] as { commands?: Array<{ type: string; url?: string }> };
    assert.equal(browserInput.commands?.[0]?.url, directoryUrl);
    assert.doesNotMatch(JSON.stringify(browserInput), /URL_FROM_PREVIOUS_STEP/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent rewrites placeholder browser navigation from dependency outputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const dependencyUrl = "https://www.doctoralia.es/alergologo/madrid";
  const lowValueUrl = "https://medlineplus.gov/directories";
  const fakeLlm = new FakeLlm([
    '{"mode":"delegated","reason":"needs upstream source discovery","domains":["research"],"riskLevel":"medium"}',
    JSON.stringify({
      subtasks: [
        {
          id: "sources",
          title: "Find source directories",
          role: "researcher",
          prompt: "Find professional medical directories.",
          expectedOutput: "Directory source URLs.",
          reviewCriteria: ["Contains real source URLs"],
        },
        {
          id: "profiles",
          title: "Extract profiles from dependency directories",
          role: "researcher",
          prompt: "Use the URL found by sources to extract profile text.",
          expectedOutput: "Profile evidence from dependency URL.",
          reviewCriteria: ["Uses dependency source URL"],
          dependsOn: ["sources"],
          requiredTools: ["web-search", "browser-operate"],
          toolInputs: {
            "browser.operate": {
              commands: [
                { type: "navigate", url: "URL_FROM_PREVIOUS_STEP" },
                { type: "extractText", label: "profiles" },
              ],
            },
          },
        },
      ],
    }),
    `Use Doctoralia as the source directory: ${dependencyUrl}`,
    '{"subtaskId":"sources","verdict":"pass","notes":"Source URL is concrete."}',
    "Profile evidence found from dependency browser extraction.",
    '{"subtaskId":"profiles","verdict":"pass","notes":"Dependency URL was executed."}',
    "Final answer cites the dependency URL.",
    '{"shouldStore":false}',
  ]);
  const browserInputs: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "web.search",
    description: "Fake web search with a lower-value URL",
    capabilities: ["web-search"],
    async run() {
      return {
        ok: true,
        content: `General medical directory\n${lowValueUrl}\nNot a profile source.`,
      };
    },
  });
  registry.register({
    name: "browser.operate",
    description: "Fake browser extraction",
    capabilities: ["browser-operate", "dom-extraction"],
    async run(input) {
      browserInputs.push(input);
      return {
        ok: true,
        content: "Executed dependency URL extraction.",
        data: {
          finalUrl: dependencyUrl,
          title: "Doctoralia Madrid",
          extractedText: [{ label: "profiles", text: "Doctor profile text" }],
          extractedLinks: [],
          screenshots: [],
          steps: [],
        },
      };
    },
  });
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);

  try {
    await agent.run("Find specialist profiles from previously identified directories.");

    const serializedInputs = JSON.stringify(browserInputs);
    assert.match(serializedInputs, /doctoralia\.es\/alergologo\/madrid/);
    assert.doesNotMatch(serializedInputs, /URL_FROM_PREVIOUS_STEP/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent hard-fails artifact subtasks that only invent placeholder proof", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"delegated","reason":"needs proof artifact","domains":["browser"],"riskLevel":"medium"}',
    JSON.stringify({
      subtasks: [
        {
          id: "proof",
          title: "Capture proof screenshot",
          role: "browser-operator",
          prompt: "Capture proof from the source page.",
          expectedOutput: "Screenshot artifact URL.",
          reviewCriteria: ["A real saved screenshot artifact URL is present"],
          requiredArtifacts: [
            {
              kind: "screenshot",
              capability: "browser-screenshot",
              description: "Proof screenshot",
              required: true,
            },
          ],
        },
      ],
    }),
    "Screenshot saved as https://screenshot-capture.placeholder/image.png.",
    "Revised output still only has screenshot.png.",
    "Final answer explains proof could not be verified.",
    '{"shouldStore":false}',
  ]);
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory);
  const reviewStatuses: string[] = [];

  try {
    const result = await agent.run("Return a proof screenshot, but no URL is available.", {
      onEvent: (event) => {
        if (event.type === "review-completed") {
          reviewStatuses.push(`${event.status}:${event.detail}`);
        }
      },
    });

    assert.equal(result.reviews.length, 2);
    assert.equal(result.reviews[0]?.verdict, "needs_revision");
    assert.match(result.reviews[0]?.notes ?? "", /Missing required real artifact/);
    assert.equal(result.reviews[1]?.verdict, "needs_revision");
    assert.equal(reviewStatuses.every((status) => status.startsWith("failed:")), true);
    assert.equal(fakeLlm.callCount, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent hard-fails irrelevant proof artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"delegated","reason":"needs proof artifact","domains":["travel"],"riskLevel":"medium"}',
    JSON.stringify({
      subtasks: [
        {
          id: "proof",
          title: "Capture travel proof screenshot",
          role: "researcher",
          prompt: "Capture proof from https://hai.stanford.edu/assets/files/ai_index_report_2026.pdf.",
          expectedOutput: "A relevant travel screenshot artifact URL.",
          reviewCriteria: ["Screenshot is relevant to the travel source"],
          requiredArtifacts: [
            {
              kind: "screenshot",
              capability: "browser-screenshot",
              description: "Travel proof screenshot",
              required: true,
            },
          ],
        },
      ],
    }),
    "Proof saved.",
    "Still proof saved.",
    "Final answer says proof was not valid.",
    '{"shouldStore":false}',
  ]);
  const registry = new ToolRegistry();
  registry.register({
    name: "browser.screenshot.fake",
    description: "Fake irrelevant screenshot tool",
    capabilities: ["browser-screenshot"],
    async run() {
      return {
        ok: true,
        content: "Captured screenshot.",
        data: {
          artifact: {
            filename: "ai-index-report-2026-pdf-screenshot.png",
            mimeType: "image/png",
            contentBase64: usefulPngBuffer().toString("base64"),
            description:
              "Browser screenshot captured from https://hai.stanford.edu/assets/files/ai_index_report_2026.pdf",
          },
        },
      };
    },
  });
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);

  try {
    const result = await agent.run("Find a flight and provide a relevant screenshot proof.", {
      saveArtifact: async (artifact): Promise<AgentArtifact> => ({
        id: `artifact-${artifact.filename}`,
        runId: "run-1",
        kind: "output",
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: Buffer.isBuffer(artifact.content) ? artifact.content.byteLength : artifact.content.length,
        url: `/artifacts/${artifact.filename}`,
        description: artifact.description,
        createdAt: new Date().toISOString(),
      }),
    });

    assert.equal(result.reviews.length, 2);
    assert.equal(result.reviews[0]?.verdict, "needs_revision");
    assert.match(result.reviews[0]?.notes ?? "", /not relevant/);
    assert.equal(result.artifacts?.length ?? 0, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent rejects unexecuted model tool-call syntax", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"delegated","reason":"needs runtime evidence","domains":["browser"],"riskLevel":"medium"}',
    JSON.stringify({
      subtasks: [
        {
          id: "browse",
          title: "Use source page",
          role: "researcher",
          prompt: "Use the available source evidence.",
          expectedOutput: "Source summary.",
          reviewCriteria: ["No fake tool calls"],
        },
      ],
    }),
    '<|tool_call>call:browser:navigate{url: "https://example.com"}<tool_call|>',
    "Revised answer based on provided evidence.",
    '{"subtaskId":"browse","verdict":"pass","notes":"No fake tool calls remain."}',
    "Final answer uses revised evidence.",
    '{"shouldStore":false}',
  ]);
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory);

  try {
    const result = await agent.run("Summarize a source without fake browser calls");

    assert.equal(result.reviews.length, 2);
    assert.equal(result.reviews[0]?.verdict, "needs_revision");
    assert.match(result.reviews[0]?.notes ?? "", /unexecuted tool-call/);
    assert.equal(result.workerResults[0]?.output, "Revised answer based on provided evidence.");
    assert.equal(fakeLlm.callCount, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent hard-fails empty discovery results before accepting a research subtask", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"delegated","reason":"needs candidate discovery","domains":["research"],"riskLevel":"medium"}',
    JSON.stringify({
      subtasks: [
        {
          id: "candidates",
          title: "Find suitable specialist candidates",
          role: "researcher",
          prompt: "Search for suitable doctors and collect candidates with sources.",
          expectedOutput: "A list of candidate doctors with source evidence.",
          reviewCriteria: ["Has at least one candidate or a well-evidenced external blocker"],
        },
      ],
    }),
    "No candidates found. Search returned no useful results.",
    "Retried alternative source directories and direct URLs; provider pages are blocked, so no useful candidates can be produced from available evidence.",
    '{"subtaskId":"candidates","verdict":"pass","notes":"The revised output describes the recovery attempt and blocker."}',
    "Final answer reports the blocker and asks for a preferred source or location radius.",
    '{"shouldStore":false}',
  ]);
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory);

  try {
    const result = await agent.run("Find a suitable specialist and explain the evidence.");

    assert.equal(result.reviews.length, 2);
    assert.equal(result.reviews[0]?.verdict, "needs_revision");
    assert.match(result.reviews[0]?.notes ?? "", /expected discovery/i);
    assert.equal(
      result.workerResults[0]?.output,
      "Retried alternative source directories and direct URLs; provider pages are blocked, so no useful candidates can be produced from available evidence.",
    );
    assert.equal(fakeLlm.callCount, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent reuses dependency artifacts instead of recreating proof in downstream subtasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"delegated","reason":"needs proof and final report","domains":["browser"],"riskLevel":"medium"}',
    JSON.stringify({
      subtasks: [
        {
          id: "proof",
          title: "Capture screenshot proof",
          role: "researcher",
          prompt: "Capture screenshot proof from https://example.com.",
          expectedOutput: "A screenshot artifact URL.",
          reviewCriteria: ["Has screenshot"],
          requiredArtifacts: [
            {
              kind: "screenshot",
              capability: "browser-screenshot",
              description: "Proof screenshot",
              required: true,
            },
          ],
        },
        {
          id: "final",
          title: "Synthesize final report",
          role: "analyst",
          prompt: "Use the provided screenshot proof in the final response.",
          expectedOutput: "Final response with screenshot proof.",
          reviewCriteria: ["Uses inherited screenshot"],
          dependsOn: ["proof"],
          requiredArtifacts: [
            {
              kind: "screenshot",
              capability: "browser-screenshot",
              description: "Existing proof screenshot",
              required: true,
            },
          ],
        },
      ],
    }),
    "Proof created at /artifacts/proof.png.",
    '{"subtaskId":"proof","verdict":"pass","notes":"Proof exists."}',
    "Final response reuses /artifacts/proof.png.",
    '{"subtaskId":"final","verdict":"pass","notes":"Inherited proof was used."}',
    "Final answer with /artifacts/proof.png.",
    '{"shouldStore":false}',
  ]);
  const registry = new ToolRegistry();
  const screenshotInputs: unknown[] = [];
  registry.register({
    name: "browser.screenshot.fake",
    description: "Fake screenshot tool",
    capabilities: ["browser-screenshot"],
    async run(input) {
      screenshotInputs.push(input);
      return {
        ok: true,
        content: "Captured screenshot.",
        data: {
          artifact: {
            filename: "proof.png",
            mimeType: "image/png",
            contentBase64: usefulPngBuffer().toString("base64"),
            description: "Proof screenshot",
          },
        },
      };
    },
  });
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);

  try {
    const result = await agent.run("Capture proof and then write a final response.", {
      saveArtifact: async (artifact): Promise<AgentArtifact> => ({
        id: "artifact-1",
        runId: "run-1",
        kind: "output",
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: Buffer.isBuffer(artifact.content) ? artifact.content.byteLength : artifact.content.length,
        url: "/artifacts/proof.png",
        createdAt: new Date().toISOString(),
      }),
    });

    assert.equal(screenshotInputs.length, 1);
    assert.equal(result.workerResults[1]?.artifacts?.[0]?.url, "/artifacts/proof.png");
    assert.equal(result.artifacts?.length, 1);
    assert.equal(fakeLlm.callCount, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent delegates, reviews, synthesizes, and stores a learned skill", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"delegated","reason":"research and implementation are separate domains","domains":["research","coding"],"riskLevel":"medium"}',
    JSON.stringify({
      subtasks: [
        {
          id: "research",
          title: "Research mapping",
          role: "researcher",
          prompt: "Map chess pieces to crypto ranks.",
          expectedOutput: "A ranked mapping.",
          reviewCriteria: ["Mapping is explicit"],
        },
        {
          id: "code",
          title: "Implement prototype",
          role: "engineer",
          prompt: "Describe implementation plan.",
          expectedOutput: "Implementation outline.",
          reviewCriteria: ["Plan is testable"],
        },
      ],
    }),
    "Research result: BTC king, ETH queen.",
    "Code result: implement mapping as typed config.",
    '{"subtaskId":"research","verdict":"pass","notes":"Mapping is explicit."}',
    '{"subtaskId":"code","verdict":"pass","notes":"Plan is testable."}',
    "Final synthesized answer with reviewed crypto chess plan.",
    JSON.stringify({
      shouldStore: true,
      title: "Delegate mixed research and coding tasks",
      tags: ["delegation", "research", "coding"],
      summary: "Split volatile research from implementation work.",
      reusableProcedure: "Create independent research and engineering subtasks, then review both before synthesis.",
    }),
  ]);
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory);
  const events: Array<{ type: string; spanId: string; parentSpanId?: string; title: string }> = [];

  try {
    const result = await agent.run("Build crypto chess", {
      onEvent: (event) => {
        events.push({
          type: event.type,
          spanId: event.spanId,
          parentSpanId: event.parentSpanId,
          title: event.title,
        });
      },
    });
    const storedMemories = await memory.list();
    const runEvent = events.find((event) => event.type === "run-started");
    const planningEvent = events.find((event) => event.type === "planning-completed");
    const workerEvent = events.find(
      (event) => event.type === "worker-completed" && event.title.includes("Research mapping"),
    );
    const reviewEvent = events.find(
      (event) => event.type === "review-completed" && event.title.includes("Research mapping"),
    );

    assert.equal(result.complexity.mode, "delegated");
    assert.equal(result.subtasks.length, 2);
    assert.equal(result.workerResults.length, 2);
    assert.equal(result.reviews.length, 2);
    assert.equal(result.learnedSkill?.title, "Delegate mixed research and coding tasks");
    assert.equal(storedMemories.length, 1);
    assert.equal(fakeLlm.callCount, 8);
    assert.equal(planningEvent?.parentSpanId, runEvent?.spanId);
    assert.equal(workerEvent?.parentSpanId, planningEvent?.spanId);
    assert.equal(reviewEvent?.parentSpanId, workerEvent?.spanId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent classifies learned memories into scoped reviewable facts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"direct","reason":"profile note can be answered directly","domains":["memory"],"riskLevel":"low"}',
    "Final answer with a personal preference.",
    JSON.stringify({
      shouldStore: true,
      title: "User prefers concise Spanish pharmacy answers",
      tags: ["preference", "pharmacy"],
      summary: "The requester prefers concise answers when asking about Spanish pharmacy logistics.",
      reusableProcedure: "For this user, keep Spanish pharmacy answers brief and practical.",
      scope: "user",
      status: "accepted",
      confidence: 0.86,
      sensitivity: "sensitive",
      evidence: ["The run answer used a concise pharmacy format."],
    }),
  ]);
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory);

  try {
    const result = await agent.run("Запомни, что я хочу короткие ответы про аптеки", {
      runId: "run-memory-1",
      requesterUserId: "user-dima",
      instanceId: "group-family",
      threadId: "thread-memory-1",
    });
    const stored = await memory.list({ includeArchived: true });

    assert.equal(result.learnedSkill?.scope, "user");
    assert.equal(result.learnedSkill?.scopeId, "user-dima");
    assert.equal(result.learnedSkill?.status, "proposed");
    assert.equal(result.learnedSkill?.sensitivity, "sensitive");
    assert.equal(result.learnedSkill?.sourceRunId, "run-memory-1");
    assert.equal(result.learnedSkill?.sourceThreadId, "thread-memory-1");
    assert.equal(stored[0]?.evidence?.some((item) => item.includes("Task:")), true);
    assert.equal(fakeLlm.callCount, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent keeps low-confidence learned memories in review even when global", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"direct","reason":"small answer","domains":["memory"],"riskLevel":"low"}',
    "Final answer with a weak reusable lesson.",
    JSON.stringify({
      shouldStore: true,
      title: "Weak source lesson",
      tags: ["review"],
      summary: "A weakly supported lesson should not become accepted automatically.",
      reusableProcedure: "Only accept this lesson after evidence review.",
      scope: "global",
      status: "accepted",
      confidence: 0.3,
      sensitivity: "normal",
    }),
  ]);
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory);

  try {
    const result = await agent.run("Remember this maybe", { runId: "run-low-confidence-memory" });

    assert.equal(result.learnedSkill?.scope, "global");
    assert.equal(result.learnedSkill?.status, "proposed");
    assert.equal(result.learnedSkill?.confidence, 0.3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent retrieves accepted scoped memories for similar repeated tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  await memory.add({
    title: "Spanish pharmacy source preference",
    tags: ["pharmacy", "spain", "aemps"],
    summary: "The family prefers Spanish pharmacy and AEMPS sources for medication logistics.",
    reusableProcedure: "For Spanish pharmacy questions, prefer AEMPS and Spanish pharmacy evidence first.",
    scope: "group",
    scopeId: "group-family",
    status: "accepted",
    confidence: 0.92,
  });
  await memory.add({
    title: "Other group pharmacy preference",
    tags: ["pharmacy", "company"],
    summary: "A different group prefers internal procurement sources.",
    reusableProcedure: "Use private procurement portals.",
    scope: "group",
    scopeId: "group-company",
    status: "accepted",
    confidence: 0.9,
  });
  const fakeLlm = new CapturingFakeLlm();
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory);
  const events: AgentEvent[] = [];

  try {
    await agent.run("Подбери Spanish pharmacy sources for a medicine answer", {
      instanceId: "group-family",
      requesterUserId: "user-dima",
      memoryScopes: [
        { scope: "global" },
        { scope: "group", scopeId: "group-family" },
        { scope: "user", scopeId: "user-dima" },
      ],
      onEvent: (event) => {
        events.push(event);
      },
    });

    const memoryEvent = events.find((event) => event.type === "memory-search-completed");
    const retrieved = memoryEvent?.payload as Array<{ title: string }> | undefined;

    assert.equal(memoryEvent?.detail, "1 relevant memories found");
    assert.equal(retrieved?.[0]?.title, "Spanish pharmacy source preference");
    assert.match(fakeLlm.prompts[0] ?? "", /Spanish pharmacy source preference/);
    assert.match(fakeLlm.prompts[1] ?? "", /AEMPS and Spanish pharmacy evidence first/);
    assert.doesNotMatch(fakeLlm.prompts.join("\n"), /Other group pharmacy preference/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent applies memory policy before prompt injection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  await memory.add({
    title: "Sensitive pharmacy preference",
    tags: ["pharmacy", "spain"],
    summary: "The family has a sensitive pharmacy preference.",
    reusableProcedure: "Only use this preference when sensitive memory is explicitly allowed.",
    scope: "group",
    scopeId: "group-family",
    status: "accepted",
    confidence: 0.95,
    sensitivity: "sensitive",
  });
  await memory.add({
    title: "Normal pharmacy preference",
    tags: ["pharmacy", "spain"],
    summary: "The family prefers official Spanish medicine sources.",
    reusableProcedure: "Prefer AEMPS and official Spanish sources first.",
    scope: "group",
    scopeId: "group-family",
    status: "accepted",
    confidence: 0.9,
    sensitivity: "normal",
  });
  const fakeLlm = new CapturingFakeLlm();
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory);
  const events: AgentEvent[] = [];

  try {
    await agent.run("pharmacy spain preference", {
      instanceId: "group-family",
      requesterUserId: "user-dima",
      memoryScopes: [{ scope: "global" }, { scope: "group", scopeId: "group-family" }],
      onEvent: (event) => {
        events.push(event);
      },
    });

    const memoryEvent = events.find((event) => event.type === "memory-search-completed");
    const retrieved = memoryEvent?.payload as Array<{ title: string }> | undefined;

    assert.equal(memoryEvent?.detail, "1 relevant memories found; 1 blocked by memory policy");
    assert.deepEqual(retrieved?.map((item) => item.title), ["Normal pharmacy preference"]);
    assert.doesNotMatch(fakeLlm.prompts.join("\n"), /Sensitive pharmacy preference/);
    assert.match(fakeLlm.prompts.join("\n"), /Normal pharmacy preference/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent can inject sensitive memory with explicit runtime grant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  await memory.add({
    title: "Sensitive pharmacy preference",
    tags: ["pharmacy", "spain"],
    summary: "The family has a sensitive pharmacy preference.",
    reusableProcedure: "Use the sensitive preference when the run policy allows it.",
    scope: "group",
    scopeId: "group-family",
    status: "accepted",
    confidence: 0.95,
    sensitivity: "sensitive",
  });
  const fakeLlm = new CapturingFakeLlm();
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory);
  const events: AgentEvent[] = [];

  try {
    await agent.run("pharmacy spain preference", {
      instanceId: "group-family",
      requesterUserId: "user-dima",
      memoryScopes: [{ scope: "global" }, { scope: "group", scopeId: "group-family" }],
      allowSensitiveMemory: true,
      onEvent: (event) => {
        events.push(event);
      },
    });

    const memoryEvent = events.find((event) => event.type === "memory-search-completed");
    const retrieved = memoryEvent?.payload as Array<{ title: string }> | undefined;

    assert.equal(memoryEvent?.detail, "1 relevant memories found");
    assert.deepEqual(retrieved?.map((item) => item.title), ["Sensitive pharmacy preference"]);
    assert.match(fakeLlm.prompts.join("\n"), /Sensitive pharmacy preference/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent emits observable lifecycle events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"direct","reason":"small definition task","domains":["ai"],"riskLevel":"low"}',
    "Direct answer.",
    '{"shouldStore":false}',
  ]);
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory);
  const events: Array<{
    type: string;
    spanId: string;
    actor: string;
    activity: string;
    status: string;
    durationMs?: number;
  }> = [];

  try {
    await agent.run("Define universal agent", {
      onEvent: (event) => {
        events.push({
          type: event.type,
          spanId: event.spanId,
          actor: event.actor,
          activity: event.activity,
          status: event.status,
          durationMs: event.durationMs,
        });
      },
    });

    assert.deepEqual(events.map((event) => event.type), [
      "run-started",
      "memory-search-completed",
      "classification-completed",
      "agent-strategy-selected",
      "agent-invocation-created",
      "synthesis-started",
      "synthesis-completed",
      "learning-completed",
      "run-completed",
    ]);
    assert.ok(events.every((event) => event.spanId.length > 0));
    assert.ok(events.every((event) => event.actor.length > 0));
    assert.ok(events.every((event) => event.activity.length > 0));
    assert.equal(events.at(-1)?.status, "completed");
    assert.equal(typeof events.find((event) => event.type === "classification-completed")?.durationMs, "number");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent injects current date and timezone into model context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new CapturingFakeLlm();
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory);

  try {
    await agent.run("Are flights in May 2026 already bookable?", {
      now: new Date("2026-05-02T10:30:00.000Z"),
      timeZone: "Europe/Madrid",
    });

    assert.match(fakeLlm.prompts[0] ?? "", /Current date: 2026-05-02/);
    assert.match(fakeLlm.prompts[0] ?? "", /Time zone: Europe\/Madrid/);
    assert.match(fakeLlm.prompts[1] ?? "", /Never recommend checking in a month\/year that is already in the past/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent starts each review as soon as its worker finishes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const agent = new UniversalAgent(new RoutingFakeLlm() as unknown as LlmClient, memory);
  const events: string[] = [];

  try {
    await agent.run("Run fast and slow branches", {
      onEvent: (event) => {
        events.push(`${event.type}:${event.title}`);
      },
    });

    const fastReviewStarted = events.findIndex(
      (event) => event === "review-started:Review: Fast branch",
    );
    const slowWorkerCompleted = events.findIndex(
      (event) => event === "worker-completed:Worker: Slow branch",
    );

    assert.ok(fastReviewStarted > -1);
    assert.ok(slowWorkerCompleted > -1);
    assert.ok(fastReviewStarted < slowWorkerCompleted);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent emits a failed worker span when a worker LLM call fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const agent = new UniversalAgent(new WorkerFailingLlm() as unknown as LlmClient, memory);
  const events: AgentEvent[] = [];

  try {
    await assert.rejects(
      () =>
        agent.run("Trigger a delegated worker failure", {
          onEvent: (event) => {
            events.push(event);
          },
        }),
      /n_keep exceeds context length/,
    );

    const failedWorker = events.find((event) => event.type === "worker-failed");
    assert.equal(failedWorker?.status, "failed");
    assert.match(failedWorker?.detail ?? "", /n_keep exceeds context length/);
    assert.equal(events.some((event) => event.type === "review-started"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent respects subtask dependencies and passes reviewed outputs forward", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new DependencyFakeLlm();
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory);
  const events: Array<{ type: string; title: string; spanId: string; parentSpanId?: string; payload?: unknown }> = [];

  try {
    const result = await agent.run("Run dependent branches", {
      onEvent: (event) => {
        events.push({
          type: event.type,
          title: event.title,
          spanId: event.spanId,
          parentSpanId: event.parentSpanId,
          payload: event.payload,
        });
      },
    });

    const sourceReviewCompleted = events.findIndex(
      (event) => event.type === "review-completed" && event.title === "Review: Collect source evidence",
    );
    const dependentWorkerStarted = events.findIndex(
      (event) => event.type === "worker-started" && event.title === "Worker: Use reviewed evidence",
    );
    const sourceWorkerCompleted = events.find(
      (event) => event.type === "worker-completed" && event.title === "Worker: Collect source evidence",
    );
    const dependentWorkerCompleted = events.find(
      (event) => event.type === "worker-completed" && event.title === "Worker: Use reviewed evidence",
    );
    const dependentPayload = dependentWorkerCompleted?.payload as { dependencySpanIds?: string[] } | undefined;

    assert.equal(result.subtasks[1]?.dependsOn?.[0], "source");
    assert.ok(sourceReviewCompleted > -1);
    assert.ok(dependentWorkerStarted > sourceReviewCompleted);
    assert.equal(dependentWorkerCompleted?.parentSpanId, sourceWorkerCompleted?.spanId);
    assert.deepEqual(dependentPayload?.dependencySpanIds, [sourceWorkerCompleted?.spanId]);
    assert.match(fakeLlm.dependentWorkerPrompt, /Dependency results from earlier reviewed agents/);
    assert.match(fakeLlm.dependentWorkerPrompt, /Source worker result/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent persists worker and reviewer call frames with return self-checks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"delegated","reason":"requires checked work","domains":["research"],"riskLevel":"medium"}',
    JSON.stringify({
      subtasks: [
        {
          id: "research",
          title: "Research answer",
          role: "researcher",
          prompt: "Produce a checked answer.",
          expectedOutput: "A complete answer.",
          reviewCriteria: ["No missing evidence"],
        },
      ],
    }),
    "Checked worker answer.",
    '{"subtaskId":"research","verdict":"pass","notes":"Worker answer is complete."}',
    "Final answer uses checked work.",
    '{"shouldStore":false}',
  ]);
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory);
  const events: AgentEvent[] = [];

  try {
    await agent.run("Research with self-check frames", {
      onEvent: (event) => {
        events.push(event);
      },
      toolExecutionContext: {
        runId: "run-self-check",
      },
    });

    const workerStarted = events.find((event) => event.type === "worker-started");
    const workerCompleted = events.find((event) => event.type === "worker-completed");
    const reviewCompleted = events.find((event) => event.type === "review-completed");
    const selfChecks = events.filter((event) => event.type === "agent-self-check-completed");

    assert.equal(selfChecks.length, 2);
    assert.equal(workerStarted?.spanId, workerCompleted?.spanId);
    assert.equal(
      ((workerStarted?.payload as { callFrame?: { id?: string; runId?: string; localTask?: string } } | undefined)
        ?.callFrame?.runId),
      "run-self-check",
    );
    assert.match(
      ((workerStarted?.payload as { callFrame?: { localTask?: string } } | undefined)?.callFrame?.localTask) ?? "",
      /Produce a checked answer/,
    );
    assert.equal(
      ((workerCompleted?.payload as { callFrame?: { status?: string }; selfCheck?: { readyToReturn?: boolean } } | undefined)
        ?.callFrame?.status),
      "completed",
    );
    assert.equal(
      ((workerCompleted?.payload as { selfCheck?: { readyToReturn?: boolean } } | undefined)?.selfCheck
        ?.readyToReturn),
      true,
    );
    assert.equal(selfChecks[0]?.parentSpanId, workerStarted?.spanId);
    assert.equal(
      ((reviewCompleted?.payload as { callFrame?: { parentFrameId?: string }; selfCheck?: { readyToReturn?: boolean } } | undefined)
        ?.selfCheck?.readyToReturn),
      true,
    );
    assert.equal(
      ((reviewCompleted?.payload as { callFrame?: { parentFrameId?: string } } | undefined)?.callFrame
        ?.parentFrameId),
      `frame_${workerCompleted?.spanId}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent revises failed worker output before synthesis", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"delegated","reason":"requires checked work","domains":["research"],"riskLevel":"medium"}',
    JSON.stringify({
      subtasks: [
        {
          id: "research",
          title: "Research answer",
          role: "researcher",
          prompt: "Produce a checked answer.",
          expectedOutput: "A complete answer.",
          reviewCriteria: ["No missing evidence"],
        },
      ],
    }),
    "Initial answer with a gap.",
    '{"subtaskId":"research","verdict":"needs_revision","notes":"Add the missing evidence before returning."}',
    "Revised answer with evidence.",
    '{"subtaskId":"research","verdict":"pass","notes":"Revision fixed the missing evidence."}',
    "Final answer uses the revised evidence.",
    '{"shouldStore":false}',
  ]);
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory);
  const events: Array<{ type: string; title: string; spanId: string; parentSpanId?: string; status: string }> = [];

  try {
    const result = await agent.run("Research with a mandatory review loop", {
      onEvent: (event) => {
        events.push({
          type: event.type,
          title: event.title,
          spanId: event.spanId,
          parentSpanId: event.parentSpanId,
          status: event.status,
        });
      },
    });

    const initialWorker = events.find(
      (event) => event.type === "worker-completed" && event.title === "Worker: Research answer",
    );
    const failedReview = events.find(
      (event) => event.type === "review-completed" && event.status === "failed",
    );
    const revisedWorker = events.find(
      (event) => event.type === "worker-completed" && event.title === "Worker revision: Research answer",
    );
    const passedReview = events.find(
      (event) => event.type === "review-completed" && event.status === "completed",
    );

    assert.equal(result.workerResults.length, 1);
    assert.equal(result.workerResults[0]?.output, "Revised answer with evidence.");
    assert.equal(result.reviews.length, 2);
    assert.equal(result.reviews[0]?.verdict, "needs_revision");
    assert.equal(result.reviews[1]?.verdict, "pass");
    assert.equal(fakeLlm.callCount, 8);
    assert.equal(failedReview?.parentSpanId, initialWorker?.spanId);
    assert.equal(revisedWorker?.parentSpanId, initialWorker?.spanId);
    assert.equal(passedReview?.parentSpanId, revisedWorker?.spanId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent rejects weak browser artifact evidence before synthesis", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"delegated","reason":"requires proof artifact","domains":["browser"],"riskLevel":"medium"}',
    JSON.stringify({
      subtasks: [
        {
          id: "proof",
          title: "Capture proof",
          role: "browser-operator",
          prompt: "Capture a useful screenshot proof from https://example.com.",
          expectedOutput: "Useful screenshot evidence or a clear blocker.",
          reviewCriteria: ["Screenshot is useful proof"],
          requiredTools: ["browser-screenshot"],
          requiredArtifacts: [
            {
              kind: "screenshot",
              capability: "browser-screenshot",
              description: "Useful proof screenshot",
              required: true,
            },
          ],
        },
      ],
    }),
    "Screenshot artifact /artifacts/proof.png is only a loading screen, so it is weak browser proof.",
    "Retried another source and confirmed useful proof cannot be produced from available pages.",
    "Final answer states the screenshot blocker plainly.",
    '{"shouldStore":false}',
  ]);
  const registry = new ToolRegistry();
  registry.register({
    name: "browser.screenshot.fake",
    description: "Fake screenshot tool",
    capabilities: ["browser-screenshot"],
    async run() {
      return {
        ok: true,
        content: "Captured a screenshot, but the page only showed a loading screen.",
        data: {
          artifact: {
            filename: "proof.png",
            mimeType: "image/png",
            contentBase64: usefulPngBuffer().toString("base64"),
            description: "Screenshot artifact shows only a loading screen.",
          },
        },
      };
    },
  });
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);
  const events: AgentEvent[] = [];

  try {
    const result = await agent.run("Capture screenshot proof, but reject loading screens.", {
      onEvent: (event) => {
        events.push(event);
      },
      saveArtifact: async (artifact): Promise<AgentArtifact> => ({
        id: "artifact-proof",
        runId: "run-1",
        kind: "output",
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: Buffer.isBuffer(artifact.content) ? artifact.content.byteLength : artifact.content.length,
        url: "/artifacts/proof.png",
        description: artifact.description,
        createdAt: new Date().toISOString(),
      }),
    });

    assert.equal(result.workerResults[0]?.output, "Retried another source and confirmed useful proof cannot be produced from available pages.");
    assert.equal(result.reviews[0]?.verdict, "needs_revision");
    assert.match(result.reviews[0]?.notes ?? "", /Missing required real artifact/);
    assert.equal(result.reviews[1]?.verdict, "needs_revision");
    assert.equal(result.artifacts?.length ?? 0, 0);
    assert.ok(events.some((event) => event.status === "failed" && /semantic QA/.test(event.title)));
    assert.equal(fakeLlm.callCount, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent uses ToolImprovementCoordinator to open a rework wait when a generated artifact tool is insufficient", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-run-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const fakeLlm = new FakeLlm([
    '{"mode":"direct","reason":"small artifact task","domains":["visualization"],"riskLevel":"low"}',
    "I tried to attach a chart, but the current tool could not parse the data.",
    '{"shouldStore":false}',
  ]);
  const registry = new ToolRegistry();
  registry.register({
    name: "generated.chart.generation",
    version: "1.0.0",
    description: "Generated chart tool with insufficient behavior.",
    capabilities: ["chart-generation"],
    async run() {
      return { ok: false, content: "Could not parse arbitrary series data." };
    },
  });
  const toolMetadataStore = new InMemoryToolMetadataStore([
    {
      name: "generated.chart.generation",
      version: "1.0.0",
      description: "Generated chart tool with insufficient behavior.",
      capabilities: ["chart-generation"],
      startupMode: "on-demand",
      requiredConfigurationKeys: [],
      requiredSecretHandles: [],
      examples: [],
      successCount: 0,
      failureCount: 0,
      source: "generated",
      status: "available",
      updatedAt: new Date().toISOString(),
    },
  ]);
  const runStore = new InMemoryRunStore();
  const sourceRun = await runStore.create('Построй график по данным {"series":[{"x":"2026-01-01","y":1}]}');
  const toolInvestigationStore = new InMemoryToolInvestigationStore();
  const toolBuildRequestStore = new InMemoryToolBuildRequestStore();
  const toolReworkWaitStore = new InMemoryToolReworkWaitStore();
  const coordinator = new ToolImprovementCoordinator({
    toolInvestigationStore,
    toolBuildRequestStore,
    toolReworkWaitStore,
    toolMetadataStore,
    runStore,
  });

  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);
  const events: AgentEvent[] = [];

  try {
    const result = await agent.run('Построй график по данным {"series":[{"x":"2026-01-01","y":1}]}', {
      runId: sourceRun.id,
      saveArtifact: async (artifact: ArtifactCreateInput): Promise<AgentArtifact> => ({
        id: "artifact-1",
        runId: sourceRun.id,
        kind: "output",
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: 1,
        url: "/artifact",
        createdAt: new Date().toISOString(),
      }),
      toolImprovementCoordinator: coordinator,
      onEvent: (event) => {
        events.push(event);
      },
    });

    const investigations = await toolInvestigationStore.list();
    assert.equal(investigations.length, 1);
    assert.equal(investigations[0]?.toolName, "generated.chart.generation");
    assert.equal(investigations[0]?.runId, sourceRun.id);
    assert.equal(investigations[0]?.status, "linked_to_build");

    const builds = await toolBuildRequestStore.list();
    assert.equal(builds.length, 1);
    assert.equal(builds[0]?.replacesToolName, "generated.chart.generation");
    assert.equal(builds[0]?.replacesVersion, "1.0.0");

    const waits = await toolReworkWaitStore.list();
    assert.equal(waits.length, 1);
    assert.equal(waits[0]?.runId, sourceRun.id);
    assert.equal(waits[0]?.status, "waiting");
    assert.equal(waits[0]?.investigationId, investigations[0]!.id);
    assert.equal(waits[0]?.buildRequestId, builds[0]!.id);

    const stored = await runStore.get(sourceRun.id);
    assert.equal(stored?.status, "waiting_tool_rework");

    const waitOpenedEvents = events.filter((event) => event.type === "tool-rework-wait-opened");
    assert.equal(waitOpenedEvents.length, 1, "agent emits exactly one tool-rework-wait-opened event");
    assert.equal(
      ((waitOpenedEvents[0]?.payload as { agentDriven?: boolean } | undefined)?.agentDriven),
      true,
    );

    assert.match(result.finalAnswer, /Pending tool rework waits/);
    assert.ok(
      result.finalAnswer.includes(waits[0]!.id),
      "final answer references the open wait id so the operator knows what is blocking",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeWorkLedgerFakeLlmResponses(): string[] {
  return [
    '{"mode":"delegated","reason":"needs current research","domains":["research"],"riskLevel":"medium"}',
    JSON.stringify({
      subtasks: [
        {
          id: "research",
          title: "Find current Schengen visa rules",
          role: "researcher",
          prompt: "Research current Schengen visa rules for short-stay visitors and produce a summary.",
          expectedOutput: "Summary citing the search evidence.",
          reviewCriteria: ["Cites the search evidence"],
          requiredTools: ["web-search"],
        },
      ],
    }),
    "Worker summary using the search evidence about Schengen rules.",
    '{"subtaskId":"research","verdict":"pass","notes":"Cites the search evidence."}',
    "Final answer summarising Schengen short-stay rules with cited evidence.",
    '{"shouldStore":false}',
  ];
}

test("UniversalAgent records work + evidence + retrospective when stores are wired and reuses on a second matching run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-ledger-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const evidenceLedgerStore = new InMemoryEvidenceLedgerStore();
  const runRetrospectiveStore = new InMemoryRunRetrospectiveStore();
  const searchInputs: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "web.search",
    description: "Fake web search",
    capabilities: ["web-search"],
    async run(input) {
      searchInputs.push(input);
      return {
        ok: true,
        content:
          "1. Schengen short-stay rules\nhttps://example.org/schengen-rules\nA Schengen short-stay visa allows up to 90 days within any 180-day period.",
      };
    },
  });

  try {
    const firstAgent = new UniversalAgent(
      new FakeLlm(makeWorkLedgerFakeLlmResponses()) as unknown as LlmClient,
      memory,
      registry,
    );
    const firstEvents: AgentEvent[] = [];
    const firstResult = await firstAgent.run("Research current Schengen short-stay visa rules.", {
      runId: "run-A1",
      threadId: "thread-A",
      workLedgerStore,
      evidenceLedgerStore,
      runRetrospectiveStore,
      onEvent: (event) => {
        firstEvents.push(event);
      },
    });

    assert.ok(searchInputs.length >= 1, "first run actually invoked web.search");
    const callsAfterFirstRun = searchInputs.length;

    const workItemsRunA1 = await workLedgerStore.listByRun("run-A1");
    assert.equal(workItemsRunA1.length, 1, "exactly one work item created in the first run");
    assert.equal(workItemsRunA1[0]?.kind, "search");
    assert.equal(workItemsRunA1[0]?.status, "completed");
    assert.ok(workItemsRunA1[0]?.outputSummary, "completed work item carries an outputSummary for reuse");
    assert.equal(workItemsRunA1[0]?.evidenceIds.length, 1, "work item is linked to its evidence");

    const evidenceRunA1 = await evidenceLedgerStore.listByRun("run-A1");
    assert.equal(evidenceRunA1.length, 1, "search_result evidence is recorded");
    assert.equal(evidenceRunA1[0]?.kind, "search_result");
    assert.equal(evidenceRunA1[0]?.workItemId, workItemsRunA1[0]?.id);

    const retrospectivesRunA1 = await runRetrospectiveStore.listByRun("run-A1");
    assert.equal(retrospectivesRunA1.length, 1, "exactly one proposed retrospective per run");
    assert.equal(retrospectivesRunA1[0]?.status, "proposed");
    assert.equal(retrospectivesRunA1[0]?.runOutcome, "completed");
    assert.deepEqual(retrospectivesRunA1[0]?.usefulEvidenceIds, [evidenceRunA1[0]!.id]);
    assert.ok(
      (retrospectivesRunA1[0]?.whatWorked.length ?? 0) >= 1,
      "retrospective tracks whatWorked signals from the runtime",
    );

    const firstRunClaimEvents = firstEvents.filter((event) => event.type === "work-ledger-claim-created");
    assert.equal(firstRunClaimEvents.length, 1, "first run emits one work-ledger-claim-created event");
    const firstRunEvidenceEvents = firstEvents.filter((event) => event.type === "evidence-ledger-recorded");
    assert.equal(firstRunEvidenceEvents.length, 1, "first run emits one evidence-ledger-recorded event");
    const firstRunRetroEvents = firstEvents.filter((event) => event.type === "run-retrospective-proposed");
    assert.equal(firstRunRetroEvents.length, 1, "first run emits one run-retrospective-proposed event");

    assert.equal(firstResult.reviews[0]?.verdict, "pass");

    const secondAgent = new UniversalAgent(
      new FakeLlm(makeWorkLedgerFakeLlmResponses()) as unknown as LlmClient,
      memory,
      registry,
    );
    const secondEvents: AgentEvent[] = [];
    const secondResult = await secondAgent.run("Research current Schengen short-stay visa rules.", {
      runId: "run-A2",
      threadId: "thread-A",
      workLedgerStore,
      evidenceLedgerStore,
      runRetrospectiveStore,
      onEvent: (event) => {
        secondEvents.push(event);
      },
    });

    assert.equal(
      searchInputs.length,
      callsAfterFirstRun,
      "second run reuses the prior completed work item without re-invoking web.search",
    );

    const reuseEvents = secondEvents.filter((event) => event.type === "work-ledger-reused");
    assert.equal(reuseEvents.length, 1, "second run emits work-ledger-reused");
    assert.equal(reuseEvents[0]?.actor, "runtime-ledger");
    const reusePayload = reuseEvents[0]?.payload as { decision?: string } | undefined;
    assert.equal(reusePayload?.decision, "reuse_completed");

    const retrospectivesRunA2 = await runRetrospectiveStore.listByRun("run-A2");
    assert.equal(retrospectivesRunA2.length, 1);
    assert.ok(
      retrospectivesRunA2[0]?.duplicatedWork.some((entry) => entry.startsWith("reuse_completed:search:")),
      "retrospective for the reused run records a duplicatedWork signal",
    );
    assert.ok(secondResult.finalAnswer.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent records limitation evidence and a failed work item when web search returns a non-OK result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-ledger-fail-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const evidenceLedgerStore = new InMemoryEvidenceLedgerStore();
  const runRetrospectiveStore = new InMemoryRunRetrospectiveStore();
  const registry = new ToolRegistry();
  registry.register({
    name: "web.search",
    description: "Fake failing web search",
    capabilities: ["web-search"],
    async run() {
      return { ok: false, content: "External provider unavailable." };
    },
  });

  const fakeLlm = new FakeLlm(makeWorkLedgerFakeLlmResponses());
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);
  const events: AgentEvent[] = [];

  try {
    await agent.run("Research current Schengen short-stay visa rules.", {
      runId: "run-fail-1",
      threadId: "thread-fail",
      workLedgerStore,
      evidenceLedgerStore,
      runRetrospectiveStore,
      onEvent: (event) => {
        events.push(event);
      },
    });

    const workItems = await workLedgerStore.listByRun("run-fail-1");
    assert.equal(workItems.length, 1);
    assert.equal(workItems[0]?.status, "failed");
    assert.ok(workItems[0]?.error?.includes("External provider unavailable"));

    const evidence = await evidenceLedgerStore.listByRun("run-fail-1");
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.kind, "limitation");
    assert.equal(evidence[0]?.qaStatus, "failed");
    assert.ok(evidence[0]?.limitations.some((line) => /web search/i.test(line)));

    const retrospectives = await runRetrospectiveStore.listByRun("run-fail-1");
    assert.equal(retrospectives.length, 1);
    assert.ok(
      retrospectives[0]?.whatFailed.some((entry) => /web search failed/i.test(entry)),
      "retrospective whatFailed reflects the search failure",
    );
    assert.ok(retrospectives[0]?.weakTools.includes("web.search"));

    const evidenceEvents = events.filter((event) => event.type === "evidence-ledger-recorded");
    assert.equal(evidenceEvents.length, 1);
    const evidencePayload = evidenceEvents[0]?.payload as { kind?: string } | undefined;
    assert.equal(evidencePayload?.kind, "limitation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent finalizes ledger retrospectives when a tool throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-ledger-throw-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const evidenceLedgerStore = new InMemoryEvidenceLedgerStore();
  const runRetrospectiveStore = new InMemoryRunRetrospectiveStore();
  const registry = new ToolRegistry();
  registry.register({
    name: "web.search",
    description: "Throwing web search",
    capabilities: ["web-search"],
    async run() {
      throw new Error("Search backend unreachable");
    },
  });

  const fakeLlm = new FakeLlm(makeWorkLedgerFakeLlmResponses());
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);
  const events: AgentEvent[] = [];

  try {
    await assert.rejects(
      () => agent.run("Research current Schengen short-stay visa rules.", {
        runId: "run-throw-1",
        threadId: "thread-throw",
        workLedgerStore,
        evidenceLedgerStore,
        runRetrospectiveStore,
        onEvent: (event) => {
          events.push(event);
        },
      }),
      /Search backend unreachable/,
    );

    const workItems = await workLedgerStore.listByRun("run-throw-1");
    assert.equal(workItems.length, 1);
    assert.equal(workItems[0]?.status, "failed");
    assert.match(workItems[0]?.error ?? "", /Search backend unreachable/);

    const retrospectives = await runRetrospectiveStore.listByRun("run-throw-1");
    assert.equal(retrospectives.length, 1, "failed thrown runs still create one retrospective");
    assert.equal(retrospectives[0]?.runOutcome, "failed");
    assert.ok(
      retrospectives[0]?.whatFailed.some((entry) => /Search backend unreachable/.test(entry)),
      "retrospective records the thrown failure reason",
    );

    const retroEvents = events.filter((event) => event.type === "run-retrospective-proposed");
    assert.equal(retroEvents.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UniversalAgent skips ledger work when no stores are wired so existing flows are unaffected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-ledger-skip-"));
  const memory = new SkillMemory(join(dir, "skills.json"));
  const registry = new ToolRegistry();
  registry.register({
    name: "web.search",
    description: "Fake web search",
    capabilities: ["web-search"],
    async run() {
      return { ok: true, content: "1. Result\nhttps://example.org/page\nSnippet." };
    },
  });
  const fakeLlm = new FakeLlm(makeWorkLedgerFakeLlmResponses());
  const agent = new UniversalAgent(fakeLlm as unknown as LlmClient, memory, registry);
  const events: AgentEvent[] = [];

  try {
    const result = await agent.run("Research current Schengen short-stay visa rules.", {
      runId: "run-skip-1",
      onEvent: (event) => {
        events.push(event);
      },
    });

    assert.equal(result.reviews[0]?.verdict, "pass");
    const ledgerEvents = events.filter((event) =>
      [
        "work-ledger-claim-created",
        "work-ledger-reused",
        "work-ledger-waiting-existing",
        "evidence-ledger-recorded",
        "run-retrospective-proposed",
      ].includes(event.type),
    );
    assert.equal(ledgerEvents.length, 0, "no ledger events emitted when stores are absent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
