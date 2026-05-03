import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InMemorySecretHandleStore,
  normalizeSecretHandleInput,
  rejectRawSecretPayload,
} from "../src/secrets/secretHandleStore.js";

test("secret handle store keeps refs without storing raw values", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "runtime-secret";
  const store = new InMemorySecretHandleStore();

  const created = await store.create({
    label: "Telegram bot token",
    provider: "env",
    secretRef: "TELEGRAM_BOT_TOKEN",
    scopes: ["instance-local", "tool:channel.telegram.bot"],
  });
  const listed = await store.list();

  assert.equal(created.handle, "secret.telegram.bot.token");
  assert.equal(created.secretRef, "TELEGRAM_BOT_TOKEN");
  assert.equal(listed[0]?.secretRef, "TELEGRAM_BOT_TOKEN");
  assert.equal(JSON.stringify(listed).includes("runtime-secret"), false);
  assert.equal(await store.resolve?.(created.handle), "runtime-secret");
});

test("secret handle store can resolve inline credentials for generated tool QA", async () => {
  const store = new InMemorySecretHandleStore();
  const created = await store.create({
    handle: "secret.api.gl-aml",
    label: "GL AML credentials",
    provider: "inline",
    secretRef: "runtime-inline-key",
    scopes: ["instance-local", "tool:api.gl-aml"],
  });

  assert.equal(created.provider, "inline");
  assert.equal(await store.resolve?.("secret.api.gl-aml"), "runtime-inline-key");
});

test("secret handle validation rejects raw secret payloads and invalid env refs", () => {
  assert.throws(
    () => rejectRawSecretPayload({ token: "do-not-store-me", label: "bad" }),
    /Raw secret values are not accepted/,
  );
  assert.throws(
    () =>
      normalizeSecretHandleInput({
        label: "Bad env",
        provider: "env",
        secretRef: "telegram-token",
      }),
    /environment variable name/,
  );
});
