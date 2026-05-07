import test from "node:test";
import assert from "node:assert/strict";
import { ToolBuildInputFinalizerService } from "../src/server/common/services/tool-build-input-finalizer.service.js";
import { InMemorySecretHandleStore } from "../src/secrets/secretHandleStore.js";
import { InMemoryToolBuildRequestStore } from "../src/tools/toolBuildRequestStore.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import type { Tool } from "../src/tools/tool.js";

const browserTool: Tool = {
  name: "browser.operate",
  displayName: "Browser Operate",
  version: "1.0.0",
  description: "Navigate websites, inspect pages, click controls, and create browser evidence.",
  capabilities: ["browser", "browser-operate", "screenshot"],
  async run() {
    return { ok: true, content: "ok" };
  },
};

const telegramTool: Tool = {
  name: "channel.telegram.bot",
  displayName: "Telegram Bot",
  version: "1.0.0",
  description: "Always-on Telegram provider adapter for inbound messages and outbound replies.",
  capabilities: ["telegram", "bot", "always-on", "service"],
  startupMode: "always-on",
  async run() {
    return { ok: true, content: "ok" };
  },
};

test("ToolBuildInputFinalizerService stores inline credentials through secret handles and redacts queued text", async () => {
  const secrets = new InMemorySecretHandleStore();
  const finalizer = new ToolBuildInputFinalizerService(
    new InMemoryToolMetadataStore(),
    new InMemoryToolBuildRequestStore(),
    secrets,
  );

  const finalized = await finalizer.finalize({
    capability: "api.aml.score",
    displayName: "AML Score",
    reason: "Build a reusable API client. Use x-api-key: NEST-SECRET-KEY-12345 for smoke calls.",
    credentialNotes: "x-api-key: NEST-SECRET-KEY-12345",
    taskSummary: "Needs NEST-SECRET-KEY-12345 for the API docs example.",
    feedback: "Never leak NEST-SECRET-KEY-12345 into generated code.",
  });

  assert.deepEqual(finalized.credentialHandles, ["secret.api.aml.score"]);
  assert.match(finalized.credentialNotes ?? "", /secret\.api\.aml\.score/);
  assert.doesNotMatch(JSON.stringify(finalized), /NEST-SECRET-KEY-12345/);
  assert.equal(finalized.desiredToolName, "generated.api.aml.score");

  const stored = await secrets.resolve?.("secret.api.aml.score");
  assert.equal(stored, "NEST-SECRET-KEY-12345");
});

test("ToolBuildInputFinalizerService refuses obvious wrong-tool change requests instead of fuzzy retargeting", async () => {
  const metadata = new InMemoryToolMetadataStore();
  await metadata.syncBuiltins([browserTool, telegramTool]);
  const finalizer = new ToolBuildInputFinalizerService(
    metadata,
    new InMemoryToolBuildRequestStore(),
    new InMemorySecretHandleStore(),
  );

  await assert.rejects(
    () =>
      finalizer.finalize({
        capability: "telegram-bot",
        reason: "Improve the Telegram bot adapter username allowlist and long message splitting.",
        feedback: "Telegram replies should include a continue thread button.",
        replacesToolName: "browser.operate",
      }),
    /Selected tool browser\.operate does not appear to match this request/,
  );
});

test("ToolBuildInputFinalizerService assigns stable generated names without colliding with installed tools or queued builds", async () => {
  const metadata = new InMemoryToolMetadataStore();
  await metadata.registerGenerated({
    name: "generated.api.aml.score",
    version: "1.0.0",
    description: "Existing AML tool.",
    capabilities: ["api.aml.score"],
    modulePath: "tools/generated.api.aml.score/1.0.0/src/index.ts",
  });
  const buildRequests = new InMemoryToolBuildRequestStore();
  await buildRequests.create({
    capability: "api.aml.score",
    reason: "Queued replacement.",
    desiredToolName: "generated.api.aml.score.2",
  });
  const finalizer = new ToolBuildInputFinalizerService(metadata, buildRequests, new InMemorySecretHandleStore());

  const finalized = await finalizer.finalize({
    capability: "api.aml.score",
    reason: "Create another reusable AML API capability.",
  });

  assert.equal(finalized.desiredToolName, "generated.api.aml.score.3");
});
