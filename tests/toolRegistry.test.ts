import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/registry.js";

test("ToolRegistry registers, lists, and retrieves tools", async () => {
  const registry = new ToolRegistry();
  const tool = {
    name: "echo",
    description: "Returns the input message.",
    capabilities: ["echo"],
    async run(input: Record<string, unknown>) {
      return { ok: true, content: String(input.message ?? "") };
    },
  };

  registry.register(tool);

  assert.deepEqual(
    registry.list().map((item) => item.name),
    ["echo"],
  );
  assert.equal(registry.get("echo"), tool);
  assert.deepEqual(registry.findByCapability("echo"), [tool]);
  assert.deepEqual(registry.findByCapability("missing"), []);
  assert.deepEqual(await registry.get("echo")?.run({ message: "hello" }), {
    ok: true,
    content: "hello",
  });
  assert.equal(registry.unregister("echo"), true);
  assert.equal(registry.get("echo"), undefined);
  assert.equal(registry.unregister("echo"), false);
});

test("ToolRegistry executes tools with scoped runtime context", async () => {
  const registry = new ToolRegistry();
  const seenContexts: unknown[] = [];
  const usageEvents: unknown[] = [];
  const savedArtifacts: unknown[] = [];
  registry.setUsageReporter((event) => {
    usageEvents.push(event);
  });
  const tool = {
    name: "context.echo",
    description: "Returns context metadata.",
    capabilities: ["echo"],
    async run(input: Record<string, unknown>, context?: any) {
      seenContexts.push(context);
      await context?.artifacts?.saveGenerated({
        filename: "context.txt",
        mimeType: "text/plain",
        content: String(input.message ?? ""),
        description: "Context artifact",
      });
      return {
        ok: true,
        content: `${input.message}:${context?.runId}:${context?.toolName}`,
      };
    },
  };

  registry.register(tool);
  const result = await registry.execute(tool, { message: "hello" }, {
    runId: "run-test",
    spanId: "span-test",
    requesterUserId: "user-admin",
    artifacts: {
      saveGenerated: async (artifact) => {
        savedArtifacts.push(artifact);
        return {
          id: "artifact-context",
          runId: "run-test",
          kind: "output",
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          sizeBytes: String(artifact.content).length,
          url: "/artifacts/context.txt",
          createdAt: new Date().toISOString(),
        };
      },
    },
  });

  assert.deepEqual(result, {
    ok: true,
    content: "hello:run-test:context.echo",
  });
  assert.equal((seenContexts[0] as any).toolName, "context.echo");
  assert.equal((seenContexts[0] as any).spanId, "span-test");
  assert.equal((seenContexts[0] as any).now instanceof Date, true);
  assert.deepEqual(savedArtifacts, [
    {
      filename: "context.txt",
      mimeType: "text/plain",
      content: "hello",
      description: "Context artifact",
    },
  ]);
  assert.equal((usageEvents[0] as any).toolName, "context.echo");
  assert.equal((usageEvents[0] as any).outcome, "success");
  assert.equal((usageEvents[0] as any).at instanceof Date, true);
});

test("ToolRegistry records failed tool usage without hiding the result", async () => {
  const registry = new ToolRegistry();
  const usageEvents: unknown[] = [];
  registry.setUsageReporter((event) => {
    usageEvents.push(event);
  });
  const tool = {
    name: "context.fail",
    description: "Returns a failed tool result.",
    capabilities: ["test"],
    async run() {
      return { ok: false, content: "blocked by provider" };
    },
  };

  registry.register(tool);
  const result = await registry.execute(tool, {});

  assert.deepEqual(result, { ok: false, content: "blocked by provider" });
  assert.equal((usageEvents[0] as any).toolName, "context.fail");
  assert.equal((usageEvents[0] as any).outcome, "failure");
});

test("ToolRegistry can enrich tool calls with a runtime context provider", async () => {
  const registry = new ToolRegistry();
  const seenContexts: unknown[] = [];
  registry.setRuntimeContextProvider(({ tool, context }) => ({
    db: {
      async query<T = unknown>(sql: string) {
        return {
          rows: [{ sql, toolName: tool.name, runId: context.runId }] as T[],
          rowCount: 1,
        };
      },
    },
  }));
  const tool = {
    name: "context.db",
    description: "Uses injected database context.",
    capabilities: ["db-test"],
    async run(_input: Record<string, unknown>, context?: any) {
      seenContexts.push(context);
      const result = await context.db.query("select 1");
      return { ok: true, content: JSON.stringify(result.rows[0]) };
    },
  };

  registry.register(tool);
  const result = await registry.execute(tool, {}, { runId: "run-db" });

  assert.equal((seenContexts[0] as any).toolName, "context.db");
  assert.equal((seenContexts[0] as any).runId, "run-db");
  assert.deepEqual(JSON.parse(result.content), {
    sql: "select 1",
    toolName: "context.db",
    runId: "run-db",
  });
});
