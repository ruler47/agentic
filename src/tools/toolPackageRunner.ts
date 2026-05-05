import { existsSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Tool, ToolExecutionContext, ToolHealth, ToolResult, ToolServiceContext, ToolServiceHandle } from "./tool.js";
import { ToolModuleMetadata } from "./toolMetadataStore.js";
import { ToolPackageReferenceType } from "./toolPackage.js";

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
  type: ToolPackageRunner["type"];
  status: "available" | "disabled";
  detail: string;
  supportedPackageTypes: ToolPackageReferenceType[];
  root?: string;
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
      type: this.type,
      status: "available",
      detail: "Loads compiled local-path TypeScript modules from the application dist directory.",
      supportedPackageTypes: ["local-path"],
    };
  }
}

export class SourceBundleToolPackageRunner implements ToolPackageRunner {
  readonly type = "source-bundle";

  constructor(private readonly packageRoot = process.env.TOOL_PACKAGE_ROOT ?? "tool-packages") {}

  canLoad(metadata: ToolModuleMetadata): boolean {
    return metadata.packageManifest?.package.type === "source-bundle";
  }

  async load(metadata: ToolModuleMetadata, projectRoot: string): Promise<ToolPackageLoadResult> {
    const ref = metadata.packageManifest?.package.ref;
    if (!ref) {
      const detail = "Source-bundle package manifest has no package.ref.";
      return { loaded: false, detail, health: { ok: false, detail } };
    }

    const packageDir = safePackagePath(resolve(projectRoot, this.packageRoot), ref);
    const moduleFile = firstExisting([
      join(packageDir, "dist/index.js"),
      join(packageDir, "index.js"),
    ]);
    if (!moduleFile) {
      const detail = `Source-bundle package has no loadable dist/index.js or index.js: ${packageDir}`;
      return { loaded: false, detail, health: { ok: false, detail } };
    }

    const imported = await import(pathToFileURL(moduleFile).href);
    const tool = exportedTool(imported);
    validateToolAgainstMetadata(tool, metadata);
    const health = tool.healthcheck ? await tool.healthcheck() : { ok: true, detail: "No healthcheck registered." };

    if (!health.ok) {
      return { loaded: false, detail: health.detail, health };
    }

    return { loaded: true, detail: `Loaded ${metadata.name} from source bundle ${moduleFile}`, tool, health };
  }

  describe(): ToolPackageRunnerInfo {
    return {
      type: this.type,
      status: "available",
      detail: "Loads pre-built source-bundle packages from TOOL_PACKAGE_ROOT. It does not install dependencies or execute build commands.",
      supportedPackageTypes: ["source-bundle"],
      root: this.packageRoot,
    };
  }
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
      type: this.type,
      status: "available",
      detail: "Loads external-package manifests whose package.ref is an HTTP(S) tool-runtime endpoint exposing /health, /run, and optional /service lifecycle routes.",
      supportedPackageTypes: ["external-package"],
    };
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
        context: executionContextPayload(context),
      }, context?.signal);
      return parseToolResult(response);
    },
    async startService(context) {
      await postJson(fetchImpl, `${baseUrl}/service/start`, {
        context: serviceContextPayload(context),
      }, context.signal);
      return externalHttpServiceHandle(fetchImpl, baseUrl, context);
    },
  };
}

function externalHttpServiceHandle(
  fetchImpl: typeof fetch,
  baseUrl: string,
  context: ToolServiceContext,
): ToolServiceHandle {
  return {
    async stop() {
      await postJson(fetchImpl, `${baseUrl}/service/stop`, {
        context: serviceContextPayload(context),
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

function executionContextPayload(context: ToolExecutionContext | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
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
  });
}

function serviceContextPayload(context: ToolServiceContext): Record<string, unknown> {
  return compactRecord({
    toolName: context.toolName,
    now: context.now.toISOString(),
    baseUrl: context.baseUrl,
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
