import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultModelProvidersFromEnv,
  InMemoryModelProviderStore,
  normalizeProviderInput,
} from "../src/settings/modelProviderStore.js";

test("defaultModelProvidersFromEnv separates chat and embedding providers", () => {
  const providers = defaultModelProvidersFromEnv({
    LLM_BASE_URL: "http://localhost:1234/v1",
    LLM_MODEL: "local-chat",
    LLM_MODEL_TIER_M: "medium-a, medium-b",
    EMBEDDING_MODEL: "embed-large",
    EMBEDDING_BASE_URL: "http://localhost:1235/v1",
    MEMORY_EMBEDDING_DIMENSIONS: "1536",
  });

  const chat = providers.find((provider) => provider.kind === "chat");
  const embedding = providers.find((provider) => provider.kind === "embedding");

  assert.equal(chat?.baseUrl, "http://localhost:1234/v1");
  assert.deepEqual(chat?.modelIds, ["local-chat", "medium-a", "medium-b"]);
  assert.equal(embedding?.providerType, "openai-compatible");
  assert.equal(embedding?.defaultModel, "embed-large");
  assert.equal(
    embedding?.dimensions,
    128,
    "durable memory embeddings must match the current pgvector column width",
  );
});

test("normalizeProviderInput validates provider shape and clamps embedding dimensions", () => {
  const provider = normalizeProviderInput(
    {
      label: " Remote GPT ",
      kind: "embedding",
      providerType: "openai-compatible",
      baseUrl: "https://api.example.test/v1",
      modelIds: [" text-embedding ", "text-embedding"],
      dimensions: 99999,
    },
    "2026-05-01T00:00:00.000Z",
    "2026-05-01T00:00:00.000Z",
  );

  assert.equal(provider.id, "remote-gpt");
  assert.deepEqual(provider.modelIds, ["text-embedding"]);
  assert.equal(provider.dimensions, 8192);
});

test("InMemoryModelProviderStore supports CRUD lifecycle", async () => {
  const store = new InMemoryModelProviderStore([]);

  const created = await store.create({
    id: "openai-prod",
    label: "OpenAI prod",
    kind: "chat",
    providerType: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    modelIds: ["gpt-5.2"],
    apiKeySecretHandle: "openai-prod-key",
  });
  const updated = await store.update(created.id, {
    status: "disabled",
    modelIds: ["gpt-5.2", "gpt-5.2-mini"],
  });
  const deleted = await store.delete(created.id);

  assert.equal(created.defaultModel, "gpt-5.2");
  assert.equal(updated.status, "disabled");
  assert.equal(updated.apiKeySecretHandle, "openai-prod-key");
  assert.deepEqual(updated.modelIds, ["gpt-5.2", "gpt-5.2-mini"]);
  assert.equal(deleted, true);
  assert.deepEqual(await store.list(), []);
});
