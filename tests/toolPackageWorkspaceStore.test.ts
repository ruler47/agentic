import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolPackageWorkspaceStore } from "../src/tools/toolPackageWorkspaceStore.js";

test("ToolPackageWorkspaceStore writes portable source-bundle packages outside app source", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-package-store-"));
  const store = new ToolPackageWorkspaceStore(projectRoot, "tools");

  try {
    const record = await store.writeSourceBundlePackage({
      manifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.demo.echo",
        displayName: "Demo Echo",
        version: "1.2.0",
        description: "Portable demo runtime.",
        capabilities: ["demo-echo"],
        startupMode: "on-demand",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      },
      files: [
        { path: "src/index.ts", content: "export const runtime = true;\n" },
        { path: "tests/runtime.test.ts", content: "import test from 'node:test';\n" },
      ],
    });
    const manifest = JSON.parse(await readFile(join(projectRoot, record.manifestPath), "utf8"));
    const readme = await readFile(join(projectRoot, "tools/generated.demo.echo/1.2.0/README.md"), "utf8");
    const dockerfile = await readFile(join(projectRoot, "tools/generated.demo.echo/1.2.0/Dockerfile"), "utf8");
    const packageJson = JSON.parse(await readFile(join(projectRoot, "tools/generated.demo.echo/1.2.0/package.json"), "utf8"));
    const tsconfig = JSON.parse(await readFile(join(projectRoot, "tools/generated.demo.echo/1.2.0/tsconfig.json"), "utf8"));
    const gitignore = await readFile(join(projectRoot, "tools/generated.demo.echo/1.2.0/.gitignore"), "utf8");

    assert.equal(record.packageRef, "generated.demo.echo/1.2.0");
    assert.equal(record.manifest.package.type, "source-bundle");
    assert.equal(manifest.package.ref, "generated.demo.echo/1.2.0");
    assert.equal(manifest.name, "generated.demo.echo");
    assert.match(readme, /Runtime Contract/);
    assert.match(dockerfile, /FROM node:22-alpine/);
    assert.equal(packageJson.scripts.build, "tsc -p tsconfig.json");
    assert.equal(packageJson.devDependencies["@types/node"], "^20.12.12");
    assert.equal(tsconfig.compilerOptions.outDir, "dist");
    assert.match(gitignore, /node_modules/);
    assert.ok(record.files.includes("tools/generated.demo.echo/1.2.0/src/index.ts"));
    assert.equal(record.files.some((path) => path.startsWith("src/tools/generated")), false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("ToolPackageWorkspaceStore rejects package path traversal", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-package-store-"));
  const store = new ToolPackageWorkspaceStore(projectRoot, "tools");

  try {
    await assert.rejects(
      () => store.writeSourceBundlePackage({
        manifest: {
          schemaVersion: "agentic.tool-package.v1",
          name: "generated.bad.package",
          version: "1.0.0",
          description: "Bad package.",
          capabilities: ["bad"],
          startupMode: "on-demand",
        },
        files: [{ path: "../escape.ts", content: "bad" }],
      }),
      /must stay inside/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("ToolPackageWorkspaceStore rejects non source-bundle package manifests", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-package-store-"));
  const store = new ToolPackageWorkspaceStore(projectRoot, "tools");

  try {
    await assert.rejects(
      () => store.writeSourceBundlePackage({
        manifest: {
          schemaVersion: "agentic.tool-package.v1",
          name: "generated.external.package",
          version: "1.0.0",
          description: "External package.",
          capabilities: ["external"],
          startupMode: "on-demand",
          package: { type: "external-package", ref: "https://runtime.example.test" },
        },
      }),
      /only writes source-bundle/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
