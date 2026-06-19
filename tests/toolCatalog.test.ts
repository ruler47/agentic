import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySecretHandleStore } from "../src/secrets/secretHandleStore.js";
import { InMemoryToolRuntimeSettingsStore } from "../src/settings/toolRuntimeSettings.js";
import {
  buildToolCatalogView,
  deriveToolAgentEligibility,
  type ToolCatalogLayer,
} from "../src/tools/toolCatalog.js";
import type { ToolModuleMetadata } from "../src/tools/toolMetadataStore.js";
import { resolveToolRuntimeReadiness } from "../src/tools/toolRuntimeReadiness.js";

function metadata(input: Partial<ToolModuleMetadata> & Pick<ToolModuleMetadata, "name">): ToolModuleMetadata {
  return {
    name: input.name,
    version: input.version ?? "0.1.0",
    description: input.description ?? "test tool",
    capabilities: input.capabilities ?? ["test"],
    startupMode: input.startupMode ?? "on-demand",
    source: input.source ?? "generated",
    status: input.status ?? "available",
    requiredConfigurationKeys: input.requiredConfigurationKeys ?? [],
    requiredSecretHandles: input.requiredSecretHandles ?? [],
    examples: input.examples ?? [],
    successCount: input.successCount ?? 0,
    failureCount: input.failureCount ?? 0,
    lastHealthOk: input.lastHealthOk,
    lastHealthDetail: input.lastHealthDetail,
    updatedAt: input.updatedAt ?? new Date(0).toISOString(),
  };
}

test("tool catalog view sorts core tools first and segregates inactive generated tools", async () => {
  const catalog = await buildToolCatalogView({
    registeredToolNames: ["web.search", "generated.good", "generated.disabled"],
    metadataTools: [
      metadata({ name: "generated.failed", status: "failed" }),
      metadata({ name: "generated.good", source: "generated" }),
      metadata({ name: "web.search", source: "builtin" }),
      metadata({ name: "generated.missing", source: "generated" }),
      metadata({ name: "generated.disabled", source: "generated", status: "disabled" }),
    ],
  });

  assert.deepEqual(catalog.slice(0, 2).map((tool) => [tool.name, tool.catalogLayer]), [
    ["web.search", "core"],
    ["generated.good", "generated-active"],
  ]);
  assert.deepEqual(
    new Map(catalog.slice(2).map((tool) => [tool.name, tool.catalogLayer])),
    new Map([
      ["generated.disabled", "generated-inactive"],
      ["generated.failed", "generated-inactive"],
      ["generated.missing", "generated-inactive"],
    ]),
  );
  assert.equal(catalog.find((tool) => tool.name === "generated.good")?.agentEligibility.offered, true);
  assert.equal(catalog.find((tool) => tool.name === "generated.failed")?.agentEligibility.offered, false);
  assert.equal(catalog.find((tool) => tool.name === "generated.missing")?.agentEligibility.reason, "not_registered");
});

test("tool catalog marks builtin metadata without implementation as legacy reference", async () => {
  const [entry] = await buildToolCatalogView({
    registeredToolNames: [],
    metadataTools: [metadata({ name: "chart.generate", source: "builtin" })],
  });

  assert.equal(entry.catalogLayer satisfies ToolCatalogLayer, "legacy-reference");
  assert.equal(entry.agentEligibility.offered, false);
  assert.equal(entry.agentEligibility.reason, "not_registered");
});

test("agent eligibility blocks unhealthy tools and missing runtime requirements", async () => {
  const settings = new InMemoryToolRuntimeSettingsStore();
  const secrets = new InMemorySecretHandleStore();
  const blockedRuntime = metadata({
    name: "external.api",
    requiredConfigurationKeys: ["API_BASE_URL"],
    requiredSecretHandles: ["secret.external.api"],
  });
  const unhealthy = metadata({
    name: "unstable.tool",
    lastHealthOk: false,
    lastHealthDetail: "last heartbeat failed",
  });

  const blockedReadiness = await resolveToolRuntimeReadiness(blockedRuntime, {
    runtimeSettings: settings,
    secretHandles: secrets,
    environment: {},
  });
  const healthyReadiness = await resolveToolRuntimeReadiness(unhealthy);

  assert.equal(
    deriveToolAgentEligibility(blockedRuntime, new Set(["external.api"]), blockedReadiness).reason,
    "runtime_not_ready",
  );
  assert.equal(
    deriveToolAgentEligibility(unhealthy, new Set(["unstable.tool"]), healthyReadiness).reason,
    "health_failed",
  );
});
