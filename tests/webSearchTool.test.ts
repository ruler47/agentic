import test from "node:test";
import assert from "node:assert/strict";
import { WebSearchTool, shouldUseWebSearch } from "../src/tools/webSearchTool.js";

test("shouldUseWebSearch detects research-oriented tasks", () => {
  assert.equal(shouldUseWebSearch("найди города Испании с аэропортом"), true);
  assert.equal(shouldUseWebSearch("format this JSON"), false);
});

test("WebSearchTool formats SearXNG results", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/search");
    assert.equal(url.searchParams.get("format"), "json");

    return new Response(
      JSON.stringify({
        results: [
          {
            title: "Barcelona tech hub",
            url: "https://example.com/barcelona",
            content: "Barcelona has a large technology ecosystem.",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const tool = new WebSearchTool("http://search.local");
    const result = await tool.run({ query: "Barcelona IT sector", limit: 1 });

    assert.equal(result.ok, true);
    assert.match(result.content, /Barcelona tech hub/);
    assert.match(result.content, /https:\/\/example.com\/barcelona/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("WebSearchTool exposes module metadata and healthcheck", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("ok", { status: 200 });

  try {
    const tool = new WebSearchTool("http://search.local");
    const health = await tool.healthcheck();

    assert.equal(tool.version, "1.0.0");
    assert.equal(tool.startupMode, "always-on");
    assert.equal(tool.inputSchema.required?.includes("query"), true);
    assert.equal(health.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
