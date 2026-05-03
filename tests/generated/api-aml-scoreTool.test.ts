import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { tool } from "../../src/tools/generated/api-aml-scoreTool.js";

test("generated.api.amlScore exposes a valid generated API tool contract", async () => {
  const health = await tool.healthcheck?.();

  assert.equal(tool.name, "generated.api.amlScore");
  assert.ok(tool.capabilities.includes("api.aml.score"));
  assert.ok(tool.capabilities.includes("api-http-json"));
  assert.equal(health?.ok, true);
});

test("generated.api.amlScore rejects invalid and unsafe inputs", async () => {
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

test("generated.api.amlScore calls a JSON API endpoint with query and declared secret handles", async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      path: url.pathname,
      address: url.searchParams.get("address"),
      auth: request.headers.authorization ?? null
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    const result = await tool.run(
      {
        url: "http://127.0.0.1:" + address.port + "/score",
        query: { address: "0x9B43b2F8aa3217F3F3947C750d58A50ac24aFfD2" },
        secretHandle: "secret.aml.gl.api"
      },
      {
        toolName: tool.name,
        now: new Date("2026-05-03T00:00:00.000Z"),
        resolveSecret: async (handle) => handle === "secret.aml.gl.api" ? "test-token" : undefined
      }
    );
    const data = result.data as { json?: { path?: string; address?: string; auth?: string } } | undefined;

    assert.equal(result.ok, true);
    assert.equal(data?.json?.path, "/score");
    assert.equal(data?.json?.address, "0x9B43b2F8aa3217F3F3947C750d58A50ac24aFfD2");
    assert.equal(data?.json?.auth, "Bearer test-token");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
