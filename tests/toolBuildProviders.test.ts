import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BrowserScreenshotToolBuildProvider,
  CommandToolQaRunner,
  DocumentArtifactToolBuildProvider,
  GeneratedToolFileBuilder,
  GenericApiToolBuildProvider,
  GenericServiceToolBuildProvider,
  MetadataToolRegistrar,
  validateToolStorageMigrationContract,
} from "../src/tools/toolBuildProviders.js";
import { LlmToolBuildProvider } from "../src/tools/llmToolBuildProvider.js";
import { InMemoryToolBuildRequestStore } from "../src/tools/toolBuildRequestStore.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import { InMemoryToolMigrationStore } from "../src/tools/toolMigrationStore.js";
import { InMemoryToolPromotionStore } from "../src/tools/toolPromotionStore.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loadGeneratedTools } from "../src/tools/generatedToolLoader.js";
import { SourceBundleHttpProcessToolPackageRunner } from "../src/tools/toolPackageRunner.js";
import { validateAndBuildToolPackageWorkspace } from "../src/tools/toolPackageWorkspaceQa.js";
import { ToolPackageWorkspaceStore } from "../src/tools/toolPackageWorkspaceStore.js";

class FakeToolBuilderLlm {
  public calls: Array<{ messages: unknown[]; options: unknown }> = [];

  constructor(private readonly responses: string[]) {}

  async complete(messages: unknown[], options: unknown): Promise<string> {
    this.calls.push({ messages, options });
    const response = this.responses.shift();
    if (!response) throw new Error("No fake LLM response queued");
    return response;
  }
}

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

