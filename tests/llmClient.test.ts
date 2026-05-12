import test from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { LlmClient } from "../src/llm/client.js";
import { InMemoryModelTierSettingsStore } from "../src/settings/modelTierSettings.js";

// Phase 22 Slice D — the client uses undici's `fetch` (with a
// long-tail timeout Agent) instead of Node's bundled global fetch,
// so these tests intercept HTTP via undici's MockAgent rather than
// monkey-patching `globalThis.fetch`. Both APIs are spec-compatible
// but they're DIFFERENT undici versions, so mocking one doesn't
// intercept the other.

const BASE_URL = "http://llm.local";

type ScriptedHandler = (init: { body: unknown }) => {
  status: number;
  body: unknown;
};

function withMockedLlm(handler: ScriptedHandler): {
  cleanup: () => Promise<void>;
  requestedModels: string[];
} {
  const previous = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  const pool = mock.get(BASE_URL);
  const requestedModels: string[] = [];
  pool
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply((opts) => {
      const body = JSON.parse(String(opts.body ?? "{}"));
      requestedModels.push(body.model);
      const out = handler({ body });
      return {
        statusCode: out.status,
        data: JSON.stringify(out.body),
        responseOptions: { headers: { "content-type": "application/json" } },
      };
    })
    .persist();
  return {
    cleanup: async () => {
      await mock.close();
      setGlobalDispatcher(previous);
    },
    requestedModels,
  };
}

test("LlmClient uses persisted model tier settings for requests", async () => {
  const mocked = withMockedLlm(() => ({
    status: 200,
    body: { choices: [{ message: { content: "ok" } }] },
  }));
  try {
    const settings = new InMemoryModelTierSettingsStore([
      { tier: "M", models: ["medium-a", "medium-b"], maxAttempts: 2 },
    ]);
    const client = new LlmClient(
      {
        baseUrl: `${BASE_URL}/v1`,
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
    assert.equal(mocked.requestedModels[0], "medium-a");
    assert.deepEqual(await client.modelsForTier("M"), ["medium-a", "medium-b"]);
  } finally {
    await mocked.cleanup();
  }
});

test("LlmClient retries same-tier models then escalates when configured", async () => {
  const mocked = withMockedLlm(({ body }) => {
    const model = (body as { model: string }).model;
    if (model !== "large-a") {
      return { status: 500, body: { error: { message: "model failed" } } };
    }
    return { status: 200, body: { choices: [{ message: { content: "large ok" } }] } };
  });

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
        baseUrl: `${BASE_URL}/v1`,
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
    assert.deepEqual(mocked.requestedModels, [
      "medium-a",
      "medium-a",
      "medium-b",
      "medium-b",
      "large-a",
    ]);
  } finally {
    await mocked.cleanup();
  }
});

test("LlmClient surfaces finish_reason on empty content and stops after one explicit-model attempt", async () => {
  // Phase G follow-up: when the council addresses a specific model
  // (e.g. gemma-4-26b-a4b) and the model returns empty content with
  // finish_reason="length" (context overflow), the client must:
  //   1. call the model exactly ONCE (no duplicate-retry — the
  //      council owns Borda cross-model fallback);
  //   2. include the finish_reason in the error string so the
  //      operator sees overflow vs. refusal in the trace.
  const mocked = withMockedLlm(() => ({
    status: 200,
    body: { choices: [{ message: { content: "" }, finish_reason: "length" }] },
  }));

  try {
    const client = new LlmClient({
      baseUrl: `${BASE_URL}/v1`,
      model: "fallback",
      temperature: 0.2,
      tierModels: {},
      tierModelCandidates: {},
    });

    await assert.rejects(
      () =>
        client.complete([{ role: "user", content: "hello" }], {
          model: "gemma-4-26b-a4b",
        }),
      /gemma-4-26b-a4b: empty assistant content \(finish_reason=length\)/,
    );

    assert.deepEqual(mocked.requestedModels, ["gemma-4-26b-a4b"]);
  } finally {
    await mocked.cleanup();
  }
});

test("LlmClient treats whitespace-only assistant content as empty", async () => {
  // Phase G follow-up: gemma occasionally returns "\n\n" on context
  // overflow. The legacy falsy-check (`!content`) let that through,
  // then `content.trim()` returned "" and a downstream JSON parser
  // crashed with a confusing error. Now the whitespace-only output
  // is bucketed into the same "empty assistant content" error path.
  const mocked = withMockedLlm(() => ({
    status: 200,
    body: { choices: [{ message: { content: "\n\n  \t" } }] },
  }));

  try {
    const client = new LlmClient({
      baseUrl: `${BASE_URL}/v1`,
      model: "fallback",
      temperature: 0.2,
      tierModels: {},
      tierModelCandidates: {},
    });

    await assert.rejects(
      () => client.complete([{ role: "user", content: "hi" }]),
      /fallback: empty assistant content/,
    );
  } finally {
    await mocked.cleanup();
  }
});

test("LlmClient preserves string error bodies from OpenAI-compatible servers", async () => {
  const mocked = withMockedLlm(() => ({
    status: 400,
    body: { error: "n_keep exceeds context length" },
  }));

  try {
    const client = new LlmClient({
      baseUrl: `${BASE_URL}/v1`,
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
    await mocked.cleanup();
  }
});
