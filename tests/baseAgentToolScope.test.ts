import test from "node:test";
import assert from "node:assert/strict";

import { scopedToolsForTaskFrame } from "../src/agents/baseAgentToolScope.js";
import { inferExplicitToolNeed } from "../src/agents/baseAgentToolChoice.js";
import { frameTask } from "../src/agents/taskFrame.js";
import type { Tool } from "../src/tools/tool.js";

function tool(name: string, capabilities: string[]): Tool {
  return {
    name,
    version: "1.0.0",
    description: name,
    capabilities,
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {} },
    async run() {
      return { ok: true, content: "ok" };
    },
  };
}

test("product-selection LLM tool scope includes source/proof tools and excludes unrelated tools", () => {
  const tools = [
    tool("web.search", ["web-search"]),
    tool("web.read", ["web-read"]),
    tool("browser.screenshot", ["browser-screenshot"]),
    tool("browser.operate", ["browser-operate"]),
    tool("file.read", ["file-read"]),
    tool("external.action.prepare", ["external-action-prepare"]),
  ];
  const taskFrame = frameTask("Подбери 2-3 варианта ноутбуков для локальных LLM и игр до 2500 долларов, актуально сейчас.");
  const scope = scopedToolsForTaskFrame({
    tools,
    toolCatalog: tools.map((candidate) => ({
      name: candidate.name,
      version: candidate.version,
      description: candidate.description,
      capabilities: candidate.capabilities,
    })),
    taskFrame,
    hasRunScopedCandidates: false,
  });

  assert.deepEqual(scope.tools.map((candidate) => candidate.name), [
    "web.search",
    "web.read",
    "browser.screenshot",
  ]);
});

test("explicit screenshot requests receive screenshot tools without expanding to the full catalog", () => {
  const tools = [
    tool("browser.screenshot", ["browser-screenshot"]),
    tool("browser.operate", ["browser-operate"]),
    tool("file.read", ["file-read"]),
    tool("web.search", ["web-search"]),
  ];
  const task = "Сделай скриншот после появления селектора";
  const scope = scopedToolsForTaskFrame({
    tools,
    toolCatalog: tools.map((candidate) => ({
      name: candidate.name,
      version: candidate.version,
      description: candidate.description,
      capabilities: candidate.capabilities,
    })),
    taskFrame: frameTask(task),
    hasRunScopedCandidates: false,
    explicitToolNeed: inferExplicitToolNeed(task),
  });

  assert.equal(scope.noToolOnly, false);
  assert.deepEqual(scope.tools.map((candidate) => candidate.name), ["browser.screenshot"]);
});
