import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/registry.js";

test("ToolRegistry registers, lists, and retrieves tools", async () => {
  const registry = new ToolRegistry();
  const tool = {
    name: "echo",
    description: "Returns the input message.",
    async run(input: Record<string, unknown>) {
      return { ok: true, content: String(input.message ?? "") };
    },
  };

  registry.register(tool);

  assert.deepEqual(
    registry.list().map((item) => item.name),
    ["echo"],
  );
  assert.equal(registry.get("echo"), tool);
  assert.deepEqual(await registry.get("echo")?.run({ message: "hello" }), {
    ok: true,
    content: "hello",
  });
});
