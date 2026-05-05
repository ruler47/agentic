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
import {
  OciImageToolPackageRunner,
  SourceBundleHttpProcessToolPackageRunner,
  ToolPackageRunner,
} from "../src/tools/toolPackageRunner.js";
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

test("loadGeneratedTools can execute source-bundles through local HTTP process runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-source-http-runtime-"));
  const runtimePath = join(root, "tool-packages/normalize/dist/runtime/server.js");
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();

  try {
    await mkdir(join(root, "tool-packages/normalize/dist/runtime"), { recursive: true });
    await writeFile(
      runtimePath,
      `
        import { createServer } from "node:http";
        const port = Number(process.env.PORT ?? 8080);
        const server = createServer(async (request, response) => {
          response.setHeader("content-type", "application/json");
          if (request.method === "GET" && request.url === "/health") {
            response.end(JSON.stringify({ ok: true, detail: "process runtime healthy" }));
            return;
          }
          if (request.method === "POST" && request.url === "/run") {
            const chunks = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            response.end(JSON.stringify({
              ok: true,
              content: String(body.input?.text ?? "").trim().toLowerCase()
            }));
            return;
          }
          response.statusCode = 404;
          response.end(JSON.stringify({ ok: false, error: "not found" }));
        });
        server.listen(port, "127.0.0.1");
      `,
    );
    await metadata.registerGenerated({
      name: "generated.bundle.httpnormalize",
      version: "1.0.0",
      description: "Normalize text from an out-of-tree HTTP runtime package.",
      capabilities: ["text-normalization"],
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.bundle.httpnormalize",
        version: "1.0.0",
        description: "Normalize text from an out-of-tree HTTP runtime package.",
        capabilities: ["text-normalization"],
        startupMode: "on-demand",
        package: { type: "source-bundle", ref: "normalize" },
      },
    });

    const results = await loadGeneratedTools(registry, metadata, root, [
      new SourceBundleHttpProcessToolPackageRunner({
        enabled: true,
        packageRoot: "tool-packages",
        startupTimeoutMs: 5000,
        pollIntervalMs: 50,
      }),
    ]);
    const [stored] = await metadata.list();
    const output = await registry.get("generated.bundle.httpnormalize")?.run({ text: " HELLO HTTP PROCESS " });

    assert.equal(results[0]?.loaded, true, JSON.stringify(results[0], null, 2));
    assert.equal(stored?.status, "available");
    assert.match(stored?.lastHealthDetail ?? "", /entrypoint is present/);
    assert.equal(output?.content, "hello http process");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source-bundle HTTP process runtimes support always-on service lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-source-http-service-"));
  const runtimePath = join(root, "tool-packages/listener/dist/runtime/server.js");
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();

  try {
    await mkdir(join(root, "tool-packages/listener/dist/runtime"), { recursive: true });
    await writeFile(
      runtimePath,
      `
        import { createServer } from "node:http";
        const port = Number(process.env.PORT ?? 8080);
        let started = false;
        const calls = [];
        const server = createServer(async (request, response) => {
          response.setHeader("content-type", "application/json");
          if (request.method === "GET" && request.url === "/health") {
            response.end(JSON.stringify({
              ok: true,
              detail: started ? "listener service running" : "listener runtime healthy",
              data: { calls }
            }));
            return;
          }
          if (request.method === "POST" && request.url === "/service/start") {
            const chunks = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            calls.push({ path: "/service/start", mode: body.context?.configuration?.LISTENER_MODE });
            started = true;
            response.end(JSON.stringify({ ok: true }));
            return;
          }
          if (request.method === "POST" && request.url === "/service/stop") {
            calls.push({ path: "/service/stop" });
            started = false;
            response.end(JSON.stringify({ ok: true }));
            setTimeout(() => server.close(), 5);
            return;
          }
          response.statusCode = 404;
          response.end(JSON.stringify({ ok: false, error: "not found" }));
        });
        server.listen(port, "127.0.0.1");
      `,
    );
    await metadata.registerGenerated({
      name: "generated.bundle.httplistener",
      version: "1.0.0",
      description: "Always-on source-bundle HTTP runtime.",
      capabilities: ["message-listener"],
      startupMode: "always-on",
      requiredConfigurationKeys: ["LISTENER_MODE"],
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.bundle.httplistener",
        version: "1.0.0",
        description: "Always-on source-bundle HTTP runtime.",
        capabilities: ["message-listener"],
        startupMode: "always-on",
        requiredConfigurationKeys: ["LISTENER_MODE"],
        package: { type: "source-bundle", ref: "listener" },
      },
    });

    const results = await loadGeneratedTools(registry, metadata, root, [
      new SourceBundleHttpProcessToolPackageRunner({
        enabled: true,
        packageRoot: "tool-packages",
        startupTimeoutMs: 5000,
        pollIntervalMs: 50,
      }),
    ]);
    const supervisor = new ToolServiceSupervisor(registry, undefined, undefined, {
      resolveConfiguration: async (key) => key === "LISTENER_MODE" ? "polling" : undefined,
    });
    const started = await supervisor.start("generated.bundle.httplistener");
    const heartbeat = await supervisor.heartbeat("generated.bundle.httplistener");
    const stopped = await supervisor.stop("generated.bundle.httplistener");

    assert.equal(results[0]?.loaded, true, JSON.stringify(results[0], null, 2));
    assert.equal(started.status, "running");
    assert.equal(heartbeat.status, "running");
    assert.equal(heartbeat.lastHealthOk, true);
    assert.equal(heartbeat.detail, "listener service running");
    assert.equal(stopped.status, "stopped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source-bundle HTTP process runtime calls are bounded by timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-source-http-timeout-"));
  const runtimePath = join(root, "tool-packages/slow/dist/runtime/server.js");
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();

  try {
    await mkdir(join(root, "tool-packages/slow/dist/runtime"), { recursive: true });
    await writeFile(
      runtimePath,
      `
        import { createServer } from "node:http";
        const port = Number(process.env.PORT ?? 8080);
        const server = createServer((request, response) => {
          response.setHeader("content-type", "application/json");
          if (request.method === "GET" && request.url === "/health") {
            response.end(JSON.stringify({ ok: true, detail: "slow runtime healthy" }));
            return;
          }
          if (request.method === "POST" && request.url === "/run") {
            return;
          }
          response.statusCode = 404;
          response.end(JSON.stringify({ ok: false, error: "not found" }));
        });
        server.listen(port, "127.0.0.1");
      `,
    );
    await metadata.registerGenerated({
      name: "generated.bundle.slowruntime",
      version: "1.0.0",
      description: "Slow source-bundle HTTP runtime.",
      capabilities: ["slow-runtime"],
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.bundle.slowruntime",
        version: "1.0.0",
        description: "Slow source-bundle HTTP runtime.",
        capabilities: ["slow-runtime"],
        startupMode: "on-demand",
        package: { type: "source-bundle", ref: "slow" },
      },
    });

    await loadGeneratedTools(registry, metadata, root, [
      new SourceBundleHttpProcessToolPackageRunner({
        enabled: true,
        packageRoot: "tool-packages",
        startupTimeoutMs: 5000,
        pollIntervalMs: 50,
        callTimeoutMs: 50,
      }),
    ]);

    await assert.rejects(
      () => registry.get("generated.bundle.slowruntime")!.run({ text: "hang" }),
      /\/run call timed out after 50 ms/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source-bundle HTTP process runner reports runtimes that exit before healthcheck", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-source-http-crash-"));
  const runtimePath = join(root, "tool-packages/crash/dist/runtime/server.js");
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();

  try {
    await mkdir(join(root, "tool-packages/crash/dist/runtime"), { recursive: true });
    await writeFile(
      runtimePath,
      `
        console.error("crash during bootstrap");
        process.exit(42);
      `,
    );
    await metadata.registerGenerated({
      name: "generated.bundle.crashruntime",
      version: "1.0.0",
      description: "Crashing source-bundle HTTP runtime.",
      capabilities: ["crash-runtime"],
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.bundle.crashruntime",
        version: "1.0.0",
        description: "Crashing source-bundle HTTP runtime.",
        capabilities: ["crash-runtime"],
        startupMode: "on-demand",
        package: { type: "source-bundle", ref: "crash" },
      },
    });

    await loadGeneratedTools(registry, metadata, root, [
      new SourceBundleHttpProcessToolPackageRunner({
        enabled: true,
        packageRoot: "tool-packages",
        startupTimeoutMs: 5000,
        pollIntervalMs: 50,
      }),
    ]);

    await assert.rejects(
      () => registry.get("generated.bundle.crashruntime")!.run({ text: "boom" }),
      /exited before healthcheck with code 42: crash during bootstrap/,
    );
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
        data: {
          contextTool: body.context.toolName,
          baseUrl: body.context.configuration.EXTERNAL_ECHO_BASE_URL,
          apiKey: body.context.secrets["secret.external.echo"],
        },
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
      requiredConfigurationKeys: ["EXTERNAL_ECHO_BASE_URL"],
      requiredSecretHandles: ["secret.external.echo"],
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.external.echo",
        version: "1.0.0",
        description: "External HTTP echo.",
        capabilities: ["external-echo"],
        requiredConfigurationKeys: ["EXTERNAL_ECHO_BASE_URL"],
        requiredSecretHandles: ["secret.external.echo"],
        startupMode: "on-demand",
        package: { type: "external-package", ref: baseUrl },
      },
    });

    const results = await loadGeneratedTools(registry, metadata);
    const [stored] = await metadata.list();
    const output = await registry.get("generated.external.echo")?.run(
      { text: "hello" },
      {
        toolName: "generated.external.echo",
        now: new Date("2026-05-05T12:00:00.000Z"),
        resolveConfiguration: async (key) => key === "EXTERNAL_ECHO_BASE_URL" ? "https://runtime.example.test" : undefined,
        resolveSecret: async (handle) => handle === "secret.external.echo" ? "runtime-secret" : undefined,
      },
    );

    assert.equal(results[0]?.loaded, true);
    assert.equal(stored?.status, "available");
    assert.equal(stored?.lastHealthDetail, "external runtime healthy");
    assert.equal(output?.content, "external:hello");
    assert.deepEqual(output?.data, {
      contextTool: "generated.external.echo",
      baseUrl: "https://runtime.example.test",
      apiKey: "runtime-secret",
    });
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

