import test from "node:test";
import assert from "node:assert/strict";
import {
  decorateCatalogModel,
  filterCatalogModelsByCapability,
  inferModelCapabilities,
  parseModelCapabilityOverrides,
} from "../src/settings/modelCatalog.js";

test("inferModelCapabilities separates embedding models from chat models", () => {
  assert.deepEqual(inferModelCapabilities("text-embedding-nomic-embed-text-v1.5"), ["embedding"]);
  assert.deepEqual(inferModelCapabilities("text-embedding-embeddinggemma-300m-qat"), ["embedding"]);
});

test("inferModelCapabilities marks reasoning, coding, and vision candidates", () => {
  assert.deepEqual(inferModelCapabilities("qwen/qwen3.6-35b-a3b"), [
    "chat",
    "reasoning",
    "tool-calling",
  ]);
  assert.ok(inferModelCapabilities("qwen/qwen3-coder-next").includes("coding"));
  assert.ok(inferModelCapabilities("qwen/qwen2.5-vl-32b").includes("vision"));
});

test("filterCatalogModelsByCapability returns only matching inferred models", () => {
  const models = [
    decorateCatalogModel({ id: "qwen/qwen3.6-35b-a3b" }),
    decorateCatalogModel({ id: "text-embedding-nomic-embed-text-v1.5" }),
  ];

  assert.deepEqual(filterCatalogModelsByCapability(models, "chat").map((model) => model.id), [
    "qwen/qwen3.6-35b-a3b",
  ]);
  assert.deepEqual(filterCatalogModelsByCapability(models, "embedding").map((model) => model.id), [
    "text-embedding-nomic-embed-text-v1.5",
  ]);
});

test("operator capability overrides add vision to ambiguous local model ids", () => {
  const overrides = parseModelCapabilityOverrides(
    "qwen/qwen3.6-35b-a3b=vision,reasoning,tool-calling;google/gemma-4-26b-a4b=vision",
  );

  const qwen = decorateCatalogModel({ id: "qwen/qwen3.6-35b-a3b" }, overrides);
  const gemma = decorateCatalogModel({ id: "google/gemma-4-26b-a4b" }, overrides);

  assert.equal(qwen.capabilitySource, "operator");
  assert.ok(qwen.capabilities.includes("vision"));
  assert.ok(qwen.capabilities.includes("reasoning"));
  assert.equal(gemma.capabilitySource, "operator");
  assert.ok(gemma.capabilities.includes("vision"));
});

test("operator capability overrides do not convert embedding models into chat models", () => {
  const overrides = parseModelCapabilityOverrides("text-embedding-nomic-embed-text-v1.5=vision,chat");
  const model = decorateCatalogModel({ id: "text-embedding-nomic-embed-text-v1.5" }, overrides);

  assert.deepEqual(model.capabilities, ["embedding"]);
});
