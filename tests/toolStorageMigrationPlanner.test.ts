import test from "node:test";
import assert from "node:assert/strict";
import {
  planToolStorageMigrations,
  runToolStorageMigrationPlanQa,
} from "../src/tools/toolStorageMigrationPlanner.js";

test("planToolStorageMigrations creates idempotent service runtime SQL", () => {
  const [plan] = planToolStorageMigrations({
    schema: "tool_custom_service",
    tables: ["service_events", "service_offsets", "service_delivery_attempts"],
    migrations: ["001_create_service_runtime_tables"],
  });

  assert.equal(plan?.migrationId, "001_create_service_runtime_tables");
  assert.ok(plan?.statements.every((statement) => /if not exists/i.test(statement)));
  assert.match(plan?.statements.join("\n") ?? "", /"tool_custom_service"."service_events"/);
  assert.match(plan?.rollbackNotes ?? "", /Drop schema tool_custom_service/);
});

test("planToolStorageMigrations rejects unsupported migration plans", () => {
  assert.throws(
    () => planToolStorageMigrations({
      schema: "tool_custom_service",
      tables: ["service_events"],
      migrations: ["999_unknown"],
    }),
    /No SQL planner/,
  );
  assert.throws(
    () => planToolStorageMigrations({
      schema: "public",
      tables: ["service_events"],
      migrations: ["001_create_service_runtime_tables"],
    }),
    /tool-owned snake_case/,
  );
});

test("runToolStorageMigrationPlanQa executes plans twice inside a rollback transaction", async () => {
  const queries: string[] = [];
  const report = await runToolStorageMigrationPlanQa(
    {
      async query(sql: string) {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
    },
    {
      schema: "tool_custom_service",
      tables: ["service_offsets"],
      migrations: ["001_create_service_runtime_tables"],
    },
  );

  assert.equal(report.ok, true);
  assert.equal(queries[0], "begin");
  assert.equal(queries.at(-1), "rollback");
  assert.equal(queries.filter((query) => /create table/i.test(query)).length, 2);
  assert.deepEqual(report.checks, [
    "isolated storage migration execution: 001_create_service_runtime_tables pass 1 ok",
    "isolated storage migration execution: 001_create_service_runtime_tables pass 2 ok",
  ]);
});
