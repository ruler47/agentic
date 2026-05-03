import test from "node:test";
import assert from "node:assert/strict";
import {
  createDeterministicTextEmbedding,
  createTextEmbeddingProviderFromEnv,
  DeterministicTextEmbeddingProvider,
  formatPgVector,
  FallbackTextEmbeddingProvider,
  memoryEmbeddingText,
  OpenAiCompatibleTextEmbeddingProvider,
  projectEmbedding,
} from "../src/memory/textEmbedding.js";

test("deterministic text embeddings are stable normalized pgvector payloads", () => {
  const first = createDeterministicTextEmbedding("Concise practical Spain household answers");
  const second = createDeterministicTextEmbedding("Concise practical Spain household answers");

  assert.equal(first.dimensions, 128);
  assert.deepEqual(first.values, second.values);
  assert.match(formatPgVector(first), /^\[-?[0-9.,-]+/);
  assert.equal(first.values.some((value) => value !== 0), true);
  const magnitude = Math.sqrt(first.values.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(magnitude - 1) < 0.00001);
});

test("memory embedding text includes tags and evidence", () => {
  const text = memoryEmbeddingText({
    title: "Short Spanish answers",
    tags: ["preference", "spain"],
    summary: "User wants concise answers.",
    reusableProcedure: "Keep replies practical.",
    evidence: ["Requested in a completed run."],
  });

  assert.match(text, /preference spain/);
  assert.match(text, /Requested in a completed run/);
});

test("projectEmbedding compresses arbitrary provider dimensions into the pgvector size", () => {
  const projected = projectEmbedding({ dimensions: 5, values: [1, 2, 3, 4, 5] }, 3);

  assert.equal(projected.dimensions, 3);
  assert.equal(projected.values.length, 3);
  const magnitude = Math.sqrt(projected.values.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(magnitude - 1) < 0.00001);
});

test("OpenAiCompatibleTextEmbeddingProvider calls /embeddings and projects the result", async () => {
  const calls: Array<{ url: string; body: unknown; authorization?: string }> = [];
  const provider = new OpenAiCompatibleTextEmbeddingProvider({
    baseUrl: "https://models.example.test/v1/",
    model: "text-embedding-test",
    apiKey: "secret-key",
    targetDimensions: 4,
    fetchImpl: (async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        authorization: (init?.headers as Record<string, string>)?.authorization,
      });
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4, 0.5] }] }));
    }) as typeof fetch,
  });

  const embedding = await provider.embed("Spanish pharmacy preference");

  assert.equal(calls[0]?.url, "https://models.example.test/v1/embeddings");
  assert.deepEqual(calls[0]?.body, {
    model: "text-embedding-test",
    input: "Spanish pharmacy preference",
  });
  assert.equal(calls[0]?.authorization, "Bearer secret-key");
  assert.equal(embedding.dimensions, 4);
  assert.equal(embedding.values.length, 4);
});

test("FallbackTextEmbeddingProvider keeps memory writes working when remote embeddings fail", async () => {
  const provider = new FallbackTextEmbeddingProvider(
    {
      name: "broken-remote",
      dimensions: 128,
      async embed() {
        throw new Error("remote down");
      },
    },
    new DeterministicTextEmbeddingProvider(128),
  );

  const embedding = await provider.embed("fallback embedding");

  assert.equal(embedding.dimensions, 128);
  assert.equal(embedding.values.some((value) => value !== 0), true);
});

test("createTextEmbeddingProviderFromEnv defaults to deterministic unless embedding model is configured", () => {
  const fallback = createTextEmbeddingProviderFromEnv({});
  const remote = createTextEmbeddingProviderFromEnv({
    EMBEDDING_MODEL: "text-embedding-3-small",
    EMBEDDING_BASE_URL: "https://api.openai.example/v1",
    MEMORY_EMBEDDING_DIMENSIONS: "128",
  });

  assert.equal(fallback.name, "deterministic-local");
  assert.match(remote.name, /openai-compatible:text-embedding-3-small/);
});
