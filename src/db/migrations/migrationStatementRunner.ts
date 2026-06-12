import type { PgQueryExecutor } from "../pool.js";

export type MigrationStatement = {
  sql: string;
  warningPrefix?: string;
};

export async function runMigrationStatements(
  pool: PgQueryExecutor,
  statements: MigrationStatement[],
): Promise<void> {
  for (const statement of statements) {
    if (statement.warningPrefix) {
      await pool.query(statement.sql).catch((error) => {
        console.warn(`${statement.warningPrefix}${error instanceof Error ? error.message : String(error)}`);
      });
      continue;
    }
    await pool.query(statement.sql);
  }
}
