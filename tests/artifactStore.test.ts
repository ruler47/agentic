import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalArtifactStore } from "../src/artifacts/artifactStore.js";

test("LocalArtifactStore saves uploads and generated artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-artifacts-"));
  const store = new LocalArtifactStore(root);

  try {
    const input = await store.saveUpload("run-1", {
      filename: "../notes.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("hello input").toString("base64"),
    });
    const output = await store.saveGenerated("run-1", {
      filename: "chart.svg",
      mimeType: "image/svg+xml",
      content: "<svg></svg>",
      description: "chart",
    });
    const listed = await store.list("run-1");
    const read = await store.read("run-1", output.id);

    assert.equal(input.kind, "input");
    assert.equal(input.filename, "notes.txt");
    assert.equal(input.contentPreview, "hello input");
    assert.equal(output.kind, "output");
    assert.equal(output.url, `/api/runs/run-1/artifacts/${output.id}`);
    assert.equal(listed.length, 2);
    assert.equal(await readFile(read!.path, "utf8"), "<svg></svg>");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
