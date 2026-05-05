import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BrowserScreenshotToolBuildProvider,
  DocumentArtifactToolBuildProvider,
  GeneratedToolFileBuilder,
  GenericApiToolBuildProvider,
  GenericServiceToolBuildProvider,
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
    assert.equal(output.inputSchema?.required, undefined);
    assert.deepEqual(output.requiredSecretHandles, ["secret.aml.gl.api"]);
    assert.match(moduleSource, /api-http-json/);
    assert.ok(moduleSource.includes("secret.aml.gl.api"));
    assert.match(testSource, /0x9B43b2F8aa3217F3F3947C750d58A50ac24aFfD2/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("GeneratedToolFileBuilder creates reusable PDF document artifact modules", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-builder-"));
  const requestStore = new InMemoryToolBuildRequestStore();
  const request = await requestStore.create({
    capability: "pdf-generation",
    displayName: "PDF Report",
    reason: "Create a reusable PDF artifact renderer for agent-generated reports.",
    requiredInputs: ["title", "content"],
    requiredOutputs: ["artifact"],
  });
  const builder = new GeneratedToolFileBuilder([new DocumentArtifactToolBuildProvider()], projectRoot);

  try {
    const output = await builder.build(request);
    const moduleSource = await readFile(join(projectRoot, output.modulePath), "utf8");
    const testSource = await readFile(join(projectRoot, output.testPath), "utf8");

    assert.equal(output.modulePath, "src/tools/generated/pdf-generationTool.ts");
    assert.equal(output.displayName, "PDF Report");
    assert.deepEqual(output.capabilities, ["pdf-generation", "document-generation", "artifact-generation"]);
    assert.match(moduleSource, /application\/pdf/);
    assert.match(moduleSource, /renderSimplePdf/);
    assert.match(testSource, /creates a reusable PDF artifact payload/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("GeneratedToolFileBuilder creates provider-neutral always-on service modules", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-builder-"));
  const requestStore = new InMemoryToolBuildRequestStore();
  const request = await requestStore.create({
    capability: "custom-inbound-service",
    displayName: "Custom Inbound Service",
    reason: "Create an always-on listener that records normalized inbound/outbound events.",
    desiredToolName: "generated.custom.inboundService",
    startupMode: "always-on",
    requiredInputs: ["event"],
    requiredOutputs: ["service-status", "normalized-event"],
  });
  const builder = new GeneratedToolFileBuilder([new GenericServiceToolBuildProvider()], projectRoot);

  try {
    const output = await builder.build(request);
    const moduleSource = await readFile(join(projectRoot, output.modulePath), "utf8");
    const testSource = await readFile(join(projectRoot, output.testPath), "utf8");

    assert.equal(output.modulePath, "src/tools/generated/custom-inbound-serviceTool.ts");
    assert.equal(output.displayName, "Custom Inbound Service");
    assert.deepEqual(output.capabilities, [
      "custom-inbound-service",
      "always-on-service",
      "tool-integration",
      "inbound-event",
      "outbound-event",
      "service-runtime",
    ]);
    assert.deepEqual(output.storage?.tables, ["service_events", "service_offsets", "service_delivery_attempts"]);
    assert.equal(output.settingsSchema?.type, "object");
    assert.match(output.docsMarkdown ?? "", /Integration contract/);
    assert.equal(output.examples?.length, 2);
    assert.equal(output.packageManifest?.schemaVersion, "agentic.tool-package.v1");
    assert.equal(output.packageManifest?.package.type, "local-path");
    assert.equal(output.packageManifest?.startupMode, "always-on");
    assert.match(moduleSource, /startService/);
    assert.match(moduleSource, /startupMode: "always-on"/);
    assert.match(moduleSource, /integrationSpec/);
    assert.match(testSource, /records neutral events/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("GeneratedToolFileBuilder captures integration metadata for provider-like service requests", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-builder-"));
  const requestStore = new InMemoryToolBuildRequestStore();
  const request = await requestStore.create({
    capability: "messaging.provider.bot",
    displayName: "Provider Bot",
    reason: "Create an always-on bot integration that receives messages, sends replies, uses a token, and allows a whitelist.",
    desiredToolName: "generated.messaging.providerBot",
    startupMode: "always-on",
    credentialNotes: "bot token abc123",
  });
  const builder = new GeneratedToolFileBuilder([new GenericServiceToolBuildProvider()], projectRoot);

  try {
    const output = await builder.build(request);
    const moduleSource = await readFile(join(projectRoot, output.modulePath), "utf8");

    assert.equal(request.contract.integration?.mode, "always-on-service");
    assert.equal(request.contract.integration?.inbound.enabled, true);
    assert.equal(request.contract.integration?.outbound.enabled, true);
    assert.deepEqual(output.requiredSecretHandles, ["secret.messaging.provider.bot"]);
    assert.ok(output.settingsSchema?.required?.includes("enabled"));
    assert.match(output.docsMarkdown ?? "", /Secret handles: `secret.messaging.provider.bot`/);
    assert.match(moduleSource, /requiredSecretHandles/);
    assert.match(moduleSource, /missingSecrets/);
    const testSource = await readFile(join(projectRoot, output.testPath), "utf8");
    assert.match(testSource, /resolveSecret: async \(\) => "resolved-secret"/);
    assert.match(testSource, /validates declared runtime secret handles/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("GeneratedToolFileBuilder creates Global Ledger API preset modules from credential notes", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-builder-"));
  const requestStore = new InMemoryToolBuildRequestStore();
  const request = await requestStore.create({
    capability: "api.gl-aml",
    displayName: "GL AML",
    reason: "Docs: https://common.glprotocol.com/api-doc/. Create AML check for address or transaction by blockchain name.",
    desiredToolName: "generated.api.gl.aml",
    credentialNotes: "api key should be used as x-api-key",
    requiredInputs: ["network", "address", "transactionHash"],
    requiredOutputs: ["score", "json"],
  });
  const builder = new GeneratedToolFileBuilder([new GenericApiToolBuildProvider()], projectRoot);

  try {
    const output = await builder.build(request);
    const moduleSource = await readFile(join(projectRoot, output.modulePath), "utf8");
    const testSource = await readFile(join(projectRoot, output.testPath), "utf8");

    assert.equal(output.modulePath, "src/tools/generated/api-gl-amlTool.ts");
    assert.deepEqual(output.requiredSecretHandles, ["secret.api.gl-aml"]);
    assert.match(output.docsMarkdown ?? "", /Global Ledger preset/);
    assert.match(moduleSource, /x-api-key/);
    assert.match(moduleSource, /glprotocol/);
    assert.match(moduleSource, /api\/report\/address/);
    assert.match(testSource, /network: "ethereum"/);
    assert.match(testSource, /x-api-key/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("GeneratedToolFileBuilder creates versioned Global Ledger replacements", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-builder-"));
  const requestStore = new InMemoryToolBuildRequestStore();
  const request = await requestStore.create({
    capability: "api.gl-aml",
    displayName: "GL AML",
    reason:
      "Change request: Global Ledger root totalFunds is the final AML score. sources[].funds lists detected sources with share percentages.",
    desiredToolName: "generated.api.gl.aml",
    credentialNotes: "api key should be used as x-api-key",
    replacesToolName: "generated.api.gl.aml",
    replacesVersion: "1.0.0",
    requiredInputs: ["network", "address", "transactionHash"],
    requiredOutputs: ["score", "sources", "json"],
  });
  const builder = new GeneratedToolFileBuilder([new GenericApiToolBuildProvider()], projectRoot);

  try {
    const output = await builder.build(request);
    const moduleSource = await readFile(join(projectRoot, output.modulePath), "utf8");
    const testSource = await readFile(join(projectRoot, output.testPath), "utf8");

    assert.equal(request.contract.version, "1.1.0");
    assert.equal(output.modulePath, "src/tools/generated/api-gl-aml-v1-1-0Tool.ts");
    assert.equal(output.testPath, "tests/generated/api-gl-aml-v1-1-0Tool.test.ts");
    assert.match(moduleSource, /version: "1\.1\.0"/);
    assert.match(moduleSource, /totalFunds/);
    assert.match(moduleSource, /extractSources/);
    assert.match(testSource, /totalFunds: 62/);
    assert.match(testSource, /highest-risk-source", 75/);
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
    settingsSchema: {
      type: "object",
      properties: { baseUrl: { type: "string" } },
    },
    storage: {
      schema: "tool_api_aml",
      tables: ["cache"],
    },
    examples: [{ title: "Lookup", input: { url: "https://example.test" } }],
    packageManifest: {
      schemaVersion: "agentic.tool-package.v1",
      name: "generated.api.amlScore",
      version: "1.0.0",
      description: "Portable generated API adapter.",
      capabilities: ["api.aml.score", "api-http-json", "http-api-call"],
      startupMode: "on-demand",
      package: { type: "local-path", ref: request.contract.modulePath },
    },
    docsMarkdown: "# API adapter",
  });
  const [metadata] = await metadataStore.list();

  assert.equal(registeredToolName, "generated.api.amlScore");
  assert.equal(metadata?.displayName, "AML Score");
  assert.deepEqual(metadata?.capabilities, ["api.aml.score", "api-http-json", "http-api-call"]);
  assert.deepEqual(metadata?.inputSchema?.required, ["url"]);
  assert.deepEqual(metadata?.requiredSecretHandles, ["secret.aml.gl.api"]);
  assert.deepEqual(metadata?.settingsSchema?.properties.baseUrl, { type: "string" });
  assert.deepEqual(metadata?.storage?.tables, ["cache"]);
  assert.equal(metadata?.examples[0]?.title, "Lookup");
  assert.equal(metadata?.packageManifest?.schemaVersion, "agentic.tool-package.v1");
  assert.equal(metadata?.docsMarkdown, "# API adapter");
});

test("MetadataToolRegistrar promotes versioned replacements", async () => {
  const requestStore = new InMemoryToolBuildRequestStore();
  const metadataStore = new InMemoryToolMetadataStore();
  await metadataStore.registerGenerated({
    name: "generated.api.gl.aml",
    displayName: "GL AML",
    version: "1.0.0",
    description: "Original GL AML adapter.",
    capabilities: ["api.gl-aml", "api-http-json"],
    modulePath: "src/tools/generated/api-gl-amlTool.ts",
  });
  const request = await requestStore.create({
    capability: "api.gl-aml",
    displayName: "GL AML",
    reason: "Change request.",
    desiredToolName: "generated.api.gl.aml",
    replacesToolName: "generated.api.gl.aml",
    replacesVersion: "1.0.0",
  });
  const registrar = new MetadataToolRegistrar(metadataStore);

  const registeredToolName = await registrar.register(request, {
    modulePath: request.contract.modulePath,
    testPath: request.contract.testPath,
    summary: "Generated API module replacement.",
    capabilities: ["api.gl-aml", "api-http-json", "http-api-call"],
  });
  const [metadata] = await metadataStore.list();

  assert.equal(registeredToolName, "generated.api.gl.aml");
  assert.equal(metadata?.version, "1.1.0");
  assert.equal(metadata?.versions?.[0]?.active, true);
  assert.equal(metadata?.modulePath, "src/tools/generated/api-gl-aml-v1-1-0Tool.ts");
});
