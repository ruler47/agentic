import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryToolBuildRequestStore } from "../src/tools/toolBuildRequestStore.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import { InMemoryToolMigrationStore } from "../src/tools/toolMigrationStore.js";
import { ToolPromotionCoordinator } from "../src/tools/toolPromotionCoordinator.js";
import { InMemoryToolPromotionStore } from "../src/tools/toolPromotionStore.js";

test("ToolPromotionCoordinator promotes metadata, migrations, and journal in one boundary", async () => {
  const requestStore = new InMemoryToolBuildRequestStore();
  const metadataStore = new InMemoryToolMetadataStore();
  const migrationStore = new InMemoryToolMigrationStore();
  const promotionStore = new InMemoryToolPromotionStore();
  const coordinator = new ToolPromotionCoordinator(metadataStore, migrationStore, promotionStore);
  const request = await requestStore.create({
    capability: "generic.service.runtime",
    reason: "Build a reusable always-on service runtime capability.",
    desiredToolName: "generated.generic.serviceRuntime",
    startupMode: "always-on",
  });
  const qaReport = {
    ok: true,
    summary: "Generated service runtime passed isolated QA.",
    checks: ["contract", "tests", "build"],
  };

  const result = await coordinator.promote(
    request,
    {
      modulePath: "tools/generated/generic-service-runtime/v1/src/index.ts",
      testPath: "tools/generated/generic-service-runtime/v1/test/index.test.ts",
      summary: "Generated service runtime.",
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.generic.serviceRuntime",
        version: "1.0.0",
        description: "Generated service runtime.",
        capabilities: ["generic.service.runtime"],
        startupMode: "always-on",
        package: {
          type: "source-bundle",
          ref: "source-bundle:generic-service-runtime@1.0.0",
        },
      },
      storage: {
        schema: "tool_generic_service_runtime",
        tables: ["tool_generic_service_runtime.events"],
        migrations: ["generic_service_runtime_events"],
      },
    },
    qaReport,
  );

  assert.equal(result.toolName, "generated.generic.serviceRuntime");
  assert.equal(result.metadata.promotionEvidence?.buildRequestId, request.id);
  assert.equal(result.metadata.promotionEvidence?.packageRef, "source-bundle:generic-service-runtime@1.0.0");
  assert.deepEqual(result.metadata.promotionEvidence?.migrationIds, ["generic_service_runtime_events"]);
  assert.equal(result.migrationRecords.length, 1);
  assert.equal(result.migrationRecords[0]?.migrationId, "generic_service_runtime_events");
  assert.equal(result.promotionRecord?.buildRequestId, request.id);
  assert.equal(result.promotionRecord?.summary, qaReport.summary);
});
