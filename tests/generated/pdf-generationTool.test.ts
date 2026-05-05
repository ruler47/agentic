import test from "node:test";
import assert from "node:assert/strict";
import { tool } from "../../src/tools/generated/pdf-generationTool.js";

test("generated.pdf.generation exposes a valid generated document tool contract", async () => {
  const health = await tool.healthcheck?.();

  assert.equal(tool.name, "generated.pdf.generation");
  assert.ok(tool.capabilities.includes("pdf-generation"));
  assert.ok(tool.capabilities.includes("pdf-generation"));
  assert.equal(health?.ok, true);
});

test("generated.pdf.generation rejects empty document content", async () => {
  const result = await tool.run({ title: "Empty" });

  assert.equal(result.ok, false);
  assert.match(result.content, /requires content/);
});

test("generated.pdf.generation creates a reusable PDF artifact payload", async () => {
  const result = await tool.run({
    title: "Reusable Agent Report",
    content: "A reusable report body with structured findings, evidence notes, and next actions.",
    filename: "reusable-agent-report.pdf"
  });
  const data = result.data as { artifact?: { filename?: string; mimeType?: string; contentBase64?: string } } | undefined;
  const content = Buffer.from(data?.artifact?.contentBase64 ?? "", "base64");

  assert.equal(result.ok, true);
  assert.equal(data?.artifact?.filename, "reusable-agent-report.pdf");
  assert.equal(data?.artifact?.mimeType, "application/pdf");
  assert.equal(content.subarray(0, 5).toString("utf8"), "%PDF-");
  assert.ok(content.byteLength > 500);
});
