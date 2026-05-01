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
