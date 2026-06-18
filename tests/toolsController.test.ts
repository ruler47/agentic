import test from "node:test";
import assert from "node:assert/strict";
import { ToolsController } from "../src/server/modules/tools/tools.controller.js";

test("ToolsController routes version activation through ToolsService lifecycle wrapper", async () => {
  const calls: Array<{ name: string; body: unknown }> = [];
  const tools = {
    async activateVersion(name: string, body: unknown) {
      calls.push({ name, body });
      return { name, version: (body as { version: string }).version };
    },
  };
  const lifecycle = {
    async activateVersion() {
      throw new Error("controller bypassed ToolsService");
    },
  };
  const controller = new ToolsController(
    tools as never,
    {} as never,
    {} as never,
    {} as never,
    lifecycle as never,
  );

  const body = { version: "0.1.5" };
  const response = await controller.activateVersion("channel.telegram", body);

  assert.deepEqual(calls, [{ name: "channel.telegram", body }]);
  assert.deepEqual(response, { tool: { name: "channel.telegram", version: "0.1.5" } });
});

test("ToolsController routes replacement promotion through ToolsService lifecycle wrapper", async () => {
  const calls: Array<{ name: string; body: unknown }> = [];
  const tools = {
    async promoteReplacement(name: string, body: unknown) {
      calls.push({ name, body });
      return { name, version: (body as { version: string }).version };
    },
  };
  const lifecycle = {
    async promoteReplacement() {
      throw new Error("controller bypassed ToolsService");
    },
  };
  const controller = new ToolsController(
    tools as never,
    {} as never,
    {} as never,
    {} as never,
    lifecycle as never,
  );

  const body = { version: "0.2.0" };
  const response = await controller.promoteReplacement("channel.telegram", body);

  assert.deepEqual(calls, [{ name: "channel.telegram", body }]);
  assert.deepEqual(response, { tool: { name: "channel.telegram", version: "0.2.0" } });
});
