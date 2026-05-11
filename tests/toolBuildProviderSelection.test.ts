import test from "node:test";
import assert from "node:assert/strict";
import {
  BrowserScreenshotToolBuildProvider,
  DocumentArtifactToolBuildProvider,
  GenericApiToolBuildProvider,
  GenericServiceToolBuildProvider,
} from "../src/tools/toolBuildProviders.js";
import { MessagingServiceToolBuildProvider } from "../src/tools/messagingServiceToolBuildProvider.js";
import type { ToolBuildRequest } from "../src/tools/toolBuildRequestStore.js";

const baseRequest = (overrides: Partial<ToolBuildRequest> = {}): ToolBuildRequest =>
  ({
    id: "tb_test",
    capability: "test-capability",
    reason: "test",
    status: "requested",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    contract: {
      capability: "test-capability",
      toolName: "test.tool",
      modulePath: "src/tools/generated/testTool.ts",
      testPath: "tests/generated/testTool.test.ts",
      description: "Test tool.",
      startupMode: "on-demand",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
      acceptanceCriteria: [],
      qaCriteria: [],
      builderInstructions: [],
      version: "1.0.0",
    },
    ...overrides,
  }) as ToolBuildRequest;

test("DocumentArtifact does NOT claim a request whose taskSummary contains an html.<host> URL", () => {
  // Regression for the bug where `\bhtml\b` matched
  // "https://html.duckduckgo.com/html/?q=..." and stole every web-search
  // request from GenericApi. Should now only fire for explicit document
  // generation intent.
  const request = baseRequest({
    capability: "web-search-duckduckgo",
    reason: "User asked for a DuckDuckGo search tool that returns top 10 organic results.",
    taskSummary: "Build a tool that calls https://html.duckduckgo.com/html/?q=<query> and returns up to 10 entries.",
    requiredOutputs: ["results"],
  });
  const document = new DocumentArtifactToolBuildProvider();
  assert.equal(document.canBuild(request), false, "DocumentArtifact must not steal HTML-URL search requests");
});

test("GenericApi claims a search-style HTTP request", () => {
  const request = baseRequest({
    capability: "web-search-duckduckgo",
    reason: "User asked for a DuckDuckGo search wrapper.",
    taskSummary: "GET https://html.duckduckgo.com/html/?q=<query>, parse results, return JSON.",
    requiredOutputs: ["results"],
  });
  const api = new GenericApiToolBuildProvider();
  assert.equal(api.canBuild(request), true, "GenericApi must claim http(s) search requests");
});

test("DocumentArtifact still claims explicit PDF / docx generation requests", () => {
  const request = baseRequest({
    capability: "pdf-report-generation",
    reason: "Generate a PDF report from supplied markdown.",
    taskSummary: "Build a tool that produces a PDF document from markdown source.",
    requiredOutputs: ["pdf"],
  });
  const document = new DocumentArtifactToolBuildProvider();
  assert.equal(document.canBuild(request), true);
});

test("DocumentArtifact still claims a 'render document' verb-noun phrase", () => {
  const request = baseRequest({
    capability: "render-document",
    reason: "We need to render a document from a template.",
    taskSummary: "Render the document and return its bytes.",
  });
  const document = new DocumentArtifactToolBuildProvider();
  assert.equal(document.canBuild(request), true);
});

test("With the production provider order, GenericApi wins over DocumentArtifact for a search-tool request", () => {
  // Mirrors the runtime-workers.module.ts ordering after the fix:
  // BrowserScreenshot, Messaging, GenericApi, DocumentArtifact, GenericService.
  const providers = [
    new BrowserScreenshotToolBuildProvider(),
    new MessagingServiceToolBuildProvider(),
    new GenericApiToolBuildProvider(),
    new DocumentArtifactToolBuildProvider(),
    new GenericServiceToolBuildProvider(),
  ];
  const request = baseRequest({
    capability: "web-search-duckduckgo",
    reason: "DuckDuckGo HTML endpoint search wrapper.",
    taskSummary: "Calls https://html.duckduckgo.com/html/?q=...; returns top 10 results.",
    requiredOutputs: ["results"],
  });
  const winner = providers.find((p) => p.canBuild(request));
  assert.ok(winner, "expected at least one provider to match");
  assert.equal(winner!.constructor.name, "GenericApiToolBuildProvider");
});
