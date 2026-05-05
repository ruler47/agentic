import type { ToolStorageContract } from "./tool.js";

export type ToolStorageMigrationQueryExecutor = {
  query(sql: string): Promise<unknown>;
};

export type ToolStorageMigrationPlan = {
  migrationId: string;
  statements: string[];
  rollbackNotes: string;
};

export type ToolStorageMigrationExecutionReport = {
  ok: boolean;
  summary: string;
  checks: string[];
  plans: ToolStorageMigrationPlan[];
};

const serviceRuntimeTables = new Set(["service_events", "service_offsets", "service_delivery_attempts"]);

export function planToolStorageMigrations(storage: ToolStorageContract): ToolStorageMigrationPlan[] {
  if (!storage.migrations?.length) return [];
  const schema = assertSchemaIdentifier(storage.schema);
  return storage.migrations.map((migrationId) => {
    if (migrationId !== "001_create_service_runtime_tables") {
      throw new Error(`No SQL planner is registered for tool migration ${migrationId}.`);
    }
    const tables = storage.tables?.length
      ? storage.tables.map((table) => assertIdentifier(table, "storage.tables"))
      : [...serviceRuntimeTables];
    const unsupported = tables.filter((table) => !serviceRuntimeTables.has(table));
    if (unsupported.length > 0) {
      throw new Error(`Migration ${migrationId} cannot create unsupported service table(s): ${unsupported.join(", ")}`);
    }

    return {
      migrationId,
      statements: serviceRuntimeStatements(schema, tables),
      rollbackNotes: `Drop schema ${schema} after confirming no active generated tool version uses it.`,
    };
  });
}

export async function runToolStorageMigrationPlanQa(
  pool: ToolStorageMigrationQueryExecutor,
  storage: ToolStorageContract,
): Promise<ToolStorageMigrationExecutionReport> {
  const plans = planToolStorageMigrations(storage);
  const checks: string[] = [];
  if (plans.length === 0) {
    return {
      ok: true,
      summary: "No storage migrations to execute.",
      checks: ["isolated storage migration execution: no migrations declared"],
      plans,
    };
  }

  await pool.query("begin");
  try {
    for (const pass of [1, 2]) {
      for (const plan of plans) {
        for (const statement of plan.statements) {
          await pool.query(statement);
        }
        checks.push(`isolated storage migration execution: ${plan.migrationId} pass ${pass} ok`);
      }
    }
    await pool.query("rollback");
  } catch (error) {
    await pool.query("rollback").catch(() => undefined);
    return {
      ok: false,
      summary: error instanceof Error ? error.message : String(error),
      checks,
      plans,
    };
  }

  return {
    ok: true,
    summary: `Executed ${plans.length} storage migration plan(s) twice in isolated transaction.`,
    checks,
    plans,
  };
}

function serviceRuntimeStatements(schema: string, tables: string[]): string[] {
  const statements = [`create schema if not exists ${quoteIdent(schema)}`];
  if (tables.includes("service_events")) {
    statements.push(`
      create table if not exists ${quoteIdent(schema)}.${quoteIdent("service_events")} (
        id text primary key,
        direction text not null,
        source_user_id text,
        source_chat_id text,
        source_message_id text,
        thread_id text,
        payload jsonb,
        recorded_at timestamptz not null,
        created_at timestamptz not null default now()
      )
    `);
    statements.push(`
      create index if not exists ${quoteIdent(`${schema}_service_events_recorded_idx`)}
      on ${quoteIdent(schema)}.${quoteIdent("service_events")} (recorded_at desc)
    `);
  }
  if (tables.includes("service_offsets")) {
    statements.push(`
      create table if not exists ${quoteIdent(schema)}.${quoteIdent("service_offsets")} (
        provider text primary key,
        cursor_value text,
        updated_at timestamptz not null default now()
      )
    `);
  }
  if (tables.includes("service_delivery_attempts")) {
    statements.push(`
      create table if not exists ${quoteIdent(schema)}.${quoteIdent("service_delivery_attempts")} (
        id text primary key,
        event_id text not null,
        target text not null,
        status text not null,
        provider_response jsonb,
        attempted_at timestamptz not null default now()
      )
    `);
    statements.push(`
      create index if not exists ${quoteIdent(`${schema}_delivery_event_idx`)}
      on ${quoteIdent(schema)}.${quoteIdent("service_delivery_attempts")} (event_id, attempted_at desc)
    `);
  }
  return statements.map((statement) => statement.trim().replace(/\s+/g, " "));
}

function assertIdentifier(value: string | undefined, field: string): string {
  if (!value || !/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error(`${field} must be a safe snake_case identifier`);
  }
  return value;
}

function assertSchemaIdentifier(value: string | undefined): string {
  const schema = assertIdentifier(value, "storage.schema");
  if (!schema.startsWith("tool_")) {
    throw new Error("storage.schema must be a tool-owned snake_case identifier prefixed with tool_");
  }
  return schema;
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
