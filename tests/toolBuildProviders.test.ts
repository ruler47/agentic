import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BrowserScreenshotToolBuildProvider,
  GeneratedToolFileBuilder,
  GenericApiToolBuildProvider,
  MetadataToolRegistrar,
} from "../src/tools/toolBuildProviders.js";
import { InMemoryToolBuildRequestStore } from "../src/tools/toolBuildRequestStore.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";

test("GeneratedToolFileBuilder writes provider-owned TypeScript module and tests", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-builder-"));
  const requestStore = new InMemoryToolBuildRequestStore();
  const request = await requestStore.create({
    capability: "browser-screenshot",
    reason: "Need screenshots as artifacts.",
    requiredInputs: ["url"],
    requiredOutputs: ["artifact"],
  });
  const builder = new GeneratedToolFileBuilder([new BrowserScreenshotToolBuildProvider()], projectRoot);

  try {
    const output = await builder.build(request);
    const moduleSource = await readFile(join(projectRoot, output.modulePath), "utf8");
    const testSource = await readFile(join(projectRoot, output.testPath), "utf8");

    assert.equal(output.modulePath, "src/tools/generated/browser-screenshotTool.ts");
    assert.match(moduleSource, /chromium/);
    assert.match(moduleSource, /browser-screenshot/);
    assert.match(testSource, /captures a local page screenshot artifact/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("GeneratedToolFileBuilder blocks unsupported capabilities without writing fallback hacks", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-builder-"));
  const requestStore = new InMemoryToolBuildRequestStore();
  const request = await requestStore.create({
    capability: "unknown-capability",
    reason: "No provider should accept this.",
  });
  const builder = new GeneratedToolFileBuilder([new BrowserScreenshotToolBuildProvider()], projectRoot);

  try {
    await assert.rejects(() => builder.build(request), /No Tool Build provider/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("GeneratedToolFileBuilder creates reusable API adapter modules for API capabilities", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-builder-"));
  const requestStore = new InMemoryToolBuildRequestStore();
  const request = await requestStore.create({
    capability: "api.aml.score",
    displayName: "AML Score",
    reason: "Create a reusable HTTP JSON API client for AML score lookups. Docs URL: https://aml.example/docs.",
    desiredToolName: "generated.api.amlScore",
    credentialHandles: ["secret.aml.gl.api"],
    requiredInputs: ["url", "query", "secretHandle"],
    requiredOutputs: ["status", "json"],
  });
  const builder = new GeneratedToolFileBuilder([new GenericApiToolBuildProvider()], projectRoot);

  try {
    const output = await builder.build(request);
    const moduleSource = await readFile(join(projectRoot, output.modulePath), "utf8");
    const testSource = await readFile(join(projectRoot, output.testPath), "utf8");

    assert.equal(output.modulePath, "src/tools/generated/api-aml-scoreTool.ts");
    assert.equal(output.displayName, "AML Score");
    assert.deepEqual(output.capabilities, ["api.aml.score", "api-http-json", "http-api-call"]);
    assert.deepEqual(output.inputSchema?.required, ["url"]);
    assert.deepEqual(output.requiredSecretHandles, ["secret.aml.gl.api"]);
    assert.match(moduleSource, /api-http-json/);
    assert.ok(moduleSource.includes("secret.aml.gl.api"));
    assert.match(testSource, /0x9B43b2F8aa3217F3F3947C750d58A50ac24aFfD2/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("MetadataToolRegistrar registers generated provider output", async () => {
  const requestStore = new InMemoryToolBuildRequestStore();
  const metadataStore = new InMemoryToolMetadataStore();
  const request = await requestStore.create({
    capability: "browser-screenshot",
    reason: "Need screenshots as artifacts.",
    requiredInputs: ["url"],
    requiredOutputs: ["artifact"],
  });
  const registrar = new MetadataToolRegistrar(metadataStore);

  const registeredToolName = await registrar.register(request, {
    modulePath: request.contract.modulePath,
    testPath: request.contract.testPath,
    summary: "Generated module.",
  });
  const [metadata] = await metadataStore.list();

  assert.equal(registeredToolName, "generated.browser.screenshot");
  assert.equal(metadata?.source, "generated");
  assert.ok(metadata?.capabilities.includes("browser-screenshot"));
  assert.ok(!metadata?.capabilities.includes("api-http-json"));
  assert.equal(metadata?.modulePath, request.contract.modulePath);
});

test("MetadataToolRegistrar preserves provider-specific capabilities and secret handles", async () => {
  const requestStore = new InMemoryToolBuildRequestStore();
  const metadataStore = new InMemoryToolMetadataStore();
  const request = await requestStore.create({
    capability: "api.aml.score",
    displayName: "AML Score",
    reason: "Create an API adapter.",
    desiredToolName: "generated.api.amlScore",
    credentialHandles: ["secret.aml.gl.api"],
  });
  const registrar = new MetadataToolRegistrar(metadataStore);

  const registeredToolName = await registrar.register(request, {
    modulePath: request.contract.modulePath,
    testPath: request.contract.testPath,
    summary: "Generated API module.",
    capabilities: ["api.aml.score", "api-http-json", "http-api-call"],
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    requiredSecretHandles: ["secret.aml.gl.api"],
    docsMarkdown: "# API adapter",
  });
  const [metadata] = await metadataStore.list();

  assert.equal(registeredToolName, "generated.api.amlScore");
  assert.equal(metadata?.displayName, "AML Score");
  assert.deepEqual(metadata?.capabilities, ["api.aml.score", "api-http-json", "http-api-call"]);
  assert.deepEqual(metadata?.inputSchema?.required, ["url"]);
  assert.deepEqual(metadata?.requiredSecretHandles, ["secret.aml.gl.api"]);
  assert.equal(metadata?.docsMarkdown, "# API adapter");
});
