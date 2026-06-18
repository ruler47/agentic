import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import type { Tool, ToolExecutionContext, ToolHealth, ToolResult, ToolServiceContext, ToolServiceHandle } from "./tool.js";
import type { ToolModuleMetadata } from "./toolMetadataStore.js";
import { MissingToolRuntimeRequirementsError } from "./toolPackageRunnerTypes.js";
import { isRecord, redactRuntimeText } from "./toolPackageRunnerShared.js";

export function externalHttpProxyTool(
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

export function sourceBundleHttpProcessTool(
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
  const env = sourceBundleHttpProcessEnv(options.packageDir, port);
  const child = spawn(process.execPath, [options.serverFile], {
    cwd: options.packageDir,
    env,
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

function sourceBundleHttpProcessEnv(packageDir: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    // Puppeteer-based packages should keep browser cache inside the portable
    // package workspace unless the operator overrides it explicitly.
    PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR ?? `${packageDir}/node_modules/.puppeteer-cache`,
  };

  const playwrightBrowsersPath =
    process.env.TOOL_SOURCE_BUNDLE_PLAYWRIGHT_BROWSERS_PATH ?? process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (playwrightBrowsersPath !== undefined) {
    env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath;
  }

  return env;
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

export async function fetchHealth(fetchImpl: typeof fetch, baseUrl: string, signal?: AbortSignal): Promise<ToolHealth> {
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

function responseDetail(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!isRecord(value)) return undefined;
  if (typeof value.detail === "string") return value.detail;
  if (typeof value.error === "string") return value.error;
  if (typeof value.message === "string") return value.message;
  if (typeof value.content === "string") return value.content;
  return undefined;
}

export async function postJson(
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

export async function withOptionalTimeoutSignal<T>(
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

export async function waitForHealthyRuntime(
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

export function parseToolResult(value: unknown): ToolResult {
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

export async function executionContextPayload(
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

export async function serviceContextPayload(
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
    throw new MissingToolRuntimeRequirementsError(
      missingConfiguration.filter((value): value is string => typeof value === "string"),
      missingSecrets.filter((value): value is string => typeof value === "string"),
    );
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

export function attachProcessCleanup(
  runtime: { stop(containerId: string): Promise<void> },
  containerId: string,
): void {
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

export async function bestEffortStop(
  runtime: { stop(containerId: string): Promise<void> },
  containerId: string,
): Promise<void> {
  try {
    await runtime.stop(containerId);
  } catch {
    // Best-effort cleanup only; failed stop should not mask the original load failure.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
