import test from "node:test";
import assert from "node:assert/strict";
import { frameTask, researchContractRepairInstructionForModel } from "../src/agents/taskFrame.js";

test("requirements questions do not trigger broad research repair", () => {
  const taskFrame = frameTask("Какие тебе от меня данные нужны чтобы забронировать?");

  assert.equal(taskFrame.mode, "direct_fact");
  assert.equal(taskFrame.researchDepth, "none");
  assert.equal(taskFrame.externalActionPolicy, undefined);
  assert.equal(taskFrame.researchContract.minResearchToolCalls, 0);
  assert.equal(taskFrame.researchContract.minIndependentSourceUrls, 0);
  assert.equal(taskFrame.researchContract.minSourceReadToolCalls, 0);
});

test("research contract repair forces source-read before broad-task finish", () => {
  const taskFrame = frameTask("сравни актуальные цены ресторанов и вилл для праздника");
  const instruction = researchContractRepairInstructionForModel({
    taskFrame,
    finalAnswer: "Черновик ответа.",
    sourceUrls: [
      "https://example.com/restaurant-prices",
      "https://example.com/villa-prices",
    ],
    successfulResearchToolCalls: 4,
    successfulSourceReadToolCalls: 0,
    attemptedToolCalls: 4,
    tools: [
      {
        name: "web.read",
        version: "0.1.0",
        description: "Read web pages",
        capabilities: ["web-read"],
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: {} },
        run: async () => ({ ok: true, content: "ok" }),
      },
    ],
  });

  assert.match(instruction ?? "", /next tool call must be a source read\/extract call/i);
  assert.match(instruction ?? "", /web\.read/);
  assert.match(instruction ?? "", /Do not call web\.search again/i);
  assert.match(instruction ?? "", /example\.com\/restaurant-prices/);
});