test("external-package HTTP runners block calls with unresolved required runtime values", async () => {
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    calls.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ ok: true, detail: "external runtime healthy" }));
      return;
    }
    if (request.url === "/run") {
      response.end(JSON.stringify({ ok: true, content: "should-not-run" }));
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
      name: "generated.external.requires",
      version: "1.0.0",
      description: "External tool requiring runtime values.",
      capabilities: ["external-requires"],
      requiredConfigurationKeys: ["REQUIRED_EXTERNAL_BASE_URL"],
      requiredSecretHandles: ["secret.external.required"],
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.external.requires",
        version: "1.0.0",
        description: "External tool requiring runtime values.",
        capabilities: ["external-requires"],
        startupMode: "on-demand",
        requiredConfigurationKeys: ["REQUIRED_EXTERNAL_BASE_URL"],
        requiredSecretHandles: ["secret.external.required"],
        package: { type: "external-package", ref: baseUrl },
      },
    });

    await loadGeneratedTools(registry, metadata);
    await assert.rejects(
      () => registry.get("generated.external.requires")!.run(
        { text: "hello" },
        { toolName: "generated.external.requires", now: new Date("2026-05-05T12:00:00.000Z") },
      ),
      /Missing required runtime values.*REQUIRED_EXTERNAL_BASE_URL.*secret\.external\.required/,
    );
    assert.deepEqual(calls, ["/health"]);
  } finally {
    await close(server);
  }
});

