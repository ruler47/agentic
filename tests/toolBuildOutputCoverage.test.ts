import test from "node:test";
import assert from "node:assert/strict";
import { findRequiredOutputsNotInSchema } from "../src/tools/toolBuildReviewers.js";

const baseRequest = (requiredOutputs: string[]) =>
  ({
    id: "tb_test",
    capability: "test-capability",
    reason: "test",
    requiredOutputs,
    contract: {
      capability: "test-capability",
      toolName: "test.tool",
      modulePath: "src/tools/generated/testTool.ts",
      testPath: "tests/generated/testTool.test.ts",
      description: "test",
      startupMode: "on-demand",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
      acceptanceCriteria: [],
      qaCriteria: [],
      builderInstructions: [],
      version: "1.0.0",
    },
  }) as never;

const buildOutput = (outputSchemaProperties: Record<string, unknown>) =>
  ({
    modulePath: "src/tools/generated/testTool.ts",
    testPath: "tests/generated/testTool.test.ts",
    summary: "x",
    capabilities: ["test-capability"],
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: outputSchemaProperties },
    files: [],
  }) as never;

test("findRequiredOutputsNotInSchema returns [] when every required output is present", () => {
  const missing = findRequiredOutputsNotInSchema(
    baseRequest(["results", "count"]),
    buildOutput({ results: { type: "array" }, count: { type: "number" } }),
  );
  assert.deepEqual(missing, []);
});

test("findRequiredOutputsNotInSchema flags missing outputs", () => {
  const missing = findRequiredOutputsNotInSchema(
    baseRequest(["results", "count"]),
    buildOutput({ artifact: { type: "object" } }),
  );
  assert.deepEqual(missing, ["results", "count"]);
});

test("findRequiredOutputsNotInSchema is case-insensitive", () => {
  const missing = findRequiredOutputsNotInSchema(
    baseRequest(["Results"]),
    buildOutput({ results: { type: "array" } }),
  );
  assert.deepEqual(missing, []);
});

test("findRequiredOutputsNotInSchema looks one level deeper into ToolResult.data.properties", () => {
  // For tools whose outputSchema is { ok, content, data: { properties: { results } } }
  // the requested `results` should be considered satisfied.
  const missing = findRequiredOutputsNotInSchema(
    baseRequest(["results"]),
    buildOutput({
      ok: { type: "boolean" },
      content: { type: "string" },
      data: { type: "object", properties: { results: { type: "array" } } },
    }),
  );
  assert.deepEqual(missing, []);
});

test("findRequiredOutputsNotInSchema returns [] when no requiredOutputs declared", () => {
  const missing = findRequiredOutputsNotInSchema(
    baseRequest([]),
    buildOutput({ results: { type: "array" } }),
  );
  assert.deepEqual(missing, []);
});
