import test from "node:test";
import assert from "node:assert/strict";

import {
  canDecodeDirectly,
  findReaderTool,
  readerCapabilityFor,
  resolveReferences,
} from "../src/agents/councilReferenceReader.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/tool.js";

function stubTool(overrides: Partial<Tool>): Tool {
  return {
    name: "stub",
    version: "1.0.0",
    description: "stub",
    capabilities: [],
    run: async () => ({ ok: true, content: "" }),
    ...overrides,
  };
}

test("canDecodeDirectly returns true for text-like MIMEs", () => {
  assert.equal(canDecodeDirectly("text/plain"), true);
  assert.equal(canDecodeDirectly("text/markdown"), true);
  assert.equal(canDecodeDirectly("application/json"), true);
  assert.equal(canDecodeDirectly("application/yaml"), true);
  assert.equal(canDecodeDirectly("application/x-yaml"), true);
  assert.equal(canDecodeDirectly("application/openapi+yaml"), true);
  assert.equal(canDecodeDirectly("text/markdown; charset=utf-8"), true);
});

test("canDecodeDirectly rejects binary MIMEs", () => {
  assert.equal(canDecodeDirectly("application/pdf"), false);
  assert.equal(canDecodeDirectly("application/octet-stream"), false);
  assert.equal(canDecodeDirectly("image/png"), false);
});

test("readerCapabilityFor returns reads:<mime>", () => {
  assert.equal(readerCapabilityFor("application/pdf"), "reads:application/pdf");
  assert.equal(readerCapabilityFor("application/pdf; charset=utf-8"), "reads:application/pdf");
});

test("findReaderTool matches by exact reads:<mime> capability", () => {
  const registry = new ToolRegistry();
  registry.register(stubTool({ name: "pdf.reader", capabilities: ["reads:application/pdf"] }));
  const found = findReaderTool(registry, "application/pdf");
  assert.equal(found?.name, "pdf.reader");
});

test("findReaderTool matches wildcard reads:* capability", () => {
  const registry = new ToolRegistry();
  registry.register(stubTool({ name: "file.generic", capabilities: ["reads:*"] }));
  const found = findReaderTool(registry, "application/x-7z-compressed");
  assert.equal(found?.name, "file.generic");
});

test("findReaderTool returns undefined when no tool advertises the capability", () => {
  const registry = new ToolRegistry();
  registry.register(stubTool({ name: "unrelated", capabilities: ["does:something-else"] }));
  const found = findReaderTool(registry, "application/pdf");
  assert.equal(found, undefined);
});

test("resolveReferences decodes text MIMEs directly without invoking any tool", async () => {
  const registry = new ToolRegistry();
  // Register a tool that would throw if invoked — proves direct-decode bypasses it.
  registry.register(
    stubTool({
      name: "would.throw",
      capabilities: ["reads:*"],
      run: async () => {
        throw new Error("should not be called for direct-decode MIME");
      },
    }),
  );
  const result = await resolveReferences({
    attachments: [
      { filename: "spec.yaml", mimeType: "application/yaml", bytes: Buffer.from("openapi: 3.0.0", "utf8") },
      { filename: "readme.md", mimeType: "text/markdown", bytes: Buffer.from("# Hello", "utf8") },
    ],
    registry,
  });
  assert.equal(result.missing.length, 0);
  assert.equal(result.texts.length, 2);
  assert.equal(result.texts[0]!.source, "utf8-decode");
  assert.equal(result.texts[0]!.content, "openapi: 3.0.0");
  assert.equal(result.texts[1]!.content, "# Hello");
});

test("resolveReferences calls reader tool for binary MIME and propagates content", async () => {
  const registry = new ToolRegistry();
  let calledWith: Record<string, unknown> | undefined;
  registry.register(
    stubTool({
      name: "pdf.read",
      capabilities: ["reads:application/pdf"],
      run: async (input) => {
        calledWith = input;
        return { ok: true, content: "Extracted PDF text" };
      },
    }),
  );
  const result = await resolveReferences({
    attachments: [
      { filename: "manual.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4 stub bytes") },
    ],
    registry,
  });
  assert.equal(result.missing.length, 0);
  assert.equal(result.texts.length, 1);
  assert.equal(result.texts[0]!.content, "Extracted PDF text");
  assert.equal(result.texts[0]!.source, "tool");
  assert.equal(result.texts[0]!.readerToolName, "pdf.read");
  assert.equal((calledWith?.filename as string), "manual.pdf");
});

test("resolveReferences reports `missing` when no reader exists for a binary MIME", async () => {
  const registry = new ToolRegistry();
  const result = await resolveReferences({
    attachments: [
      { filename: "manual.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4 stub") },
    ],
    registry,
  });
  assert.equal(result.texts.length, 0);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0]!.capability, "reads:application/pdf");
  assert.match(result.missing[0]!.reason, /reads:application\/pdf/);
});

test("resolveReferences marks a reference as missing when the reader throws", async () => {
  const registry = new ToolRegistry();
  registry.register(
    stubTool({
      name: "broken.reader",
      capabilities: ["reads:application/pdf"],
      run: async () => {
        throw new Error("kaboom");
      },
    }),
  );
  const result = await resolveReferences({
    attachments: [
      { filename: "manual.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4 stub") },
    ],
    registry,
  });
  assert.equal(result.texts.length, 0);
  assert.equal(result.missing.length, 1);
  assert.match(result.missing[0]!.reason, /kaboom/);
});

test("resolveReferences marks a reference as missing when the reader returns ok=false", async () => {
  const registry = new ToolRegistry();
  registry.register(
    stubTool({
      name: "polite.reader",
      capabilities: ["reads:application/pdf"],
      run: async () => ({ ok: false, content: "encrypted PDF" }),
    }),
  );
  const result = await resolveReferences({
    attachments: [
      { filename: "secret.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4 enc") },
    ],
    registry,
  });
  assert.equal(result.texts.length, 0);
  assert.equal(result.missing.length, 1);
  assert.match(result.missing[0]!.reason, /ok=false/);
});
