import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySecretHandleStore } from "../src/secrets/secretHandleStore.js";
import { InMemoryToolRuntimeSettingsStore } from "../src/settings/toolRuntimeSettings.js";
import type { ToolModuleMetadata } from "../src/tools/toolMetadataStore.js";
import { resolveToolRuntimeReadiness } from "../src/tools/toolRuntimeReadiness.js";
import { agentCallableToolNames } from "../src/server/modules/runs/runs.service.js";

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
    updatedAt: input.updatedAt ?? new Date(0).toISOString(),
  };
}

test("resolveToolRuntimeReadiness reports missing runtime configuration and secrets", async () => {
  const settings = new InMemoryToolRuntimeSettingsStore();
  const secrets = new InMemorySecretHandleStore();
  const tool = metadata({
    name: "external.api",
    requiredConfigurationKeys: ["API_BASE_URL"],
    requiredSecretHandles: ["secret.external.api"],
  });

  const blocked = await resolveToolRuntimeReadiness(tool, {
    runtimeSettings: settings,
    secretHandles: secrets,
    environment: {},
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, "missing_runtime_requirements");
  assert.deepEqual(blocked.missingConfigurationKeys, ["API_BASE_URL"]);
  assert.deepEqual(blocked.missingSecretHandles, ["secret.external.api"]);

  await settings.set({
    toolName: "external.api",
    key: "API_BASE_URL",
    value: "https://api.example.test",
  });
  await secrets.create({
    handle: "secret.external.api",
    label: "External API",
    provider: "inline",
    secretRef: "token",
  });

  const ready = await resolveToolRuntimeReadiness(tool, {
    runtimeSettings: settings,
    secretHandles: secrets,
    environment: {},
  });

  assert.equal(ready.ok, true);
  assert.equal(ready.status, "ready");
  assert.deepEqual(ready.missingConfigurationKeys, []);
  assert.deepEqual(ready.missingSecretHandles, []);
});

test("agentCallableToolNames excludes available tools whose runtime requirements are missing", async () => {
  const settings = new InMemoryToolRuntimeSettingsStore();
  const secrets = new InMemorySecretHandleStore();
  const ready = metadata({ name: "ready.tool" });
  const blocked = metadata({
    name: "blocked.tool",
    requiredConfigurationKeys: ["API_BASE_URL"],
    requiredSecretHandles: ["secret.blocked"],
  });

  assert.deepEqual(
    await agentCallableToolNames({
      registeredToolNames: ["ready.tool", "blocked.tool"],
      metadataTools: [ready, blocked],
      runtimeSettings: settings,
      secretHandles: secrets,
      environment: {},
    }),
    ["ready.tool"],
  );

  await settings.set({
    toolName: "blocked.tool",
    key: "API_BASE_URL",
    value: "https://api.example.test",
  });
  await secrets.create({
    handle: "secret.blocked",
    label: "Blocked tool secret",
    provider: "inline",
    secretRef: "token",
  });

  assert.deepEqual(
    await agentCallableToolNames({
      registeredToolNames: ["ready.tool", "blocked.tool"],
      metadataTools: [ready, blocked],
      runtimeSettings: settings,
      secretHandles: secrets,
      environment: {},
    }),
    ["blocked.tool", "ready.tool"],
  );
});

test("agentCallableToolNames excludes guarded external action commit tools", async () => {
  const regular = metadata({ name: "browser.operate" });
  const commit = metadata({
    name: "external.action.commit",
    capabilities: ["external-action-commit", "external-action-commit-generic"],
  });

  assert.deepEqual(
    await agentCallableToolNames({
      registeredToolNames: ["browser.operate", "external.action.commit"],
      metadataTools: [regular, commit],
    }),
    ["browser.operate"],
  );
});
