import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolPackageWorkspaceStore } from "../src/tools/toolPackageWorkspaceStore.js";
import {
  validateAndBuildToolPackageWorkspace,
  validateToolPackageWorkspace,
} from "../src/tools/toolPackageWorkspaceQa.js";

test("validateToolPackageWorkspace accepts a complete generated package snapshot", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-package-qa-"));
  const store = new ToolPackageWorkspaceStore(projectRoot, "tools");

  try {
    const record = await store.writeSourceBundlePackage({
      manifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.qa.echo",
        version: "1.0.0",
        description: "QA echo package.",
        capabilities: ["qa-echo"],
        startupMode: "on-demand",
      },
      files: [
        { path: "src/tools/tool.ts", content: "export type Tool = { name: string };\n" },
        { path: "src/tools/generated/qa-echoTool.ts", content: "export const ok = true;\n" },
        { path: "tests/generated/qa-echoTool.test.ts", content: "import test from 'node:test';\n" },
      ],
    });

    const report = await validateToolPackageWorkspace(projectRoot, {
      packageRef: record.packageRef,
      manifestPath: record.manifestPath,
      files: record.files,
    });

    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.match(report.summary, /passed structural QA/);
    assert.ok(report.checks.some((check) => check.includes("package-local Tool contract ok")));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("validateAndBuildToolPackageWorkspace builds and tests the package-local project", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-package-qa-"));
  const store = new ToolPackageWorkspaceStore(projectRoot, "tools");

  try {
    const record = await store.writeSourceBundlePackage({
      manifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.qa.echo",
        version: "1.0.0",
        description: "QA echo package.",
        capabilities: ["qa-echo"],
        startupMode: "on-demand",
      },
      files: [
        {
          path: "src/tools/tool.ts",
          content: [
            "export type ToolInput = Record<string, unknown>;",
            "export type ToolResult = { ok: boolean; content: string };",
            "export type Tool = { name: string; run(input: ToolInput): ToolResult };",
            "",
          ].join("\n"),
        },
        {
          path: "src/tools/generated/qa-echoTool.ts",
          content: [
            "import { Tool } from '../tool.js';",
            "export const tool: Tool = {",
            "  name: 'generated.qa.echo',",
            "  run(input) {",
            "    return { ok: true, content: String(input.value ?? '') };",
            "  }",
            "};",
            "",
          ].join("\n"),
        },
        {
          path: "tests/generated/qa-echoTool.test.ts",
          content: [
            "import test from 'node:test';",
            "import assert from 'node:assert/strict';",
            "import { tool } from '../../src/tools/generated/qa-echoTool.js';",
            "test('qa echo package works', () => {",
            "  assert.equal(tool.run({ value: 'ok' }).content, 'ok');",
            "});",
            "",
          ].join("\n"),
        },
      ],
    });

    const report = await validateAndBuildToolPackageWorkspace(
      projectRoot,
      {
        packageRef: record.packageRef,
        manifestPath: record.manifestPath,
        files: record.files,
      },
      { linkNodeModulesFrom: process.cwd() },
    );

    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.match(report.summary, /build, and test QA/);
    assert.ok(report.checks.some((check) => check.includes("package-local TypeScript build passed")));
    assert.ok(report.checks.some((check) => check.includes("package-local tests passed")));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("validateToolPackageWorkspace rejects path traversal", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-package-qa-"));

  try {
    const report = await validateToolPackageWorkspace(projectRoot, {
      packageRef: "generated.bad/1.0.0",
      manifestPath: "../tool.package.json",
      files: [],
    });

    assert.equal(report.ok, false);
    assert.match(report.summary, /project-relative/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
