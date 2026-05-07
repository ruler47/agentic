import { existsSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { execFile, spawn, ChildProcess } from "node:child_process";
import { resolve, relative, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Tool, ToolExecutionContext, ToolHealth, ToolResult, ToolServiceContext, ToolServiceHandle } from "./tool.js";
import { ToolModuleMetadata } from "./toolMetadataStore.js";
import { ToolPackageReferenceType } from "./toolPackage.js";

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

export type OciContainerRuntime = {
  start(input: { image: string; internalPort: number; toolName: string }): Promise<{ containerId: string; baseUrl: string }>;
  stop(containerId: string): Promise<void>;
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
  runtime?: OciContainerRuntime;
  fetchImpl?: typeof fetch;
};

export class OciImageToolPackageRunner implements ToolPackageRunner {
  readonly type = "oci-image";
  private readonly enabled: boolean;
  private readonly internalPort: number;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly runtime: OciContainerRuntime;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OciImageToolPackageRunnerOptions = {}) {
    this.enabled = options.enabled ?? process.env.TOOL_OCI_RUNNER === "enabled";
    this.internalPort = options.internalPort ?? Number(process.env.TOOL_OCI_INTERNAL_PORT ?? 8080);
    this.startupTimeoutMs = options.startupTimeoutMs ?? Number(process.env.TOOL_OCI_STARTUP_TIMEOUT_MS ?? 15_000);
    this.pollIntervalMs = options.pollIntervalMs ?? Number(process.env.TOOL_OCI_POLL_INTERVAL_MS ?? 250);
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

    let container: { containerId: string; baseUrl: string } | undefined;
    try {
      container = await this.runtime.start({
        image: ref,
        internalPort: this.internalPort,
        toolName: metadata.name,
      });
      const baseUrl = normalizeBaseUrl(container.baseUrl);
      const health = await waitForHealthyRuntime(
        this.fetchImpl,
        baseUrl,
        this.startupTimeoutMs,
        this.pollIntervalMs,
      );
      if (!health.ok) {
        await this.runtime.stop(container.containerId);
        return { loaded: false, detail: health.detail, health };
      }

      attachProcessCleanup(this.runtime, container.containerId);
      return {
        loaded: true,
        detail: `Loaded ${metadata.name} from OCI image ${ref} at ${baseUrl}`,
        tool: externalHttpProxyTool(metadata, baseUrl, this.fetchImpl),
        health,
      };
    } catch (error) {
      if (container) await bestEffortStop(this.runtime, container.containerId);
      const detail = error instanceof Error ? error.message : String(error);
      return { loaded: false, detail, health: { ok: false, detail } };
    }
  }

  describe(): ToolPackageRunnerInfo {
    return {
      name: "OCI image HTTP runner",
      type: this.type,
      status: this.enabled ? "available" : "disabled",
      detail: this.enabled
        ? `Starts OCI image packages with Docker and proxies their HTTP runtime on internal port ${this.internalPort}.`
        : "Disabled by default. Set TOOL_OCI_RUNNER=enabled to start OCI image packages through Docker.",
      supportedPackageTypes: ["oci-image"],
    };
  }
}

export class DockerCliContainerRuntime implements OciContainerRuntime {
  async start(input: { image: string; internalPort: number; toolName: string }): Promise<{ containerId: string; baseUrl: string }> {
    const { stdout: idOutput } = await execFileAsync("docker", [
      "run",
      "--rm",
      "-d",
      "--label",
      `agentic.tool=${input.toolName}`,
      "-p",
      `127.0.0.1::${input.internalPort}`,
      input.image,
    ]);
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
    await linkRootNodeModulesIfAvailable(projectRoot, packageDir);
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
  return output || detail.message || String(error);
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
      return fetchHealth(fetchImpl, baseUrl);
    },
    async run(input, context) {
      const response = await postJson(fetchImpl, `${baseUrl}/run`, {
        input,
        context: await executionContextPayload(metadata, context),
      }, context?.signal);
      return parseToolResult(response);
    },
    async startService(context) {
      await postJson(fetchImpl, `${baseUrl}/service/start`, {
        context: await serviceContextPayload(metadata, context),
      }, context.signal);
      return externalHttpServiceHandle(fetchImpl, metadata, baseUrl, context);
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
  const child = spawn(process.execPath, [options.serverFile], {
    cwd: options.packageDir,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
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
    const output = line.length > 2_000 ? `${line.slice(0, 2_000)}...` : line;
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
): ToolServiceHandle {
  return {
    async stop() {
      await postJson(fetchImpl, `${baseUrl}/service/stop`, {
        context: await serviceContextPayload(metadata, context),
      });
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
      detail: responseDetail(body) ?? `External tool runtime healthcheck failed with HTTP ${response.status}.`,
    };
  }
  if (isRecord(body) && typeof body.ok === "boolean" && typeof body.detail === "string") {
    return { ok: body.ok, detail: body.detail };
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
    throw new Error(responseDetail(parsed) ?? `External tool runtime call failed with HTTP ${response.status}.`);
  }
  return parsed;
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
  return {
    ok,
    content,
    data: value.data,
  };
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
      lastDetail = error instanceof Error ? error.message : String(error);
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
