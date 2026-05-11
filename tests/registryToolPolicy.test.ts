import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/tool.js";

const stub = (name: string, capabilities: string[]): Tool =>
  ({
    name,
    version: "1.0.0",
    description: `${name} stub`,
    capabilities,
    startupMode: "on-demand",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {} },
    healthcheck: async () => ({ ok: true, detail: "stub" }),
    run: async () => ({ ok: true, content: "stub" }),
  }) as unknown as Tool;

test("findByCapability with denied policy filters out the denied tool", () => {
  const registry = new ToolRegistry();
  registry.register(stub("web.search", ["web-search"]));
  registry.register(stub("web.duckduckgo", ["web-search-duckduckgo"]));

  const matches = registry.findByCapability("web-search", { denied: ["web.search"] });
  assert.deepEqual(
    matches.map((t) => t.name),
    ["web.duckduckgo"],
  );
});

test("findByCapability with preferred policy promotes preferred tools to the front", () => {
  const registry = new ToolRegistry();
  registry.register(stub("web.search", ["web-search"]));
  registry.register(stub("web.duckduckgo", ["web-search-duckduckgo"]));
  registry.register(stub("web.google", ["web-search-google"]));

  const matches = registry.findByCapability("web-search", { preferred: ["web.duckduckgo"] });
  assert.deepEqual(
    matches.map((t) => t.name),
    ["web.duckduckgo", "web.search", "web.google"],
  );
});

test("findByCapability respects preferred order when multiple are listed", () => {
  const registry = new ToolRegistry();
  registry.register(stub("web.a", ["web-search-a"]));
  registry.register(stub("web.b", ["web-search-b"]));
  registry.register(stub("web.c", ["web-search-c"]));

  const matches = registry.findByCapability("web-search", { preferred: ["web.c", "web.a"] });
  assert.deepEqual(
    matches.map((t) => t.name),
    ["web.c", "web.a", "web.b"],
  );
});

test("findByCapability with both denied and preferred applies both rules", () => {
  const registry = new ToolRegistry();
  registry.register(stub("web.search", ["web-search"]));
  registry.register(stub("web.duckduckgo", ["web-search-duckduckgo"]));
  registry.register(stub("web.google", ["web-search-google"]));

  const matches = registry.findByCapability("web-search", {
    denied: ["web.search"],
    preferred: ["web.duckduckgo"],
  });
  assert.deepEqual(
    matches.map((t) => t.name),
    ["web.duckduckgo", "web.google"],
  );
});

test("findByCapability with empty policy returns same as no-policy call", () => {
  const registry = new ToolRegistry();
  registry.register(stub("web.search", ["web-search"]));
  registry.register(stub("web.duckduckgo", ["web-search-duckduckgo"]));

  const a = registry.findByCapability("web-search").map((t) => t.name);
  const b = registry.findByCapability("web-search", {}).map((t) => t.name);
  const c = registry.findByCapability("web-search", { denied: [], preferred: [] }).map((t) => t.name);
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
});
