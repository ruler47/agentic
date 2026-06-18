import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemorySecretHandleStore } from "../src/secrets/secretHandleStore.js";
import { buildToolBuilderPlan } from "../src/tools/toolBuilderAgent.js";
import {
  applyStoredSecretsToToolBuilderPlan,
  persistToolCreationSecrets,
  prepareToolCreationSecrets,
  redactToolCreationTracePayload,
} from "../src/tools/toolCreationSecrets.js";

test("tool creation extracts inline API keys into tool-scoped secret handles", async () => {
  const rawSecret = "live_TEST_key_123456789abcdef";
  const prepared = prepareToolCreationSecrets({
    name: "weather.lookup",
    request: `Build an HTTP API tool. api key: ${rawSecret}`,
  });

  assert.equal(JSON.stringify(prepared.input).includes(rawSecret), false);
  assert.equal(prepared.extractedSecrets.length, 1);
  assert.equal(prepared.extractedSecrets[0]?.purpose, "api key");

  const initialPlan = buildToolBuilderPlan(prepared.input);
  const store = new InMemorySecretHandleStore();
  const stored = await persistToolCreationSecrets({
    extractedSecrets: prepared.extractedSecrets,
    toolName: initialPlan.input.name,
    store,
  });
  const plan = applyStoredSecretsToToolBuilderPlan(initialPlan, stored);

  assert.deepEqual(stored.map((secret) => secret.handle), ["secret.tool.weather.lookup.api-key"]);
  assert.equal(await store.resolve?.("secret.tool.weather.lookup.api-key"), rawSecret);
  assert.deepEqual(plan.input.integrationContract?.auth?.requiredSecretHandles, [
    "secret.tool.weather.lookup.api-key",
  ]);
  const requiredSecretHandles = plan.input.requiredSecretHandles ?? [];
  assert.equal(requiredSecretHandles[0], "secret.tool.weather.lookup.api-key");
  assert.equal(requiredSecretHandles.includes("secret.api.integration"), false);
});

test("tool creation extracts nested bot tokens without version-specific handles", async () => {
  const rawSecret = "123456789:AAExampleTelegramTokenValue987654321";
  const prepared = prepareToolCreationSecrets({
    name: "channel.telegram.bot",
    version: "0.1.0",
    request: "Create a Telegram bot service adapter.",
    credentials: {
      telegramBotToken: rawSecret,
    },
  });

  const store = new InMemorySecretHandleStore();
  const stored = await persistToolCreationSecrets({
    extractedSecrets: prepared.extractedSecrets,
    toolName: "channel.telegram.bot",
    store,
  });

  assert.equal(JSON.stringify(prepared.input).includes(rawSecret), false);
  assert.deepEqual(stored.map((secret) => secret.handle), [
    "secret.tool.channel.telegram.bot.telegram-bot-token",
  ]);
  assert.equal(await store.resolve?.(stored[0]!.handle), rawSecret);
});

test("tool creation treats arbitrary credentials map values as secrets", async () => {
  const rawSecret = "AAF1SV1mdl9QSRliMBjPhP-fX2Z-Icly0AQ";
  const prepared = prepareToolCreationSecrets({
    name: "channel.telegram",
    request: "Create a Telegram bot service adapter.",
    credentials: {
      "8701832328": rawSecret,
    },
  });

  const serialized = JSON.stringify(prepared.input);

  assert.equal(serialized.includes(rawSecret), false);
  assert.equal(serialized.includes("8701832328"), false);
  assert.deepEqual(prepared.extractedSecrets, [
    {
      purpose: "credential",
      value: rawSecret,
      sourcePath: "$.credentials.<credential>",
    },
  ]);

  const store = new InMemorySecretHandleStore();
  const stored = await persistToolCreationSecrets({
    extractedSecrets: prepared.extractedSecrets,
    toolName: "channel.telegram",
    store,
  });

  assert.deepEqual(stored.map((secret) => secret.handle), [
    "secret.tool.channel.telegram.credential",
  ]);
  assert.equal(await store.resolve?.(stored[0]!.handle), rawSecret);
});

test("tool creation trace payload redacts raw credentials before run storage", () => {
  const rawSecret = "AAF1SV1mdl9QSRliMBjPhP-fX2Z-Icly0AQ";
  const payload = redactToolCreationTracePayload({
    input: {
      request: {
        credentials: {
          "8701832328": rawSecret,
        },
      },
    },
  });
  const serialized = JSON.stringify(payload);

  assert.equal(serialized.includes(rawSecret), false);
  assert.match(serialized, /secret redacted: credential/);
});

