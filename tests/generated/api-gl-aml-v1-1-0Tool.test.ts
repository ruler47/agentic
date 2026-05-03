import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { tool } from "../../src/tools/generated/api-gl-aml-v1-1-0Tool.js";

test("generated.api.gl.aml exposes a valid generated API tool contract", async () => {
  const health = await tool.healthcheck?.();

  assert.equal(tool.name, "generated.api.gl.aml");
  assert.ok(tool.capabilities.includes("api.gl-aml"));
  assert.ok(tool.capabilities.includes("api-http-json"));
  assert.equal(health?.ok, true);
});

test("generated.api.gl.aml rejects invalid and unsafe inputs", async () => {
  const invalid = await tool.run({ url: "notaurl" });
  const unsafeHeader = await tool.run({
    url: "https://example.com/api",
    headers: { Authorization: "raw-secret" }
  });

  assert.equal(invalid.ok, false);
  assert.match(invalid.content, /Invalid API URL/);
  assert.equal(unsafeHeader.ok, false);
  assert.match(unsafeHeader.content, /Raw credential headers/);
});

test("generated.api.gl.aml calls a JSON API endpoint with query and declared secret handles", async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      path: url.pathname,
      totalFunds: 62,
      sources: [
        { name: "low-risk-source", funds: { score: 30, share: 25 } },
        { name: "highest-risk-source", funds: { score: 60, share: 75 } }
      ],
      auth: request.headers.authorization ?? request.headers["x-api-key"] ?? null
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    const result = await tool.run(
      {
        baseUrl: "http://127.0.0.1:" + address.port,
        network: "ethereum",
        address: "0x9B43b2F8aa3217F3F3947C750d58A50ac24aFfD2"
      },
      {
        toolName: tool.name,
        now: new Date("2026-05-03T00:00:00.000Z"),
        resolveSecret: async (handle) => handle === "secret.api.gl-aml" ? "test-token" : undefined
      }
    );
    const data = result.data as { score?: unknown; sources?: Array<{ name: string; share?: number }>; json?: { path?: string; address?: string | null; auth?: string | null; score?: number } } | undefined;

    assert.equal(result.ok, true);
    assert.equal(data?.json?.path, "/api/report/address/0x9B43b2F8aa3217F3F3947C750d58A50ac24aFfD2");
    
    
    assert.equal(data?.score, 62);
    assert.match(result.content, /score: 62/);
    assert.deepEqual(data?.sources?.map((source) => [source.name, source.share]), [["highest-risk-source", 75], ["low-risk-source", 25]]);
    assert.equal(data?.json?.auth ?? null, "test-token");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
