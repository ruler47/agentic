import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadGeneratedTools, compiledModulePath } from "../src/tools/generatedToolLoader.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import { ToolPackageRunner } from "../src/tools/toolPackageRunner.js";

test("compiledModulePath maps source tool modules to built JavaScript modules", () => {
  assert.equal(
    compiledModulePath("src/tools/generated/browser-screenshotTool.ts"),
    "dist/tools/generated/browser-screenshotTool.js",
  );
});

test("loadGeneratedTools imports healthy generated tools and promotes metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-generated-tools-"));
  const modulePath = join(root, "dist/tools/generated/echoTool.js");
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();

  try {
    await mkdir(join(root, "dist/tools/generated"), { recursive: true });
    await writeFile(
      modulePath,
      `
        export default {
          name: "generated.test.echo",
          version: "1.0.0",
          description: "Echo test generated tool.",
          capabilities: ["test-echo"],
          async healthcheck() { return { ok: true, detail: "healthy" }; },
          async run(input) { return { ok: true, content: String(input.text ?? "") }; }
        };
      `,
    );
    await metadata.registerGenerated({
      name: "generated.test.echo",
      version: "1.0.0",
      description: "Echo test generated tool.",
      capabilities: ["test-echo"],
      modulePath: "src/tools/generated/echoTool.ts",
    });

    const results = await loadGeneratedTools(registry, metadata, root);
    const [stored] = await metadata.list();
    const tool = registry.get("generated.test.echo");
    const output = await tool?.run({ text: "hello" });

    assert.equal(results[0]?.loaded, true);
    assert.equal(stored?.status, "available");
    assert.equal(stored?.lastHealthOk, true);
    assert.equal(tool?.name, "generated.test.echo");
    assert.equal(output?.content, "hello");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadGeneratedTools rejects modules that do not match registered metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-generated-tools-"));
  const modulePath = join(root, "dist/tools/generated/mismatchTool.js");
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();

  try {
    await mkdir(join(root, "dist/tools/generated"), { recursive: true });
    await writeFile(
      modulePath,
      `
        export const tool = {
          name: "generated.test.other",
          version: "1.0.0",
          description: "Mismatched generated tool.",
          capabilities: ["test-echo"],
          async run() { return { ok: true, content: "bad" }; }
        };
      `,
    );
    await metadata.registerGenerated({
      name: "generated.test.echo",
      version: "1.0.0",
      description: "Echo test generated tool.",
      capabilities: ["test-echo"],
      modulePath: "src/tools/generated/mismatchTool.ts",
    });

    const results = await loadGeneratedTools(registry, metadata, root);
    const [stored] = await metadata.list();

    assert.equal(results[0]?.loaded, false);
    assert.match(results[0]?.detail ?? "", /name mismatch/);
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.lastHealthOk, false);
    assert.equal(registry.get("generated.test.echo"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadGeneratedTools leaves non-local package manifests disabled until a runner exists", async () => {
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();
  await metadata.registerGenerated({
    name: "generated.remote.normalize",
    version: "1.0.0",
    description: "Portable package reference.",
    capabilities: ["text-normalization"],
    packageManifest: {
      schemaVersion: "agentic.tool-package.v1",
      name: "generated.remote.normalize",
      version: "1.0.0",
      description: "Portable package reference.",
      capabilities: ["text-normalization"],
      startupMode: "on-demand",
      package: { type: "external-package", ref: "npm:@agentic-tools/remote-normalize@1.0.0" },
    },
  });

  const results = await loadGeneratedTools(registry, metadata);
  const [stored] = await metadata.list();

  assert.equal(results[0]?.loaded, false);
  assert.match(results[0]?.detail ?? "", /No generated-tool runner/);
  assert.equal(stored?.status, "disabled");
  assert.equal(stored?.lastHealthOk, undefined);
  assert.equal(registry.get("generated.remote.normalize"), undefined);
});

test("loadGeneratedTools can load non-local package manifests through a registered runner", async () => {
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();
  await metadata.registerGenerated({
    name: "generated.remote.normalize",
    version: "1.0.0",
    description: "Portable package reference.",
    capabilities: ["text-normalization"],
    packageManifest: {
      schemaVersion: "agentic.tool-package.v1",
      name: "generated.remote.normalize",
      version: "1.0.0",
      description: "Portable package reference.",
      capabilities: ["text-normalization"],
      startupMode: "on-demand",
      package: { type: "external-package", ref: "npm:@agentic-tools/remote-normalize@1.0.0" },
    },
  });
  const runner: ToolPackageRunner = {
    type: "external-package",
    canLoad(module) {
      return module.packageManifest?.package.type === "external-package";
    },
    async load(module) {
      return {
        loaded: true,
        detail: `Loaded ${module.name} through test external runner.`,
        health: { ok: true, detail: "external runner healthy" },
        tool: {
          name: module.name,
          version: module.version,
          description: module.description,
          capabilities: module.capabilities,
          async run(input) {
            return { ok: true, content: String(input.text ?? "").trim().replace(/\s+/g, " ") };
          },
        },
      };
    },
  };

  const results = await loadGeneratedTools(registry, metadata, process.cwd(), [runner]);
  const [stored] = await metadata.list();
  const output = await registry.get("generated.remote.normalize")?.run({ text: " hello   runner " });

  assert.equal(results[0]?.loaded, true);
  assert.equal(stored?.status, "available");
  assert.equal(stored?.lastHealthDetail, "external runner healthy");
  assert.equal(output?.content, "hello runner");
});