test("GeneratedToolFileBuilder can mirror generated output into an out-of-tree package workspace", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-builder-"));
  const requestStore = new InMemoryToolBuildRequestStore();
  const request = await requestStore.create({
    capability: "browser-screenshot",
    reason: "Need screenshots as artifacts.",
    requiredInputs: ["url"],
    requiredOutputs: ["artifact"],
  });
  const builder = new GeneratedToolFileBuilder(
    [new BrowserScreenshotToolBuildProvider()],
    projectRoot,
    { packageWorkspaceStore: new ToolPackageWorkspaceStore(projectRoot, "tools") },
  );

  try {
    const output = await builder.build(request);
    const packageManifestPath = output.packageWorkspace?.manifestPath;
    assert.ok(packageManifestPath);
    assert.equal(packageManifestPath, "tools/generated.browser.screenshot/1.0.0/tool.package.json");
    assert.ok(output.packageWorkspace?.files.includes("tools/generated.browser.screenshot/1.0.0/tsconfig.json"));
    assert.ok(output.packageWorkspace?.files.includes("tools/generated.browser.screenshot/1.0.0/index.ts"));
    assert.ok(output.packageWorkspace?.files.includes("tools/generated.browser.screenshot/1.0.0/runtime/server.ts"));
    assert.ok(output.packageWorkspace?.files.includes("tools/generated.browser.screenshot/1.0.0/src/tools/tool.ts"));
    assert.ok(output.packageWorkspace?.files.includes("tools/generated.browser.screenshot/1.0.0/src/tools/generated/browser-screenshotTool.ts"));

    const packageManifest = JSON.parse(await readFile(join(projectRoot, packageManifestPath), "utf8"));
    const packageJson = JSON.parse(await readFile(join(projectRoot, "tools/generated.browser.screenshot/1.0.0/package.json"), "utf8"));
    const dockerfile = await readFile(join(projectRoot, "tools/generated.browser.screenshot/1.0.0/Dockerfile"), "utf8");
    const packageReadme = await readFile(join(projectRoot, "tools/generated.browser.screenshot/1.0.0/README.md"), "utf8");
    const packageToolContract = await readFile(join(projectRoot, "tools/generated.browser.screenshot/1.0.0/src/tools/tool.ts"), "utf8");
    assert.equal(packageManifest.package.type, "source-bundle");
    assert.equal(packageManifest.package.ref, "generated.browser.screenshot/1.0.0");
    assert.equal(packageManifest.name, "generated.browser.screenshot");
    assert.equal(packageJson.scripts.build, "tsc -p tsconfig.json");
    assert.equal(packageJson.scripts.start, "node dist/runtime/server.js");
    assert.equal(packageJson.dependencies["@playwright/test"], "^1.59.1");
    assert.match(dockerfile, /dist\/runtime\/server\.js/);
    assert.match(await readFile(join(projectRoot, "tools/generated.browser.screenshot/1.0.0/index.ts"), "utf8"), /browser-screenshotTool\.js/);
    assert.match(packageReadme, /Source Snapshot/);
    assert.match(packageToolContract, /export type Tool =/);
    assert.equal(output.modulePath, "src/tools/generated/browser-screenshotTool.ts");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("GeneratedToolFileBuilder can create package-only tools without writing project generated files", async () => {
  const projectRoot = process.cwd();
  const unique = `isolated${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const capability = `api.${unique}.lookup`;
  const desiredToolName = `generated.api.${unique}`;
  const requestStore = new InMemoryToolBuildRequestStore();
  const metadataStore = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();
  const request = await requestStore.create({
    capability,
    displayName: "Isolated API Lookup",
    reason: "Create a reusable HTTP JSON API client from API documentation.",
    desiredToolName,
    requiredInputs: ["url"],
    requiredOutputs: ["status", "json"],
  });
  const builder = new GeneratedToolFileBuilder(
    [new GenericApiToolBuildProvider()],
    projectRoot,
    {
      packageWorkspaceStore: new ToolPackageWorkspaceStore(projectRoot, "tools"),
      writeProjectFiles: false,
    },
  );
  const server = createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ value: "package-only-ok" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    const output = await builder.build(request);
    assert.ok(output.packageWorkspace);
    await assert.rejects(() => readFile(join(projectRoot, output.modulePath), "utf8"));
    await assert.rejects(() => readFile(join(projectRoot, output.testPath), "utf8"));

    const qa = await new CommandToolQaRunner(projectRoot).run(request, output);
    assert.equal(qa.ok, true, JSON.stringify(qa, null, 2));
    assert.match(qa.summary, /package-workspace/);

    const packageQa = await validateAndBuildToolPackageWorkspace(
      projectRoot,
      output.packageWorkspace,
      { linkNodeModulesFrom: projectRoot },
    );
    assert.equal(packageQa.ok, true, JSON.stringify(packageQa, null, 2));

    const registrar = new MetadataToolRegistrar(metadataStore);
    await registrar.register(request, output, qa);

    const results = await loadGeneratedTools(registry, metadataStore, projectRoot, [
      new SourceBundleHttpProcessToolPackageRunner({
        enabled: true,
        packageRoot: "tools",
        startupTimeoutMs: 5000,
        pollIntervalMs: 50,
      }),
    ]);
    assert.equal(results[0]?.loaded, true, JSON.stringify(results[0], null, 2));
    assert.match(results[0]?.detail ?? "", /HTTP process runtime/);

    const result = await registry.get(desiredToolName)?.run({
      url: `http://127.0.0.1:${address.port}/lookup`,
    });
    assert.equal(result?.ok, true);
    assert.match(result?.content ?? "", /200/);
    assert.match(JSON.stringify(result?.data), /package-only-ok/);
  } finally {
    server.close();
    await rm(join(projectRoot, "tools", desiredToolName, request.contract.version), { recursive: true, force: true });
    await rm(join(projectRoot, "tools", desiredToolName), { recursive: true, force: true });
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
    assert.deepEqual(output.storage?.permissions, ["tool-db:read", "tool-db:write"]);
    assert.match(output.storage?.destructiveCapabilities?.join("\n") ?? "", /approved maintenance capability/);
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

test("GeneratedToolFileBuilder mirrors always-on services into a package workspace that builds", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-builder-"));
  const requestStore = new InMemoryToolBuildRequestStore();
  const request = await requestStore.create({
    capability: "messaging.provider.bot",
    displayName: "Provider Bot",
    reason: "Create an always-on bot integration that receives messages, sends replies, uses a token, and allows a whitelist.",
    desiredToolName: "generated.messaging.provider.bot",
    startupMode: "always-on",
    credentialHandles: ["secret.messaging.provider.bot"],
  });
  const builder = new GeneratedToolFileBuilder(
    [new GenericServiceToolBuildProvider()],
    projectRoot,
    { packageWorkspaceStore: new ToolPackageWorkspaceStore(projectRoot, "tools") },
  );

  try {
    const output = await builder.build(request);
    assert.ok(output.packageWorkspace);
    const packageToolContract = await readFile(
      join(projectRoot, "tools/generated.messaging.provider.bot/1.0.0/src/tools/tool.ts"),
      "utf8",
    );
    assert.match(packageToolContract, /export type ToolServiceContext/);
    assert.match(packageToolContract, /export type ToolServiceHandle/);
    assert.ok(packageToolContract.includes("startService?: (context: ToolServiceContext)"));

    const packageQa = await validateAndBuildToolPackageWorkspace(
      projectRoot,
      output.packageWorkspace,
      { linkNodeModulesFrom: process.cwd() },
    );
    assert.equal(packageQa.ok, true, JSON.stringify(packageQa, null, 2));
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

test("LlmToolBuildProvider turns unknown integration requests into QA-able generated files", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-builder-"));
  const requestStore = new InMemoryToolBuildRequestStore();
  const request = await requestStore.create({
    capability: "provider.custom.crm",
    displayName: "Custom CRM",
    reason: "Create an always-on custom CRM integration from provider docs and token handle.",
    desiredToolName: "generated.provider.customCrm",
    startupMode: "always-on",
    credentialHandles: ["secret.custom.crm"],
  });
  const moduleSource = [
    'import { Tool } from "../tool.js";',
    "export const tool: Tool = {",
    '  name: "generated.provider.customCrm",',
    '  version: "1.0.0",',
    '  description: "Custom CRM integration.",',
    '  capabilities: ["provider.custom.crm", "tool-integration"],',
    '  startupMode: "always-on",',
    '  requiredSecretHandles: ["secret.custom.crm"],',
    '  async healthcheck() { return { ok: true, detail: "ok" }; },',
    '  async run() { return { ok: true, content: "ready", data: { status: "ready" } }; }',
    "};",
    "export default tool;",
  ].join("\n");
  const testSource = [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { tool } from "../../src/tools/generated/provider-custom-crmTool.js";',
    'test("generated.provider.customCrm exposes a reusable contract", async () => {',
    '  assert.equal(tool.name, "generated.provider.customCrm");',
    '  assert.ok(tool.capabilities.includes("provider.custom.crm"));',
    '  assert.equal((await tool.run({})).ok, true);',
    "});",
  ].join("\n");
  const llm = new FakeToolBuilderLlm([
    JSON.stringify({
      summary: "Generated custom CRM integration.",
      capabilities: ["provider.custom.crm", "tool-integration"],
      requiredSecretHandles: ["secret.custom.crm"],
      docsMarkdown: "Use this integration through the neutral Tool contract.",
      files: [
        { path: request.contract.modulePath, content: moduleSource },
        { path: request.contract.testPath, content: testSource },
      ],
    }),
  ]);
  const builder = new GeneratedToolFileBuilder([new LlmToolBuildProvider(llm)], projectRoot);

  try {
    const output = await builder.build(request);
    const writtenModule = await readFile(join(projectRoot, output.modulePath), "utf8");
    const writtenTest = await readFile(join(projectRoot, output.testPath), "utf8");

    assert.equal(output.modulePath, "src/tools/generated/provider-custom-crmTool.ts");
    assert.equal(output.packageManifest?.schemaVersion, "agentic.tool-package.v1");
    assert.equal(output.packageManifest?.startupMode, "always-on");
    assert.deepEqual(output.requiredSecretHandles, ["secret.custom.crm"]);
    assert.match(writtenModule, /generated.provider.customCrm/);
    assert.match(writtenTest, /exposes a reusable contract/);
    assert.equal(llm.calls.length, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("LlmToolBuildProvider rejects unsafe file paths and raw-looking secrets", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-builder-"));
  const requestStore = new InMemoryToolBuildRequestStore();
  const request = await requestStore.create({
    capability: "provider.bad",
    reason: "Create a bad provider integration.",
    desiredToolName: "generated.provider.bad",
  });
  const llm = new FakeToolBuilderLlm([
    JSON.stringify({
      summary: "unsafe",
      capabilities: ["provider.bad"],
      requiredSecretHandles: ["token=raw-secret-value"],
      files: [
        { path: request.contract.modulePath, content: "export {};" },
        { path: "../outside.test.ts", content: "export {};" },
      ],
    }),
  ]);
  const builder = new GeneratedToolFileBuilder([new LlmToolBuildProvider(llm)], projectRoot);

  try {
    await assert.rejects(() => builder.build(request), /required file|unexpected file path|raw-looking secret/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("LlmToolBuildProvider rejects mismatched package manifests", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-builder-"));
  const requestStore = new InMemoryToolBuildRequestStore();
  const request = await requestStore.create({
    capability: "provider.manifest",
    reason: "Create a provider integration with a manifest.",
    desiredToolName: "generated.provider.manifest",
  });
  const llm = new FakeToolBuilderLlm([
    JSON.stringify({
      summary: "mismatched manifest",
      capabilities: ["provider.manifest"],
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.provider.other",
        version: request.contract.version,
        description: "Wrong manifest.",
        capabilities: ["provider.manifest"],
        startupMode: request.contract.startupMode,
        package: { type: "local-path", ref: request.contract.modulePath },
      },
      files: [
        { path: request.contract.modulePath, content: "export {};" },
        { path: request.contract.testPath, content: "export {};" },
      ],
    }),
  ]);
  const builder = new GeneratedToolFileBuilder([new LlmToolBuildProvider(llm)], projectRoot);

  try {
    await assert.rejects(() => builder.build(request), /package manifest name must match/);
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
  assert.equal(metadata?.promotionEvidence?.buildRequestId, request.id);
  assert.equal(metadata?.promotionEvidence?.summary, "Generated module.");
});

test("MetadataToolRegistrar promotes package workspace manifests when available", async () => {
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

  await registrar.register(request, {
    modulePath: request.contract.modulePath,
    testPath: request.contract.testPath,
    summary: "Generated API module.",
    capabilities: ["api.aml.score", "api-http-json"],
    packageWorkspace: {
      packageRef: "generated.api.amlscore/1.0.0",
      manifestPath: "tools/generated.api.amlscore/1.0.0/tool.package.json",
      files: ["tools/generated.api.amlscore/1.0.0/tool.package.json"],
    },
  });
  const [metadata] = await metadataStore.list();

  assert.equal(metadata?.packageManifest?.package.type, "source-bundle");
  assert.equal(metadata?.packageManifest?.package.ref, "generated.api.amlscore/1.0.0");
  assert.equal(metadata?.packageManifest?.name, "generated.api.amlScore");
  assert.deepEqual(metadata?.packageManifest?.requiredSecretHandles, ["secret.aml.gl.api"]);
});

test("MetadataToolRegistrar records pending migration manifests with QA evidence", async () => {
  const requestStore = new InMemoryToolBuildRequestStore();
  const metadataStore = new InMemoryToolMetadataStore();
  const migrationStore = new InMemoryToolMigrationStore();
  const promotionStore = new InMemoryToolPromotionStore();
  const request = await requestStore.create({
    capability: "custom-inbound-service",
    displayName: "Custom Inbound Service",
    reason: "Create a reusable always-on bridge with storage.",
    desiredToolName: "generated.custom.inboundService",
    startupMode: "always-on",
  });
  const registrar = new MetadataToolRegistrar(metadataStore, migrationStore, promotionStore);

  await registrar.register(
    request,
    {
      modulePath: request.contract.modulePath,
      testPath: request.contract.testPath,
      summary: "Generated service module.",
      storage: {
        schema: "tool_custom_inboundservice",
        tables: ["service_events", "service_offsets"],
        migrations: ["001_create_service_runtime_tables"],
        permissions: ["tool-db:read", "tool-db:write"],
      },
    },
    {
      ok: true,
      summary: "Generated service passed QA.",
      checks: ["isolated package build", "storage contract checked"],
    },
  );
  const [migration] = await migrationStore.list({ toolName: "generated.custom.inboundService" });
  const [metadata] = await metadataStore.list();
  const [promotion] = await promotionStore.list({ toolName: "generated.custom.inboundService" });

  assert.equal(migration?.status, "pending");
  assert.equal(migration?.migrationId, "001_create_service_runtime_tables");
  assert.match(migration?.checksum ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(migration?.qaReport?.checks, ["isolated package build", "storage contract checked"]);
  assert.match(migration?.rollbackNotes ?? "", /Pending isolated database execution/);
  assert.equal(metadata?.promotionEvidence?.buildRequestId, request.id);
  assert.equal(metadata?.promotionEvidence?.qaReport?.summary, "Generated service passed QA.");
  assert.deepEqual(metadata?.versions?.[0]?.promotionEvidence?.migrationIds, ["001_create_service_runtime_tables"]);
  assert.equal(promotion?.buildRequestId, request.id);
  assert.equal(promotion?.summary, "Generated service passed QA.");
  assert.deepEqual(promotion?.migrationIds, ["001_create_service_runtime_tables"]);
});

test("validateToolStorageMigrationContract rejects raw SQL permissions before promotion QA", () => {
  const report = validateToolStorageMigrationContract({
    schema: "tool_bad_runtime",
    tables: ["service_events"],
    migrations: ["001_create_service_runtime_tables"],
    permissions: ["select", "insert"],
  });

  assert.equal(report.ok, false);
  assert.match(report.summary, /raw SQL verbs/);
  assert.match(report.summary, /tool-db:read/);
});

test("package workspace promotion loads generated tools through source-bundle runner", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-builder-source-bundle-"));
  const requestStore = new InMemoryToolBuildRequestStore();
  const metadataStore = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();
  const request = await requestStore.create({
    capability: "api.demo.lookup",
    displayName: "Demo Lookup",
    reason: "Create a reusable HTTP JSON API client.",
    desiredToolName: "generated.api.demolookup",
    requiredInputs: ["url"],
    requiredOutputs: ["status", "json"],
  });
  const builder = new GeneratedToolFileBuilder(
    [new GenericApiToolBuildProvider()],
    projectRoot,
    { packageWorkspaceStore: new ToolPackageWorkspaceStore(projectRoot, "tools") },
  );
  const server = createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ value: "source-bundle-ok" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    const output = await builder.build(request);
    assert.ok(output.packageWorkspace);
    const qa = await validateAndBuildToolPackageWorkspace(
      projectRoot,
      output.packageWorkspace,
      { linkNodeModulesFrom: process.cwd() },
    );
    assert.equal(qa.ok, true, JSON.stringify(qa, null, 2));

    const registrar = new MetadataToolRegistrar(metadataStore);
    await registrar.register(request, output);

    const results = await loadGeneratedTools(registry, metadataStore, projectRoot);
    const stored = (await metadataStore.list())[0];
    const result = await registry.get("generated.api.demolookup")?.run({
      url: `http://127.0.0.1:${address.port}/lookup`,
    });
    const runtimePort = await freePort();
    const runtime = spawn(process.execPath, ["dist/runtime/server.js"], {
      cwd: join(projectRoot, "tools/generated.api.demolookup/1.0.0"),
      env: { ...process.env, PORT: String(runtimePort) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const runtimeOutput: Buffer[] = [];
    runtime.stdout.on("data", (chunk) => runtimeOutput.push(Buffer.from(chunk)));
    runtime.stderr.on("data", (chunk) => runtimeOutput.push(Buffer.from(chunk)));
    try {
      await waitForHealth(
        `http://127.0.0.1:${runtimePort}/health`,
        () => Buffer.concat(runtimeOutput).toString("utf8"),
      );
      const runtimeResponse = await fetch(`http://127.0.0.1:${runtimePort}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { url: `http://127.0.0.1:${address.port}/lookup` } }),
      });
      const runtimeResult = await runtimeResponse.json() as { ok?: boolean; content?: string };
      assert.equal(runtimeResult.ok, true);
      assert.match(runtimeResult.content ?? "", /200/);
    } finally {
      runtime.kill("SIGTERM");
    }

    assert.equal(stored?.packageManifest?.package.type, "source-bundle");
    assert.equal(results[0]?.loaded, true, JSON.stringify(results[0], null, 2));
    assert.match(results[0]?.detail ?? "", /source bundle/);
    assert.equal(result?.ok, true);
    assert.match(result?.content ?? "", /200/);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitForHealth(url: string, diagnostic: () => string = () => ""): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Runtime is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for tool runtime health: ${url}\n${diagnostic()}`);
}

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
