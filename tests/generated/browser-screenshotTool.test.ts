import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { tool } from "../../src/tools/generated/browser-screenshotTool.js";

test("generated.browser.screenshot exposes a valid generated tool contract", async () => {
  const health = await tool.healthcheck?.();

  assert.equal(tool.name, "generated.browser.screenshot");
  assert.ok(tool.capabilities.includes("browser-screenshot"));
  assert.equal(health?.ok, true);
});

test("generated.browser.screenshot rejects invalid URLs without launching a browser", async () => {
  const result = await tool.run({ url: "notaurl" });

  assert.equal(result.ok, false);
  assert.match(result.content, /Invalid URL/);
});

test("generated.browser.screenshot captures a local page screenshot artifact", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>smoke</title><main style='font: 24px sans-serif'>Browser screenshot smoke</main>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    const result = await tool.run({
      url: "http://127.0.0.1:" + address.port + "/",
      filename: "smoke.png",
      fullPage: false
    });
    const data = result.data as { artifact?: { contentBase64?: string; mimeType?: string } } | undefined;

    assert.equal(result.ok, true);
    assert.equal(data?.artifact?.mimeType, "image/png");
    assert.ok(Buffer.from(data?.artifact?.contentBase64 ?? "", "base64").byteLength > 1000);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
