import { existsSync } from "node:fs";
import { readFile, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { execFile, spawn, ChildProcess } from "node:child_process";
import { resolve, relative, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Tool, ToolExecutionContext, ToolHealth, ToolResult, ToolServiceContext, ToolServiceHandle } from "./tool.js";
import { ToolMetadataStore, ToolModuleMetadata } from "./toolMetadataStore.js";
import { ToolPackageReferenceType } from "./toolPackage.js";
import type { ToolRegistry } from "./registry.js";

const execFileAsync = promisify(execFile);

export type ToolPackageLoadResult = {
  loaded: boolean;
  detail: string;
  tool?: Tool;
  health?: ToolHealth;
};

export type ToolPackageRunner = {
  type: ToolPackageReferenceType | "legacy-local-path";
  canLoad(metadata: ToolModuleMetadata): boolean;
  load(metadata: ToolModuleMetadata, projectRoot: string): Promise<ToolPackageLoadResult>;
  describe?(): ToolPackageRunnerInfo;
};

export type ToolPackageRunnerInfo = {
  name: string;
  type: ToolPackageRunner["type"];
  status: "available" | "disabled";
  detail: string;
  supportedPackageTypes: ToolPackageReferenceType[];
  root?: string;
};

export type OciContainerResources = {
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  network?: string;
  readOnly?: boolean;
};

export type OciContainerRuntimeStartInput = {
  image: string;
  internalPort: number;
  toolName: string;
  toolVersion?: string;
  startupMode?: string;
  labels?: Record<string, string>;
  env?: Record<string, string>;
  resources?: OciContainerResources;
};

export type OciContainerRuntime = {
  start(input: OciContainerRuntimeStartInput): Promise<{ containerId: string; baseUrl: string }>;
  stop(containerId: string): Promise<void>;
  logs?(containerId: string): Promise<string | undefined>;
};

export class LocalPathToolPackageRunner implements ToolPackageRunner {
  readonly type = "local-path";

  canLoad(metadata: ToolModuleMetadata): boolean {
    const packageType = metadata.packageManifest?.package.type;
    return packageType === "local-path" || (!packageType && Boolean(metadata.modulePath));
  }

  async load(metadata: ToolModuleMetadata, projectRoot: string): Promise<ToolPackageLoadResult> {
    const modulePath = metadata.modulePath ?? metadata.packageManifest?.package.ref;
    if (!modulePath) {
      return {
        loaded: false,
        detail: "Generated tool metadata has no modulePath or local package ref.",
        health: { ok: false, detail: "Generated tool metadata has no modulePath or local package ref." },
      };
    }

    const moduleFile = resolve(projectRoot, compiledModulePath(modulePath));
    if (!existsSync(moduleFile)) {
      const detail = `Compiled generated module not found: ${moduleFile}`;
      return { loaded: false, detail, health: { ok: false, detail } };
    }

    const imported = await import(pathToFileURL(moduleFile).href);
    const tool = exportedTool(imported);
    validateToolAgainstMetadata(tool, metadata);
    const health = tool.healthcheck ? await tool.healthcheck() : { ok: true, detail: "No healthcheck registered." };

    if (!health.ok) {
      return { loaded: false, detail: health.detail, health };
    }

    return { loaded: true, detail: `Loaded ${metadata.name} from ${moduleFile}`, tool, health };
  }

  describe(): ToolPackageRunnerInfo {
    return {
      name: "Local compiled module runner",
      type: this.type,
      status: "available",
      detail: "Loads compiled local-path TypeScript modules from the application dist directory.",
      supportedPackageTypes: ["local-path"],
    };
  }
}

export class SourceBundleToolPackageRunner implements ToolPackageRunner {
  readonly type = "source-bundle";
  private readonly packageRoots: string[];

  constructor(
    packageRoot: string | string[] = defaultSourceBundleRoots(),
    private readonly autoBuildMissingEntrypoint = sourceBundleAutoBuildEnabled(),
  ) {
    this.packageRoots = Array.isArray(packageRoot) ? packageRoot : [packageRoot];
  }

  canLoad(metadata: ToolModuleMetadata): boolean {
    return metadata.packageManifest?.package.type === "source-bundle";
  }

  async load(metadata: ToolModuleMetadata, projectRoot: string): Promise<ToolPackageLoadResult> {
    const ref = metadata.packageManifest?.package.ref;
    if (!ref) {
      const detail = "Source-bundle package manifest has no package.ref.";
      return { loaded: false, detail, health: { ok: false, detail } };
    }

    const entrypoints = ["dist/index.js", "index.js"];
    let found = findSourceBundlePackage(projectRoot, this.packageRoots, ref, entrypoints);
    if (!found?.moduleFile && this.autoBuildMissingEntrypoint) {
      const build = await buildSourceBundlePackage(projectRoot, this.packageRoots, ref);
      if (!build.ok) {
        return { loaded: false, detail: build.detail, health: { ok: false, detail: build.detail } };
      }
      found = findSourceBundlePackage(projectRoot, this.packageRoots, ref, entrypoints);
    }
    if (!found?.moduleFile) {
      const detail = `Source-bundle package has no loadable dist/index.js or index.js under: ${this.packageRoots.join(", ")}`;
      return { loaded: false, detail, health: { ok: false, detail } };
    }

    const imported = await import(pathToFileURL(found.moduleFile).href);
    const tool = exportedTool(imported);
    validateToolAgainstMetadata(tool, metadata);
    const health = tool.healthcheck ? await tool.healthcheck() : { ok: true, detail: "No healthcheck registered." };

    if (!health.ok) {
      return { loaded: false, detail: health.detail, health };
    }

    return { loaded: true, detail: `Loaded ${metadata.name} from source bundle ${found.moduleFile}`, tool, health };
  }

  describe(): ToolPackageRunnerInfo {
    return {
      name: "Source bundle in-process runner",
      type: this.type,
      status: "available",
      detail: "Loads pre-built source-bundle packages from the tool package workspace. It does not install dependencies or execute build commands.",
      supportedPackageTypes: ["source-bundle"],
      root: this.packageRoots.join(","),
    };
  }
}

export type SourceBundleHttpProcessToolPackageRunnerOptions = {
  enabled?: boolean;
  packageRoot?: string | string[];
  autoBuildMissingRuntime?: boolean;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  callTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class SourceBundleHttpProcessToolPackageRunner implements ToolPackageRunner {
  readonly type = "source-bundle";
  private readonly enabled: boolean;
  private readonly packageRoots: string[];
  private readonly autoBuildMissingRuntime: boolean;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly callTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SourceBundleHttpProcessToolPackageRunnerOptions = {}) {
    this.enabled = options.enabled ?? (
      process.env.TOOL_SOURCE_BUNDLE_HTTP_RUNNER === "enabled" ||
      process.env.TOOL_SOURCE_BUNDLE_RUNNER === "http-process"
    );
    const roots = options.packageRoot ?? defaultSourceBundleRoots();
    this.packageRoots = Array.isArray(roots) ? roots : [roots];
    this.autoBuildMissingRuntime = options.autoBuildMissingRuntime ?? sourceBundleAutoBuildEnabled();
    this.startupTimeoutMs = options.startupTimeoutMs ?? Number(process.env.TOOL_SOURCE_BUNDLE_STARTUP_TIMEOUT_MS ?? 15_000);
    this.pollIntervalMs = options.pollIntervalMs ?? Number(process.env.TOOL_SOURCE_BUNDLE_POLL_INTERVAL_MS ?? 250);
    this.callTimeoutMs = options.callTimeoutMs ?? Number(process.env.TOOL_SOURCE_BUNDLE_CALL_TIMEOUT_MS ?? 60_000);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  canLoad(metadata: ToolModuleMetadata): boolean {
    return this.enabled && metadata.packageManifest?.package.type === "source-bundle";
  }

  async load(metadata: ToolModuleMetadata, projectRoot: string): Promise<ToolPackageLoadResult> {
    const ref = metadata.packageManifest?.package.ref;
    if (!ref) {
      const detail = "Source-bundle package manifest has no package.ref.";
      return { loaded: false, detail, health: { ok: false, detail } };
    }

    const entrypoints = ["dist/runtime/server.js"];
    let found = findSourceBundlePackage(projectRoot, this.packageRoots, ref, entrypoints);
    if (!found?.moduleFile && this.autoBuildMissingRuntime) {
      const build = await buildSourceBundlePackage(projectRoot, this.packageRoots, ref);
      if (!build.ok) {
        return { loaded: false, detail: build.detail, health: { ok: false, detail: build.detail } };
      }
      found = findSourceBundlePackage(projectRoot, this.packageRoots, ref, entrypoints);
    }
    if (!found?.moduleFile) {
      const detail = `Source-bundle package has no HTTP runtime dist/runtime/server.js under: ${this.packageRoots.join(", ")}`;
      return { loaded: false, detail, health: { ok: false, detail } };
    }

    return {
      loaded: true,
      detail: `Loaded ${metadata.name} from source-bundle HTTP process runtime ${found.moduleFile}`,
      tool: sourceBundleHttpProcessTool(metadata, {
        packageDir: found.packageDir,
        serverFile: found.moduleFile,
        startupTimeoutMs: this.startupTimeoutMs,
        pollIntervalMs: this.pollIntervalMs,
        callTimeoutMs: this.callTimeoutMs,
        fetchImpl: this.fetchImpl,
      }),
      health: { ok: true, detail: "Source-bundle HTTP runtime entrypoint is present; process starts on demand or service start." },
    };
  }

  describe(): ToolPackageRunnerInfo {
    return {
      name: "Source bundle HTTP process runner",
      type: this.type,
      status: this.enabled ? "available" : "disabled",
      detail: this.enabled
        ? "Starts source-bundle package HTTP runtimes as local supervised Node processes."
        : "Disabled by default. Set TOOL_SOURCE_BUNDLE_HTTP_RUNNER=enabled or TOOL_SOURCE_BUNDLE_RUNNER=http-process to execute source-bundles as local HTTP runtimes.",
      supportedPackageTypes: ["source-bundle"],
      root: this.packageRoots.join(","),
    };
  }
}

function defaultSourceBundleRoots(): string[] {
  if (process.env.TOOL_PACKAGE_ROOT) return [process.env.TOOL_PACKAGE_ROOT];
  if (process.env.TOOL_PACKAGE_WORKSPACE_ROOT) return [process.env.TOOL_PACKAGE_WORKSPACE_ROOT];
  return ["tools", "tool-packages"];
}

export class ExternalHttpToolPackageRunner implements ToolPackageRunner {
  readonly type = "external-package";

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  canLoad(metadata: ToolModuleMetadata): boolean {
    const reference = metadata.packageManifest?.package;
    return reference?.type === "external-package" && isHttpUrl(reference.ref);
  }

  async load(metadata: ToolModuleMetadata): Promise<ToolPackageLoadResult> {
    const ref = metadata.packageManifest?.package.ref;
    if (!ref || !isHttpUrl(ref)) {
      const detail = "External package ref must be an http(s) URL for the HTTP package runner.";
      return { loaded: false, detail, health: { ok: false, detail } };
    }
    const baseUrl = normalizeBaseUrl(ref);
    const tool = externalHttpProxyTool(metadata, baseUrl, this.fetchImpl);
    const health = await tool.healthcheck?.() ?? { ok: true, detail: "No healthcheck registered." };
    if (!health.ok) return { loaded: false, detail: health.detail, health };
    return {
      loaded: true,
      detail: `Loaded ${metadata.name} as external HTTP package ${baseUrl}`,
      tool,
      health,
    };
  }

  describe(): ToolPackageRunnerInfo {
    return {
      name: "External HTTP package runner",
      type: this.type,
      status: "available",
      detail: "Loads external-package manifests whose package.ref is an HTTP(S) tool-runtime endpoint exposing /health, /run, and optional /service lifecycle routes.",
      supportedPackageTypes: ["external-package"],
    };
  }
}

export type OciImageToolPackageRunnerOptions = {
  enabled?: boolean;
  internalPort?: number;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  callTimeoutMs?: number;
  resources?: OciContainerResources;
  runtime?: OciContainerRuntime;
  fetchImpl?: typeof fetch;
};

export class OciImageToolPackageRunner implements ToolPackageRunner {
  readonly type = "oci-image";
  private readonly enabled: boolean;
  private readonly internalPort: number;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly callTimeoutMs: number;
  private readonly resources: OciContainerResources;
  private readonly runtime: OciContainerRuntime;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OciImageToolPackageRunnerOptions = {}) {
    this.enabled = options.enabled ?? process.env.TOOL_OCI_RUNNER === "enabled";
    this.internalPort = options.internalPort ?? Number(process.env.TOOL_OCI_INTERNAL_PORT ?? 8080);
    this.startupTimeoutMs = options.startupTimeoutMs ?? Number(process.env.TOOL_OCI_STARTUP_TIMEOUT_MS ?? 15_000);
    this.pollIntervalMs = options.pollIntervalMs ?? Number(process.env.TOOL_OCI_POLL_INTERVAL_MS ?? 250);
    this.callTimeoutMs = options.callTimeoutMs ?? Number(process.env.TOOL_OCI_CALL_TIMEOUT_MS ?? 60_000);
    this.resources = compactOciResources(options.resources ?? ociResourcesFromEnv());
    this.runtime = options.runtime ?? new DockerCliContainerRuntime();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  canLoad(metadata: ToolModuleMetadata): boolean {
    return this.enabled && metadata.packageManifest?.package.type === "oci-image";
  }

  async load(metadata: ToolModuleMetadata): Promise<ToolPackageLoadResult> {
    const ref = metadata.packageManifest?.package.ref;
    if (!ref) {
      const detail = "OCI package manifest has no package.ref.";
      return { loaded: false, detail, health: { ok: false, detail } };
    }

    return {
      loaded: true,
      detail: `Loaded ${metadata.name} from OCI image ${ref}; container starts on run or service start.`,
      tool: ociImageHttpTool(metadata, {
        image: ref,
        internalPort: this.internalPort,
        startupTimeoutMs: this.startupTimeoutMs,
        pollIntervalMs: this.pollIntervalMs,
        callTimeoutMs: this.callTimeoutMs,
        resources: this.resources,
        runtime: this.runtime,
        fetchImpl: this.fetchImpl,
      }),
      health: { ok: true, detail: "OCI image manifest accepted; container starts lazily on run or service start." },
    };
  }

  describe(): ToolPackageRunnerInfo {
    return {
      name: "OCI image HTTP runner",
      type: this.type,
      status: this.enabled ? "available" : "disabled",
      detail: this.enabled
        ? `Starts OCI image packages with Docker on demand or through service lifecycle on internal port ${this.internalPort}.`
        : "Disabled by default. Set TOOL_OCI_RUNNER=enabled to start OCI image packages through Docker.",
      supportedPackageTypes: ["oci-image"],
    };
  }
}

type OciImageHttpRuntimeOptions = {
  image: string;
  internalPort: number;
  startupTimeoutMs: number;
  pollIntervalMs: number;
  callTimeoutMs: number;
  resources: OciContainerResources;
  runtime: OciContainerRuntime;
  fetchImpl: typeof fetch;
};

function ociImageHttpTool(
  metadata: ToolModuleMetadata,
  options: OciImageHttpRuntimeOptions,
): Tool {
  let serviceRuntime: { containerId: string; baseUrl: string } | undefined;
  let serviceStarted = false;

  return {
    name: metadata.name,
    displayName: metadata.displayName,
    version: metadata.version,
    description: metadata.description,
    capabilities: [...metadata.capabilities],
    inputSchema: metadata.inputSchema,
    outputSchema: metadata.outputSchema,
    startupMode: metadata.startupMode,
    requiredConfigurationKeys: metadata.requiredConfigurationKeys,
    requiredSecretHandles: metadata.requiredSecretHandles,
    settingsSchema: metadata.settingsSchema,
    storage: metadata.storage,
    docsMarkdown: metadata.docsMarkdown,
    examples: metadata.examples,
    async healthcheck() {
      if (serviceRuntime) return fetchHealth(options.fetchImpl, serviceRuntime.baseUrl);
      return { ok: true, detail: "OCI image runtime is not running; container starts on demand or service start." };
    },
    async run(input, context) {
      const runtime = serviceRuntime ?? await startOciHttpRuntime(metadata, options);
      const shouldStop = !serviceRuntime;
      try {
        const response = await withOptionalTimeoutSignal(
          context?.signal,
          options.callTimeoutMs,
          "OCI image HTTP runtime /run call",
          async (signal) => postJson(options.fetchImpl, `${runtime.baseUrl}/run`, {
            input,
            context: await executionContextPayload(metadata, context),
          }, signal),
        );
        return parseToolResult(response);
      } finally {
        if (shouldStop) await bestEffortStop(options.runtime, runtime.containerId);
      }
    },
    async startService(context) {
      let startedForThisCall = false;
      if (!serviceRuntime) {
        serviceRuntime = await startOciHttpRuntime(metadata, options);
        startedForThisCall = true;
      }
      try {
        if (!serviceStarted) {
          await withOptionalTimeoutSignal(
            context.signal,
            options.callTimeoutMs,
            "OCI image HTTP runtime /service/start call",
            async (signal) => postJson(options.fetchImpl, `${serviceRuntime!.baseUrl}/service/start`, {
              context: await serviceContextPayload(metadata, context),
            }, signal),
          );
          serviceStarted = true;
        }
      } catch (error) {
        if (startedForThisCall && serviceRuntime) {
          await bestEffortStop(options.runtime, serviceRuntime.containerId);
          serviceRuntime = undefined;
        }
        serviceStarted = false;
        throw error;
      }

      const activeRuntime = serviceRuntime;
      return {
        async stop() {
          if (!activeRuntime) return;
          try {
            if (serviceStarted) {
              await withOptionalTimeoutSignal(
                undefined,
                options.callTimeoutMs,
                "OCI image HTTP runtime /service/stop call",
                async (signal) => postJson(options.fetchImpl, `${activeRuntime.baseUrl}/service/stop`, {
                  context: await serviceContextPayload(metadata, context),
                }, signal),
              );
            }
          } finally {
            await bestEffortStop(options.runtime, activeRuntime.containerId);
            if (serviceRuntime?.containerId === activeRuntime.containerId) {
              serviceRuntime = undefined;
              serviceStarted = false;
            }
          }
        },
        async healthcheck() {
          return fetchHealth(options.fetchImpl, activeRuntime.baseUrl, context.signal);
        },
      };
    },
  };
}

async function startOciHttpRuntime(
  metadata: ToolModuleMetadata,
  options: OciImageHttpRuntimeOptions,
): Promise<{ containerId: string; baseUrl: string }> {
  let container: { containerId: string; baseUrl: string } | undefined;
  let stopped = false;
  try {
    container = await options.runtime.start({
      image: options.image,
      internalPort: options.internalPort,
      toolName: metadata.name,
      toolVersion: metadata.version,
      startupMode: metadata.startupMode,
      labels: {
        "agentic.tool": metadata.name,
        "agentic.tool.version": metadata.version,
        "agentic.tool.package-type": "oci-image",
        "agentic.tool.startup-mode": metadata.startupMode ?? "on-demand",
      },
      env: {
        AGENTIC_TOOL_NAME: metadata.name,
        AGENTIC_TOOL_VERSION: metadata.version,
        AGENTIC_TOOL_STARTUP_MODE: metadata.startupMode ?? "on-demand",
      },
      resources: Object.keys(options.resources).length ? options.resources : undefined,
    });
    const baseUrl = normalizeBaseUrl(container.baseUrl);
    const health = await waitForHealthyRuntime(
      options.fetchImpl,
      baseUrl,
      options.startupTimeoutMs,
      options.pollIntervalMs,
    );
    if (!health.ok) {
      const detail = await healthDetailWithContainerLogs(options.runtime, container.containerId, health.detail);
      await bestEffortStop(options.runtime, container.containerId);
      stopped = true;
      throw new Error(detail);
    }

    attachProcessCleanup(options.runtime, container.containerId);
    return { containerId: container.containerId, baseUrl };
  } catch (error) {
    const baseDetail = error instanceof Error ? error.message : String(error);
    const detail = container && !stopped
      ? await healthDetailWithContainerLogs(options.runtime, container.containerId, baseDetail)
      : redactRuntimeText(baseDetail);
    if (container && !stopped) await bestEffortStop(options.runtime, container.containerId);
    throw new Error(detail);
  }
}

export type DockerCliContainerRuntimeOptions = {
  resources?: OciContainerResources;
};

export class DockerCliContainerRuntime implements OciContainerRuntime {
  constructor(private readonly options: DockerCliContainerRuntimeOptions = {}) {}

  async start(input: OciContainerRuntimeStartInput): Promise<{ containerId: string; baseUrl: string }> {
    const resources = { ...this.options.resources, ...input.resources };
    const args = dockerRunArgsForToolContainer({ ...input, resources });
    const { stdout: idOutput } = await execFileAsync("docker", args);
    const containerId = idOutput.trim();
    if (!containerId) throw new Error("Docker did not return a container id.");

    try {
      const { stdout: portOutput } = await execFileAsync("docker", ["port", containerId, `${input.internalPort}/tcp`]);
      const baseUrl = dockerPortOutputToBaseUrl(portOutput);
      return { containerId, baseUrl };
    } catch (error) {
      await this.stop(containerId);
      throw error;
    }
  }

  async stop(containerId: string): Promise<void> {
    await execFileAsync("docker", ["stop", containerId]);
  }

  async logs(containerId: string): Promise<string | undefined> {
    try {
      const { stdout, stderr } = await execFileAsync("docker", ["logs", "--tail", "80", containerId], {
        maxBuffer: 128 * 1024,
      });
      return `${stdout ?? ""}\n${stderr ?? ""}`.trim();
    } catch (error) {
      return commandErrorDetail(error);
    }
  }
}

export function dockerRunArgsForToolContainer(input: OciContainerRuntimeStartInput): string[] {
  return [
    "run",
    "--rm",
    "-d",
    ...dockerLabelArgs(input.labels ?? { "agentic.tool": input.toolName }),
    ...dockerEnvArgs(input.env ?? {}),
    ...dockerResourceArgs(input.resources ?? {}),
    "-p",
    `127.0.0.1::${input.internalPort}`,
    input.image,
  ];
}

export function compiledModulePath(modulePath: string): string {
  return modulePath
    .replace(/^src\//, "dist/")
    .replace(/\.ts$/, ".js");
}

function exportedTool(imported: Record<string, unknown>): Tool {
  const candidate = imported.default ?? imported.tool;
  if (isTool(candidate)) return candidate;

  for (const value of Object.values(imported)) {
    if (isTool(value)) return value;
  }

  throw new Error("Generated module must export a Tool as default, `tool`, or a named Tool export.");
}

function validateToolAgainstMetadata(tool: Tool, metadata: ToolModuleMetadata): void {
  if (tool.name !== metadata.name) {
    throw new Error(`Generated tool name mismatch: module exports ${tool.name}, metadata expects ${metadata.name}.`);
  }
  const toolVersion = tool.version ?? "0.0.0";
  if (toolVersion !== metadata.version) {
    throw new Error(`Generated tool version mismatch: module exports ${toolVersion}, metadata expects ${metadata.version}.`);
  }
  for (const capability of metadata.capabilities) {
    if (!tool.capabilities.includes(capability)) {
      throw new Error(`Generated tool ${tool.name} is missing capability ${capability}.`);
    }
  }
}

function isTool(value: unknown): value is Tool {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Tool>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.description === "string" &&
    Array.isArray(candidate.capabilities) &&
    typeof candidate.run === "function"
  );
}

function safePackagePath(root: string, ref: string): string {
  if (isAbsolute(ref)) throw new Error("Source-bundle package.ref must be relative to TOOL_PACKAGE_ROOT.");
  const resolved = resolve(root, ref);
  const rel = relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Source-bundle package.ref must stay inside TOOL_PACKAGE_ROOT.");
  }
  return resolved;
}

function findSourceBundlePackage(
  projectRoot: string,
  packageRoots: string[],
  ref: string,
  entrypoints: string[],
): { packageDir: string; moduleFile?: string } | undefined {
  const candidates = packageRoots.map((root) => {
    const packageDir = safePackagePath(resolve(projectRoot, root), ref);
    return {
      packageDir,
      moduleFile: firstExisting(entrypoints.map((entrypoint) => join(packageDir, entrypoint))),
    };
  });
  return candidates.find((candidate) => candidate.moduleFile);
}

function findSourceBundlePackageDir(
  projectRoot: string,
  packageRoots: string[],
  ref: string,
): string | undefined {
  return packageRoots
    .map((root) => safePackagePath(resolve(projectRoot, root), ref))
    .find((packageDir) => existsSync(join(packageDir, "package.json")));
}

type SourceBundleBuildResult = {
  ok: boolean;
  detail: string;
};

async function buildSourceBundlePackage(
  projectRoot: string,
  packageRoots: string[],
  ref: string,
): Promise<SourceBundleBuildResult> {
  const packageDir = findSourceBundlePackageDir(projectRoot, packageRoots, ref);
  if (!packageDir) {
    return {
      ok: false,
      detail: `Source-bundle package ${ref} has no package.json under: ${packageRoots.join(", ")}`,
    };
  }

  try {
    // Phase 22 Slice E — install the tool's own runtime
    // dependencies BEFORE we symlink the root node_modules.
    // Council-built tools declare their imports (puppeteer, axios,
    // …) in package.json.dependencies; without `npm install` the
    // bundle's tsc build crashes with TS2307 "Cannot find module
    // X". We use `--prefer-offline --no-audit --no-fund` so reruns
    // hit the npm cache and runs stay fast (typical: <2 s for an
    // already-cached package, 10-30 s for first install).
    //
    // The order matters: install FIRST so the tool gets its own
    // node_modules, then symlink root only if still empty (some
    // tools declare zero runtime deps and rely entirely on shared
    // packages installed at the project root — for those the
    // symlink is the only path).
    // Phase 25 Slice A (revised) — tools are FULLY self-contained.
    // Always run `npm install` in the bundle dir; never symlink
    // the host's root node_modules. Even tools with zero declared
    // runtime deps get their own empty `node_modules` so `import`
    // resolution stays scoped to the bundle. This matches the
    // operator's "tool = standalone project" model: a tool moved
    // to another host / image / cluster still works without
    // pulling anything from the platform's package graph.
    //
    // Tools with no `dependencies` block run `npm install` on a
    // bundle that only declares devDependencies (typescript +
    // @types/node) — fast (<2 s) and produces just the tsc
    // toolchain needed to build `dist/`.
    try {
      await execFileAsync(
        "npm",
        ["install", "--prefer-offline", "--no-audit", "--no-fund", "--no-progress"],
        {
          cwd: packageDir,
          timeout: sourceBundleBuildTimeoutMs(),
          maxBuffer: 4 * 1024 * 1024,
          // Phase 28 follow-up — make playwright/puppeteer
          // browser downloads SELF-CONTAINED to the tool's own
          // node_modules. Default playwright postinstall installs
          // Chromium to `$HOME/.cache/ms-playwright/` — which is
          // container-ephemeral. After a container restart, the
          // bind-mounted tools/ dir survives (source + node_modules
          // + dist) but the home-cache browser disappears, leaving
          // the tool reporting "Executable doesn't exist at
          // /root/.cache/ms-playwright/...".
          //
          // PLAYWRIGHT_BROWSERS_PATH=0 tells playwright to look in
          // and install to `node_modules/playwright-core/.local-browsers/`
          // (i.e. INSIDE the package, which is bind-mounted). Same
          // semantics for puppeteer via PUPPETEER_CACHE_DIR set to
          // a per-package node_modules path.
          //
          // We DELIBERATELY do NOT set
          // PUPPETEER_SKIP_DOWNLOAD / PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
          // — the tool's postinstall MUST actually download the
          // browser; we just redirect WHERE the bytes land.
          env: {
            ...process.env,
            PLAYWRIGHT_BROWSERS_PATH: "0",
            PUPPETEER_CACHE_DIR: `${packageDir}/node_modules/.puppeteer-cache`,
          },
        },
      );
    } catch (installError) {
      return {
        ok: false,
        detail: `Source-bundle package ${ref} npm install failed: ${commandErrorDetail(installError)}`,
      };
    }
    const { stdout, stderr } = await execFileAsync("npm", ["run", "build"], {
      cwd: packageDir,
      timeout: sourceBundleBuildTimeoutMs(),
      maxBuffer: 1024 * 1024,
    });
    const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim().replace(/\s+/g, " ").slice(-500);
    return {
      ok: true,
      detail: `Built source-bundle package ${ref}${output ? `: ${output}` : ""}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `Source-bundle package ${ref} build failed: ${commandErrorDetail(error)}`,
    };
  }
}

async function packageDeclaresRuntimeDependencies(packageDir: string): Promise<boolean> {
  try {
    const pkgPath = join(packageDir, "package.json");
    const text = await readFile(pkgPath, "utf8");
    const parsed = JSON.parse(text) as { dependencies?: Record<string, unknown> };
    return Boolean(parsed.dependencies && Object.keys(parsed.dependencies).length > 0);
  } catch {
    return false;
  }
}

/**
 * Phase 25 Slice A (revised): retained only as documentation of
 * the legacy fallback behaviour. The bundle runner no longer
 * symlinks the host root `node_modules` into the tool's package
 * dir — tools are fully self-contained and must declare every
 * runtime dependency in their own package.json. Left here in case
 * a future operator wants a `--shared-deps` opt-in mode.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function linkRootNodeModulesIfAvailable(projectRoot: string, packageDir: string): Promise<void> {
  const packageNodeModules = join(packageDir, "node_modules");
  if (existsSync(packageNodeModules)) return;

  const rootNodeModules = join(resolve(projectRoot), "node_modules");
  if (!existsSync(rootNodeModules)) return;

  await symlink(rootNodeModules, packageNodeModules, "dir");
}

function commandErrorDetail(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const detail = error as { message?: string; stdout?: string | Buffer; stderr?: string | Buffer };
  const output = `${detail.stdout ?? ""}\n${detail.stderr ?? ""}`.trim().replace(/\s+/g, " ").slice(-800);
  return redactRuntimeText(output || detail.message || String(error));
}

function sourceBundleAutoBuildEnabled(): boolean {
  return process.env.TOOL_SOURCE_BUNDLE_AUTO_BUILD !== "disabled";
}

function sourceBundleBuildTimeoutMs(): number {
  const value = Number(process.env.TOOL_SOURCE_BUNDLE_BUILD_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(value) && value > 0 ? value : 120_000;
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path));
}

function externalHttpProxyTool(
  metadata: ToolModuleMetadata,
  baseUrl: string,
  fetchImpl: typeof fetch,
  options: { callTimeoutMs?: number; labelPrefix?: string } = {},
): Tool {
  const labelPrefix = options.labelPrefix ?? "External tool runtime";
  return {
    name: metadata.name,
    displayName: metadata.displayName,
    version: metadata.version,
    description: metadata.description,
    capabilities: [...metadata.capabilities],
    inputSchema: metadata.inputSchema,
    outputSchema: metadata.outputSchema,
    startupMode: metadata.startupMode,
    requiredConfigurationKeys: metadata.requiredConfigurationKeys,
    requiredSecretHandles: metadata.requiredSecretHandles,
    settingsSchema: metadata.settingsSchema,
    storage: metadata.storage,
    docsMarkdown: metadata.docsMarkdown,
    examples: metadata.examples,
    async healthcheck() {
      return fetchHealth(fetchImpl, baseUrl);
    },
    async run(input, context) {
      const response = await withOptionalTimeoutSignal(
        context?.signal,
        options.callTimeoutMs,
        `${labelPrefix} /run call`,
        async (signal) => postJson(fetchImpl, `${baseUrl}/run`, {
          input,
          context: await executionContextPayload(metadata, context),
        }, signal),
      );
      return parseToolResult(response);
    },
    async startService(context) {
      await withOptionalTimeoutSignal(
        context.signal,
        options.callTimeoutMs,
        `${labelPrefix} /service/start call`,
        async (signal) => postJson(fetchImpl, `${baseUrl}/service/start`, {
          context: await serviceContextPayload(metadata, context),
        }, signal),
      );
      return externalHttpServiceHandle(fetchImpl, metadata, baseUrl, context, options);
    },
  };
}

type SourceBundleHttpProcessRuntimeOptions = {
  packageDir: string;
  serverFile: string;
  startupTimeoutMs: number;
  pollIntervalMs: number;
  callTimeoutMs: number;
  fetchImpl: typeof fetch;
};

function sourceBundleHttpProcessTool(
  metadata: ToolModuleMetadata,
  options: SourceBundleHttpProcessRuntimeOptions,
): Tool {
  return {
    name: metadata.name,
    displayName: metadata.displayName,
    version: metadata.version,
    description: metadata.description,
    capabilities: [...metadata.capabilities],
    inputSchema: metadata.inputSchema,
    outputSchema: metadata.outputSchema,
    startupMode: metadata.startupMode,
    requiredConfigurationKeys: metadata.requiredConfigurationKeys,
    requiredSecretHandles: metadata.requiredSecretHandles,
    settingsSchema: metadata.settingsSchema,
    storage: metadata.storage,
    docsMarkdown: metadata.docsMarkdown,
    examples: metadata.examples,
    async healthcheck() {
      return { ok: true, detail: "Source-bundle HTTP process runtime entrypoint is available." };
    },
    async run(input, context) {
      const runtime = await startSourceBundleHttpRuntime(options, context?.logger);
      try {
        const response = await withTimeoutSignal(
          context?.signal,
          options.callTimeoutMs,
          "Source-bundle HTTP runtime /run call",
          async (signal) => postJson(options.fetchImpl, `${runtime.baseUrl}/run`, {
            input,
            context: await executionContextPayload(metadata, context),
          }, signal),
        );
        return parseToolResult(response);
      } finally {
        stopChildProcess(runtime.child);
      }
    },
    async startService(context) {
      const runtime = await startSourceBundleHttpRuntime(options, context.logger);
      try {
        await withTimeoutSignal(
          context.signal,
          options.callTimeoutMs,
          "Source-bundle HTTP runtime /service/start call",
          async (signal) => postJson(options.fetchImpl, `${runtime.baseUrl}/service/start`, {
            context: await serviceContextPayload(metadata, context),
          }, signal),
        );
      } catch (error) {
        stopChildProcess(runtime.child);
        throw error;
      }
      return {
        async stop() {
          try {
            await withTimeoutSignal(
              undefined,
              options.callTimeoutMs,
              "Source-bundle HTTP runtime /service/stop call",
              async (signal) => postJson(options.fetchImpl, `${runtime.baseUrl}/service/stop`, {
                context: await serviceContextPayload(metadata, context),
              }, signal),
            );
          } finally {
            stopChildProcess(runtime.child);
          }
        },
        async healthcheck() {
          return fetchHealth(options.fetchImpl, runtime.baseUrl, context.signal);
        },
      };
    },
  };
}

async function startSourceBundleHttpRuntime(
  options: SourceBundleHttpProcessRuntimeOptions,
  logger?: ToolServiceContext["logger"] | ToolExecutionContext["logger"],
): Promise<{
  child: ChildProcess;
  baseUrl: string;
}> {
  const port = await freeLocalPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output: Buffer[] = [];
  // Phase 25 Slice A (revised) — tools are self-contained. The
  // spawned subprocess only receives a minimal env: PATH so the
  // `node` binary resolves, HOME so npm/cache lookups don't write
  // to root, PORT so the runtime knows which TCP port to bind.
  // We DELIBERATELY do NOT pass `process.env` through. Without
  // this clamp the tool would inherit DATABASE_URL, LLM_BASE_URL,
  // PUPPETEER_EXECUTABLE_PATH, et al — every platform secret +
  // every shared binary lookup leaks in. With it the tool stays
  // a "separate project": its only inputs are the JSON over /run.
  const minimalEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    PORT: String(port),
    // Phase 28 follow-up — match the install-time env so the
    // subprocess looks for browser binaries INSIDE its own
    // node_modules (where postinstall just put them) instead of
    // in $HOME/.cache/ms-playwright (container-ephemeral). Same
    // PUPPETEER_CACHE_DIR pin so puppeteer-extra tools resolve
    // their browsers from the bind-mounted package dir.
    PLAYWRIGHT_BROWSERS_PATH: "0",
    PUPPETEER_CACHE_DIR: `${options.packageDir}/node_modules/.puppeteer-cache`,
  };
  const child = spawn(process.execPath, [options.serverFile], {
    cwd: options.packageDir,
    env: minimalEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Phase 22 Slice E follow-up — `spawn()` emits an asynchronous
  // 'error' event when the binary cannot be found / executed
  // (ENOENT, EACCES, etc.). Without a listener Node converts that
  // into an uncaught exception and CRASHES the whole agentic-app
  // process — exactly what happened during a tool reload race
  // when /app/tools/.../dist/runtime/server.js existed but the
  // node binary lookup transiently failed. We capture the first
  // error and surface it as a runtime health failure so the
  // run aborts cleanly and the operator sees a usable detail.
  let spawnError: Error | undefined;
  child.once("error", (err) => {
    spawnError = err;
    logRuntimeOutput(
      logger,
      "warn",
      "stderr",
      Buffer.from(`Source-bundle HTTP runtime spawn failed: ${err.message}\n`),
    );
  });
  child.stdout?.on("data", (chunk) => {
    output.push(Buffer.from(chunk));
    logRuntimeOutput(logger, "info", "stdout", chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output.push(Buffer.from(chunk));
    logRuntimeOutput(logger, "warn", "stderr", chunk);
  });

  const exitBeforeHealth = new Promise<ToolHealth>((resolveExit) => {
    const finish = () => {
      const processDetail = Buffer.concat(output).toString("utf8").trim();
      const reason = spawnError
        ? `spawn error: ${spawnError.message}`
        : "exit";
      resolveExit({
        ok: false,
        detail: processDetail
          ? `Source-bundle HTTP runtime exited before healthcheck with ${reason}: ${processDetail}`
          : `Source-bundle HTTP runtime exited before healthcheck with ${reason}.`,
      });
    };
    child.once("exit", (code, signal) => {
      const processDetail = Buffer.concat(output).toString("utf8").trim();
      const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      resolveExit({
        ok: false,
        detail: processDetail
          ? `Source-bundle HTTP runtime exited before healthcheck with ${reason}: ${processDetail}`
          : `Source-bundle HTTP runtime exited before healthcheck with ${reason}.`,
      });
    });
    // Also resolve on 'error' so a spawn-failure (binary missing,
    // EACCES) doesn't dangle the await on exitBeforeHealth.
    child.once("error", () => finish());
  });
  const health = await Promise.race([
    waitForHealthyRuntime(
      options.fetchImpl,
      baseUrl,
      options.startupTimeoutMs,
      options.pollIntervalMs,
    ),
    exitBeforeHealth,
  ]);
  if (!health.ok) {
    stopChildProcess(child);
    const processDetail = Buffer.concat(output).toString("utf8").trim();
    throw new Error(health.detail.includes(processDetail) ? health.detail : processDetail ? `${health.detail}: ${processDetail}` : health.detail);
  }

  attachChildProcessCleanup(child);
  return { child, baseUrl };
}

function logRuntimeOutput(
  logger: ToolServiceContext["logger"] | ToolExecutionContext["logger"] | undefined,
  level: "info" | "warn",
  stream: "stdout" | "stderr",
  chunk: unknown,
): void {
  if (!logger) return;
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
  for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const redacted = redactRuntimeText(line);
    const output = redacted.length > 2_000 ? `${redacted.slice(0, 2_000)}...` : redacted;
    logger[level](`Source-bundle runtime ${stream}: ${output.slice(0, 180)}`, {
      stream,
      output,
    });
  }
}

function externalHttpServiceHandle(
  fetchImpl: typeof fetch,
  metadata: ToolModuleMetadata,
  baseUrl: string,
  context: ToolServiceContext,
  options: { callTimeoutMs?: number; labelPrefix?: string } = {},
): ToolServiceHandle {
  const labelPrefix = options.labelPrefix ?? "External tool runtime";
  return {
    async stop() {
      await withOptionalTimeoutSignal(
        undefined,
        options.callTimeoutMs,
        `${labelPrefix} /service/stop call`,
        async (signal) => postJson(fetchImpl, `${baseUrl}/service/stop`, {
          context: await serviceContextPayload(metadata, context),
        }, signal),
      );
    },
    async healthcheck() {
      return fetchHealth(fetchImpl, baseUrl, context.signal);
    },
  };
}

async function fetchHealth(fetchImpl: typeof fetch, baseUrl: string, signal?: AbortSignal): Promise<ToolHealth> {
  const response = await fetchImpl(`${baseUrl}/health`, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  const body = await readJsonResponse(response);
  if (!response.ok) {
    return {
      ok: false,
      detail: redactRuntimeText(responseDetail(body) ?? `External tool runtime healthcheck failed with HTTP ${response.status}.`),
    };
  }
  if (isRecord(body) && typeof body.ok === "boolean" && typeof body.detail === "string") {
    return { ok: body.ok, detail: redactRuntimeText(body.detail) };
  }
  return { ok: true, detail: "External tool runtime healthcheck passed." };
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  const parsed = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(redactRuntimeText(responseDetail(parsed) ?? `External tool runtime call failed with HTTP ${response.status}.`));
  }
  return parsed;
}

async function withOptionalTimeoutSignal<T>(
  upstreamSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  label: string,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return withTimeoutSignal(upstreamSignal, timeoutMs ?? 0, label, action);
}

async function withTimeoutSignal<T>(
  upstreamSignal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (timeoutMs <= 0) {
    return action(upstreamSignal ?? new AbortController().signal);
  }

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(upstreamSignal?.reason);

  if (upstreamSignal?.aborted) {
    controller.abort(upstreamSignal.reason);
  } else {
    upstreamSignal?.addEventListener("abort", onAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await action(controller.signal);
  } catch (error) {
    if (timedOut) {
      throw new Error(`${label} timed out after ${timeoutMs} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", onAbort);
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseToolResult(value: unknown): ToolResult {
  if (!isRecord(value)) {
    return { ok: true, content: value === undefined ? "" : String(value), data: value };
  }
  const ok = typeof value.ok === "boolean" ? value.ok : true;
  const content = typeof value.content === "string"
    ? value.content
    : value.data === undefined
      ? JSON.stringify(value)
      : JSON.stringify(value.data);
  // Phase 13: dockerized tool services return inline artifact bodies as
  // `contentBase64` strings (Buffer is not JSON-serializable). Recursively
  // walk the data tree and rehydrate any `contentBase64` field to a real
  // Buffer in `content`, so existing artifact consumers see the same
  // shape as in-process tools.
  return {
    ok,
    content,
    data: rehydrateInlineArtifacts(value.data),
  };
}

function rehydrateInlineArtifacts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => rehydrateInlineArtifacts(item));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "contentBase64" && typeof nested === "string") {
      out.content = Buffer.from(nested, "base64");
      continue;
    }
    out[key] = rehydrateInlineArtifacts(nested);
  }
  return out;
}

