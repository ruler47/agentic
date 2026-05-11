import test from "node:test";
import assert from "node:assert/strict";

/**
 * Smoke tests for the regex-based inputSchema extractor inside
 * `councilToolAdapter.ts`. The extractor is the fallback the Tools
 * page relies on when a council-built tool fails to load (TS error,
 * missing dep): without it the operator can't even see the schema
 * the LLM declared, so they have no way to compose a manual call.
 *
 * The extractor is currently a module-private helper. To keep this
 * test honest without leaking the helper into the public API, we
 * dynamically import the source file and invoke the helper via a
 * synthetic surface: we drive the adapter against an in-memory
 * metadata store and inspect what gets persisted. That keeps the
 * test focused on the operator-visible behaviour ("after I build
 * this tool, the metadata row carries the schema") rather than the
 * helper's exact regex.
 */

import { CouncilToolAdapter } from "../src/tools/councilToolAdapter.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import { InMemoryCodingCouncilStore } from "../src/settings/codingCouncilStore.js";
import { InMemoryModelTierSettingsStore } from "../src/settings/modelTierSettings.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runAdapterAgainstSource(toolSource: string): Promise<Record<string, unknown> | undefined> {
  const toolsRoot = await mkdtemp(join(tmpdir(), "council-adapter-"));
  try {
    const metadata = new InMemoryToolMetadataStore();
    const adapter = new CouncilToolAdapter({
      toolsRoot,
      codingCouncilStore: new InMemoryCodingCouncilStore(),
      modelTierSettings: new InMemoryModelTierSettingsStore(),
      metadataStore: metadata,
      // Don't actually start tools — just exercise the metadata path.
      runToolManually: async () => ({ result: { ok: true, content: "stub" } }),
      // No live tool — forces the regex fallback path.
      getRegisteredTool: () => undefined,
    });
    await adapter.registerToolFromFiles(
      "demo.echo",
      [
        {
          path: "src/tools/generated/demo.echoTool.ts",
          content: toolSource,
        },
      ],
      { description: "demo" },
    );
    const list = await metadata.list();
    const row = list.find((m) => m.name === "demo.echo");
    return row?.inputSchema as Record<string, unknown> | undefined;
  } finally {
    await rm(toolsRoot, { recursive: true, force: true });
  }
}

test("extractInputSchemaFromSource handles inline `inputSchema: { … }`", async () => {
  const source = [
    'import { Tool } from "../tool.js";',
    "export const tool: Tool = {",
    '  name: "demo.echo",',
    '  version: "1.0.0",',
    '  description: "echo",',
    "  capabilities: [],",
    "  inputSchema: {",
    '    type: "object",',
    "    properties: {",
    '      text: { type: "string" }',
    "    },",
    '    required: ["text"]',
    "  },",
    "  run: () => ({ ok: true, content: \"\" }),",
    "};",
  ].join("\n");

  const schema = await runAdapterAgainstSource(source);
  assert.ok(schema, "expected schema to be extracted");
  assert.equal(schema.type, "object");
  assert.deepEqual(Object.keys(schema.properties as Record<string, unknown>), ["text"]);
  assert.deepEqual(schema.required, ["text"]);
});

test("extractInputSchemaFromSource handles separate `const inputSchema = { … }` declaration + shorthand reference", async () => {
  // qwen + gemma both produce this shape in practice — the inline
  // regex misses it because the Tool literal has `inputSchema,` not
  // `inputSchema: {`.
  const source = [
    'import { Tool } from "../tool.js";',
    "const inputSchema = {",
    '  type: "object",',
    "  properties: {",
    '    text: { type: "string", description: "The text to echo back." }',
    "  },",
    '  required: ["text"]',
    "};",
    "export const tool: Tool = {",
    '  name: "demo.echo",',
    '  version: "1.0.0",',
    '  description: "echo",',
    "  capabilities: [],",
    "  inputSchema,",
    "  run: () => ({ ok: true, content: \"\" }),",
    "};",
  ].join("\n");

  const schema = await runAdapterAgainstSource(source);
  assert.ok(schema, "expected schema to be extracted from shorthand reference");
  assert.equal(schema.type, "object");
  assert.deepEqual(Object.keys(schema.properties as Record<string, unknown>), ["text"]);
  assert.deepEqual(schema.required, ["text"]);
});

test("extractInputSchemaFromSource leaves schema undefined when source has no schema literal", async () => {
  const source = [
    'import { Tool } from "../tool.js";',
    "export const tool: Tool = {",
    '  name: "demo.echo",',
    '  version: "1.0.0",',
    '  description: "echo",',
    "  capabilities: [],",
    "  run: () => ({ ok: true, content: \"\" }),",
    "};",
  ].join("\n");

  const schema = await runAdapterAgainstSource(source);
  assert.equal(schema, undefined);
});
