import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
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
        { path: "index.ts", content: "export { ok } from './src/tools/generated/qa-echoTool.js';\n" },
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
          path: "index.ts",
          content: "export { tool } from './src/tools/generated/qa-echoTool.js';\n",
        },
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

test("validateAndBuildToolPackageWorkspace rejects always-on packages without startService", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-package-qa-"));
  const store = new ToolPackageWorkspaceStore(projectRoot, "tools");

  try {
    const record = await store.writeSourceBundlePackage({
      manifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.qa.service",
        version: "1.0.0",
        description: "QA service package.",
        capabilities: ["qa-service"],
        startupMode: "always-on",
      },
      files: [
        {
          path: "index.ts",
          content: "export { tool } from './src/tools/generated/qa-serviceTool.js';\n",
        },
        {
          path: "src/tools/tool.ts",
          content: [
            "export type ToolInput = Record<string, unknown>;",
            "export type ToolResult = { ok: boolean; content: string };",
            "export type Tool = { name: string; description: string; capabilities: string[]; startupMode?: 'always-on' | 'on-demand'; run(input: ToolInput): ToolResult };",
            "",
          ].join("\n"),
        },
        {
          path: "src/tools/generated/qa-serviceTool.ts",
          content: [
            "import { Tool } from '../tool.js';",
            "export const tool: Tool = {",
            "  name: 'generated.qa.service',",
            "  description: 'QA service package.',",
            "  capabilities: ['qa-service'],",
            "  startupMode: 'always-on',",
            "  run(input) {",
            "    return { ok: true, content: String(input.value ?? '') };",
            "  }",
            "};",
            "",
          ].join("\n"),
        },
        {
          path: "tests/generated/qa-serviceTool.test.ts",
          content: [
            "import test from 'node:test';",
            "import assert from 'node:assert/strict';",
            "import { tool } from '../../src/tools/generated/qa-serviceTool.js';",
            "test('qa service package echoes', () => {",
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

    assert.equal(report.ok, false);
    assert.match(report.summary, /startService/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("validateAndBuildToolPackageWorkspace can fail behavior QA on bad screenshot artifacts", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-package-qa-"));
  const store = new ToolPackageWorkspaceStore(projectRoot, "tools");
  const modalPngBase64 = lowerLeftConsentPanelPngBase64();

  try {
    const record = await store.writeSourceBundlePackage({
      manifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.qa.screenshot",
        version: "1.0.0",
        description: "QA screenshot package.",
        capabilities: ["browser-screenshot", "artifact-image"],
        startupMode: "on-demand",
      },
      files: [
        {
          path: "index.ts",
          content: "export { tool } from './src/tools/generated/qa-screenshotTool.js';\n",
        },
        {
          path: "src/tools/tool.ts",
          content: [
            "export type ToolInput = Record<string, unknown>;",
            "export type ToolResult = { ok: boolean; content: string; data?: unknown };",
            "export type Tool = { name: string; run(input: ToolInput): ToolResult };",
            "",
          ].join("\n"),
        },
        {
          path: "src/tools/generated/qa-screenshotTool.ts",
          content: [
            "import { Tool } from '../tool.js';",
            `const modalPngBase64 = ${JSON.stringify(modalPngBase64)};`,
            "export const tool: Tool = {",
            "  name: 'generated.qa.screenshot',",
            "  run() {",
            "    return { ok: true, content: 'Screenshot captured', data: { artifact: { filename: 'blocked.png', mimeType: 'image/png', contentBase64: modalPngBase64, description: 'Blocked screenshot' } } };",
            "  }",
            "};",
            "",
          ].join("\n"),
        },
        {
          path: "tests/generated/qa-screenshotTool.test.ts",
          content: [
            "import test from 'node:test';",
            "import assert from 'node:assert/strict';",
            "import { tool } from '../../src/tools/generated/qa-screenshotTool.js';",
            "test('qa screenshot package returns artifact', () => {",
            "  const result = tool.run({});",
            "  assert.equal(result.ok, true);",
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
      {
        linkNodeModulesFrom: process.cwd(),
        behaviorExamples: [{
          title: "Screenshot proof must be visually usable",
          input: { url: "https://example.test" },
          expectedArtifactMimeType: "image/png",
          expectedArtifactVisualOk: true,
        }],
      },
    );

    assert.equal(report.ok, false);
    assert.match(report.summary, /visual artifact ok=true/i);
    assert.match(report.summary, /modal|consent/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("validateAndBuildToolPackageWorkspace runs multi-step behavior scenarios with output placeholders", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-package-qa-"));
  const store = new ToolPackageWorkspaceStore(projectRoot, "tools");

  try {
    const record = await store.writeSourceBundlePackage({
      manifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.qa.workflow",
        version: "1.0.0",
        description: "QA workflow package.",
        capabilities: ["workflow-qa"],
        startupMode: "on-demand",
      },
      files: [
        {
          path: "index.ts",
          content: "export { tool } from './src/tools/generated/qa-workflowTool.js';\n",
        },
        {
          path: "src/tools/tool.ts",
          content: [
            "export type ToolInput = Record<string, unknown>;",
            "export type ToolResult = { ok: boolean; content: string; data?: unknown };",
            "export type Tool = { name: string; run(input: ToolInput): ToolResult };",
            "",
          ].join("\n"),
        },
        {
          path: "src/tools/generated/qa-workflowTool.ts",
          content: [
            "import { Tool } from '../tool.js';",
            "const store = new Map<string, string>();",
            "export const tool: Tool = {",
            "  name: 'generated.qa.workflow',",
            "  run(input) {",
            "    if (input.action === 'create') {",
            "      const id = `item-${store.size + 1}`;",
            "      store.set(id, String(input.value ?? ''));",
            "      return { ok: true, content: `created ${id}`, data: { id } };",
            "    }",
            "    if (input.action === 'read') {",
            "      const id = String(input.id ?? '');",
            "      return { ok: store.has(id), content: store.get(id) ?? 'missing', data: { id, value: store.get(id) } };",
            "    }",
            "    return { ok: false, content: 'unknown action' };",
            "  }",
            "};",
            "",
          ].join("\n"),
        },
        {
          path: "tests/generated/qa-workflowTool.test.ts",
          content: [
            "import test from 'node:test';",
            "import assert from 'node:assert/strict';",
            "import { tool } from '../../src/tools/generated/qa-workflowTool.js';",
            "test('qa workflow package creates and reads', () => {",
            "  const created = tool.run({ action: 'create', value: 'alpha' });",
            "  assert.equal(created.ok, true);",
            "  const data = created.data as { id: string };",
            "  assert.equal(tool.run({ action: 'read', id: data.id }).content, 'alpha');",
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
      {
        linkNodeModulesFrom: process.cwd(),
        behaviorExamples: [{
          title: "Create then read by generated id",
          steps: [
            {
              title: "Create record",
              input: { action: "create", value: "alpha" },
              saveAs: "created",
              expectedDataPath: "id",
              expectedDataIncludes: "item-",
            },
            {
              title: "Read created record",
              input: { action: "read", id: "{{created.data.id}}" },
              expectedContent: "alpha",
              expectedDataPath: "value",
              expectedDataEquals: "alpha",
            },
          ],
        }],
      },
    );

    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.ok(report.checks.some((check) => check.includes("package behavior scenario step passed")));
    assert.ok(report.checks.some((check) => check.includes("package behavior scenario passed")));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("validateAndBuildToolPackageWorkspace defers transient live behavior failures to manual verification", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-package-qa-"));
  const store = new ToolPackageWorkspaceStore(projectRoot, "tools");

  try {
    const record = await store.writeSourceBundlePackage({
      manifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.qa.live",
        version: "1.0.0",
        description: "QA live package.",
        capabilities: ["external-api"],
        startupMode: "on-demand",
      },
      files: liveQaPackageFiles([
        "import { Tool } from '../tool.js';",
        "let attempts = 0;",
        "export const tool: Tool = {",
        "  name: 'generated.qa.live',",
        "  run() {",
        "    attempts += 1;",
        "    return { ok: false, content: `fetch failed on attempt ${attempts}` };",
        "  }",
        "};",
        "",
      ].join("\n")),
    });

    const report = await validateAndBuildToolPackageWorkspace(
      projectRoot,
      {
        packageRef: record.packageRef,
        manifestPath: record.manifestPath,
        files: record.files,
      },
      {
        linkNodeModulesFrom: process.cwd(),
        behaviorExamples: [{
          title: "External API smoke",
          input: { url: "https://api.example.test/current" },
          expectedContentIncludes: "temperature",
        }],
      },
    );

    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.equal(report.requiresManualLiveVerification, true);
    assert.match(report.summary, /live verification warnings/);
    assert.equal(report.issues?.[0]?.kind, "transient_network");
    assert.equal(report.issues?.[0]?.severity, "warning");
    assert.equal(report.issues?.[0]?.attempts, 3);
    assert.ok(report.checks.some((check) => check.includes("package live behavior retry scheduled")));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("validateAndBuildToolPackageWorkspace keeps live semantic mismatch as a hard behavior failure", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-package-qa-"));
  const store = new ToolPackageWorkspaceStore(projectRoot, "tools");

  try {
    const record = await store.writeSourceBundlePackage({
      manifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.qa.live-mismatch",
        version: "1.0.0",
        description: "QA live mismatch package.",
        capabilities: ["external-api"],
        startupMode: "on-demand",
      },
      files: liveQaPackageFiles([
        "import { Tool } from '../tool.js';",
        "export const tool: Tool = {",
        "  name: 'generated.qa.live-mismatch',",
        "  run() {",
        "    return { ok: true, content: 'wrong payload' };",
        "  }",
        "};",
        "",
      ].join("\n")),
    });

    const report = await validateAndBuildToolPackageWorkspace(
      projectRoot,
      {
        packageRef: record.packageRef,
        manifestPath: record.manifestPath,
        files: record.files,
      },
      {
        linkNodeModulesFrom: process.cwd(),
        behaviorExamples: [{
          title: "External API semantic check",
          input: { url: "https://api.example.test/current" },
          expectedContentIncludes: "temperature",
        }],
      },
    );

    assert.equal(report.ok, false);
    assert.equal(report.requiresManualLiveVerification, undefined);
    assert.equal(report.issues?.[0]?.kind, "semantic_mismatch");
    assert.equal(report.issues?.[0]?.severity, "error");
    assert.match(report.summary, /expected content to include/);
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

function liveQaPackageFiles(toolSource: string): Array<{ path: string; content: string }> {
  return [
    {
      path: "index.ts",
      content: "export { tool } from './src/tools/generated/qa-liveTool.js';\n",
    },
    {
      path: "src/tools/tool.ts",
      content: [
        "export type ToolInput = Record<string, unknown>;",
        "export type ToolResult = { ok: boolean; content: string; data?: unknown };",
        "export type Tool = { name: string; run(input: ToolInput): ToolResult };",
        "",
      ].join("\n"),
    },
    {
      path: "src/tools/generated/qa-liveTool.ts",
      content: toolSource,
    },
    {
      path: "tests/generated/qa-liveTool.test.ts",
      content: [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { tool } from '../../src/tools/generated/qa-liveTool.js';",
        "test('qa live package exports tool', () => {",
        "  assert.equal(typeof tool.run, 'function');",
        "});",
        "",
      ].join("\n"),
    },
  ];
}

function lowerLeftConsentPanelPngBase64(): string {
  const png = new PNG({ width: 1280, height: 720 });
  fill(png, 248, 250, 252);
  drawRect(png, 0, 0, 1280, 64, 255, 255, 255);
  drawRect(png, 24, 26, 190, 16, 20, 24, 28);
  for (let y = 96; y < 680; y += 38) {
    drawRect(png, 24, y, 680, 18, 216, 220, 224);
    drawRect(png, 24, y + 24, 560, 12, 230, 233, 236);
  }
  drawRect(png, 16, 314, 607, 309, 255, 255, 255);
  drawRect(png, 40, 344, 270, 22, 14, 18, 22);
  for (let y = 392; y < 500; y += 22) drawRect(png, 40, y, 520, 10, 88, 92, 102);
  drawRect(png, 40, 520, 178, 40, 0, 0, 0);
  drawRect(png, 230, 520, 178, 40, 255, 255, 255);
  drawRect(png, 420, 520, 178, 40, 236, 248, 255);
  drawRect(png, 270, 536, 90, 10, 20, 24, 28);
  drawRect(png, 468, 536, 80, 10, 20, 24, 28);
  return PNG.sync.write(png).toString("base64");
}

function fill(png: PNG, r: number, g: number, b: number): void {
  drawRect(png, 0, 0, png.width, png.height, r, g, b);
}

function drawRect(png: PNG, x: number, y: number, width: number, height: number, r: number, g: number, b: number): void {
  for (let yy = Math.max(0, y); yy < Math.min(png.height, y + height); yy += 1) {
    for (let xx = Math.max(0, x); xx < Math.min(png.width, x + width); xx += 1) {
      const offset = (png.width * yy + xx) << 2;
      png.data[offset] = r;
      png.data[offset + 1] = g;
      png.data[offset + 2] = b;
      png.data[offset + 3] = 255;
    }
  }
}
