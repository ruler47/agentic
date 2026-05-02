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
import { ToolRegistry } from "../src/tools/registry.js";
import { Tool } from "../src/tools/tool.js";
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

  try {
    const result = await agent.run("Define universal agent in one sentence");

    assert.equal(result.complexity.mode, "direct");
    assert.equal(result.subtasks.length, 0);
    assert.match(result.finalAnswer, /coordinates/);
    assert.equal(fakeLlm.callCount, 3);
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
  registry.register({
    name: "browser.operate",
    description: "Fake browser operate tool",
    capabilities: ["browser-operate", "browser-screenshot", "artifact-generation"],
    async run(input) {
      toolInputs.push(input);
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
    assert.equal(savedArtifacts.length, 1);
    assert.equal(result.workerResults[0]?.artifacts?.[0]?.url, "/artifacts/browser-proof.png");
    assert.match(result.workerResults[0]?.toolEvidence?.join("\n") ?? "", /Example Domain/);
    assert.match(result.finalAnswer, /\/artifacts\/browser-proof\.png/);
    assert.doesNotMatch(result.finalAnswer, /api\.runs\.example\.com/);
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
