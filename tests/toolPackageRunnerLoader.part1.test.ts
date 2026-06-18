import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { ToolRegistry } from "../src/tools/registry.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import {
  compiledModulePath,
  dockerRunArgsForToolContainer,
  loadGeneratedTools,
  OciImageToolPackageRunner,
  SourceBundleHttpProcessToolPackageRunner,
  ToolPackageRunner,
} from "../src/tools/toolPackageRunner.js";
import { ToolServiceSupervisor } from "../src/tools/toolServiceSupervisor.js";

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
    assert.equal(stored?.status, "loaded");
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

test("loadGeneratedTools marks available generated tools failed when no runner can load them", async () => {
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();

  await metadata.registerGenerated({
    name: "generated.missing.runner",
    version: "1.0.0",
    description: "Needs a missing runner.",
    capabilities: ["missing-runner"],
    packageManifest: {
      schemaVersion: "agentic.tool-package.v1",
      name: "generated.missing.runner",
      version: "1.0.0",
      description: "Needs a missing runner.",
      capabilities: ["missing-runner"],
      startupMode: "on-demand",
      package: { type: "external-package", ref: "missing-runner" },
    },
  });
  await metadata.markAvailable("generated.missing.runner", "1.0.0");

  const results = await loadGeneratedTools(registry, metadata, process.cwd(), []);
  const [stored] = await metadata.list();

  assert.equal(results[0]?.loaded, false);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.lastHealthOk, false);
  assert.match(stored?.lastHealthDetail ?? "", /No generated-tool runner/);
});

