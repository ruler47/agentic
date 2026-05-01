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
