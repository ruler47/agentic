import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalJsonToolMetadataStore } from "../src/tools/toolMetadataStore.js";

test("LocalJsonToolMetadataStore persists generated availability and versions across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-tool-metadata-"));
  const file = join(dir, "tool-metadata.json");

  try {
    const first = new LocalJsonToolMetadataStore(file);
    await first.registerGenerated({
      name: "web.search",
      version: "0.1.0",
      description: "Searches the web.",
      capabilities: ["web-search"],
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "web.search",
        version: "0.1.0",
        description: "Searches the web.",
        capabilities: ["web-search"],
        startupMode: "on-demand",
        package: { type: "source-bundle", ref: "web.search/0.1.0" },
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      },
    });
    await first.updateHealth("web.search", { ok: true, detail: "loaded" });
    await first.markAvailable("web.search", "0.1.0");

    const second = new LocalJsonToolMetadataStore(file);
    const tool = (await second.list()).find((item) => item.name === "web.search");

    assert.equal(tool?.status, "available");
    assert.equal(tool?.versions?.[0]?.version, "0.1.0");
    assert.equal(tool?.versions?.[0]?.status, "available");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LocalJsonToolMetadataStore preserves operator disabled status across reload health checks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-tool-metadata-"));
  const file = join(dir, "tool-metadata.json");

  try {
    const first = new LocalJsonToolMetadataStore(file);
    await first.registerGenerated({
      name: "browser.screenshot",
      version: "0.1.0",
      description: "Captures screenshots.",
      capabilities: ["browser-screenshot"],
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "browser.screenshot",
        version: "0.1.0",
        description: "Captures screenshots.",
        capabilities: ["browser-screenshot"],
        startupMode: "on-demand",
        package: { type: "source-bundle", ref: "browser.screenshot/0.1.0" },
      },
    });
    await first.updateHealth("browser.screenshot", { ok: true, detail: "loaded on startup" });
    await first.markAvailable("browser.screenshot", "0.1.0");
    await first.setStatus("browser.screenshot", "disabled");
    await first.updateHealth("browser.screenshot", { ok: true, detail: "loaded on restart" });

    const second = new LocalJsonToolMetadataStore(file);
    const tool = (await second.list()).find((item) => item.name === "browser.screenshot");

    assert.equal(tool?.status, "disabled");
    assert.match(tool?.lastHealthDetail ?? "", /Operator disabled tool/);
    assert.match(tool?.lastHealthDetail ?? "", /loaded on restart/);
    assert.equal(tool?.versions?.[0]?.status, "disabled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LocalJsonToolMetadataStore persists failed health for previously available tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-tool-metadata-"));
  const file = join(dir, "tool-metadata.json");

  try {
    const first = new LocalJsonToolMetadataStore(file);
    await first.registerGenerated({
      name: "web.search",
      version: "0.1.0",
      description: "Searches the web.",
      capabilities: ["web-search"],
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "web.search",
        version: "0.1.0",
        description: "Searches the web.",
        capabilities: ["web-search"],
        startupMode: "on-demand",
        package: { type: "source-bundle", ref: "web.search/0.1.0" },
      },
    });
    await first.markAvailable("web.search", "0.1.0");
    await first.updateHealth("web.search", { ok: false, detail: "Package missing from tools workspace." });

    const second = new LocalJsonToolMetadataStore(file);
    const tool = (await second.list()).find((item) => item.name === "web.search");

    assert.equal(tool?.status, "failed");
    assert.equal(tool?.lastHealthOk, false);
    assert.equal(tool?.lastHealthDetail, "Package missing from tools workspace.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
