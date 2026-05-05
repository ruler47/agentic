import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { loadGeneratedTools, compiledModulePath } from "../src/tools/generatedToolLoader.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import { ToolPackageRunner } from "../src/tools/toolPackageRunner.js";
import { ToolServiceSupervisor } from "../src/tools/toolServiceSupervisor.js";

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

test("loadGeneratedTools imports prebuilt source-bundle package manifests from package root", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-source-bundles-"));
  const bundlePath = join(root, "tool-packages/normalize/dist/index.js");
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();

  try {
    await mkdir(join(root, "tool-packages/normalize/dist"), { recursive: true });
    await writeFile(
      bundlePath,
      `
        export const tool = {
          name: "generated.bundle.normalize",
          version: "1.0.0",
          description: "Normalize text from an out-of-tree package.",
          capabilities: ["text-normalization"],
          async healthcheck() { return { ok: true, detail: "bundle healthy" }; },
          async run(input) { return { ok: true, content: String(input.text ?? "").toLowerCase() }; }
        };
      `,
    );
    await metadata.registerGenerated({
      name: "generated.bundle.normalize",
      version: "1.0.0",
      description: "Normalize text from an out-of-tree package.",
      capabilities: ["text-normalization"],
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.bundle.normalize",
        version: "1.0.0",
        description: "Normalize text from an out-of-tree package.",
        capabilities: ["text-normalization"],
        startupMode: "on-demand",
        package: { type: "source-bundle", ref: "normalize" },
      },
    });

    const results = await loadGeneratedTools(registry, metadata, root);
    const [stored] = await metadata.list();
    const output = await registry.get("generated.bundle.normalize")?.run({ text: "HELLO BUNDLE" });

    assert.equal(results[0]?.loaded, true);
    assert.equal(stored?.status, "available");
    assert.equal(stored?.lastHealthDetail, "bundle healthy");
    assert.equal(output?.content, "hello bundle");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadGeneratedTools rejects source-bundle refs outside the package root", async () => {
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();
  await metadata.registerGenerated({
    name: "generated.bundle.unsafe",
    version: "1.0.0",
    description: "Unsafe bundle ref.",
    capabilities: ["text-normalization"],
    packageManifest: {
      schemaVersion: "agentic.tool-package.v1",
      name: "generated.bundle.unsafe",
      version: "1.0.0",
      description: "Unsafe bundle ref.",
      capabilities: ["text-normalization"],
      startupMode: "on-demand",
      package: { type: "source-bundle", ref: "../outside" },
    },
  });

  const results = await loadGeneratedTools(registry, metadata);
  const [stored] = await metadata.list();

  assert.equal(results[0]?.loaded, false);
  assert.match(results[0]?.detail ?? "", /inside TOOL_PACKAGE_ROOT/);
  assert.equal(stored?.status, "failed");
  assert.equal(registry.get("generated.bundle.unsafe"), undefined);
});

test("loadGeneratedTools proxies external-package HTTP runtimes", async () => {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    calls.push({ path: request.url ?? "", body });

    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ ok: true, detail: "external runtime healthy" }));
      return;
    }
    if (request.url === "/run") {
      response.end(JSON.stringify({
        ok: true,
        content: `external:${body.input.text}`,
        data: { contextTool: body.context.toolName },
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  const baseUrl = await listen(server);
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();

  try {
    await metadata.registerGenerated({
      name: "generated.external.echo",
      version: "1.0.0",
      description: "External HTTP echo.",
      capabilities: ["external-echo"],
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.external.echo",
        version: "1.0.0",
        description: "External HTTP echo.",
        capabilities: ["external-echo"],
        startupMode: "on-demand",
        package: { type: "external-package", ref: baseUrl },
      },
    });

    const results = await loadGeneratedTools(registry, metadata);
    const [stored] = await metadata.list();
    const output = await registry.get("generated.external.echo")?.run(
      { text: "hello" },
      { toolName: "generated.external.echo", now: new Date("2026-05-05T12:00:00.000Z") },
    );

    assert.equal(results[0]?.loaded, true);
    assert.equal(stored?.status, "available");
    assert.equal(stored?.lastHealthDetail, "external runtime healthy");
    assert.equal(output?.content, "external:hello");
    assert.deepEqual(output?.data, { contextTool: "generated.external.echo" });
    assert.deepEqual(calls.map((call) => call.path), ["/health", "/run"]);
  } finally {
    await close(server);
  }
});

test("loadGeneratedTools keeps non-HTTP external packages disabled until a runner exists", async () => {
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();
  await metadata.registerGenerated({
    name: "generated.remote.npmnormalize",
    version: "1.0.0",
    description: "Portable npm package reference.",
    capabilities: ["text-normalization"],
    packageManifest: {
      schemaVersion: "agentic.tool-package.v1",
      name: "generated.remote.npmnormalize",
      version: "1.0.0",
      description: "Portable npm package reference.",
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
  assert.equal(registry.get("generated.remote.npmnormalize"), undefined);
});

test("external-package HTTP runners expose always-on service lifecycle handles", async () => {
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    calls.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ ok: true, detail: "external service healthy" }));
      return;
    }
    if (request.url === "/service/start" || request.url === "/service/stop") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  const baseUrl = await listen(server);
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();

  try {
    await metadata.registerGenerated({
      name: "generated.external.listener",
      version: "1.0.0",
      description: "External HTTP listener.",
      capabilities: ["external-listener"],
      startupMode: "always-on",
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.external.listener",
        version: "1.0.0",
        description: "External HTTP listener.",
        capabilities: ["external-listener"],
        startupMode: "always-on",
        package: { type: "external-package", ref: baseUrl },
      },
    });

    await loadGeneratedTools(registry, metadata);
    const supervisor = new ToolServiceSupervisor(registry);
    const started = await supervisor.start("generated.external.listener");
    const heartbeat = await supervisor.heartbeat("generated.external.listener");
    const stopped = await supervisor.stop("generated.external.listener");

    assert.equal(started.status, "running");
    assert.equal(heartbeat.lastHealthOk, true);
    assert.equal(stopped.status, "stopped");
    assert.deepEqual(calls, ["/health", "/service/start", "/health", "/health", "/service/stop"]);
  } finally {
    await close(server);
  }
});

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
