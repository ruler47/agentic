import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LlmClient } from "../src/llm/client.js";
import {
  DeterministicToolCodeReviewer,
  DeterministicToolBehaviorReviewer,
  LlmToolBuildReviewer,
} from "../src/tools/toolBuildReviewers.js";
import { InMemoryToolBuildRequestStore } from "../src/tools/toolBuildRequestStore.js";
import { Message } from "../src/types.js";

class FakeReviewLlm {
  public calls: Array<{ messages: Message[]; options: unknown }> = [];

  constructor(private readonly responses: string[]) {}

  async complete(messages: Message[], options?: unknown): Promise<string> {
    this.calls.push({ messages, options });
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No fake review response queued");
    return response;
  }
}

test("DeterministicToolCodeReviewer rejects raw secret handles before promotion", async () => {
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "api-risk-check",
    reason: "Need an API tool.",
  });
  const reviewer = new DeterministicToolCodeReviewer();

  const review = await reviewer.review(request, {
    modulePath: "src/tools/generated/api-risk-checkTool.ts",
    testPath: "tests/generated/api-risk-checkTool.test.ts",
    summary: "Generated.",
    capabilities: ["api-risk-check"],
    requiredSecretHandles: ["api_key=raw-secret-value"],
  });

  assert.equal(review.kind, "code");
  assert.equal(review.decision, "needs_revision");
  assert.match(review.findings.join("\n"), /stable handles/);
});

test("DeterministicToolBehaviorReviewer rejects generic bridges for provider-specific Telegram requests", async () => {
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "api.personal-assistant-telegram-bot",
    displayName: "Personal Assistant Telegram Bot",
    reason:
      "Create a Telegram bot that polls Telegram Bot API getUpdates and sends answers with sendMessage.",
    startupMode: "always-on",
  });
  const reviewer = new DeterministicToolBehaviorReviewer();

  const review = await reviewer.review(
    request,
    {
      modulePath: "src/tools/generated/api-personal-assistant-telegram-botTool.ts",
      testPath: "tests/generated/api-personal-assistant-telegram-botTool.test.ts",
      summary: "Generated provider-neutral always-on service tool.",
      capabilities: ["api.personal-assistant-telegram-bot", "always-on-service", "provider:telegram"],
      docsMarkdown: "Generated provider-neutral always-on service tool with normalized events.",
    },
    {
      ok: true,
      summary: "Package workspace tests and TypeScript build passed.",
      checks: ["package-local tests passed", "package-local TypeScript build passed"],
    },
  );

  assert.equal(review.kind, "behavior");
  assert.equal(review.decision, "needs_revision");
  assert.match(review.findings.join("\n"), /Telegram Bot API polling\/sending/);
});

test("DeterministicToolBehaviorReviewer accepts Telegram requests when QA proves provider API behavior", async () => {
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "api.personal-assistant-telegram-bot",
    displayName: "Personal Assistant Telegram Bot",
    reason:
      "Create a Telegram bot that polls Telegram Bot API getUpdates and sends answers with sendMessage.",
    startupMode: "always-on",
  });
  const reviewer = new DeterministicToolBehaviorReviewer();

  const review = await reviewer.review(
    request,
    {
      modulePath: "src/tools/generated/api-personal-assistant-telegram-botTool.ts",
      testPath: "tests/generated/api-personal-assistant-telegram-botTool.test.ts",
      summary: "Generated Telegram Bot API adapter.",
      capabilities: ["api.personal-assistant-telegram-bot", "always-on-service", "provider:telegram"],
      docsMarkdown: "Implements Telegram Bot API getUpdates polling and sendMessage delivery.",
    },
    {
      ok: true,
      summary: "Package workspace tests and TypeScript build passed.",
      checks: [
        "package-local tests passed",
        "package-local TypeScript build passed",
        "Telegram Bot API getUpdates polling fixture passed",
        "Telegram Bot API sendMessage delivery fixture passed",
      ],
    },
  );

  assert.equal(review.kind, "behavior");
  assert.equal(review.decision, "pass");
});

test("LlmToolBuildReviewer reads generated files and returns structured review decisions", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-reviewer-"));
  const modulePath = "src/tools/generated/reviewedTool.ts";
  const testPath = "tests/generated/reviewedTool.test.ts";
  await mkdir(join(projectRoot, "src/tools/generated"), { recursive: true });
  await mkdir(join(projectRoot, "tests/generated"), { recursive: true });
  await writeFile(join(projectRoot, modulePath), "export const marker = 'module';\n", "utf8");
  await writeFile(join(projectRoot, testPath), "import test from 'node:test';\n", "utf8");

  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "reviewed-capability",
    reason: "Need reviewer coverage.",
  });
  const fakeLlm = new FakeReviewLlm([
    '{"decision":"needs_revision","summary":"Missing behavior edge-case test.","findings":["Add a failure-path test."]}',
  ]);
  const reviewer = new LlmToolBuildReviewer(fakeLlm as unknown as LlmClient, {
    kind: "behavior",
    projectRoot,
  });

  try {
    const review = await reviewer.review(
      request,
      {
        modulePath,
        testPath,
        summary: "Generated.",
        capabilities: ["reviewed-capability"],
      },
      {
        ok: true,
        summary: "Tests and build passed.",
        checks: ["targeted tests passed", "TypeScript build passed"],
      },
    );

    assert.equal(review.kind, "behavior");
    assert.equal(review.decision, "needs_revision");
    assert.deepEqual(review.findings, ["Add a failure-path test."]);
    assert.equal(fakeLlm.calls.length, 1);
    assert.equal((fakeLlm.calls[0]?.options as { modelTier?: string }).modelTier, "L");
    assert.match(fakeLlm.calls[0]?.messages[1]?.content ?? "", /marker = 'module'/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("LlmToolBuildReviewer converts untrusted reviewer output into repair findings", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-reviewer-"));
  const modulePath = "src/tools/generated/reviewedTool.ts";
  const testPath = "tests/generated/reviewedTool.test.ts";
  await mkdir(join(projectRoot, "src/tools/generated"), { recursive: true });
  await mkdir(join(projectRoot, "tests/generated"), { recursive: true });
  await writeFile(join(projectRoot, modulePath), "export const marker = 'module';\n", "utf8");
  await writeFile(join(projectRoot, testPath), "import test from 'node:test';\n", "utf8");

  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "reviewed-capability",
    reason: "Need reviewer coverage.",
  });
  const fakeLlm = new FakeReviewLlm(["not json"]);
  const reviewer = new LlmToolBuildReviewer(fakeLlm as unknown as LlmClient, {
    kind: "code",
    projectRoot,
  });

  try {
    const review = await reviewer.review(
      request,
      {
        modulePath,
        testPath,
        summary: "Generated.",
        capabilities: ["reviewed-capability"],
      },
      {
        ok: true,
        summary: "Tests and build passed.",
        checks: ["targeted tests passed", "TypeScript build passed"],
      },
    );

    assert.equal(review.kind, "code");
    assert.equal(review.decision, "needs_revision");
    assert.match(review.summary, /could not produce/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
