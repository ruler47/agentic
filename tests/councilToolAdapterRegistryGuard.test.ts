import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CouncilToolAdapter } from "../src/tools/councilToolAdapter.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import { InMemoryCodingCouncilStore } from "../src/settings/codingCouncilStore.js";
import { InMemoryModelTierSettingsStore } from "../src/settings/modelTierSettings.js";

/**
 * Phase 16 Slice B regression coverage.
 *
 * Before the fix, when a council-built tool's new version was promoted
 * in metadata but failed to import into the in-process registry, the
 * adapter returned successfully and the QA loop downstream raised the
 * generic "Tool not registered" without any pointer to the real
 * cause. This produced the failed runs
 * `run_1778526527329_lour2zbm` and `run_..._9vyn7xg0`.
 *
 * After the fix, the adapter probes
 * `deps.getRegisteredTool(toolName)` right after
 * `deps.reloadGeneratedTools()` and throws a descriptive error that
 * includes the loader's last-health detail. The council run then
 * fails at the registration step, with diagnostics, before QA wastes
 * repair attempts on a missing tool.
 *
 * The guard only fires when BOTH `reloadGeneratedTools` and
 * `getRegisteredTool` are wired (production runtime). Test fixtures
 * that leave `reloadGeneratedTools` undefined still work — that
 * preserves the existing parser-fallback test.
 */

const TOOL_SOURCE = [
  'import { Tool } from "../tool.js";',
  "export const tool: Tool = {",
  '  name: "demo.echo",',
  '  version: "1.0.0",',
  '  description: "echo",',
  "  capabilities: [],",
  "  inputSchema: { type: \"object\", properties: { text: { type: \"string\" } } },",
  "  run: () => ({ ok: true, content: \"\" }),",
  "};",
].join("\n");

async function withTempToolsRoot<T>(fn: (toolsRoot: string) => Promise<T>): Promise<T> {
  const toolsRoot = await mkdtemp(join(tmpdir(), "council-adapter-guard-"));
  try {
    return await fn(toolsRoot);
  } finally {
    await rm(toolsRoot, { recursive: true, force: true });
  }
}

test("guard fires when reload + probe wired and the new version did not register", async () => {
  await withTempToolsRoot(async (toolsRoot) => {
    const metadata = new InMemoryToolMetadataStore();
    let reloadCalls = 0;
    const adapter = new CouncilToolAdapter({
      toolsRoot,
      codingCouncilStore: new InMemoryCodingCouncilStore(),
      modelTierSettings: new InMemoryModelTierSettingsStore(),
      metadataStore: metadata,
      runToolManually: async () => ({ result: { ok: true, content: "stub" } }),
      // Simulate "loader failed to import the new version" — the
      // probe returns undefined even though promoteReplacement just
      // updated the metadata row.
      getRegisteredTool: () => undefined,
      reloadGeneratedTools: async () => {
        reloadCalls += 1;
      },
    });

    await assert.rejects(
      adapter.registerToolFromFiles(
        "demo.echo",
        [{ path: "src/tools/generated/demo.echoTool.ts", content: TOOL_SOURCE }],
        { description: "demo" },
      ),
      (err: Error) =>
        /promoted in metadata/.test(err.message) && /could not import/.test(err.message),
      "expected a descriptive error mentioning promotion + import failure",
    );
    assert.equal(reloadCalls, 1, "reload should have been called once before the throw");
  });
});

test("guard stays silent when reload is not wired (preserves legacy test setups)", async () => {
  await withTempToolsRoot(async (toolsRoot) => {
    const metadata = new InMemoryToolMetadataStore();
    const adapter = new CouncilToolAdapter({
      toolsRoot,
      codingCouncilStore: new InMemoryCodingCouncilStore(),
      modelTierSettings: new InMemoryModelTierSettingsStore(),
      metadataStore: metadata,
      runToolManually: async () => ({ result: { ok: true, content: "stub" } }),
      // `getRegisteredTool` returning undefined is the existing
      // signal for "force the inputSchema fallback path". With
      // `reloadGeneratedTools` undefined too, the guard must not
      // throw — that would break every fallback test.
      getRegisteredTool: () => undefined,
      // reloadGeneratedTools deliberately omitted.
    });

    await adapter.registerToolFromFiles(
      "demo.echo",
      [{ path: "src/tools/generated/demo.echoTool.ts", content: TOOL_SOURCE }],
      { description: "demo" },
    );
    const list = await metadata.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, "demo.echo");
  });
});

test("guard stays silent when probe returns a tool (happy path)", async () => {
  await withTempToolsRoot(async (toolsRoot) => {
    const metadata = new InMemoryToolMetadataStore();
    const adapter = new CouncilToolAdapter({
      toolsRoot,
      codingCouncilStore: new InMemoryCodingCouncilStore(),
      modelTierSettings: new InMemoryModelTierSettingsStore(),
      metadataStore: metadata,
      runToolManually: async () => ({ result: { ok: true, content: "stub" } }),
      // Probe simulates a successful registry registration.
      getRegisteredTool: () => ({
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        outputSchema: undefined,
        examples: undefined,
        requiredSecretHandles: [],
      }),
      reloadGeneratedTools: async () => undefined,
    });

    const result = await adapter.registerToolFromFiles(
      "demo.echo",
      [{ path: "src/tools/generated/demo.echoTool.ts", content: TOOL_SOURCE }],
      { description: "demo" },
    );
    assert.equal(result.toolName, "demo.echo");
    assert.equal(result.version, "1.0.0");
  });
});

test("guard error includes loader detail from metadata last-health when available", async () => {
  await withTempToolsRoot(async (toolsRoot) => {
    const metadata = new InMemoryToolMetadataStore();
    const adapter = new CouncilToolAdapter({
      toolsRoot,
      codingCouncilStore: new InMemoryCodingCouncilStore(),
      modelTierSettings: new InMemoryModelTierSettingsStore(),
      metadataStore: metadata,
      runToolManually: async () => ({ result: { ok: true, content: "stub" } }),
      getRegisteredTool: () => undefined,
      reloadGeneratedTools: async () => {
        // Simulate the loader marking the just-promoted version as
        // unhealthy with a useful detail string.
        await metadata.updateHealth("demo.echo", {
          ok: false,
          detail: "SourceBundle index.ts missing — file write incomplete.",
        });
      },
    });

    await assert.rejects(
      adapter.registerToolFromFiles(
        "demo.echo",
        [{ path: "src/tools/generated/demo.echoTool.ts", content: TOOL_SOURCE }],
        { description: "demo" },
      ),
      (err: Error) => /SourceBundle index\.ts missing/.test(err.message),
      "expected error to surface the loader detail",
    );
  });
});
