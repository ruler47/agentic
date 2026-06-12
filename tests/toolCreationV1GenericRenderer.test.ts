import test from "node:test";
import assert from "node:assert/strict";

import { renderToolSource } from "../src/tools/toolCreationV1GenericRenderer.js";
import { buildToolBuilderPlan } from "../src/tools/toolBuilderAgent.js";

test("http-json generated tools reject HTML SPA responses as API mismatches", () => {
  const source = renderToolSource(
    {
      kind: "http-json",
      name: "api.example",
      displayName: "Example API",
      version: "0.1.0",
      description: "Calls an example API.",
      capabilities: ["external-api", "http-json"],
      dependencies: {},
      behaviorExamples: [],
      integrationContract: {
        baseUrl: "https://api.example.test",
        auth: { type: "none" },
        operations: [{ operationId: "getThing", method: "GET", path: "/thing" }],
      },
    } as any,
    {
      name: "api.example",
      schemaVersion: "agentic.tool-package.v1",
      version: "0.1.0",
      description: "Calls an example API.",
      startupMode: "on-demand",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
      capabilities: ["external-api", "http-json"],
      requiredConfigurationKeys: [],
      requiredSecretHandles: [],
    },
  );

  assert.match(source, /looksLikeHtmlApiMismatch/);
  assert.match(source, /html_api_mismatch/);
  assert.match(source, /returned HTML instead of a machine-readable API response/);
});

test("telegram service-adapter generation produces a real provider bridge, not an empty scaffold", () => {
  const source = renderToolSource(
    {
      kind: "service-adapter",
      name: "channel.telegram",
      displayName: "Telegram Channel",
      version: "0.1.0",
      description: "Receives Telegram messages and returns run answers.",
      capabilities: ["telegram-channel", "always-on-messaging"],
      dependencies: {},
      behaviorExamples: [],
      integrationContract: {
        schemaVersion: "agentic.tool-integration.v1",
        mode: "always-on-service",
        protocol: "messaging-bot",
        provider: "telegram",
        auth: {
          type: "bot-token",
          requiredSecretHandles: ["secret.telegram.bot"],
        },
        operations: [
          { name: "receive_inbound_event", direction: "inbound-event" },
          { name: "send_outbound_response", direction: "outbound-event" },
        ],
        callbackStrategy: "runtime-callbacks",
      },
    } as any,
    {
      name: "channel.telegram",
      schemaVersion: "agentic.tool-package.v1",
      version: "0.1.0",
      description: "Receives Telegram messages and returns run answers.",
      startupMode: "always-on",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
      capabilities: ["telegram-channel", "always-on-messaging"],
      requiredConfigurationKeys: [],
      requiredSecretHandles: ["secret.telegram.bot"],
    },
  );

  assert.match(source, /getUpdates/);
  assert.match(source, /sendMessage/);
  assert.match(source, /sendPhoto/);
  assert.match(source, /sendDocument/);
  assert.match(source, /replyToProviderMessageId/);
  assert.match(source, /telegramMessageAttachments/);
  assert.match(source, /tool-services.*inbound/);
  assert.match(source, /outbox.*limit=10/);
  assert.match(source, /Telegram bridge tick failed/);
  assert.doesNotMatch(source, /scaffold has no provider loop/i);
});

