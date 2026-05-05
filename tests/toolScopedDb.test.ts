import test from "node:test";
import assert from "node:assert/strict";
import { createScopedToolDbClient, validateScopedToolSql } from "../src/tools/toolScopedDb.js";
import type { Tool } from "../src/tools/tool.js";

test("scoped tool DB client allows declared read queries", async () => {
  const queries: unknown[] = [];
  const pool = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return { rows: [{ ok: true }] as T[], rowCount: 1 };
    },
  };
  const tool: Tool = {
    name: "generated.storage.reader",
    description: "Reads tool-owned data.",
    capabilities: ["storage-read"],
    storage: {
      schema: "tool_generated_storage_reader",
      tables: ["items"],
      permissions: ["tool-db:read"],
    },
    async run() {
      return { ok: true, content: "unused" };
    },
  };

  const db = createScopedToolDbClient(pool, tool);
  const result = await db?.query("select * from tool_generated_storage_reader.items where id = $1", ["item-1"]);

  assert.deepEqual(result, { rows: [{ ok: true }], rowCount: 1 });
  assert.deepEqual(queries, [
    {
      sql: "select * from tool_generated_storage_reader.items where id = $1",
      params: ["item-1"],
    },
  ]);
});

test("scoped tool DB client rejects undeclared writes and destructive SQL", async () => {
  const readOnly = new Set(["tool-db:read"]);
  assert.throws(
    () => validateScopedToolSql("update tool_data.items set value = $1", readOnly),
    /write query requires/,
  );
  assert.throws(
    () => validateScopedToolSql("delete from tool_data.items where id = $1", new Set(["tool-db:write"])),
    /cannot delete records/,
  );
  assert.throws(
    () => validateScopedToolSql("select 1; select 2", readOnly),
    /exactly one statement/,
  );
  assert.throws(
    () => validateScopedToolSql("create table tool_data.items(id text)", new Set(["tool-db:write"])),
    /cannot execute DDL/,
  );
});

test("scoped tool DB client is only created for tools with storage contracts", () => {
  const tool: Tool = {
    name: "plain.tool",
    description: "No storage.",
    capabilities: ["plain"],
    async run() {
      return { ok: true, content: "unused" };
    },
  };

  assert.equal(createScopedToolDbClient({ async query() { return { rows: [] }; } }, tool), undefined);
});
