import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MessagingServiceToolBuildProvider } from "../src/tools/messagingServiceToolBuildProvider.js";
import {
  DeterministicToolBehaviorReviewer,
  DeterministicToolCodeReviewer,
} from "../src/tools/toolBuildReviewers.js";
import { GenericServiceToolBuildProvider } from "../src/tools/toolBuildProviders.js";
import {
  ToolBuildRequest,
  ToolBuildRequestInput,
  createToolBuildContract,
} from "../src/tools/toolBuildRequestStore.js";

function buildRequest(input: ToolBuildRequestInput): ToolBuildRequest {
  return {
    ...input,
    id: `toolbuild_${input.capability}_${Math.random().toString(36).slice(2, 8)}`,
    status: "requested",
    contract: createToolBuildContract({ ...input, startupMode: input.startupMode ?? "always-on" }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test("MessagingServiceToolBuildProvider claims Telegram Bot API requests and rejects unrelated ones", () => {
  const provider = new MessagingServiceToolBuildProvider();

  const telegramRequest = buildRequest({
    capability: "channel.telegram.family-assistant",
    displayName: "Family Telegram Assistant Bot",
    reason:
      "Create an always-on Telegram bot integration for a second bot. " +
      "It should poll getUpdates, send messages back via sendMessage, split long replies, and include a Continue thread button. " +
      "Token is provided via secret handle secret.telegram.family.bot.token.",
    credentialHandles: ["secret.telegram.family.bot.token"],
    startupMode: "always-on",
  });
  assert.equal(provider.canBuild(telegramRequest), true);

  const browserRequest = buildRequest({
    capability: "browser-screenshot",
    reason: "Need PNG screenshots for the run.",
    startupMode: "on-demand",
  });
  assert.equal(provider.canBuild(browserRequest), false);

  const apiRequest = buildRequest({
    capability: "api.aml.score",
    reason: "Generic AML risk scoring HTTP API adapter.",
    startupMode: "on-demand",
  });
  assert.equal(provider.canBuild(apiRequest), false);
});

test("MessagingServiceToolBuildProvider produces an isolated source bundle with Telegram Bot API surface", () => {
  const provider = new MessagingServiceToolBuildProvider();
  const request = buildRequest({
    capability: "channel.telegram.family-assistant",
    displayName: "Family Telegram Assistant Bot",
    reason:
      "Create an always-on Telegram bot integration that receives messages from allowed users, " +
      "creates Agentic runs, sends answers back, splits long messages, and includes a Continue thread button. " +
      "Token is provided via secret handle secret.telegram.family.bot.token.",
    credentialHandles: ["secret.telegram.family.bot.token"],
    startupMode: "always-on",
    desiredToolName: "generated.telegram.family-assistant-bot",
  });

  const output = provider.build(request);
  assert.equal(output.modulePath, request.contract.modulePath);
  assert.equal(output.testPath, request.contract.testPath);

  // Capability metadata reflects the Telegram surface so the behavior reviewer accepts it.
  assert.ok(output.capabilities!.includes("telegram"));
  assert.ok(output.capabilities!.includes("provider:telegram"));
  assert.ok(output.capabilities!.includes("inbound-message"));
  assert.ok(output.capabilities!.includes("outbound-message"));
  assert.ok(output.requiredSecretHandles!.includes("secret.telegram.family.bot.token"));
  // Default secret handle is preserved as a fallback so generated bots stay portable.
  assert.ok(output.requiredSecretHandles!.includes("secret.telegram.bot.token"));

  // Settings schema declares the user/chat allowlists, so a future operator UI can edit
  // them without forcing a re-build of the tool.
  const settings = output.settingsSchema as { properties?: Record<string, unknown> } | undefined;
  assert.ok(settings?.properties?.allowedSourceUserIds);
  assert.ok(settings?.properties?.allowedSourceUsernames);
  assert.ok(settings?.properties?.allowedChatIds);

  const moduleFile = output.files.find((file) => file.path === request.contract.modulePath);
  const testFile = output.files.find((file) => file.path === request.contract.testPath);
  assert.ok(moduleFile, "module file is generated");
  assert.ok(testFile, "test file is generated");

  // Generated module proves real Telegram Bot API behavior, not a generic bridge.
  for (const marker of [
    "getUpdates",
    "sendMessage",
    "answerCallbackQuery",
    "continue_thread",
    "Continue thread",
    "/api/tool-services/",
    "context.resolveSecret",
  ]) {
    assert.match(moduleFile!.content, new RegExp(marker), `module source contains ${marker}`);
  }
  // Token must never appear in source as a literal — every reference goes through the secret handle.
  assert.ok(
    !/[A-Za-z0-9]{15,}:[A-Za-z0-9_\-]{30,}/.test(moduleFile!.content),
    "module must not embed a real Telegram bot token literal",
  );

  // Generated test proves the cycle through a fake Telegram + fake Agentic.
  for (const marker of [
    "runTelegramBotServiceCycle",
    "/getUpdates",
    "/sendMessage",
    "/inbound",
    "/outbox",
    "/ack",
    "Continue thread",
    "splitTelegramMessage",
  ]) {
    assert.match(testFile!.content, new RegExp(marker), `test source contains ${marker}`);
  }

  // Package manifest carries the generated bot's full contract so it is portable.
  assert.ok(output.packageManifest);
  assert.equal(output.packageManifest!.startupMode, "always-on");
  assert.equal(output.packageManifest!.name, request.contract.toolName);
  assert.ok(output.packageManifest!.capabilities.includes("provider:telegram"));
  assert.deepEqual(output.packageManifest!.requiredSecretHandles, output.requiredSecretHandles);
});

test("MessagingServiceToolBuildProvider runs cleanly inside an isolated tsx workspace against a fake Telegram server", async () => {
  const provider = new MessagingServiceToolBuildProvider();
  const request = buildRequest({
    capability: "channel.telegram.family-assistant",
    displayName: "Family Telegram Assistant Bot",
    reason:
      "Create an always-on Telegram bot. Polls getUpdates, sends sendMessage replies, splits long answers, attaches Continue thread inline keyboard, and acks outbox.",
    credentialHandles: ["secret.telegram.family.bot.token"],
    startupMode: "always-on",
  });

  const output = provider.build(request);
  const workspace = await mkdtemp(join(tmpdir(), "agentic-telegram-build-"));

  try {
    // Drop a minimal portable Tool contract next to the generated source so the temp
    // workspace can `import { Tool } from "../tool.js"` without pulling in Agentic.
    await mkdir(resolve(workspace, "src/tools"), { recursive: true });
    await writeFile(resolve(workspace, "src/tools/tool.ts"), MINIMAL_TOOL_CONTRACT, "utf8");

    for (const file of output.files) {
      const absolutePath = resolve(workspace, file.path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, file.content, "utf8");
    }

    const here = dirname(fileURLToPath(import.meta.url));
    const projectRoot = resolve(here, "..");
    const tsxBin = resolve(projectRoot, "node_modules/.bin/tsx");
    const absoluteTestPath = resolve(workspace, output.testPath);
    // Strip node:test context env so the child process can run its own test runner
    // instead of bailing out with "node:test run() is being called recursively".
    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^NODE_TEST_/.test(key)),
    );
    const child = spawnSync(tsxBin, ["--test", absoluteTestPath], {
      cwd: projectRoot,
      env: childEnv,
      stdio: "pipe",
      encoding: "utf8",
    });

    const stdout = child.stdout ?? "";
    const stderr = child.stderr ?? "";
    if (child.status !== 0 || !/# pass /.test(stdout) || !/# fail 0\b/.test(stdout)) {
      throw new Error(
        `Generated Telegram tool tests failed in isolated workspace (status=${child.status}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("DeterministicToolBehaviorReviewer rejects a provider-neutral bridge for Telegram requests", async () => {
  const generic = new GenericServiceToolBuildProvider();
  const request = buildRequest({
    capability: "channel.telegram.family-assistant",
    displayName: "Family Telegram Assistant Bot",
    reason:
      "Create an always-on Telegram bot integration. It must poll Telegram getUpdates and send messages back via sendMessage.",
    credentialHandles: ["secret.telegram.family.bot.token"],
    startupMode: "always-on",
  });
  const output = generic.build(request);
  const codeReviewer = new DeterministicToolCodeReviewer();
  const codeReview = await codeReviewer.review(request, { ...output, packageWorkspace: undefined } as never);
  assert.equal(codeReview.decision, "pass");

  const behaviorReviewer = new DeterministicToolBehaviorReviewer();
  const behaviorReview = await behaviorReviewer.review(
    request,
    { ...output, packageWorkspace: undefined } as never,
    {
      ok: true,
      summary: "Generic service bridge tests passed.",
      checks: [
        "isolated targeted generated tool tests: pass",
        "isolated TypeScript build: pass",
      ],
    },
  );
  assert.equal(behaviorReview.decision, "needs_revision");
  assert.ok(
    behaviorReview.findings.some((finding) => /Telegram/.test(finding)),
    "behavior reviewer must call out missing named-provider behavior",
  );
});

test("DeterministicToolBehaviorReviewer accepts a generated Telegram adapter with provider QA evidence", async () => {
  const provider = new MessagingServiceToolBuildProvider();
  const request = buildRequest({
    capability: "channel.telegram.family-assistant",
    displayName: "Family Telegram Assistant Bot",
    reason:
      "Create an always-on Telegram bot. Polls getUpdates and sends sendMessage replies through the Telegram Bot API.",
    credentialHandles: ["secret.telegram.family.bot.token"],
    startupMode: "always-on",
  });
  const output = provider.build(request);

  const behaviorReviewer = new DeterministicToolBehaviorReviewer();
  const behaviorReview = await behaviorReviewer.review(
    request,
    { ...output, packageWorkspace: undefined } as never,
    {
      ok: true,
      summary: "Telegram bot generated tests covered getUpdates and sendMessage.",
      checks: [
        "isolated targeted generated tool tests: pass",
        "isolated TypeScript build: pass",
        "fake Telegram getUpdates served one update",
        "fake Telegram sendMessage delivered chunked answer with Continue thread inline keyboard",
      ],
    },
  );
  assert.equal(behaviorReview.decision, "pass");
});

const MINIMAL_TOOL_CONTRACT = `export type ToolInput = Record<string, unknown>;
export type ToolResult = { ok: boolean; content: string; data?: unknown };
export type ToolSchema = Record<string, unknown>;
export type ToolStartupMode = "on-demand" | "always-on" | "ephemeral";
export type ToolStorageContract = { schema?: string; tables?: string[]; migrations?: string[]; retention?: string; permissions?: string[]; destructiveCapabilities?: string[]; notes?: string };
export type ToolExecutionContext = {
  signal?: AbortSignal;
  logger?: { info(message: string, data?: unknown): void; warn(message: string, data?: unknown): void; error(message: string, data?: unknown): void };
  resolveSecret?: (handle: string) => Promise<string | undefined> | string | undefined;
  resolveConfiguration?: (key: string, toolName?: string) => Promise<string | undefined> | string | undefined;
  [key: string]: unknown;
};
export type ToolServiceContext = ToolExecutionContext & {
  toolName: string;
  now: Date;
  signal: AbortSignal;
  baseUrl?: string;
  fetch?: typeof fetch;
};
export type ToolServiceHandle = {
  stop?: () => Promise<void> | void;
  healthcheck?: () => Promise<{ ok: boolean; detail: string }>;
};
export type Tool = {
  name: string;
  displayName?: string;
  version: string;
  description: string;
  capabilities: string[];
  startupMode?: ToolStartupMode;
  inputSchema?: ToolSchema;
  outputSchema?: ToolSchema;
  requiredConfigurationKeys?: string[];
  requiredSecretHandles?: string[];
  settingsSchema?: ToolSchema;
  storage?: ToolStorageContract;
  docsMarkdown?: string;
  examples?: unknown[];
  healthcheck?: () => Promise<{ ok: boolean; detail: string }> | { ok: boolean; detail: string };
  run: (input: ToolInput, context?: ToolExecutionContext) => Promise<ToolResult> | ToolResult;
  startService?: (context: ToolServiceContext) => Promise<ToolServiceHandle> | ToolServiceHandle;
};
`;
