import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
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

  constructor(packageRoot: string | string[] = defaultSourceBundleRoots()) {
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

    const candidates = this.packageRoots.map((root) => {
      const packageDir = safePackagePath(resolve(projectRoot, root), ref);
      return {
        packageDir,
        moduleFile: firstExisting([
          join(packageDir, "dist/index.js"),
          join(packageDir, "index.js"),
        ]),
      };
    });
    const found = candidates.find((candidate) => candidate.moduleFile);
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
      type: this.type,
      status: "available",
      detail: "Loads pre-built source-bundle packages from the tool package workspace. It does not install dependencies or execute build commands.",
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
  resolveConfiguration: ((key: string) => Promise<string | undefined>) | undefined,
): Promise<Record<string, unknown>> {
  const requestedKeys = [...new Set(keys ?? [])];
  if (!requestedKeys.length) return {};
  if (!resolveConfiguration) {
    return { configurationKeys: requestedKeys, missingConfigurationKeys: requestedKeys };
  }

  const configuration: Record<string, string> = {};
  const missingConfigurationKeys: string[] = [];
  for (const key of requestedKeys) {
    const value = await resolveConfiguration(key);
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
