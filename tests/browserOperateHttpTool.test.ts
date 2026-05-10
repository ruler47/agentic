import test from "node:test";
import assert from "node:assert/strict";
import { BrowserOperateHttpTool } from "../src/tools/browserOperateHttpTool.js";

function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    return handler(url, init);
  }) as typeof fetch;
}

test("BrowserOperateHttpTool.run forwards POST /run and rehydrates contentBase64 to Buffer", async () => {
  const fetchMock = fakeFetch(async (url, init) => {
    assert.equal(url, "http://test-host/run");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body ?? "{}"));
    assert.deepEqual(body.input, { url: "https://example.com" });
    return new Response(
      JSON.stringify({
        ok: true,
        content: "Captured 1 screenshot",
        data: {
          finalUrl: "https://example.com/",
          steps: [{ index: 0, type: "navigate", status: "completed", summary: "ok", durationMs: 1 }],
          extractedText: [],
          extractedLinks: [],
          screenshots: [
            {
              filename: "shot.png",
              mimeType: "image/png",
              contentBase64: Buffer.from("hello").toString("base64"),
              description: "test",
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const tool = new BrowserOperateHttpTool({ baseUrl: "http://test-host", fetchImpl: fetchMock });
  const result = await tool.run({ url: "https://example.com" });
  assert.equal(result.ok, true);
  assert.match(result.content, /Captured/);
  const data = result.data as { screenshots: Array<{ filename: string; content: Buffer; mimeType: string }> };
  assert.equal(data.screenshots.length, 1);
  assert.equal(data.screenshots[0].filename, "shot.png");
  assert.ok(Buffer.isBuffer(data.screenshots[0].content));
  assert.equal(data.screenshots[0].content.toString("utf8"), "hello");
});

test("BrowserOperateHttpTool.run reports HTTP errors with the error body", async () => {
  const fetchMock = fakeFetch(async () =>
    new Response(JSON.stringify({ error: "browser crashed" }), { status: 500 }),
  );
  const tool = new BrowserOperateHttpTool({ baseUrl: "http://test-host", fetchImpl: fetchMock });
  const result = await tool.run({ url: "https://example.com" });
  assert.equal(result.ok, false);
  assert.match(result.content, /browser crashed/);
});

test("BrowserOperateHttpTool.healthcheck pings /health endpoint", async () => {
  const fetchMock = fakeFetch(async (url) => {
    assert.equal(url, "http://test-host/health");
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  });
  const tool = new BrowserOperateHttpTool({ baseUrl: "http://test-host", fetchImpl: fetchMock });
  const health = await tool.healthcheck();
  assert.equal(health.ok, true);
});