test("loadGeneratedTools preserves operator-disabled generated tools when no runner can load them", async () => {
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();

  await metadata.registerGenerated({
    name: "generated.disabled.runner",
    version: "1.0.0",
    description: "Disabled missing runner.",
    capabilities: ["missing-runner"],
    packageManifest: {
      schemaVersion: "agentic.tool-package.v1",
      name: "generated.disabled.runner",
      version: "1.0.0",
      description: "Disabled missing runner.",
      capabilities: ["missing-runner"],
      startupMode: "on-demand",
      package: { type: "external-package", ref: "missing-runner" },
    },
  });
  await metadata.markAvailable("generated.disabled.runner", "1.0.0");
  await metadata.setStatus("generated.disabled.runner", "disabled");

  const results = await loadGeneratedTools(registry, metadata, process.cwd(), []);
  const [stored] = await metadata.list();

  assert.equal(results[0]?.loaded, false);
  assert.equal(stored?.status, "disabled");
  assert.match(stored?.lastHealthDetail ?? "", /Operator disabled tool/);
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
  assert.equal(stored?.status, "loaded");
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
    assert.equal(stored?.status, "loaded");
    assert.equal(stored?.lastHealthDetail, "bundle healthy");
    assert.equal(output?.content, "hello bundle");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadGeneratedTools bootstraps source-bundle manifests from the package workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-source-bundle-bootstrap-"));
  const packageRef = "bootstrap-echo/1.0.0";
  const packageDir = join(root, "tools", packageRef);
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();

  try {
    await mkdir(join(packageDir, "dist"), { recursive: true });
    await writeFile(
      join(packageDir, "tool.package.json"),
      JSON.stringify(
        {
          schemaVersion: "agentic.tool-package.v1",
          name: "generated.bootstrap.echo",
          version: "1.0.0",
          description: "Bootstrapped echo tool.",
          capabilities: ["bootstrap-echo"],
          startupMode: "on-demand",
          package: { type: "source-bundle", ref: packageRef },
          qa: {
            summary: "Package workspace bootstrap-echo/1.0.0 passed structural, build, and test QA.",
            checks: ["package-local tests passed with exit 0"],
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(packageDir, "dist/index.js"),
      `
        export const tool = {
          name: "generated.bootstrap.echo",
          version: "1.0.0",
          description: "Bootstrapped echo tool.",
          capabilities: ["bootstrap-echo"],
          async healthcheck() { return { ok: true, detail: "bootstrapped healthy" }; },
          async run(input) { return { ok: true, content: String(input.text ?? "") }; }
        };
      `,
    );

    const results = await loadGeneratedTools(registry, metadata, root);
    const [stored] = await metadata.list();
    const output = await registry.get("generated.bootstrap.echo")?.run({ text: "hello bootstrap" });

    assert.equal(results.find((result) => result.name === "generated.bootstrap.echo")?.loaded, true);
    assert.equal(stored?.name, "generated.bootstrap.echo");
    assert.equal(stored?.status, "loaded");
    assert.equal(stored?.lastHealthDetail, "bootstrapped healthy");
    assert.equal(output?.content, "hello bootstrap");

    await metadata.markAvailable("generated.bootstrap.echo", "1.0.0");
    await loadGeneratedTools(registry, metadata, root);
    assert.equal((await metadata.list())[0]?.status, "available");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadGeneratedTools does not bootstrap source-bundles without successful QA evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-source-bundle-bootstrap-no-qa-"));
  const packageRef = "bootstrap-no-qa/1.0.0";
  const packageDir = join(root, "tools", packageRef);
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();

  try {
    await mkdir(join(packageDir, "dist"), { recursive: true });
    await writeFile(
      join(packageDir, "tool.package.json"),
      JSON.stringify(
        {
          schemaVersion: "agentic.tool-package.v1",
          name: "generated.bootstrap.noqa",
          version: "1.0.0",
          description: "Missing QA marker.",
          capabilities: ["bootstrap-no-qa"],
          startupMode: "on-demand",
          package: { type: "source-bundle", ref: packageRef },
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(packageDir, "dist/index.js"),
      "export const tool = { name: 'generated.bootstrap.noqa', description: 'noqa', capabilities: [], run() { return { ok: true, content: 'bad' }; } };",
    );

    const results = await loadGeneratedTools(registry, metadata, root);

    assert.equal(results.find((result) => result.name === "generated.bootstrap.noqa")?.loaded, undefined);
    assert.deepEqual(await metadata.list(), []);
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
    assert.equal(stored?.status, "loaded");
    assert.match(stored?.lastHealthDetail ?? "", /entrypoint is present/);
    assert.equal(output?.content, "hello http process");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source-bundle HTTP process runner builds TypeScript package when runtime dist is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-source-http-autobuild-"));
  const packageDir = join(root, "tool-packages/autobuild");
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();

  try {
    if (existsSync(join(process.cwd(), "node_modules"))) {
      await symlink(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
    }
    await mkdir(join(packageDir, "runtime"), { recursive: true });
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: "generated.bundle.autobuild",
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { build: "tsc -p tsconfig.json" },
        devDependencies: { "@types/node": "^20.12.12", typescript: "^5.6.3" },
      }, null, 2),
    );
    await writeFile(
      join(packageDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          outDir: "dist",
          rootDir: ".",
        },
        include: ["index.ts", "runtime/**/*.ts"],
      }, null, 2),
    );
    await writeFile(
      join(packageDir, "index.ts"),
      `
        export const tool = {
          name: "generated.bundle.autobuild",
          version: "1.0.0",
          description: "Autobuilt HTTP runtime source bundle.",
          capabilities: ["text-normalization"],
          async run(input: Record<string, unknown>) {
            return { ok: true, content: String(input.text ?? "").toUpperCase() };
          }
        };
      `,
    );
    await writeFile(
      join(packageDir, "runtime/server.ts"),
      `
        import { createServer } from "node:http";
        import { tool } from "../index.js";
        const port = Number(process.env.PORT ?? 8080);
        const server = createServer(async (request, response) => {
          response.setHeader("content-type", "application/json");
          if (request.method === "GET" && request.url === "/health") {
            response.end(JSON.stringify({ ok: true, detail: "autobuilt runtime healthy" }));
            return;
          }
          if (request.method === "POST" && request.url === "/run") {
            const chunks = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            response.end(JSON.stringify(await tool.run(body.input ?? {})));
            return;
          }
          response.statusCode = 404;
          response.end(JSON.stringify({ ok: false, error: "not found" }));
        });
        server.listen(port, "127.0.0.1");
      `,
    );
    await metadata.registerGenerated({
      name: "generated.bundle.autobuild",
      version: "1.0.0",
      description: "Autobuilt HTTP runtime source bundle.",
      capabilities: ["text-normalization"],
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.bundle.autobuild",
        version: "1.0.0",
        description: "Autobuilt HTTP runtime source bundle.",
        capabilities: ["text-normalization"],
        startupMode: "on-demand",
        package: { type: "source-bundle", ref: "autobuild" },
      },
    });

    assert.equal(existsSync(join(packageDir, "dist/runtime/server.js")), false);

    const results = await loadGeneratedTools(registry, metadata, root, [
      new SourceBundleHttpProcessToolPackageRunner({
        enabled: true,
        packageRoot: "tool-packages",
        startupTimeoutMs: 5000,
        pollIntervalMs: 50,
      }),
    ]);
    const output = await registry.get("generated.bundle.autobuild")?.run({ text: "hello" });

    assert.equal(results[0]?.loaded, true, JSON.stringify(results[0], null, 2));
    assert.equal(existsSync(join(packageDir, "dist/runtime/server.js")), true);
    assert.equal(output?.content, "HELLO");
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
            console.log("listener service started");
            console.error("listener service stderr diagnostic");
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
        server.listen(port, "127.0.0.1", () => console.log("listener runtime booted"));
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
    const logs = await supervisor.listLogs("generated.bundle.httplistener");

    assert.equal(results[0]?.loaded, true, JSON.stringify(results[0], null, 2));
    assert.equal(started.status, "running");
    assert.equal(heartbeat.status, "running");
    assert.equal(heartbeat.lastHealthOk, true);
    assert.equal(heartbeat.detail, "listener service running");
    assert.equal(stopped.status, "stopped");
    assert.match(logs.map((log) => log.message).join("\n"), /Source-bundle runtime stdout: listener service started/);
    assert.match(logs.map((log) => log.message).join("\n"), /Source-bundle runtime stderr: listener service stderr diagnostic/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
