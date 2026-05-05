import type { PgPool } from "../db/pool.js";
import type { Tool, ToolExecutionContext } from "./tool.js";
import type { ToolRuntimeContextProvider } from "./registry.js";

type QueryResult<T> = { rows: T[]; rowCount?: number | null };

type QueryablePool = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
};

const READ_PERMISSIONS = new Set(["read", "db:read", "tool-db:read", "runtime-db:read"]);
const WRITE_PERMISSIONS = new Set(["write", "db:write", "tool-db:write", "runtime-db:write"]);

export function createToolScopedDbContextProvider(pool: PgPool): ToolRuntimeContextProvider {
  return ({ tool }) => {
    const db = createScopedToolDbClient(pool, tool);
    return db ? { db } : undefined;
  };
}

export function createScopedToolDbClient(
  pool: QueryablePool,
  tool: Tool,
): ToolExecutionContext["db"] | undefined {
  if (!tool.storage) return undefined;

  const permissions = new Set(tool.storage.permissions ?? []);

  return {
    async query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      validateScopedToolSql(sql, permissions);
      return pool.query<T>(sql, params);
    },
  };
}

export function validateScopedToolSql(sql: string, permissions: Set<string>): void {
  const normalized = normalizeSql(sql);
  if (!normalized) throw new Error("Tool DB query cannot be empty.");
  if (hasMultipleStatements(normalized)) {
    throw new Error("Tool DB query must contain exactly one statement.");
  }
  const verb = firstSqlVerb(normalized);
  if (!verb) throw new Error("Tool DB query must start with a SQL command.");
  if (containsUnsafeSqlToken(normalized) || verb === "set") {
    throw new Error("Tool DB runtime queries cannot execute DDL, grants, transactions, or session changes.");
  }

  if (verb === "select" || verb === "with") {
    requireAnyPermission(permissions, READ_PERMISSIONS, "read");
    return;
  }

  if (verb === "insert" || verb === "update") {
    requireAnyPermission(permissions, WRITE_PERMISSIONS, "write");
    return;
  }

  if (verb === "delete") {
    throw new Error("Tool DB runtime queries cannot delete records; create an auditable maintenance capability instead.");
  }

  throw new Error(`Tool DB runtime query command "${verb}" is not allowed.`);
}

function requireAnyPermission(permissions: Set<string>, allowed: Set<string>, label: string): void {
  for (const permission of allowed) {
    if (permissions.has(permission)) return;
  }
  throw new Error(`Tool DB ${label} query requires one of: ${[...allowed].join(", ")}.`);
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/;\s*$/, "").trim();
}

function firstSqlVerb(sql: string): string | undefined {
  return sql.match(/^[a-z]+/i)?.[0]?.toLowerCase();
}

function hasMultipleStatements(sql: string): boolean {
  return /;\s*\S/.test(sql);
}

function containsUnsafeSqlToken(sql: string): boolean {
  return /\b(alter|begin|call|commit|copy|create|drop|execute|grant|listen|notify|reindex|reset|revoke|rollback|truncate|vacuum)\b/i.test(
    sql,
  );
}
