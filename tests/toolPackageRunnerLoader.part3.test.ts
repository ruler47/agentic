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

test("ToolServiceSupervisor controls OCI always-on container lifecycle", async () => {
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    calls.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ ok: true, detail: "supervised oci healthy" }));
      return;
    }
    if (request.url === "/service/start" || request.url === "/service/stop") {
      response.end(JSON.stringify({ ok: true, content: "ok" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  const baseUrl = await listen(server);
  const metadata = new InMemoryToolMetadataStore();
  const registry = new ToolRegistry();
  const started: string[] = [];
  const stopped: string[] = [];

  try {
    await metadata.registerGenerated({
      name: "generated.oci.supervised",
      version: "1.0.0",
      description: "OCI supervised service.",
      capabilities: ["oci-supervised"],
      startupMode: "always-on",
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.oci.supervised",
        version: "1.0.0",
        description: "OCI supervised service.",
        capabilities: ["oci-supervised"],
        startupMode: "always-on",
        package: { type: "oci-image", ref: "registry.local/agentic/supervised:1.0.0" },
      },
    });
    await loadGeneratedTools(registry, metadata, process.cwd(), [
      new OciImageToolPackageRunner({
        enabled: true,
        runtime: {
          async start() {
            started.push("container-supervised");
            return { containerId: "container-supervised", baseUrl };
          },
          async stop(containerId) {
            stopped.push(containerId);
          },
        },
      }),
    ]);

    const supervisor = new ToolServiceSupervisor(registry);
    const listed = await supervisor.list();
    const startedStatus = await supervisor.start("generated.oci.supervised");
    const heartbeat = await supervisor.heartbeat("generated.oci.supervised");
    const stoppedStatus = await supervisor.stop("generated.oci.supervised");

    assert.equal(listed[0]?.status, "stopped");
    assert.equal(startedStatus.status, "running");
    assert.equal(startedStatus.detail, "supervised oci healthy");
    assert.equal(heartbeat.status, "running");
    assert.equal(stoppedStatus.status, "stopped");
    assert.deepEqual(started, ["container-supervised"]);
    assert.deepEqual(stopped, ["container-supervised"]);
    assert.deepEqual(calls, ["/health", "/service/start", "/health", "/health", "/service/stop"]);
  } finally {
    await close(server);
  }
});

test("OCI image packages stop lazy containers when their HTTP runtime fails health", async () => {
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
        async logs() {
          return "boot failed apiKey=DO-NOT-LEAK token:abc12345678901234567890";
        },
      },
    });
    const results = await loadGeneratedTools(registry, metadata, process.cwd(), [runner]);
    await assert.rejects(
      () => registry.get("generated.oci.unhealthy")!.run({ value: "hello" }),
      /runtime not ready; container logs: boot failed apiKey=\[redacted\] token=\[redacted\]/,
    );
    const [stored] = await metadata.list();

    assert.equal(results[0]?.loaded, true);
    assert.equal(
      results[0]?.detail,
      "Loaded generated.oci.unhealthy from OCI image registry.local/agentic/unhealthy:1.0.0; container starts on run or service start.",
    );
    assert.deepEqual(stopped, ["container-unhealthy"]);
    assert.equal(stored?.status, "loaded");
    assert.equal(stored?.lastHealthDetail, "OCI image manifest accepted; container starts lazily on run or service start.");
  } finally {
    await close(server);
  }
});

test("docker CLI container runtime args include labels, env, and resource limits", () => {
  const args = dockerRunArgsForToolContainer({
    image: "registry.local/agentic/tool:1.2.3",
    internalPort: 8080,
    toolName: "generated.oci.args",
    labels: {
      "agentic.tool": "generated.oci.args",
      "agentic.tool.version": "1.2.3",
    },
    env: {
      AGENTIC_TOOL_NAME: "generated.oci.args",
    },
    resources: {
      memory: "256m",
      cpus: "0.5",
      pidsLimit: 128,
      network: "agentic_default",
      readOnly: true,
    },
  });

  assert.deepEqual(args, [
    "run",
    "--rm",
    "-d",
    "--label",
    "agentic.tool=generated.oci.args",
    "--label",
    "agentic.tool.version=1.2.3",
    "--env",
    "AGENTIC_TOOL_NAME=generated.oci.args",
    "--memory",
    "256m",
    "--cpus",
    "0.5",
    "--pids-limit",
    "128",
    "--network",
    "agentic_default",
    "--read-only",
    "-p",
    "127.0.0.1::8080",
    "registry.local/agentic/tool:1.2.3",
  ]);
});
