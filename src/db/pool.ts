import pg from "pg";

export function createPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  return new pg.Pool({
    connectionString,
  });
}

export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;
export type PgQueryExecutor = Pick<pg.Pool | pg.PoolClient, "query">;
