import test from "node:test";
import assert from "node:assert/strict";
import {
  findExplicitRunScopedToolCandidate,
  findExplicitRunScopedToolVersionCandidate,
  findReusableCreatedCandidate,
} from "../src/server/modules/runs/run-tool-catalog.js";
import type { BaseAgentToolCreationRequest } from "../src/agents/baseAgent.js";
import type {
  ToolModuleMetadata,
  ToolModuleVersionSummary,
} from "../src/tools/toolMetadataStore.js";

function version(input: Partial<ToolModuleVersionSummary> & { version: string }): ToolModuleVersionSummary {
  return {
    active: false,
    status: "disabled",
    description: "Captures a URL as a PNG screenshot artifact.",
    capabilities: ["browser-screenshot", "artifact-image"],
    packageManifest: {
      schemaVersion: "agentic.tool-package.v1",
      name: "browser.screenshot",
      version: input.version,
      description: "Captures a URL as a PNG screenshot artifact.",
      capabilities: ["browser-screenshot", "artifact-image"],
      startupMode: "on-demand",
      package: { type: "source-bundle", ref: `browser.screenshot/${input.version}` },
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    },
    updatedAt: new Date(0).toISOString(),
    ...input,
  };
}

const screenshotRequest: BaseAgentToolCreationRequest = {
  name: "browser.screenshot",
  version: "0.1.0",
  request: "A tool that takes a URL as input and returns a screenshot of the page as a PNG artifact.",
  capabilities: ["browser.screenshot"],
};

test("findReusableCreatedCandidate treats default 0.1.0 as non-binding when newer candidates exist", () => {
  const reusable = findReusableCreatedCandidate([
    version({ version: "0.1.0", status: "disabled" }),
    version({ version: "0.1.1", status: "disabled" }),
    version({ version: "0.1.2", status: "loaded" }),
  ], screenshotRequest);

  assert.equal(reusable?.version, "0.1.2");
});

test("findReusableCreatedCandidate respects explicit non-default version requests", () => {
  const reusable = findReusableCreatedCandidate([
    version({ version: "0.1.0", status: "disabled" }),
    version({ version: "0.1.1", status: "loaded" }),
    version({ version: "0.1.2", status: "loaded" }),
  ], {
    ...screenshotRequest,
    version: "0.1.1",
  });

  assert.equal(reusable?.version, "0.1.1");
});

test("findReusableCreatedCandidate skips rejected candidates", () => {
  const reusable = findReusableCreatedCandidate([
    version({ version: "0.1.0", status: "disabled" }),
    version({ version: "0.1.1", status: "loaded", reviewStatus: "rejected" }),
    version({ version: "0.1.2", status: "disabled" }),
  ], screenshotRequest);

  assert.equal(reusable?.version, "0.1.2");
});

test("findExplicitRunScopedToolCandidate matches an explicitly requested disabled generated tool", async () => {
  const tool: ToolModuleMetadata = {
    name: "crypto.aml.gl",
    version: "0.1.0",
    description: "AML API for crypto addresses and transactions",
    capabilities: ["api-client", "generated-tool", "aml"],
    startupMode: "on-demand",
    source: "generated",
    status: "disabled",
    requiredConfigurationKeys: [],
    requiredSecretHandles: [],
    examples: [],
    successCount: 0,
    failureCount: 0,
    updatedAt: new Date(0).toISOString(),
  };

  const match = await findExplicitRunScopedToolCandidate({
    task: "Проверь адрес через амл тулзу",
    metadataTools: [tool],
    alreadyAllowedNames: [],
  });

  assert.equal(match?.metadata.name, "crypto.aml.gl");
  assert.match(match?.reason ?? "", /run-scoped candidate/);
});

test("findExplicitRunScopedToolCandidate does not expose disabled tools without explicit tool intent", async () => {
  const tool: ToolModuleMetadata = {
    name: "risk.lookup",
    version: "0.1.0",
    description: "Risk lookup API client",
    capabilities: ["api-client", "risk"],
    startupMode: "on-demand",
    source: "generated",
    status: "disabled",
    requiredConfigurationKeys: [],
    requiredSecretHandles: [],
    examples: [],
    successCount: 0,
    failureCount: 0,
    updatedAt: new Date(0).toISOString(),
  };

  const match = await findExplicitRunScopedToolCandidate({
    task: "Проверь риск адреса",
    metadataTools: [tool],
    alreadyAllowedNames: [],
  });

  assert.equal(match, undefined);
});

test("findExplicitRunScopedToolVersionCandidate pins a disabled generated version even when the tool is active globally", async () => {
  const activeTool: ToolModuleMetadata = {
    name: "crypto.aml.gl",
    version: "0.1.13",
    description: "AML API for crypto addresses and transactions",
    capabilities: ["api-client", "generated-tool", "aml"],
    startupMode: "on-demand",
    source: "generated",
    status: "available",
    requiredConfigurationKeys: [],
    requiredSecretHandles: [],
    examples: [],
    successCount: 2,
    failureCount: 0,
    updatedAt: new Date(0).toISOString(),
  };

  const match = await findExplicitRunScopedToolVersionCandidate({
    task: "Проверь адрес через crypto.aml.gl@0.1.20, это candidate run.",
    metadataTools: [activeTool],
    listVersions: async () => [
      version({ version: "0.1.13", active: true, status: "available" }),
      version({ version: "0.1.20", status: "disabled" }),
    ],
  });

  assert.equal(match?.name, "crypto.aml.gl");
  assert.equal(match?.version, "0.1.20");
  assert.match(match?.reason ?? "", /without changing the active global version/);
});
