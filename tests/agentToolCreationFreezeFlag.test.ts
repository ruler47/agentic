import test from "node:test";
import assert from "node:assert/strict";

import { RunAgentRuntimeHelpers } from "../src/server/modules/runs/run-agent-runtime-helpers.js";
import type { ToolsService } from "../src/server/modules/tools/tools.service.js";

function helperWith(toolsService: unknown): RunAgentRuntimeHelpers {
  // Only toolsService is exercised on the creation path; the rest are unused
  // here, so undefined stubs are safe for this focused unit test.
  return new RunAgentRuntimeHelpers(
    undefined as never,
    undefined,
    undefined as never,
    undefined,
    undefined,
    undefined as never,
    toolsService as ToolsService,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
}

const baseRequest = {
  name: "weather.demo",
  request: "build a weather client",
  capabilities: ["api-client"],
};

test("agent-originated tool creation is blocked unless AGENT_TOOL_CREATION=enabled", async () => {
  delete process.env.AGENT_TOOL_CREATION;
  let createCalled = false;
  const toolsService = {
    listVersions: async () => [],
    createToolPackage: async () => {
      createCalled = true;
      return {} as never;
    },
  };

  const helper = helperWith(toolsService);
  const result = await helper.handleAgentToolCreationRequest(baseRequest as never, undefined);

  assert.equal(createCalled, false, "createToolPackage must not be called when the flag is off");
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "agent_tool_creation_disabled");
});

test("with AGENT_TOOL_CREATION=enabled the creation path runs", async () => {
  process.env.AGENT_TOOL_CREATION = "enabled";
  let createCalled = false;
  const toolsService = {
    listVersions: async () => [],
    createToolPackage: async () => {
      createCalled = true;
      throw new Error("stop after reaching creation");
    },
  };

  const helper = helperWith(toolsService);
  await helper.handleAgentToolCreationRequest(baseRequest as never, undefined).catch(() => undefined);

  assert.equal(createCalled, true, "the creation path is reached when the flag is enabled");
  delete process.env.AGENT_TOOL_CREATION;
});
