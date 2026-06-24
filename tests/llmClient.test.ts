import test from "node:test";
import assert from "node:assert/strict";
import { LlmClient } from "../src/llm/client.js";
import { InMemoryModelProfileStore } from "../src/settings/modelProfileStore.js";
import { InMemoryModelTierSettingsStore } from "../src/settings/modelTierSettings.js";
import type { ModelRouteDecision } from "../src/settings/modelRouting.js";

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

test("LlmClient exposes provider token usage for text completions", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        model: "usage-model",
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );

  try {
    const client = new LlmClient({
      baseUrl: "http://llm.local/v1",
      model: "fallback",
      temperature: 0.2,
      tierModels: {},
      tierModelCandidates: {},
    });

    const result = await client.completeDetailed([{ role: "user", content: "hello" }]);

    assert.equal(result.content, "ok");
    assert.equal(result.model, "usage-model");
    assert.deepEqual(result.usage, {
      promptTokens: 12,
      completionTokens: 5,
      totalTokens: 17,
      source: "provider",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LlmClient exposes provider token usage for tool completions", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        model: "tool-model",
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "finish", arguments: "{\"answer\":\"ok\"}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );

  try {
    const client = new LlmClient({
      baseUrl: "http://llm.local/v1",
      model: "fallback",
      temperature: 0.2,
      tierModels: {},
      tierModelCandidates: {},
    });

    const result = await client.completeWithTools([{ role: "user", content: "hello" }], []);

    assert.equal(result.model, "tool-model");
    assert.equal(result.finishReason, "tool_calls");
    assert.deepEqual(result.usage, {
      promptTokens: 20,
      completionTokens: 8,
      totalTokens: 28,
      source: "provider",
    });
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

test("LlmClient filters tier candidates by required capability before requesting a model", async () => {
  const originalFetch = globalThis.fetch;
  const requestedModels: string[] = [];
  let routeDecision: ModelRouteDecision | undefined;

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requestedModels.push(body.model);
    return new Response(JSON.stringify({ choices: [{ message: { content: "vision ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const settings = new InMemoryModelTierSettingsStore([
      {
        tier: "M",
        models: ["plain-text-model"],
        maxAttempts: 1,
        escalateOnFailure: true,
      },
      {
        tier: "L",
        models: ["qwen/qwen2.5-vl-32b"],
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

    const result = await client.complete([{ role: "user", content: "describe image" }], {
      modelTier: "M",
      requiredCapabilities: ["vision"],
      onRouteDecision: (decision) => {
        routeDecision = decision;
      },
    });

    assert.equal(result, "vision ok");
    assert.deepEqual(requestedModels, ["qwen/qwen2.5-vl-32b"]);
    assert.equal(routeDecision?.selectedTier, "L");
    assert.equal(routeDecision?.fallbackUsed, true);
    assert.deepEqual(
      routeDecision?.rejectedCandidates.map((candidate) => candidate.reason),
      ["missing vision"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LlmClient reports a clear blocker when no tier candidate has a required capability", async () => {
  const settings = new InMemoryModelTierSettingsStore([
    {
      tier: "M",
      models: ["plain-text-model"],
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
    () =>
      client.complete([{ role: "user", content: "repair code" }], {
        modelTier: "M",
        requiredCapabilities: ["coding"],
      }),
    /No compatible LLM model found for tier M requiring coding.*plain-text-model \(missing coding\)/,
  );
});

test("LlmClient uses durable model profile capabilities and disabled state for routing", async () => {
  const originalFetch = globalThis.fetch;
  const requestedModels: string[] = [];

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requestedModels.push(body.model);
    return new Response(JSON.stringify({ choices: [{ message: { content: "profile ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const settings = new InMemoryModelTierSettingsStore([
      {
        tier: "M",
        models: ["plain-disabled", "plain-enabled"],
        maxAttempts: 1,
        escalateOnFailure: false,
      },
    ]);
    const profiles = new InMemoryModelProfileStore([
      {
        providerId: "local-chat",
        modelId: "plain-disabled",
        enabled: false,
        capabilities: ["chat", "vision"],
        capabilitiesOverridden: true,
      },
      {
        providerId: "local-chat",
        modelId: "plain-enabled",
        capabilities: ["chat", "vision"],
        capabilitiesOverridden: true,
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
      profiles,
    );

    const result = await client.complete([{ role: "user", content: "describe image" }], {
      modelTier: "M",
      requiredCapabilities: ["vision"],
    });

    assert.equal(result, "profile ok");
    assert.deepEqual(requestedModels, ["plain-enabled"]);
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
