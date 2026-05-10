import test from "node:test";
import assert from "node:assert/strict";
import { ToolsService } from "../src/server/modules/tools/tools.service.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { WebSearchTool } from "../src/tools/webSearchTool.js";

class FakeAudit {
  async record() { /* no-op */ }
}

async function makeService() {
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();
  registry.register(new WebSearchTool());
  await metadata.syncBuiltins(registry.list());
  const service = new ToolsService(
    registry,
    metadata,
    undefined,
    undefined,
    undefined,
    new FakeAudit() as never,
  );
  return { metadata, service };
}

test("ToolsService.getToolStats derives totals + success rate from metadata store", async () => {
  const { metadata, service } = await makeService();
  await metadata.recordUsage("web.search", "success");
  await metadata.recordUsage("web.search", "success");
  await metadata.recordUsage("web.search", "success");
  await metadata.recordUsage("web.search", "failure");
  const stats = await service.getToolStats("web.search");
  assert.equal(stats.name, "web.search");
  assert.equal(stats.totalRuns, 4);
  assert.equal(stats.successCount, 3);
  assert.equal(stats.failureCount, 1);
  assert.equal(stats.successRate, 0.75);
  assert.ok(stats.lastSuccessAt);
  assert.ok(stats.lastFailureAt);
  assert.ok(Array.isArray(stats.versions));
});

test("ToolsService.getToolStats reports null successRate when no runs recorded", async () => {
  const { service } = await makeService();
  const stats = await service.getToolStats("web.search");
  assert.equal(stats.totalRuns, 0);
  assert.equal(stats.successRate, null);
});

test("ToolsService.exportPackageManifest returns the manifest with a sensible filename", async () => {
  const { metadata, service } = await makeService();
  await metadata.registerGenerated({
    name: "test.tool",
    displayName: "Test Tool",
    version: "1.2.3",
    description: "x",
    capabilities: ["x"],
    startupMode: "on-demand",
    requiredConfigurationKeys: [],
    requiredSecretHandles: [],
    examples: [],
    packageManifest: {
      schemaVersion: "agentic.tool-package.v1",
      name: "test.tool",
      version: "1.2.3",
      description: "x",
      capabilities: ["x"],
      startupMode: "on-demand",
      package: { type: "oci-image", ref: "agentic-tool-test-tool:1.2.3" },
    },
  });
  const exported = await service.exportPackageManifest("test.tool");
  assert.equal((exported.manifest as { name: string }).name, "test.tool");
  assert.equal(exported.filename, "test.tool-1.2.3.tool-package.json");
});
