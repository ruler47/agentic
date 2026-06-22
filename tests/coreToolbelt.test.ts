import test from "node:test";
import assert from "node:assert/strict";
import { createCoreToolbelt } from "../src/tools/coreToolbelt.js";
import { BrowserScreenshotTool } from "../src/tools/browserScreenshotTool.js";
import { DataTransformTool } from "../src/tools/dataTransformTool.js";
import { DocumentExtractTool } from "../src/tools/documentExtractTool.js";
import { ExternalActionCommitTool, ExternalActionPrepareTool } from "../src/tools/externalActionTools.js";
import { HttpRequestTool } from "../src/tools/httpRequestTool.js";
import { WebReadTool } from "../src/tools/webReadTool.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Tool } from "../src/tools/tool.js";

test("createCoreToolbelt returns the preinstalled first-party tools", () => {
  const tools = createCoreToolbelt();
  const names = tools.map((tool) => tool.name).sort();

  assert.deepEqual(names, [
    "browser.operate",
    "browser.screenshot",
    "channel.telegram",
    "data.transform",
    "document.extract",
    "external.action.commit",
    "external.action.prepare",
    "file.read",
    "file.write",
    "http.request",
    "web.read",
    "web.search",
  ]);

  for (const tool of tools) {
    assert.ok(tool.version, `${tool.name} has a version`);
    assert.ok(tool.description, `${tool.name} has a description`);
    assert.ok(tool.capabilities.length > 0, `${tool.name} declares capabilities`);
    assert.equal(typeof tool.run, "function", `${tool.name} has a runner`);
    assert.ok(!tool.name.startsWith("generated."), `${tool.name} is not a generated package`);
  }
});

test("createCoreToolbelt can be disabled for focused tests", () => {
  assert.deepEqual(createCoreToolbelt({ enabled: false }), []);
});

test("web.read extracts readable page text and links", async () => {
  await withTestServer(async (baseUrl) => {
    const tool = new WebReadTool();
    const result = await tool.run({ url: `${baseUrl}/page` });

    assert.equal(result.ok, true);
    assert.match(result.content, /Hello reader/);
    assert.deepEqual((result.data as { title?: string }).title, "Fixture Page");
    assert.equal((result.data as { links?: unknown[] }).links?.length, 1);
  });
});

test("http.request executes JSON API calls and redacts sensitive headers", async () => {
  await withTestServer(async (baseUrl) => {
    const tool = new HttpRequestTool();
    const result = await tool.run({
      url: `${baseUrl}/api`,
      method: "POST",
      headers: { authorization: "Bearer secret" },
      json: { ok: true },
      responseType: "json",
    });

    assert.equal(result.ok, true);
    assert.match(result.content, /"received": true/);
    const data = result.data as { response: { method: string; body: unknown }; headers: Record<string, string> };
    assert.equal(data.response.method, "POST");
    assert.deepEqual(data.response.body, { ok: true });
  });
});

test("data.transform filters and serializes structured data", async () => {
  const tool = new DataTransformTool();
  const result = await tool.run({
    input: [
      { name: "A", score: 2 },
      { name: "B", score: 5 },
    ],
    operations: [
      { type: "filter", path: "score", equals: 5 },
      { type: "template", template: "{name}:{score}" },
    ],
    outputFormat: "text",
  });

  assert.equal(result.ok, true);
  assert.equal(result.content, "B:5");
});

test("data.transform parses JSON-looking input strings before applying operations", async () => {
  const tool = new DataTransformTool();
  const result = await tool.run({
    input: "[{\"name\":\"Ann\",\"age\":31},{\"name\":\"Bob\",\"age\":42},{\"name\":\"Cara\",\"age\":25}]",
    operations: [
      { type: "sort", key: "age", order: "desc" },
    ],
    outputFormat: "csv",
  });

  assert.equal(result.ok, true);
  assert.equal(result.content, "name,age\nBob,42\nAnn,31\nCara,25");
  assert.deepEqual((result.data as { operationsApplied?: string[] }).operationsApplied, ["sort"]);
});

test("document.extract extracts inline HTML and JSON", async () => {
  const tool = new DocumentExtractTool();
  const html = await tool.run({ content: "<html><title>T</title><body><h1>Hello</h1><p>World</p></body></html>", mimeType: "text/html" });
  const json = await tool.run({ content: "{\"a\":1}", mimeType: "application/json" });

  assert.equal(html.ok, true);
  assert.match(html.content, /Hello/);
  assert.equal(json.ok, true);
  assert.equal(json.content.trim(), '{\n  "a": 1\n}');
});

test("external action tools prepare drafts and only commit after approval", async () => {
  const prepare = new ExternalActionPrepareTool();
  const commit = new ExternalActionCommitTool();

  const draft = await prepare.run({
    goal: "Book an appointment",
    action: "submit appointment form",
    targetName: "Provider",
    data: { email: "user@example.com", apiKey: "secret" },
  });
  assert.equal(draft.ok, true);
  assert.match(draft.content, /Prepared external action/);
  assert.equal(((draft.data as { dataPreview: { apiKey: string } }).dataPreview.apiKey), "[redacted]");

  const blocked = await commit.run({ preparedActionId: "external_action_test", approved: false });
  assert.equal(blocked.ok, false);

  const committed = await commit.run({
    preparedActionId: "external_action_test",
    approved: true,
    provider: "fixture",
    fixtureConfirmation: "confirmed-1",
    commitPayload: { token: "secret" },
  });
  assert.equal(committed.ok, true);
  assert.match(committed.content, /confirmed-1/);
});

test("browser.screenshot delegates to browser.operate with proof-oriented commands", async () => {
  const calls: unknown[] = [];
  const fakeBrowserOperate: Tool = {
    name: "browser.operate",
    version: "test",
    description: "fake",
    capabilities: ["browser-operate"],
    run: async (input) => {
      calls.push(input);
      return { ok: true, content: "captured", data: { screenshots: [] } };
    },
  };
  const tool = new BrowserScreenshotTool(fakeBrowserOperate);
  const result = await tool.run({ url: "https://example.com", focusText: "Example", filename: "proof.png" });

  assert.equal(result.ok, true);
  const call = calls[0] as { commands: Array<{ type: string; url?: string; filename?: string }> };
  assert.equal(call.commands[0].type, "navigate");
  assert.ok(call.commands.some((command) => command.type === "extractText"));
  assert.ok(call.commands.findIndex((command) => command.type === "extractText") < call.commands.findIndex((command) => command.type === "screenshot"));
  assert.equal(call.commands.at(-1)?.type, "screenshot");
  assert.equal(call.commands.at(-1)?.filename, "proof.png");
});

async function withTestServer(testBody: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    if (request.url === "/page") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><title>Fixture Page</title><body><h1>Hello reader</h1><a href='/next'>Next</a></body></html>");
      return;
    }
    if (request.url === "/api") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json", authorization: "server-secret" });
        response.end(JSON.stringify({ received: true, method: request.method, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    await testBody(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
