import assert from "node:assert/strict";
import test from "node:test";
import { MIGRATION_STATEMENTS_PART_1 } from "../src/db/migrations/schemaPart1.js";

test("runs status migrations preserve waiting_approval during idempotent replays", () => {
  const statusConstraintStatements = MIGRATION_STATEMENTS_PART_1.filter((statement) =>
    statement.sql.includes("runs_status_check"),
  );

  assert.ok(statusConstraintStatements.length > 0);
  for (const statement of statusConstraintStatements) {
    assert.match(statement.sql, /waiting_approval/);
  }
});