test("browser operate generation includes prepare-only commit boundary", () => {
  const source = renderToolSource(
    {
      kind: "browser-operate",
      name: "browser.operate",
      displayName: "Browser Operate",
      version: "0.1.0",
      description: "Operates web pages safely before commit.",
      capabilities: ["browser-operate", "browser-automation"],
      dependencies: { "playwright-core": "^1.56.1" },
      behaviorExamples: [],
    } as any,
    {
      name: "browser.operate",
      schemaVersion: "agentic.tool-package.v1",
      version: "0.1.0",
      description: "Operates web pages safely before commit.",
      startupMode: "on-demand",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
      capabilities: ["browser-operate", "browser-automation"],
      requiredConfigurationKeys: [],
      requiredSecretHandles: [],
    },
  );

  assert.match(source, /POSSIBLE_COMMIT_TARGET/);
  assert.match(source, /FINAL_COMMIT_TARGET/);
  assert.match(source, /SAFE_ADVANCE_TARGET/);
  assert.match(source, /prepareOnly/);
  assert.match(source, /blocked possible final commit target/);
  assert.match(source, /dismissCommonDialogs/);
  assert.match(source, /contentBase64/);
  assert.match(source, /browser-field-candidates/);
  assert.match(source, /browser-form-schema/);
  assert.match(source, /browser-interactive-fields/);
  assert.match(source, /browser-no-progress-detection/);
  assert.match(source, /browser-repeated-control-targeting/);
  assert.match(source, /browser-safe-advance/);
  assert.match(source, /safeAdvance/);
  assert.match(source, /selectorOrdinal/);
  assert.match(source, /candidateIndex/);
  assert.match(source, /nearText/);
  assert.match(source, /optionalNonNegativeInteger/);
  assert.match(source, /filter\(\{ hasText:/);
  assert.match(source, /typed into focused field fallback/);
  assert.match(source, /extractforms/);
  assert.match(source, /extractPageFields/);
  assert.match(source, /scope: "page"/);
  assert.match(source, /cssPath/);
  assert.match(source, /__agenticForms/);
  assert.match(source, /optional skipped/);
  assert.match(source, /command\.labels/);
  assert.match(source, /command\.placeholders/);
  assert.match(source, /command\.testIds/);
});

test("external action commit executor is an explicit generated tool kind", () => {
  const plan = buildToolBuilderPlan({
    name: "booking.commit",
    request: "Build a commit executor for approved external actions after browser preparation.",
    capabilities: ["external-action-commit", "external-action-commit-reservation"],
  });
  assert.equal(plan.input.kind, "external-action-commit");
  assert.deepEqual(plan.input.capabilities, ["external-action-commit", "external-action-commit-reservation"]);

  const source = renderToolSource(
    {
      kind: "external-action-commit",
      name: "booking.commit",
      version: "0.1.0",
      description: "Commits approved fixture actions.",
      capabilities: ["external-action-commit"],
      dependencies: {},
      behaviorExamples: [],
    } as any,
    {
      name: "booking.commit",
      schemaVersion: "agentic.tool-package.v1",
      version: "0.1.0",
      description: "Commits approved fixture actions.",
      startupMode: "on-demand",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
      capabilities: ["external-action-commit"],
      requiredConfigurationKeys: [],
      requiredSecretHandles: [],
    },
  );

  assert.match(source, /External action commit executor loaded/);
  assert.match(source, /missing_requirements/);
  assert.match(source, /fixtureConfirmation/);
  assert.match(source, /preparedSession/);
});

test("external action prepare is an explicit generated tool kind", () => {
  const plan = buildToolBuilderPlan({
    name: "external.action.prepare",
    request: "Build an external-action-prepare tool that safely prepares external action proposals, creates a prepared action draft, captures proof, and stops before final commit.",
  });
  assert.equal(plan.input.kind, "external-action-prepare");
  assert.ok(plan.input.capabilities?.includes("external-action-prepare"));
  assert.ok(plan.input.capabilities?.includes("browser-form-schema"));

  const source = renderToolSource(
    {
      kind: "external-action-prepare",
      name: "external.action.prepare",
      version: "0.1.0",
      description: "Safely prepares external actions.",
      capabilities: ["external-action-prepare", "browser-operate"],
      dependencies: { "playwright-core": "^1.56.1" },
      behaviorExamples: [],
    } as any,
    {
      name: "external.action.prepare",
      schemaVersion: "agentic.tool-package.v1",
      version: "0.1.0",
      description: "Safely prepares external actions.",
      startupMode: "on-demand",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
      capabilities: ["external-action-prepare", "browser-operate"],
      requiredConfigurationKeys: [],
      requiredSecretHandles: [],
    },
  );

  assert.match(source, /Browser operate tool loaded/);
  assert.match(source, /prepareOnly/);
  assert.match(source, /POSSIBLE_COMMIT_TARGET/);
  assert.match(source, /actionCandidates/);
  assert.match(source, /extractActionCandidates/);
  assert.match(source, /extractPageFields/);
  assert.match(source, /browser-interactive-fields/);
  assert.match(source, /browser-no-progress-detection/);
  assert.match(source, /browser-repeated-control-targeting/);
  assert.match(source, /browser-safe-advance/);
  assert.match(source, /kind === "safe_advance"/);
  assert.match(source, /selectorOrdinal/);
  assert.match(source, /candidateIndex/);
  assert.match(source, /nearText/);
  assert.match(source, /DOM safe-advance fallback/);
  assert.match(source, /reject all\|reject\|decline\|deny/);
  assert.match(source, /CybotCookiebotDialogBodyButtonDecline/);
  assert.match(source, /clickAndVerifyDialogDismissed/);
});