async function executionContextPayload(
  metadata: ToolModuleMetadata,
  context: ToolExecutionContext | undefined,
): Promise<Record<string, unknown> | undefined> {
  const configurationEnvelope = await resolvedConfigurationEnvelope(
    metadata.requiredConfigurationKeys,
    context?.resolveConfiguration,
    metadata.name,
  );
  const secretEnvelope = await resolvedSecretEnvelope(metadata.requiredSecretHandles, context?.resolveSecret);
  assertResolvedRuntimeRequirements(configurationEnvelope, secretEnvelope);
  if (!context) return compactRecord({ ...configurationEnvelope, ...secretEnvelope });

  return compactRecord({
    instanceId: context.instanceId,
    requesterUserId: context.requesterUserId,
    threadId: context.threadId,
    runId: context.runId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    toolName: context.toolName,
    capability: context.capability,
    caller: context.caller,
    now: context.now.toISOString(),
    callback: context.callback,
    ...configurationEnvelope,
    ...secretEnvelope,
  });
}

async function serviceContextPayload(
  metadata: ToolModuleMetadata,
  context: ToolServiceContext,
): Promise<Record<string, unknown>> {
  const configurationEnvelope = await resolvedConfigurationEnvelope(
    metadata.requiredConfigurationKeys,
    context.resolveConfiguration,
    metadata.name,
  );
  const secretEnvelope = await resolvedSecretEnvelope(metadata.requiredSecretHandles, context.resolveSecret);
  assertResolvedRuntimeRequirements(configurationEnvelope, secretEnvelope);

  return compactRecord({
    toolName: context.toolName,
    now: context.now.toISOString(),
    baseUrl: context.baseUrl,
    ...configurationEnvelope,
    ...secretEnvelope,
  });
}

