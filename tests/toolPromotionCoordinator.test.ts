import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryToolBuildRequestStore } from "../src/tools/toolBuildRequestStore.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import { InMemoryToolMigrationStore } from "../src/tools/toolMigrationStore.js";
import { ToolPromotionCoordinator } from "../src/tools/toolPromotionCoordinator.js";
import { InMemoryToolPromotionStore } from "../src/tools/toolPromotionStore.js";
import { PostgresToolPromotionCoordinator } from "../src/tools/postgresToolPromotionCoordinator.js";
import { PgPool } from "../src/db/pool.js";

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

test("PostgresToolPromotionCoordinator commits metadata, migrations, and journal together", async () => {
  const queries: string[] = [];
  const pool = fakePromotionPool(queries);
  const coordinator = new PostgresToolPromotionCoordinator(pool);
  const request = await new InMemoryToolBuildRequestStore().create({
    capability: "generic.service.runtime",
    reason: "Build a reusable service runtime.",
    desiredToolName: "generated.generic.serviceRuntime",
    startupMode: "always-on",
  });

  const result = await coordinator.promote(
    request,
    {
      modulePath: "tools/generated/generic-service-runtime/v1/src/index.ts",
      testPath: "tools/generated/generic-service-runtime/v1/test/index.test.ts",
      summary: "Generated service runtime.",
      storage: {
        schema: "tool_generic_service_runtime",
        tables: ["tool_generic_service_runtime.events"],
        migrations: ["generic_service_runtime_events"],
      },
    },
    { ok: true, summary: "QA passed.", checks: ["ok"] },
  );

  assert.equal(result.promotionRecord?.status, "promoted");
  assert.equal(queries.filter((query) => query === "begin").length, 1);
  assert.equal(queries.filter((query) => query === "commit").length, 1);
  assert.equal(queries.filter((query) => query === "rollback").length, 0);
  assert.equal(queries.some((query) => /insert into tool_migrations/.test(query)), true);
  assert.equal(queries.some((query) => /insert into tool_promotions/.test(query)), true);
});

test("PostgresToolPromotionCoordinator rolls back when journal write fails", async () => {
  const queries: string[] = [];
  const pool = fakePromotionPool(queries, { failPromotionInsert: true });
  const coordinator = new PostgresToolPromotionCoordinator(pool);
  const request = await new InMemoryToolBuildRequestStore().create({
    capability: "generic.service.runtime",
    reason: "Build a reusable service runtime.",
    desiredToolName: "generated.generic.serviceRuntime",
  });

  await assert.rejects(
    () =>
      coordinator.promote(
        request,
        {
          modulePath: "tools/generated/generic-service-runtime/v1/src/index.ts",
          testPath: "tools/generated/generic-service-runtime/v1/test/index.test.ts",
          summary: "Generated service runtime.",
        },
        { ok: true, summary: "QA passed.", checks: ["ok"] },
      ),
    /promotion insert failed/,
  );

  assert.equal(queries.filter((query) => query === "begin").length, 1);
  assert.equal(queries.filter((query) => query === "commit").length, 0);
  assert.equal(queries.filter((query) => query === "rollback").length, 1);
});

function fakePromotionPool(
  queries: string[],
  options: { failPromotionInsert?: boolean } = {},
): PgPool {
  const rowDate = new Date("2026-05-04T10:00:00.000Z");
  const client = {
    async query(text: string, params?: unknown[]) {
      queries.push(text.trim());
      if (text.trim() === "begin" || text.trim() === "commit" || text.trim() === "rollback") {
        return { rows: [] };
      }
      if (text.includes("select name") && text.includes("from tool_modules")) {
        return { rows: [] };
      }
      if (text.includes("insert into tool_modules")) {
        return {
          rows: [
            {
              name: params?.[0],
              display_name: params?.[1],
              version: params?.[2],
              description: params?.[3],
              capabilities: params?.[4],
              startup_mode: params?.[5],
              input_schema: params?.[6],
              output_schema: params?.[7],
              module_path: params?.[8],
              test_path: params?.[9],
              required_configuration_keys: params?.[10],
              required_secret_handles: params?.[11],
              settings_schema: params?.[12],
              storage_contract: params?.[13],
              docs_markdown: params?.[14],
              change_summary: params?.[15],
              promotion_evidence: params?.[16] ? JSON.parse(String(params[16])) : null,
              examples: JSON.parse(String(params?.[17] ?? "[]")),
              package_manifest: params?.[18] ? JSON.parse(String(params[18])) : null,
              source: "generated",
              status: "disabled",
              last_health_ok: null,
              last_health_detail: null,
              success_count: 0,
              failure_count: 0,
              last_success_at: null,
              last_failure_at: null,
              updated_at: rowDate,
            },
          ],
        };
      }
      if (text.includes("insert into tool_module_versions")) {
        return { rows: [] };
      }
      if (text.includes("update tool_module_versions set active = false")) {
        return { rows: [] };
      }
      if (text.includes("insert into tool_migrations")) {
        return {
          rows: [
            {
              id: "tool_migration_fake",
              tool_name: params?.[1],
              tool_version: params?.[2],
              migration_id: params?.[3],
              checksum: params?.[4],
              status: params?.[5],
              applied_at: null,
              applied_by_actor: null,
              qa_report: params?.[8],
              rollback_notes: params?.[9],
              created_at: rowDate,
              updated_at: rowDate,
            },
          ],
        };
      }
      if (text.includes("insert into tool_promotions")) {
        if (options.failPromotionInsert) {
          throw new Error("promotion insert failed");
        }
        return {
          rows: [
            {
              id: "tool_promotion_fake",
              tool_name: params?.[1],
              tool_version: params?.[2],
              status: params?.[3],
              promoted_at: new Date(String(params?.[4])),
              build_request_id: params?.[5] ?? null,
              qa_report: params?.[6] ?? null,
              package_ref: params?.[7] ?? null,
              migration_ids: params?.[8] ?? [],
              summary: params?.[9],
              created_at: new Date(String(params?.[4])),
            },
          ],
        };
      }
      return { rows: [] };
    },
    release() {},
  };

  return {
    async connect() {
      return client;
    },
  } as unknown as PgPool;
}