test("external-package HTTP runners expose always-on service lifecycle handles", async () => {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString("utf8");
    calls.push({ path: request.url ?? "", body: bodyText ? JSON.parse(bodyText) : undefined });
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
      requiredConfigurationKeys: ["EXTERNAL_LISTENER_MODE"],
      requiredSecretHandles: ["secret.external.listener"],
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.external.listener",
        version: "1.0.0",
        description: "External HTTP listener.",
        capabilities: ["external-listener"],
        startupMode: "always-on",
        requiredConfigurationKeys: ["EXTERNAL_LISTENER_MODE"],
        requiredSecretHandles: ["secret.external.listener"],
        package: { type: "external-package", ref: baseUrl },
      },
    });

    await loadGeneratedTools(registry, metadata);
    const supervisor = new ToolServiceSupervisor(registry, undefined, undefined, {
      resolveConfiguration: async (key) => key === "EXTERNAL_LISTENER_MODE" ? "polling" : undefined,
      resolveSecret: async (handle) => handle === "secret.external.listener" ? "listener-secret" : undefined,
    });
    const started = await supervisor.start("generated.external.listener");
    const heartbeat = await supervisor.heartbeat("generated.external.listener");
    const stopped = await supervisor.stop("generated.external.listener");

    assert.equal(started.status, "running");
    assert.equal(heartbeat.lastHealthOk, true);
    assert.equal(stopped.status, "stopped");
    assert.deepEqual(calls.map((call) => call.path), ["/health", "/service/start", "/health", "/health", "/service/stop"]);
    assert.equal(
      (calls[1]?.body as { context?: { secrets?: Record<string, string> } }).context?.secrets?.["secret.external.listener"],
      "listener-secret",
    );
    assert.equal(
      (calls[1]?.body as { context?: { configuration?: Record<string, string> } }).context?.configuration?.EXTERNAL_LISTENER_MODE,
      "polling",
    );
    assert.equal(
      (calls[4]?.body as { context?: { secrets?: Record<string, string> } }).context?.secrets?.["secret.external.listener"],
      "listener-secret",
    );
  } finally {
    await close(server);
  }
});

