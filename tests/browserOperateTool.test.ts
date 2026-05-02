import test from "node:test";
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import { BrowserOperateTool, isBrowserOperateData } from "../src/tools/browserOperateTool.js";

test("BrowserOperateTool runs generic browser commands and returns text plus screenshots", async () => {
  const server = await startTestServer();
  const tool = new BrowserOperateTool();

  try {
    const result = await tool.run({
      commands: [
        { type: "navigate", url: server.url },
        { type: "dismissDialogs", texts: ["Accept cookies"] },
        { type: "fill", selector: "#search", text: "Malaga Istanbul" },
        { type: "selectOption", selector: "#kind", value: "flight" },
        { type: "check", selector: "#direct" },
        { type: "click", selector: "#submit" },
        { type: "waitForText", text: "Result for Malaga Istanbul" },
        { type: "assertText", selector: "#result", text: "Kind: flight" },
        { type: "assertUrl", includes: "/" },
        { type: "extractText", selector: "#result", label: "result" },
        { type: "extractLinks", selector: "#links", label: "links" },
        { type: "screenshot", label: "proof", filename: "proof.png" },
      ],
      defaultTimeoutMs: 5000,
    });

    assert.equal(result.ok, true);
    assert.ok(isBrowserOperateData(result.data));
    assert.equal(result.data.steps.length, 12);
    assert.equal(result.data.steps.every((step) => step.status === "completed"), true);
    assert.match(result.data.extractedText[0]?.text ?? "", /Result for Malaga Istanbul/);
    assert.match(result.data.extractedText[0]?.text ?? "", /Kind: flight/);
    assert.equal(result.data.extractedLinks[0]?.links[0]?.href, `${server.url}details`);
    assert.equal(result.data.screenshots[0]?.filename, "proof.png");
    assert.equal(result.data.screenshots[0]?.mimeType, "image/png");
    assert.ok(Buffer.isBuffer(result.data.screenshots[0]?.content));
    assert.ok(result.data.storageState);
  } finally {
    await server.close();
  }
});

test("BrowserOperateTool can reuse returned storage state", async () => {
  const server = await startTestServer();
  const tool = new BrowserOperateTool();

  try {
    const first = await tool.run({
      commands: [
        { type: "navigate", url: server.url },
        { type: "dismissDialogs", texts: ["Accept cookies"] },
      ],
    });
    assert.equal(first.ok, true);
    assert.ok(isBrowserOperateData(first.data));

    const second = await tool.run({
      storageState: first.data.storageState,
      commands: [
        { type: "navigate", url: server.url },
        { type: "assertText", selector: "#session", text: "Accepted session" },
        { type: "extractText", selector: "#session", label: "session" },
      ],
    });

    assert.equal(second.ok, true);
    assert.ok(isBrowserOperateData(second.data));
    assert.equal(second.data.extractedText[0]?.text, "Accepted session");
  } finally {
    await server.close();
  }
});

test("BrowserOperateTool accepts screenshot-style URL input for compatibility", async () => {
  const server = await startTestServer();
  const tool = new BrowserOperateTool();

  try {
    const result = await tool.run({
      url: server.url,
      filename: "alias-proof.png",
      fullPage: true,
    });

    assert.equal(result.ok, true);
    assert.ok(isBrowserOperateData(result.data));
    assert.match(result.data.extractedText[0]?.text ?? "", /Accepted session|Fresh session|Waiting/);
    assert.equal(result.data.screenshots[0]?.filename, "alias-proof.png");
  } finally {
    await server.close();
  }
});

test("BrowserOperateTool captures a diagnostic screenshot when a command fails", async () => {
  const server = await startTestServer();
  const tool = new BrowserOperateTool();

  try {
    const result = await tool.run({
      commands: [
        { type: "navigate", url: server.url },
        { type: "fill", selector: "#missing-field", text: "will fail", timeoutMs: 100 },
      ],
      defaultTimeoutMs: 500,
    });

    assert.equal(result.ok, false);
    assert.ok(isBrowserOperateData(result.data));
    assert.match(result.content, /failed at command 1/);
    assert.equal(result.data.screenshots.length, 1);
    assert.match(result.data.screenshots[0]?.filename ?? "", /failure-command-1-fill/);
    assert.ok(Buffer.isBuffer(result.data.screenshots[0]?.content));
  } finally {
    await server.close();
  }
});

test("BrowserOperateTool validates command contracts before launching complex flows", async () => {
  const tool = new BrowserOperateTool();

  const result = await tool.run({
    commands: [{ type: "navigate" }],
  });

  assert.equal(result.ok, false);
  assert.match(result.content, /navigate requires url/);
});

async function startTestServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html>
        <head><title>Browser Tool Test</title></head>
        <body>
          <div id="cookie-banner">
            <button id="accept" onclick="localStorage.setItem('accepted','yes'); document.getElementById('cookie-banner').remove(); document.getElementById('session').textContent = 'Accepted session'">Accept cookies</button>
          </div>
          <p id="session">Fresh session</p>
          <label>Search <input id="search" /></label>
          <select id="kind">
            <option value="hotel">Hotel</option>
            <option value="flight">Flight</option>
          </select>
          <label><input id="direct" type="checkbox" /> Direct only</label>
          <button id="submit" onclick="document.getElementById('result').textContent = 'Result for ' + document.getElementById('search').value + ' | Kind: ' + document.getElementById('kind').value + ' | Direct: ' + document.getElementById('direct').checked">Go</button>
          <main id="result">Waiting</main>
          <nav id="links"><a href="/details">Details</a></nav>
          <script>
            if (localStorage.getItem('accepted') === 'yes') {
              document.getElementById('cookie-banner').remove();
              document.getElementById('session').textContent = 'Accepted session';
            }
          </script>
        </body>
      </html>`);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start test server.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