function assertResolvedRuntimeRequirements(
  configurationEnvelope: Record<string, unknown>,
  secretEnvelope: Record<string, unknown>,
): void {
  const missingConfiguration = Array.isArray(configurationEnvelope.missingConfigurationKeys)
    ? configurationEnvelope.missingConfigurationKeys
    : [];
  const missingSecrets = Array.isArray(secretEnvelope.missingSecretHandles)
    ? secretEnvelope.missingSecretHandles
    : [];
  if (missingConfiguration.length || missingSecrets.length) {
    const parts = [
      missingConfiguration.length
        ? `configuration: ${missingConfiguration.join(", ")}`
        : undefined,
      missingSecrets.length
        ? `secret handles: ${missingSecrets.join(", ")}`
        : undefined,
    ].filter(Boolean);
    throw new Error(`Missing required runtime values for external tool package (${parts.join("; ")}).`);
  }
}

async function resolvedConfigurationEnvelope(
  keys: string[] | undefined,
  resolveConfiguration: ((key: string, toolName?: string) => Promise<string | undefined>) | undefined,
  toolName: string,
): Promise<Record<string, unknown>> {
  const requestedKeys = [...new Set(keys ?? [])];
  if (!requestedKeys.length) return {};
  if (!resolveConfiguration) {
    return { configurationKeys: requestedKeys, missingConfigurationKeys: requestedKeys };
  }

  const configuration: Record<string, string> = {};
  const missingConfigurationKeys: string[] = [];
  for (const key of requestedKeys) {
    const value = await resolveConfiguration(key, toolName);
    if (value === undefined) missingConfigurationKeys.push(key);
    else configuration[key] = value;
  }

  return compactRecord({
    configurationKeys: requestedKeys,
    configuration,
    missingConfigurationKeys: missingConfigurationKeys.length ? missingConfigurationKeys : undefined,
  });
}

