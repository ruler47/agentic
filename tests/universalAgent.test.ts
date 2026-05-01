import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UniversalAgent } from "../src/agents/universalAgent.js";
import { LlmClient } from "../src/llm/client.js";
import { SkillMemory } from "../src/memory/skillMemory.js";
import { Message } from "../src/types.js";

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
