import test from "node:test";
import assert from "node:assert/strict";
import { LlmClient } from "../src/llm/client.js";
import { InMemoryModelTierSettingsStore } from "../src/settings/modelTierSettings.js";

test("LlmClient uses persisted model tier settings for requests", async () => {
  const originalFetch = globalThis.fetch;
  let requestedModel = "";

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requestedModel = body.model;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const settings = new InMemoryModelTierSettingsStore([
      { tier: "M", models: ["medium-a", "medium-b"], maxAttempts: 2 },
    ]);
    const client = new LlmClient(
      {
        baseUrl: "http://llm.local/v1",
        model: "fallback",
        temperature: 0.2,
        tierModels: {},
        tierModelCandidates: {},
      },
      settings,
    );

    const result = await client.complete([{ role: "user", content: "hello" }], {
      modelTier: "M",
    });

    assert.equal(result, "ok");
    assert.equal(requestedModel, "medium-a");
    assert.deepEqual(await client.modelsForTier("M"), ["medium-a", "medium-b"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LlmClient sends configured reasoning_effort to OpenAI-compatible chat requests", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = new LlmClient({
      baseUrl: "http://llm.local/v1",
      model: "reasoning-local",
      temperature: 0.2,
      reasoningEffort: "none",
      tierModels: {},
      tierModelCandidates: {},
    });

    assert.equal(await client.complete([{ role: "user", content: "hello" }]), "ok");
    await client.completeWithTools([{ role: "user", content: "hello" }], []);

    assert.deepEqual(
      bodies.map((body) => body.reasoning_effort),
      ["none", "none"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LlmClient sends configured max_tokens to normal chat requests", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = new LlmClient({
      baseUrl: "http://llm.local/v1",
      model: "local-small-context",
      temperature: 0.2,
      tierModels: {},
      tierModelCandidates: {},
    });

    assert.equal(await client.complete([{ role: "user", content: "hello" }], { maxTokens: 321 }), "ok");
    assert.equal(body?.max_tokens, 321);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LlmClient retries same-tier models then escalates when configured", async () => {
  const originalFetch = globalThis.fetch;
  const requestedModels: string[] = [];

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requestedModels.push(body.model);

    if (body.model !== "large-a") {
      return new Response(JSON.stringify({ error: { message: "model failed" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ choices: [{ message: { content: "large ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const settings = new InMemoryModelTierSettingsStore([
      {
        tier: "M",
        models: ["medium-a", "medium-b"],
        maxAttempts: 2,
        escalateOnFailure: true,
      },
      {
        tier: "L",
        models: ["large-a"],
        maxAttempts: 1,
        escalateOnFailure: false,
      },
    ]);
    const client = new LlmClient(
      {
        baseUrl: "http://llm.local/v1",
        model: "fallback",
        temperature: 0.2,
        tierModels: {},
        tierModelCandidates: {},
      },
      settings,
    );

    const result = await client.complete([{ role: "user", content: "hello" }], {
      modelTier: "M",
    });

    assert.equal(result, "large ok");
    assert.deepEqual(requestedModels, [
      "medium-a",
      "medium-a",
      "medium-b",
      "medium-b",
      "large-a",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LlmClient does not retry the same model again when escalating tiers", async () => {
  const originalFetch = globalThis.fetch;
  const requestedModels: string[] = [];

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requestedModels.push(body.model);
    return new Response(JSON.stringify({ error: { message: "model failed" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const settings = new InMemoryModelTierSettingsStore([
      {
        tier: "M",
        models: ["shared-model"],
        maxAttempts: 1,
        escalateOnFailure: true,
      },
      {
        tier: "L",
        models: ["shared-model"],
        maxAttempts: 1,
        escalateOnFailure: true,
      },
      {
        tier: "XL",
        models: ["shared-model"],
        maxAttempts: 1,
        escalateOnFailure: false,
      },
    ]);
    const client = new LlmClient(
      {
        baseUrl: "http://llm.local/v1",
        model: "fallback",
        temperature: 0.2,
        tierModels: {},
        tierModelCandidates: {},
      },
      settings,
    );

    await assert.rejects(
      () => client.complete([{ role: "user", content: "hello" }], { modelTier: "M" }),
      /shared-model: model failed/,
    );

    assert.deepEqual(requestedModels, ["shared-model"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LlmClient preserves string error bodies from OpenAI-compatible servers", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "n_keep exceeds context length" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });

  try {
    const client = new LlmClient({
      baseUrl: "http://llm.local/v1",
      model: "local-small-context",
      temperature: 0.2,
      tierModels: {},
      tierModelCandidates: {},
    });

    await assert.rejects(
      () => client.complete([{ role: "user", content: "hello" }]),
      /local-small-context: n_keep exceeds context length/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LlmClient accepts LM Studio reasoning_content when assistant content is empty", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "", reasoning_content: "usable local text" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    const client = new LlmClient({
      baseUrl: "http://llm.local/v1",
      model: "reasoning-local",
      temperature: 0.2,
      tierModels: {},
      tierModelCandidates: {},
    });

    assert.equal(await client.complete([{ role: "user", content: "hello" }]), "usable local text");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LlmClient tool completion accepts LM Studio reasoning_content when assistant content is empty", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "", reasoning_content: "usable tool text" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    const client = new LlmClient({
      baseUrl: "http://llm.local/v1",
      model: "reasoning-local",
      temperature: 0.2,
      tierModels: {},
      tierModelCandidates: {},
    });

    const reply = await client.completeWithTools([{ role: "user", content: "hello" }], []);
    assert.equal(reply.content, "usable tool text");
    assert.deepEqual(reply.toolCalls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LlmClient times out stalled model requests", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason ?? new Error("aborted"));
      });
    });

  try {
    const client = new LlmClient({
      baseUrl: "http://llm.local/v1",
      model: "slow-local",
      temperature: 0.2,
      requestTimeoutMs: 5,
      tierModels: {},
      tierModelCandidates: {},
    });

    await assert.rejects(
      () => client.complete([{ role: "user", content: "hello" }]),
      /slow-local: LLM request timed out after 5ms/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
