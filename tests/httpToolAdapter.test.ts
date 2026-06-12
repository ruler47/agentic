import test from "node:test";
import assert from "node:assert/strict";
import { HttpToolAdapter } from "../src/tools/httpToolAdapter.js";

function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    return handler(url, init);
  }) as typeof fetch;
}

test("HttpToolAdapter.run forwards POST /run and returns parsed result", async () => {
  const fetchMock = fakeFetch(async (url) => {
    assert.equal(url, "http://my-tool:8080/run");
    return new Response(JSON.stringify({ ok: true, content: "did the thing" }), { status: 200 });
  });
  const tool = new HttpToolAdapter({
    name: "my.tool",
    version: "1.0.0",
    description: "x",
    capabilities: ["x"],
    baseUrl: "http://my-tool:8080",
    fetchImpl: fetchMock,
  });
  const r = await tool.run({ x: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.content, "did the thing");
});

test("HttpToolAdapter rehydrates contentBase64 → Buffer in nested data", async () => {
  const fetchMock = fakeFetch(async () =>
    new Response(JSON.stringify({
      ok: true,
      content: "x",
      data: { artifact: { filename: "a.svg", mimeType: "image/svg+xml", contentBase64: Buffer.from("hi", "utf8").toString("base64") } },
    }), { status: 200 }),
  );
  const tool = new HttpToolAdapter({
    name: "chart.generate",
    version: "1.0.0",
    description: "x",
    capabilities: ["chart-generation"],
    fetchImpl: fetchMock,
  });
  const r = await tool.run({ task: "make chart", text: "{}" });
  const data = r.data as { artifact: { filename: string; content: Buffer; mimeType: string } };
  assert.ok(Buffer.isBuffer(data.artifact.content));
  assert.equal(data.artifact.content.toString("utf8"), "hi");
});

test("HttpToolAdapter default base URL is http://<dashed-name>:8080", async () => {
  const seen: string[] = [];
  const fetchMock = fakeFetch(async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ ok: true, content: "" }), { status: 200 });
  });
  const tool = new HttpToolAdapter({
    name: "market.timeseries",
    version: "1.0.0",
    description: "x",
    capabilities: ["market-timeseries"],
    fetchImpl: fetchMock,
  });
  await tool.run({});
  assert.equal(seen[0], "http://market-timeseries:8080/run");
});

test("HttpToolAdapter env override <TOOL>_BASE_URL takes precedence", async () => {
  process.env.MARKET_TIMESERIES_BASE_URL = "http://custom-mt:9000";
  try {
    const seen: string[] = [];
    const fetchMock = fakeFetch(async (url) => {
      seen.push(url);
      return new Response(JSON.stringify({ ok: true, content: "" }), { status: 200 });
    });
    const tool = new HttpToolAdapter({
      name: "market.timeseries",
      version: "1.0.0",
      description: "x",
      capabilities: ["market-timeseries"],
      fetchImpl: fetchMock,
    });
    await tool.run({});
    assert.equal(seen[0], "http://custom-mt:9000/run");
  } finally {
    delete process.env.MARKET_TIMESERIES_BASE_URL;
  }
});

test("HttpToolAdapter healthcheck reports unreachable services as ok=false", async () => {
  const fetchMock = fakeFetch(async () => { throw new Error("ECONNREFUSED"); });
  const tool = new HttpToolAdapter({
    name: "my.tool",
    version: "1.0.0",
    description: "x",
    capabilities: ["x"],
    baseUrl: "http://nowhere:8080",
    fetchImpl: fetchMock,
  });
  const h = await tool.healthcheck();
  assert.equal(h.ok, false);
  assert.match(h.detail!, /unreachable/);
});

test("HttpToolAdapter healthcheck treats service degraded as not ok", async () => {
  const fetchMock = fakeFetch(async () =>
    new Response(JSON.stringify({ status: "degraded", detail: "Service not started." }), { status: 200 }),
  );
  const tool = new HttpToolAdapter({
    name: "channel.telegram",
    version: "1.0.0",
    description: "x",
    capabilities: ["messaging-channel"],
    baseUrl: "http://telegram:8080",
    fetchImpl: fetchMock,
  });

  const h = await tool.healthcheck();

  assert.equal(h.ok, false);
  assert.equal(h.detail, "Service not started.");
});