test("tool creation adds non-secret credential hints for builder planning", () => {
  const prepared = prepareToolCreationSecrets({
    name: "docs.api.client",
    request: "Build a client for the documented HTTP API.",
    credentials: {
      apiKey: "live_HINT_key_123456789abcdef",
    },
  });

  const input = prepared.input as { request?: string; credentialPurposes?: string[] };

  assert.match(input.request ?? "", /Credential provided through secret handle: api key/);
  assert.deepEqual(input.credentialPurposes, ["api key"]);
  assert.equal(JSON.stringify(prepared.input).includes("live_HINT_key_123456789abcdef"), false);
});

test("tool edit credentials do not hijack mismatched existing API auth", () => {
  const plan = buildToolBuilderPlan({
    name: "crypto.aml.gl",
    request: "Edit an existing Global Ledger API client.",
    kind: "http-json",
    requiredSecretHandles: ["secret.tool.crypto.aml.gl.api-key"],
    integration: {
      schemaVersion: "agentic.tool-integration.v1",
      mode: "run-on-demand",
      protocol: "http-api",
      baseUrl: "https://eth.glprotocol.com/api",
      auth: {
        type: "api-key",
        credentialLocation: "header",
        credentialName: "x-api-key",
        requiredSecretHandles: ["secret.tool.crypto.aml.gl.api-key"],
      },
      operations: [
        {
          name: "getAddressReport",
          direction: "query",
          method: "GET",
          path: "/report/address/{address}",
          requiredSecretHandles: ["secret.tool.crypto.aml.gl.api-key"],
        },
      ],
    },
  });

  const updated = applyStoredSecretsToToolBuilderPlan(plan, [
    {
      handle: "secret.tool.crypto.aml.gl.token",
      purpose: "token",
      sourcePath: "$.credentials",
    },
  ]);

  assert.deepEqual(updated.input.integrationContract?.auth?.requiredSecretHandles, [
    "secret.tool.crypto.aml.gl.api-key",
  ]);
  assert.equal(
    updated.input.requiredSecretHandles?.includes("secret.tool.crypto.aml.gl.token") ?? false,
    false,
  );
});

test("tool edit API key credentials can replace existing API auth", () => {
  const plan = buildToolBuilderPlan({
    name: "weather.lookup",
    request: "Edit an existing API key client.",
    kind: "http-json",
    requiredSecretHandles: ["secret.tool.weather.lookup.api-key"],
    integration: {
      schemaVersion: "agentic.tool-integration.v1",
      mode: "run-on-demand",
      protocol: "http-api",
      auth: {
        type: "api-key",
        credentialLocation: "header",
        credentialName: "x-api-key",
        requiredSecretHandles: ["secret.tool.weather.lookup.api-key"],
      },
      operations: [
        {
          name: "call_api",
          direction: "query",
          method: "GET",
          path: "/weather",
        },
      ],
    },
  });

  const updated = applyStoredSecretsToToolBuilderPlan(plan, [
    {
      handle: "secret.tool.weather.lookup.api-key.2",
      purpose: "api key",
      sourcePath: "$.credentials.apiKey",
    },
  ]);

  assert.deepEqual(updated.input.integrationContract?.auth?.requiredSecretHandles, [
    "secret.tool.weather.lookup.api-key.2",
    "secret.tool.weather.lookup.api-key",
  ]);
});

test("generic credential handles satisfy inferred bot-token auth contracts", () => {
  const plan = buildToolBuilderPlan({
    name: "channel.telegram",
    request: "Create a Telegram bot service adapter.",
  });

  const updated = applyStoredSecretsToToolBuilderPlan(plan, [
    {
      handle: "secret.tool.channel.telegram.credential",
      purpose: "credential",
      sourcePath: "$.credentials.<credential>",
    },
  ]);

  assert.deepEqual(updated.input.integrationContract?.auth?.requiredSecretHandles, [
    "secret.tool.channel.telegram.credential",
  ]);
  assert.equal(updated.input.requiredSecretHandles?.includes("secret.telegram.bot"), false);
  assert.equal(updated.input.requiredSecretHandles?.includes("secret.tool.channel.telegram.credential"), true);
});

test("tool creation does not extract existing handles or env references", () => {
  const prepared = prepareToolCreationSecrets({
    name: "existing.secret.tool",
    request: "Use requiredSecretHandles secret.api.integration and env WEATHER_API_KEY.",
    requiredSecretHandles: ["secret.api.integration"],
    secretRef: "WEATHER_API_KEY",
  });

  assert.deepEqual(prepared.extractedSecrets, []);
  assert.equal(JSON.stringify(prepared.input).includes("secret.api.integration"), true);
  assert.equal(JSON.stringify(prepared.input).includes("WEATHER_API_KEY"), true);
});
