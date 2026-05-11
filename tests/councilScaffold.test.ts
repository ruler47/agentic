import test from "node:test";
import assert from "node:assert/strict";
import {
  COUNCIL_TOOL_BODY_PATH,
  extractToolBody,
  renderCouncilScaffold,
} from "../src/agents/councilScaffold.js";

test("renderCouncilScaffold emits all canonical files plus the model body", () => {
  const files = renderCouncilScaffold({
    toolName: "demo.echo",
    sanitizedName: "demo.echo",
    version: "1.0.0",
    toolBody: "export const tool = {} as any;",
  });
  const paths = files.map((file) => file.path).sort();
  assert.deepEqual(paths, [
    "index.ts",
    "package.json",
    "runtime/server.ts",
    "src/tools/generated/demo.echoTool.ts",
    "src/tools/tool.ts",
    "tsconfig.json",
  ]);

  const indexFile = files.find((f) => f.path === "index.ts")!;
  assert.match(indexFile.content, /export \{ tool \} from "\.\/src\/tools\/generated\/demo\.echoTool\.js"/);

  const pkg = JSON.parse(files.find((f) => f.path === "package.json")!.content);
  assert.equal(pkg.name, "demo.echo");
  assert.equal(pkg.version, "1.0.0");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.scripts.build, "tsc -p tsconfig.json");
  assert.equal(pkg.scripts.start, "node dist/runtime/server.js");

  const server = files.find((f) => f.path === "runtime/server.ts")!.content;
  assert.match(server, /import \{ tool \} from "\.\.\/index\.js"/);
  assert.match(server, /tool\.run\(/);
});

test("extractToolBody finds the model file at the canonical path", () => {
  const body = "import { Tool } from '../tool.js';\nexport const tool: Tool = {} as Tool;";
  const result = extractToolBody(
    [
      { path: "src/tools/generated/demo.echoTool.ts", content: body },
      { path: "package.json", content: "{}" },
    ],
    "demo.echo",
  );
  assert.equal(result, body);
});

test("extractToolBody falls back to any file under src/tools/generated/", () => {
  const body = "export const tool = { name: 'x' } as any;";
  const result = extractToolBody(
    [{ path: "src/tools/generated/other-name.ts", content: body }],
    "demo.echo",
  );
  assert.equal(result, body);
});

test("extractToolBody falls back to any .ts file with `export const tool` marker", () => {
  const body = "export const tool = { name: 'inline' };";
  const result = extractToolBody(
    [
      { path: "package.json", content: "{}" },
      { path: "tool.ts", content: body },
    ],
    "demo.echo",
  );
  assert.equal(result, body);
});

test("extractToolBody returns undefined when no Tool file can be found", () => {
  const result = extractToolBody(
    [
      { path: "package.json", content: "{}" },
      { path: "README.md", content: "# hi" },
    ],
    "demo.echo",
  );
  assert.equal(result, undefined);
});

test("COUNCIL_TOOL_BODY_PATH is stable for a given sanitized name", () => {
  assert.equal(COUNCIL_TOOL_BODY_PATH("demo.echo"), "src/tools/generated/demo.echoTool.ts");
  assert.equal(COUNCIL_TOOL_BODY_PATH("my_tool"), "src/tools/generated/my_toolTool.ts");
});