async function resolvedSecretEnvelope(
  handles: string[] | undefined,
  resolveSecret: ((handle: string) => Promise<string | undefined>) | undefined,
): Promise<Record<string, unknown>> {
  const requestedHandles = [...new Set(handles ?? [])];
  if (!requestedHandles.length) return {};
  if (!resolveSecret) return { secretHandles: requestedHandles, missingSecretHandles: requestedHandles };

  const secrets: Record<string, string> = {};
  const missingSecretHandles: string[] = [];
  for (const handle of requestedHandles) {
    const value = await resolveSecret(handle);
    if (value === undefined) missingSecretHandles.push(handle);
    else secrets[handle] = value;
  }

  return compactRecord({
    secretHandles: requestedHandles,
    secrets,
    missingSecretHandles: missingSecretHandles.length ? missingSecretHandles : undefined,
  });
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function responseDetail(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!isRecord(value)) return undefined;
  if (typeof value.detail === "string") return value.detail;
  if (typeof value.error === "string") return value.error;
  if (typeof value.message === "string") return value.message;
  return undefined;
}

async function waitForHealthyRuntime(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<ToolHealth> {
  const startedAt = Date.now();
  let lastDetail = "External runtime did not become healthy before timeout.";
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const health = await fetchHealth(fetchImpl, baseUrl);
      if (health.ok) return health;
      lastDetail = health.detail;
    } catch (error) {
      lastDetail = redactRuntimeText(error instanceof Error ? error.message : String(error));
    }
    await delay(pollIntervalMs);
  }
  return { ok: false, detail: lastDetail };
}

