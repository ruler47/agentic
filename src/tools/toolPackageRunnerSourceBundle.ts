import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolModuleMetadata } from "./toolMetadataStore.js";
import type { ToolPackageLoadResult, ToolPackageRunner, ToolPackageRunnerInfo } from "./toolPackageRunnerTypes.js";
import { sourceBundleHttpProcessTool } from "./toolPackageRunnerHttpRuntime.js";
import {
  buildSourceBundlePackage,
  compiledModulePath,
  defaultSourceBundleRoots,
  exportedTool,
  findSourceBundlePackage,
  sourceBundleAutoBuildEnabled,
  validateToolAgainstMetadata,
} from "./toolPackageRunnerShared.js";

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

