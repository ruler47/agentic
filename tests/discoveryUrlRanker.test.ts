import test from "node:test";
import assert from "node:assert/strict";
import { rankDiscoveryUrls } from "../src/agents/discoveryUrlRanker.js";
import type { LlmClient } from "../src/llm/client.js";
import type { Message } from "../src/types.js";

class FakeLlm implements Pick<LlmClient, "complete"> {
  public lastMessages: Message[] | undefined;
  constructor(private readonly response: string | (() => string | Promise<string>)) {}
  async complete(messages: Message[]): Promise<string> {
    this.lastMessages = messages;
    return typeof this.response === "function" ? await this.response() : this.response;
  }
}

const baseInput = {
  subtask: { title: "Test", prompt: "Pick a great laptop" },
  candidateUrls: [
    "https://www.pccomponentes.com/laptops",
    "https://www.amazon.es/laptops",
    "https://www.bbc.com/news",
  ],
  candidateContext: "",
  intents: [] as string[],
  limit: 2,
};

test("rankDiscoveryUrls: empty candidates always returns heuristic", async () => {
  const out = await rankDiscoveryUrls(
    { ...baseInput, candidateUrls: [] },
    { llm: new FakeLlm("{}") as unknown as LlmClient, fallback: () => [] },
  );
  assert.equal(out.source, "heuristic");
  assert.deepEqual(out.selected, []);
});

test("rankDiscoveryUrls: env=disabled forces heuristic without calling LLM", async () => {
  let called = false;
  const llm = new FakeLlm(() => {
    called = true;
    return "{}";
  });
  const out = await rankDiscoveryUrls(baseInput, {
    llm: llm as unknown as LlmClient,
    fallback: (limit) => baseInput.candidateUrls.slice(0, limit),
    envValue: "disabled",
  });
  assert.equal(called, false);
  assert.equal(out.source, "heuristic");
  assert.equal(out.reason, "URL_RANKER_LLM=disabled");
  assert.deepEqual(out.selected, baseInput.candidateUrls.slice(0, 2));
});

test("rankDiscoveryUrls: no LLM client falls back without crashing", async () => {
  const out = await rankDiscoveryUrls(baseInput, {
    fallback: (limit) => baseInput.candidateUrls.slice(0, limit),
  });
  assert.equal(out.source, "heuristic");
});

test("rankDiscoveryUrls: single candidate skips LLM", async () => {
  let called = false;
  const llm = new FakeLlm(() => {
    called = true;
    return "{}";
  });
  const out = await rankDiscoveryUrls(
    { ...baseInput, candidateUrls: ["https://only.example/a"] },
    { llm: llm as unknown as LlmClient, fallback: () => [] },
  );
  assert.equal(called, false);
  assert.deepEqual(out.selected, ["https://only.example/a"]);
});

test("rankDiscoveryUrls: LLM picks the relevant URL and rejects irrelevant one", async () => {
  const response = JSON.stringify({
    selected: [
      "https://www.pccomponentes.com/laptops",
      "https://www.amazon.es/laptops",
    ],
    rejected: [
      { url: "https://www.bbc.com/news", reason: "Off-topic news article, not a laptop catalog" },
    ],
  });
  const llm = new FakeLlm(response);
  const out = await rankDiscoveryUrls(baseInput, {
    llm: llm as unknown as LlmClient,
    fallback: () => [],
  });
  assert.equal(out.source, "llm");
  assert.deepEqual(out.selected, [
    "https://www.pccomponentes.com/laptops",
    "https://www.amazon.es/laptops",
  ]);
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].url, "https://www.bbc.com/news");
});

test("rankDiscoveryUrls: LLM-fabricated URLs not in candidate list are dropped", async () => {
  const response = JSON.stringify({
    selected: [
      "https://hallucinated.example/totally-made-up",
      "https://www.amazon.es/laptops",
    ],
    rejected: [],
  });
  const llm = new FakeLlm(response);
  const out = await rankDiscoveryUrls(baseInput, {
    llm: llm as unknown as LlmClient,
    fallback: (l) => baseInput.candidateUrls.slice(0, l),
  });
  assert.equal(out.source, "llm");
  assert.deepEqual(out.selected, ["https://www.amazon.es/laptops"]);
});

test("rankDiscoveryUrls: malformed JSON falls back to heuristic", async () => {
  const llm = new FakeLlm("not json at all");
  const out = await rankDiscoveryUrls(baseInput, {
    llm: llm as unknown as LlmClient,
    fallback: (l) => baseInput.candidateUrls.slice(0, l),
  });
  assert.equal(out.source, "heuristic");
  assert.match(out.reason ?? "", /parseable JSON/);
});

test("rankDiscoveryUrls: LLM failure falls back to heuristic with reason", async () => {
  const llm = new FakeLlm(async () => {
    throw new Error("network unreachable");
  });
  const out = await rankDiscoveryUrls(baseInput, {
    llm: llm as unknown as LlmClient,
    fallback: (l) => baseInput.candidateUrls.slice(0, l),
  });
  assert.equal(out.source, "heuristic");
  assert.match(out.reason ?? "", /LLM call failed.*network unreachable/);
});

test("rankDiscoveryUrls: prompt contains subtask title and candidate previews", async () => {
  const llm = new FakeLlm(JSON.stringify({ selected: ["https://www.pccomponentes.com/laptops"] }));
  await rankDiscoveryUrls(
    {
      ...baseInput,
      subtask: { title: "Find best laptop", prompt: "Compare gaming laptops" },
      candidatePreviews: {
        "https://www.pccomponentes.com/laptops": "Spanish PC retailer",
        "https://www.amazon.es/laptops": "Generic ecommerce",
      },
    },
    { llm: llm as unknown as LlmClient, fallback: () => [] },
  );
  const userMessage = llm.lastMessages?.find((m) => m.role === "user");
  assert.ok(userMessage);
  assert.match(userMessage.content as string, /Find best laptop/);
  assert.match(userMessage.content as string, /Compare gaming laptops/);
  assert.match(userMessage.content as string, /Spanish PC retailer/);
});
