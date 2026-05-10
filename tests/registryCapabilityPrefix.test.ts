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

test("findByCapability returns literal-match tools first, prefix matches after", () => {
  const registry = new ToolRegistry();
  registry.register(stub("web.search", ["web-search", "research"]));
  registry.register(stub("web.duckduckgo", ["web-search-duckduckgo"]));
  registry.register(stub("web.google", ["web-search-google"]));

  const matches = registry.findByCapability("web-search");
  assert.equal(matches.length, 3, `expected all three to match, got ${matches.map((t) => t.name)}`);
  assert.equal(matches[0]!.name, "web.search", "literal-match comes first");
  // The two prefix matches preserve registration order:
  assert.deepEqual(
    matches.slice(1).map((t) => t.name),
    ["web.duckduckgo", "web.google"],
  );
});

test("findByCapability with no literal match still returns prefix matches", () => {
  const registry = new ToolRegistry();
  registry.register(stub("web.duckduckgo", ["web-search-duckduckgo"]));
  registry.register(stub("web.google", ["web-search-google"]));

  const matches = registry.findByCapability("web-search");
  assert.deepEqual(
    matches.map((t) => t.name),
    ["web.duckduckgo", "web.google"],
  );
});

test("findByCapability does NOT match unrelated capabilities", () => {
  const registry = new ToolRegistry();
  registry.register(stub("chart.generate", ["chart-generation"]));
  registry.register(stub("market.timeseries", ["market-timeseries"]));

  assert.equal(registry.findByCapability("web-search").length, 0);
});

test("findByCapability prefix match requires the dash separator", () => {
  // `web-search` should not match `websearch` (no dash) or `web-search2`
  // (the dash must be the literal `<capability>-` prefix).
  const registry = new ToolRegistry();
  registry.register(stub("a", ["websearchnodash"]));
  registry.register(stub("b", ["web-searchextension"]));
  registry.register(stub("c", ["web-search-real"]));

  const matches = registry.findByCapability("web-search");
  assert.deepEqual(
    matches.map((t) => t.name),
    ["c"],
    "only the canonically-prefixed capability counts",
  );
});