async function freeLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => resolvePort());
  });
  const address = server.address();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a local port for source-bundle runtime.");
  }
  return address.port;
}

function dockerPortOutputToBaseUrl(value: string): string {
  const firstLine = value.split(/\r?\n/).find((line) => line.trim());
  if (!firstLine) throw new Error("Docker did not publish an HTTP runtime port.");
  const match = firstLine.trim().match(/^(.*):(\d+)$/);
  if (!match) throw new Error(`Could not parse Docker published port: ${firstLine}`);
  const host = match[1] === "0.0.0.0" || match[1] === "::" ? "127.0.0.1" : match[1];
  return `http://${host}:${match[2]}`;
}

function dockerLabelArgs(labels: Record<string, string>): string[] {
  return Object.entries(labels)
    .filter(([, value]) => value.trim() !== "")
    .flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

function dockerEnvArgs(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

function dockerResourceArgs(resources: OciContainerResources): string[] {
  const args: string[] = [];
  if (resources.memory) args.push("--memory", resources.memory);
  if (resources.cpus) args.push("--cpus", resources.cpus);
  if (resources.pidsLimit !== undefined) args.push("--pids-limit", String(resources.pidsLimit));
  if (resources.network) args.push("--network", resources.network);
  if (resources.readOnly) args.push("--read-only");
  return args;
}

function ociResourcesFromEnv(): OciContainerResources {
  return compactOciResources({
    memory: nonEmptyEnv("TOOL_OCI_MEMORY"),
    cpus: nonEmptyEnv("TOOL_OCI_CPUS"),
    pidsLimit: positiveIntegerEnv("TOOL_OCI_PIDS_LIMIT"),
    network: nonEmptyEnv("TOOL_OCI_NETWORK"),
    readOnly: process.env.TOOL_OCI_READ_ONLY === "enabled",
  });
}

function compactOciResources(resources: OciContainerResources): OciContainerResources {
  return compactRecord({
    memory: resources.memory,
    cpus: resources.cpus,
    pidsLimit: resources.pidsLimit,
    network: resources.network,
    readOnly: resources.readOnly || undefined,
  }) as OciContainerResources;
}

function nonEmptyEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value || undefined;
}

function positiveIntegerEnv(key: string): number | undefined {
  const value = Number(process.env[key]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

async function healthDetailWithContainerLogs(
  runtime: OciContainerRuntime,
  containerId: string,
  detail: string,
): Promise<string> {
  const redactedDetail = redactRuntimeText(detail);
  if (!runtime.logs) return redactedDetail;
  let rawLogs = "";
  try {
    rawLogs = (await runtime.logs(containerId)) ?? "";
  } catch (error) {
    rawLogs = commandErrorDetail(error);
  }
  const logs = redactRuntimeText(rawLogs).trim();
  if (!logs) return redactedDetail;
  const clipped = logs.length > 2_000 ? `${logs.slice(-2_000)}` : logs;
  return `${redactedDetail}; container logs: ${clipped}`;
}

function redactRuntimeText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization|credential)\b\s*[:=]\s*['"]?[^'"\s,;)}]+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{8,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted-token]");
}

function attachProcessCleanup(runtime: OciContainerRuntime, containerId: string): void {
  const cleanup = () => {
    void bestEffortStop(runtime, containerId);
  };
  process.once("exit", cleanup);
}

function attachChildProcessCleanup(child: ChildProcess): void {
  const cleanup = () => {
    stopChildProcess(child);
  };
  process.once("exit", cleanup);
}

function stopChildProcess(child: ChildProcess): void {
  if (!child.killed) child.kill("SIGTERM");
}

async function bestEffortStop(runtime: OciContainerRuntime, containerId: string): Promise<void> {
  try {
    await runtime.stop(containerId);
  } catch {
    // Best-effort cleanup only; failed stop should not mask the original load failure.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Phase 13 follow-up: thin dispatcher that walks the metadata
 * store and asks each runner whether it can load the recorded
 * package descriptor. Used to live in
 * src/tools/generatedToolLoader.ts; now co-located with the
 * runners themselves so there is one obvious home for "given a
 * registered generated module, get a runtime Tool out of it".
 */
export type GeneratedToolLoadResult = {
  name: string;
  loaded: boolean;
  detail: string;
};

export async function loadGeneratedTools(
  registry: ToolRegistry,
  metadataStore: ToolMetadataStore,
  projectRoot = process.cwd(),
  runners: ToolPackageRunner[] = [
    new LocalPathToolPackageRunner(),
    new SourceBundleHttpProcessToolPackageRunner(),
    new SourceBundleToolPackageRunner(),
    new ExternalHttpToolPackageRunner(),
    new OciImageToolPackageRunner(),
  ],
): Promise<GeneratedToolLoadResult[]> {
  const modules = (await metadataStore.list()).filter((item) => item.source === "generated");
  const results: GeneratedToolLoadResult[] = [];
  for (const module of modules) {
    const runner = runners.find((candidate) => candidate.canLoad(module));
    if (!runner) {
      const packageType = module.packageManifest?.package.type ?? "legacy-local-path";
      results.push({
        name: module.name,
        loaded: false,
        detail: `No generated-tool runner is available for ${packageType} package references yet.`,
      });
      continue;
    }
    try {
      const result = await runner.load(module, projectRoot);
      if (result.health) await metadataStore.updateHealth(module.name, result.health);
      if (!result.loaded) {
        results.push({ name: module.name, loaded: false, detail: result.detail });
        continue;
      }
      if (!result.tool) {
        const detail = `Runner ${runner.type} reported success without returning a Tool.`;
        await metadataStore.updateHealth(module.name, { ok: false, detail });
        results.push({ name: module.name, loaded: false, detail });
        continue;
      }
      registry.register(result.tool);
      results.push({ name: module.name, loaded: true, detail: result.detail });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await metadataStore.updateHealth(module.name, { ok: false, detail });
      results.push({ name: module.name, loaded: false, detail });
    }
  }
  return results;
}
