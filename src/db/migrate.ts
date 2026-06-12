import { createPool } from "./pool.js";
import { runMigrationStatements } from "./migrations/migrationStatementRunner.js";
import { MIGRATION_STATEMENTS_PART_1 } from "./migrations/schemaPart1.js";
import { MIGRATION_STATEMENTS_PART_2 } from "./migrations/schemaPart2.js";
import { loadDefaultEnvFiles } from "../config/envFile.js";

export async function migrate(connectionString?: string): Promise<void> {
  loadDefaultEnvFiles();
  const pool = createPool(connectionString ?? process.env.DATABASE_URL);

  try {
    await runMigrationStatements(pool, [
      ...MIGRATION_STATEMENTS_PART_1,
      ...MIGRATION_STATEMENTS_PART_2,
    ]);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
