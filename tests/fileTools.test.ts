import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileReadTool, FileWriteTool } from "../src/tools/fileTools.js";

test("file tools write and read inside workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-files-"));
  const writer = new FileWriteTool(dir);
  const reader = new FileReadTool(dir);

  try {
    const write = await writer.run({ path: "reports/test.txt", content: "hello" });
    const read = await reader.run({ path: "reports/test.txt" });

    assert.equal(write.ok, true);
    assert.match(write.content, /reports\/test.txt/);
    assert.equal(read.ok, true);
    assert.equal(read.content, "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file tools reject paths outside workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-files-"));
  const writer = new FileWriteTool(dir);
  const reader = new FileReadTool(dir);

  try {
    const write = await writer.run({ path: "../outside.txt", content: "nope" });
    const read = await reader.run({ path: "../outside.txt" });

    assert.equal(write.ok, false);
    assert.match(write.content, /inside the workspace/);
    assert.equal(read.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
