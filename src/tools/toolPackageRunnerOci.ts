import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "./tool.js";
import type { ToolModuleMetadata } from "./toolMetadataStore.js";
import type { ToolPackageLoadResult, ToolPackageRunner, ToolPackageRunnerInfo } from "./toolPackageRunnerTypes.js";
import {
  attachProcessCleanup,
  bestEffortStop,
  executionContextPayload,
  fetchHealth,
  parseToolResult,
  postJson,
  serviceContextPayload,
  waitForHealthyRuntime,
  withOptionalTimeoutSignal,
} from "./toolPackageRunnerHttpRuntime.js";
import { commandErrorDetail, normalizeBaseUrl, redactRuntimeText } from "./toolPackageRunnerShared.js";

const execFileAsync = promisify(execFile);

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

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
