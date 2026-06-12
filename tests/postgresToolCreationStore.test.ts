import test from "node:test";
import assert from "node:assert/strict";
import { PostgresToolCreationStore } from "../src/tools/postgresToolCreationStore.js";
import type { PgQueryExecutor } from "../src/db/pool.js";

test("PostgresToolCreationStore serializes JSONB arrays and objects explicitly", async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      assert.ok(params);
      assert.equal(typeof params[8], "string");
      assert.equal(typeof params[9], "string");
      assert.deepEqual(JSON.parse(String(params[8])), [{ name: "camelcase", versionRange: "^8.0.0" }]);
      assert.deepEqual(JSON.parse(String(params[9])), {
        kind: "npm-package",
        reason: "wrap package",
        confidence: "high",
        candidates: [],
        rejectedCandidates: [],
        selectedDependencies: [{ name: "camelcase", versionRange: "^8.0.0" }],
        implementationNotes: [],
      });
      return {
        rows: [{
          id: params[0],
          status: "requested",
          source: params[1],
          tool_name: params[2],
          tool_version: params[3],
          kind: params[4],
          request: params[5],
          description: params[6],
          capabilities: params[7],
          dependencies: params[8],
          strategy_decision: params[9],
          package_ref: null,
          manifest_path: null,
          files: [],
          qa_report: null,
          error: null,
          run_id: params[10],
          created_at: new Date(String(params[11])),
          updated_at: new Date(String(params[11])),
          registered_at: null,
        }] as T[],
        rowCount: 1,
      };
    },
  } as unknown as PgQueryExecutor;
  const store = new PostgresToolCreationStore(pool);

  const created = await store.create({
    source: "agent",
    toolName: "text.camelcase",
    toolVersion: "0.1.0",
    kind: "npm-default-function",
    request: "camelCase text",
    capabilities: ["camelcase"],
    dependencies: [{ name: "camelcase", versionRange: "^8.0.0" }],
    strategy: {
      kind: "npm-package",
      reason: "wrap package",
      confidence: "high",
      candidates: [],
      rejectedCandidates: [],
      selectedDependencies: [{ name: "camelcase", versionRange: "^8.0.0" }],
      implementationNotes: [],
    },
    runId: "run-tool-build",
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(created.dependencies, [{ name: "camelcase", versionRange: "^8.0.0" }]);
  assert.equal(created.strategy?.kind, "npm-package");
});

test("PostgresToolCreationStore serializes JSONB update fields explicitly", async () => {
  const existingRow = {
    id: "tool_creation_existing",
    status: "building",
    source: "agent",
    tool_name: "text.camelcase",
    tool_version: "0.1.0",
    kind: "npm-default-function",
    request: "camelCase text",
    description: null,
    capabilities: ["camelcase"],
    dependencies: [{ name: "camelcase", versionRange: "^8.0.0" }],
    strategy_decision: null,
    package_ref: null,
    manifest_path: null,
    files: [],
    qa_report: null,
    error: null,
    run_id: "run-tool-build",
    created_at: new Date(),
    updated_at: new Date(),
    registered_at: null,
  };
  const pool = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      assert.ok(params);
      if (/from tool_creations/.test(sql)) {
        return { rows: [existingRow] as T[], rowCount: 1 };
      }
      assert.equal(params[0], "tool_creation_existing");
      assert.equal(params[1], "registered");
      assert.equal(typeof params[2], "string");
      assert.equal(typeof params[6], "string");
      assert.deepEqual(JSON.parse(String(params[2])).kind, "npm-package");
      assert.deepEqual(JSON.parse(String(params[6])).ok, true);
      return {
        rows: [{
          ...existingRow,
          status: params[1],
          strategy_decision: params[2],
          package_ref: params[3],
          manifest_path: params[4],
          files: params[5],
          qa_report: params[6],
          updated_at: new Date(String(params[9])),
          registered_at: new Date(),
        }] as T[],
        rowCount: 1,
      };
    },
  } as unknown as PgQueryExecutor;
  const store = new PostgresToolCreationStore(pool);

  const updated = await store.update("tool_creation_existing", {
    status: "registered",
    strategy: {
      kind: "npm-package",
      reason: "wrap package",
      confidence: "high",
      candidates: [],
      rejectedCandidates: [],
      selectedDependencies: [{ name: "camelcase", versionRange: "^8.0.0" }],
      implementationNotes: [],
    },
    packageRef: "tools/text.camelcase/0.1.0",
    manifestPath: "tools/text.camelcase/0.1.0/tool.package.json",
    files: ["tool.package.json"],
    qa: { ok: true, summary: "ok", checks: [] },
    registeredAt: new Date(),
  });

  assert.equal(updated?.status, "registered");
  assert.equal(updated?.strategy?.kind, "npm-package");
  assert.equal(updated?.qa?.ok, true);
});