test("loadGeneratedTools proxies OCI image packages through the container HTTP runtime", async () => {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    calls.push({ path: request.url ?? "", body });

    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ ok: true, detail: "oci runtime healthy" }));
      return;
    }
    if (request.url === "/run") {
      response.end(JSON.stringify({
        ok: true,
        content: `oci:${body.input.value}`,
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
  const started: unknown[] = [];

  try {
    await metadata.registerGenerated({
      name: "generated.oci.echo",
      version: "1.0.0",
      description: "OCI echo.",
      capabilities: ["oci-echo"],
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.oci.echo",
        version: "1.0.0",
        description: "OCI echo.",
        capabilities: ["oci-echo"],
        startupMode: "on-demand",
        package: { type: "oci-image", ref: "registry.local/agentic/echo:1.0.0" },
      },
    });

    const runner = new OciImageToolPackageRunner({
      enabled: true,
      runtime: {
        async start(input) {
          started.push(input);
          return { containerId: "container-echo", baseUrl };
        },
        async stop() {},
      },
    });
    const results = await loadGeneratedTools(registry, metadata, process.cwd(), [runner]);
    const output = await registry.get("generated.oci.echo")?.run(
      { value: "hello" },
      { toolName: "generated.oci.echo", now: new Date("2026-05-05T12:00:00.000Z") },
    );
    const [stored] = await metadata.list();

    assert.equal(results[0]?.loaded, true);
    assert.deepEqual(started, [{
      image: "registry.local/agentic/echo:1.0.0",
      internalPort: 8080,
      toolName: "generated.oci.echo",
    }]);
    assert.equal(stored?.status, "available");
    assert.equal(stored?.lastHealthDetail, "oci runtime healthy");
    assert.equal(output?.content, "oci:hello");
    assert.deepEqual(output?.data, { contextTool: "generated.oci.echo" });
    assert.deepEqual(calls.map((call) => call.path), ["/health", "/run"]);
  } finally {
    await close(server);
  }
});

test("loadGeneratedTools stops OCI containers when their HTTP runtime fails QA health", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: false, detail: "runtime not ready" }));
  });
  const baseUrl = await listen(server);
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();
  const stopped: string[] = [];

  try {
    await metadata.registerGenerated({
      name: "generated.oci.unhealthy",
      version: "1.0.0",
      description: "Unhealthy OCI tool.",
      capabilities: ["oci-unhealthy"],
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.oci.unhealthy",
        version: "1.0.0",
        description: "Unhealthy OCI tool.",
        capabilities: ["oci-unhealthy"],
        startupMode: "on-demand",
        package: { type: "oci-image", ref: "registry.local/agentic/unhealthy:1.0.0" },
      },
    });

    const runner = new OciImageToolPackageRunner({
      enabled: true,
      startupTimeoutMs: 1,
      pollIntervalMs: 1,
      runtime: {
        async start() {
          return { containerId: "container-unhealthy", baseUrl };
        },
        async stop(containerId) {
          stopped.push(containerId);
        },
      },
    });
    const results = await loadGeneratedTools(registry, metadata, process.cwd(), [runner]);
    const [stored] = await metadata.list();

    assert.equal(results[0]?.loaded, false);
    assert.equal(results[0]?.detail, "runtime not ready");
    assert.deepEqual(stopped, ["container-unhealthy"]);
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.lastHealthDetail, "runtime not ready");
    assert.equal(registry.get("generated.oci.unhealthy"), undefined);
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
