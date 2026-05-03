import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  ToolBuildAttemptContext,
  ToolBuildOutput,
  ToolBuilder,
  ToolQaRunner,
  ToolRegistrar,
} from "./toolBuildWorkflow.js";
import {
  ToolBuildQaReport,
  ToolBuildRequest,
} from "./toolBuildRequestStore.js";
import { ToolMetadataStore } from "./toolMetadataStore.js";
import { ToolSchema } from "./tool.js";

type GeneratedFile = {
  path: string;
  content: string;
};

type ToolBuildProviderOutput = {
  modulePath: string;
  testPath: string;
  summary: string;
  displayName?: string;
  capabilities?: string[];
  inputSchema?: ToolSchema;
  outputSchema?: ToolSchema;
  requiredSecretHandles?: string[];
  docsMarkdown?: string;
  files: GeneratedFile[];
};

export type ToolBuildProvider = {
  canBuild(request: ToolBuildRequest): boolean;
  build(request: ToolBuildRequest, context?: ToolBuildAttemptContext): ToolBuildProviderOutput;
};

export class GeneratedToolFileBuilder implements ToolBuilder {
  constructor(
    private readonly providers: ToolBuildProvider[],
    private readonly projectRoot = process.cwd(),
  ) {}

  async build(request: ToolBuildRequest, context?: ToolBuildAttemptContext): Promise<ToolBuildOutput> {
    const provider = this.providers.find((item) => item.canBuild(request));
    if (!provider) {
      throw new Error(`No Tool Build provider can create capability "${request.capability}".`);
    }

    const output = provider.build(request, context);
    for (const file of output.files) {
      const absolutePath = safeProjectPath(this.projectRoot, file.path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, file.content, "utf8");
    }

    return {
      modulePath: output.modulePath,
      testPath: output.testPath,
      summary: output.summary,
      displayName: output.displayName,
      capabilities: output.capabilities,
      inputSchema: output.inputSchema,
      outputSchema: output.outputSchema,
      requiredSecretHandles: output.requiredSecretHandles,
      docsMarkdown: output.docsMarkdown,
    };
  }
}

export class IsolatedCommandToolQaRunner implements ToolQaRunner {
  constructor(private readonly projectRoot = process.cwd()) {}

  async run(request: ToolBuildRequest, output: ToolBuildOutput): Promise<ToolBuildQaReport> {
    const checks: string[] = [];
    const isolatedRoot = await createIsolatedQaWorkspace(this.projectRoot);
    try {
      const isolatedTestResult = await runCommand(
        "npx",
        ["tsx", "--test", output.testPath],
        isolatedRoot,
      );
      checks.push(formatCommandCheck("isolated targeted generated tool tests", isolatedTestResult));
      if (!isolatedTestResult.ok) {
        return {
          ok: false,
          summary: `Isolated generated tool tests failed for ${request.contract.toolName}.`,
          checks,
        };
      }

      const isolatedBuildResult = await runCommand("npm", ["run", "build"], isolatedRoot);
      checks.push(formatCommandCheck("isolated TypeScript build", isolatedBuildResult));
      if (!isolatedBuildResult.ok) {
        return {
          ok: false,
          summary: `Isolated TypeScript build failed for ${request.contract.toolName}.`,
          checks,
        };
      }
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true });
    }

    const testResult = await runCommand(
      "npx",
      ["tsx", "--test", output.testPath],
      this.projectRoot,
    );
    checks.push(formatCommandCheck("promotion targeted generated tool tests", testResult));
    if (!testResult.ok) {
      return {
        ok: false,
        summary: `Promotion generated tool tests failed for ${request.contract.toolName}.`,
        checks,
      };
    }

    const buildResult = await runCommand("npm", ["run", "build"], this.projectRoot);
    checks.push(formatCommandCheck("promotion TypeScript build", buildResult));
    if (!buildResult.ok) {
      return {
        ok: false,
        summary: `Promotion TypeScript build failed for ${request.contract.toolName}.`,
        checks,
      };
    }

    return {
      ok: true,
      summary: `Generated tool ${request.contract.toolName} passed isolated QA and promotion build.`,
      checks,
      artifacts: [output.modulePath, output.testPath],
    };
  }
}

export class CommandToolQaRunner extends IsolatedCommandToolQaRunner {}

export class MetadataToolRegistrar implements ToolRegistrar {
  constructor(private readonly metadataStore: ToolMetadataStore) {}

  async register(request: ToolBuildRequest, output: ToolBuildOutput): Promise<string> {
    const toolName = request.contract.toolName;
    const input = {
      name: toolName,
      displayName: output.displayName ?? request.displayName ?? request.contract.displayName,
      version: request.contract.version,
      description: request.contract.description,
      capabilities: output.capabilities ?? [request.capability],
      startupMode: request.contract.startupMode,
      inputSchema: output.inputSchema ?? request.contract.inputSchema,
      outputSchema: output.outputSchema ?? request.contract.outputSchema,
      modulePath: output.modulePath,
      testPath: output.testPath,
      requiredSecretHandles: output.requiredSecretHandles ?? request.credentialHandles,
      docsMarkdown: output.docsMarkdown,
    };

    if (request.replacesVersion) {
      await this.metadataStore.promoteReplacement({
        ...input,
        replacesVersion: request.replacesVersion,
      });
    } else {
      await this.metadataStore.registerGenerated(input);
    }

    return toolName;
  }
}

export class BrowserScreenshotToolBuildProvider implements ToolBuildProvider {
  canBuild(request: ToolBuildRequest): boolean {
    const text = [
      request.capability,
      request.contract.capability,
      request.contract.toolName,
      request.reason,
    ].join(" ");

    return /browser[-.\s]?screenshot|screenshot|screen[-.\s]?capture/i.test(text);
  }

  build(request: ToolBuildRequest): ToolBuildProviderOutput {
    const modulePath = request.contract.modulePath;
    const testPath = request.contract.testPath;
    const toolName = request.contract.toolName;
    const capability = request.capability;

    return {
      modulePath,
      testPath,
      summary: `Generated Playwright-based browser screenshot tool ${toolName}.`,
      displayName: request.displayName ?? request.contract.displayName,
      capabilities: [request.capability, "browser-screenshot", "artifact-generation"],
      files: [
        { path: modulePath, content: browserScreenshotToolSource(toolName, capability, request.contract.version) },
        { path: testPath, content: browserScreenshotToolTestSource(modulePath, toolName) },
      ],
    };
  }
}

export class GenericApiToolBuildProvider implements ToolBuildProvider {
  canBuild(request: ToolBuildRequest): boolean {
    const text = [
      request.capability,
      request.contract.capability,
      request.contract.toolName,
      request.reason,
      request.taskSummary,
    ].join(" ");

    return /\bapi\b|https?:\/\/|openapi|swagger|endpoint|webhook|json api/i.test(text);
  }

  build(request: ToolBuildRequest): ToolBuildProviderOutput {
    const modulePath = request.contract.modulePath;
    const testPath = request.contract.testPath;
    const toolName = request.contract.toolName;
    const capability = request.capability;
    const allowedSecretHandles = resolveApiSecretHandles(request);
    const preset = inferApiEndpointPreset(request);

    return {
      modulePath,
      testPath,
      summary: `Generated reusable HTTP JSON API adapter ${toolName}.`,
      displayName: request.displayName ?? request.contract.displayName,
      capabilities: [capability, "api-http-json", "http-api-call"],
      inputSchema: genericApiInputSchema(),
      outputSchema: genericApiOutputSchema(),
      requiredSecretHandles: allowedSecretHandles,
      docsMarkdown: genericApiDocsMarkdown(capability, allowedSecretHandles, preset),
      files: [
        { path: modulePath, content: genericApiToolSource(toolName, capability, allowedSecretHandles, preset, request.contract.version) },
        { path: testPath, content: genericApiToolTestSource(modulePath, toolName, capability, allowedSecretHandles, preset) },
      ],
    };
  }
}

type ApiEndpointPreset = {
  provider: "glprotocol";
  defaultAuthHeaderName: string;
  defaultAuthScheme: string;
  networkTickers: Record<string, string>;
};

function resolveApiSecretHandles(request: ToolBuildRequest): string[] {
  if (request.credentialHandles?.length) return request.credentialHandles;
  if (!request.credentialNotes?.trim()) return [];
  return [secretHandleFromCapability(request.capability)];
}

function secretHandleFromCapability(capability: string): string {
  const slug = capability
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, ".")
    .replace(/^[^a-z]+/, "")
    .replace(/[.:-]+$/g, "")
    .slice(0, 96) || "generated.tool";
  return `secret.${slug}`;
}

function inferApiEndpointPreset(request: ToolBuildRequest): ApiEndpointPreset | undefined {
  const text = [
    request.capability,
    request.displayName,
    request.reason,
    request.taskSummary,
  ].join(" ");
  if (!/glprotocol\.com|global\s+ledger|gl\s+aml|глобал\s+леджер/i.test(text)) return undefined;

  return {
    provider: "glprotocol",
    defaultAuthHeaderName: "x-api-key",
    defaultAuthScheme: "",
    networkTickers: {
      bitcoin: "btc",
      btc: "btc",
      litecoin: "ltc",
      ltc: "ltc",
      ethereum: "eth",
      ether: "eth",
      eth: "eth",
      эфир: "eth",
      эфира: "eth",
      tron: "tron",
      trx: "tron",
      bnb: "bnb",
      bsc: "bnb",
      avalanche: "avax",
      avax: "avax",
    },
  };
}

type CommandResult = {
  ok: boolean;
  exitCode: number | null;
  output: string;
};

function safeProjectPath(projectRoot: string, filePath: string): string {
  if (filePath.includes("..") || filePath.startsWith("/") || filePath.includes("\\")) {
    throw new Error(`Generated file path must be project-relative: ${filePath}`);
  }

  const absolutePath = resolve(projectRoot, filePath);
  const relativePath = relative(resolve(projectRoot), absolutePath);
  if (relativePath.startsWith("..") || relativePath === "") {
    throw new Error(`Generated file path escapes project root: ${filePath}`);
  }

  return absolutePath;
}

async function createIsolatedQaWorkspace(projectRoot: string): Promise<string> {
  const isolatedRoot = await mkdtemp(resolve(tmpdir(), "agentic-tool-qa-"));
  const entries = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.test.json",
  ];

  for (const entry of entries) {
    await cp(resolve(projectRoot, entry), resolve(isolatedRoot, entry));
  }
  await cp(resolve(projectRoot, "src"), resolve(isolatedRoot, "src"), { recursive: true });
  await cp(resolve(projectRoot, "tests"), resolve(isolatedRoot, "tests"), { recursive: true });

  const nodeModules = resolve(projectRoot, "node_modules");
  if (existsSync(nodeModules)) {
    await symlink(nodeModules, resolve(isolatedRoot, "node_modules"), "dir");
  }

  return isolatedRoot;
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: { ...process.env },
    });
    const chunks: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ ok: false, exitCode: null, output: `Command timed out after ${timeoutMs} ms.` });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, exitCode: null, output: error.message });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const output = Buffer.concat(chunks).toString("utf8").slice(-6000);
      resolve({ ok: exitCode === 0, exitCode, output });
    });
  });
}

function formatCommandCheck(label: string, result: CommandResult): string {
  const status = result.ok ? "passed" : "failed";
  const output = result.output.trim().replace(/\s+/g, " ").slice(0, 500);
  return `${label} ${status} with exit ${result.exitCode ?? "none"}${output ? `: ${output}` : ""}`;
}

function genericApiDocsMarkdown(
  capability: string,
  allowedSecretHandles: string[],
  preset?: ApiEndpointPreset,
): string {
  const secretText = allowedSecretHandles.length
    ? `Declared secret handles: ${allowedSecretHandles.map((handle) => `\`${handle}\``).join(", ")}.`
    : "No secret handles were declared at build time; runtime calls must be unauthenticated.";
  const presetText = preset?.provider === "glprotocol"
    ? [
        "",
        "Global Ledger preset:",
        "- address risk: `network` + `address`",
        "- transaction risk: `network` + `transactionHash`",
        "- auth header: `x-api-key` from the declared secret handle",
        "- supported networks map to Global Ledger tickers such as `ethereum -> eth`.",
      ].join("\n")
    : "";

  return [
    `# ${capability}`,
    "",
    "Generated reusable HTTP JSON API adapter.",
    "",
    secretText,
    "",
    "Use this tool for documented HTTPS APIs where the agent can provide endpoint, method, query/body, and an optional declared credential handle.",
    "Do not paste raw credentials into tool inputs; store them as secret handles first.",
    presetText,
  ].join("\n");
}

function genericApiInputSchema(): ToolSchema {
  return {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1 },
      baseUrl: { type: "string", minLength: 1 },
      operation: { type: "string" },
      network: { type: "string" },
      address: { type: "string" },
      transactionHash: { type: "string" },
      token: { type: "string" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      query: { type: "object" },
      headers: { type: "object" },
      body: {},
      secretHandle: { type: "string" },
      authHeaderName: { type: "string" },
      authScheme: { type: "string" },
      timeoutMs: { type: "number" },
    },
  };
}

function genericApiOutputSchema(): ToolSchema {
  return {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: {
        type: "object",
        properties: {
          status: { type: "number" },
          url: { type: "string" },
          method: { type: "string" },
          provider: { type: "string" },
          score: {},
          sources: {},
          json: {},
          text: { type: "string" },
        },
      },
    },
    required: ["ok", "content"],
  };
}

function genericApiToolSource(
  toolName: string,
  capability: string,
  allowedSecretHandles: string[],
  preset?: ApiEndpointPreset,
  version = "1.0.0",
): string {
  return `import { Tool, ToolExecutionContext, ToolInput, ToolResult } from "../tool.js";

type JsonRecord = Record<string, unknown>;

const allowedSecretHandles: string[] = ${JSON.stringify(allowedSecretHandles)};
const apiPreset = ${JSON.stringify(preset ?? null)} as null | {
  provider: "glprotocol";
  defaultAuthHeaderName: string;
  defaultAuthScheme: string;
  networkTickers: Record<string, string>;
};

export const tool: Tool = {
  name: ${JSON.stringify(toolName)},
  version: ${JSON.stringify(version)},
  description: "Calls a documented HTTPS JSON API endpoint with structured input and optional declared secret-handle authentication.",
  capabilities: [${JSON.stringify(capability)}, "api-http-json", "http-api-call"],
  startupMode: "on-demand",
  requiredSecretHandles: allowedSecretHandles,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1 },
      baseUrl: { type: "string", minLength: 1 },
      operation: { type: "string" },
      network: { type: "string" },
      address: { type: "string" },
      transactionHash: { type: "string" },
      token: { type: "string" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      query: { type: "object" },
      headers: { type: "object" },
      body: {},
      secretHandle: { type: "string" },
      authHeaderName: { type: "string" },
      authScheme: { type: "string" },
      timeoutMs: { type: "number" }
    }
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: {
        type: "object",
        properties: {
          status: { type: "number" },
          url: { type: "string" },
          method: { type: "string" },
          provider: { type: "string" },
          score: {},
          sources: {},
          json: {},
          text: { type: "string" }
        }
      }
    },
    required: ["ok", "content"]
  },
  async healthcheck() {
    return { ok: true, detail: "Generic API adapter module is importable; runtime calls require a documented endpoint." };
  },
  async run(input: ToolInput, context?: ToolExecutionContext): Promise<ToolResult> {
    const parsedUrl = buildRequestUrl(input);
    if (!parsedUrl.ok) return { ok: false, content: parsedUrl.error };

    const method = normalizeMethod(input.method);
    const headersResult = await buildHeaders(input, context);
    if (!headersResult.ok) return { ok: false, content: headersResult.error };

    const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
      ? Math.max(100, Math.min(input.timeoutMs, 30000))
      : 15000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (context?.signal) {
      context.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      const init: RequestInit = {
        method,
        headers: headersResult.headers,
        signal: controller.signal
      };
      if (method !== "GET" && method !== "HEAD" && input.body !== undefined) {
        init.body = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
        if (!headersResult.hasContentType) headersResult.headers.set("content-type", "application/json");
      }

      const response = await fetch(parsedUrl.url, init);
      const text = await response.text();
      const json = parseJson(text);
      const score = extractScore(json);
      const sources = extractSources(json);
      const data = {
        status: response.status,
        url: parsedUrl.url,
        method,
        provider: apiPreset?.provider,
        score,
        sources,
        json,
        text: json === undefined ? text : undefined
      };
      const content = response.ok
        ? "API call succeeded with HTTP " + response.status + (score === undefined ? "." : "; score: " + String(score) + ".") + (sources.length === 0 ? "" : " Sources: " + sources.map((source) => source.name + (source.share === undefined ? "" : " (" + source.share + "%)")).join(", ") + ".")
        : "API call failed with HTTP " + response.status + ".";

      return { ok: response.ok, content, data };
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? "API call failed: " + error.message : "API call failed."
      };
    } finally {
      clearTimeout(timeout);
    }
  }
};

export default tool;

function normalizeMethod(value: unknown): string {
  const method = typeof value === "string" ? value.toUpperCase() : "GET";
  return ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ? method : "GET";
}

function buildRequestUrl(input: ToolInput): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof input.url === "string" && input.url.trim()) {
    return buildUrl(input.url, input.query);
  }
  if (apiPreset?.provider !== "glprotocol") {
    return { ok: false, error: "api-http-json requires a url input unless this generated tool has an API preset." };
  }

  const ticker = normalizeNetwork(input.network);
  if (!ticker) {
    return { ok: false, error: "Global Ledger calls require a supported network such as ethereum, bitcoin, tron, bnb, or avax." };
  }

  const query: JsonRecord = isRecord(input.query) ? { ...input.query } : {};
  if (typeof input.token === "string" && input.token.trim()) {
    query.token = input.token.trim();
  }

  const baseUrl = typeof input.baseUrl === "string" && input.baseUrl.trim()
    ? input.baseUrl.trim().replace(/\\/+$/g, "")
    : "https://" + ticker + ".glprotocol.com";

  if (typeof input.transactionHash === "string" && input.transactionHash.trim()) {
    return buildUrl(baseUrl + "/api/report/tx_hash/" + encodeURIComponent(input.transactionHash.trim()), query);
  }
  if (typeof input.address === "string" && input.address.trim()) {
    return buildUrl(baseUrl + "/api/report/address/" + encodeURIComponent(input.address.trim()), query);
  }
  return { ok: false, error: "Global Ledger calls require address or transactionHash input." };
}

function normalizeNetwork(value: unknown): string | undefined {
  if (!apiPreset || typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase();
  return apiPreset.networkTickers[key];
}

function buildUrl(value: unknown, query: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: "api-http-json requires a url input." };
  }

  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      return { ok: false, error: "Only https URLs are supported, except localhost for QA smoke tests." };
    }
    if (query && typeof query === "object" && !Array.isArray(query)) {
      for (const [key, raw] of Object.entries(query as JsonRecord)) {
        if (raw === undefined || raw === null) continue;
        parsed.searchParams.set(key, String(raw));
      }
    }
    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false, error: "Invalid API URL." };
  }
}

async function buildHeaders(
  input: ToolInput,
  context?: ToolExecutionContext,
): Promise<{ ok: true; headers: Headers; hasContentType: boolean } | { ok: false; error: string }> {
  const headers = new Headers();
  headers.set("accept", "application/json");
  let hasContentType = false;

  if (input.headers && typeof input.headers === "object" && !Array.isArray(input.headers)) {
    for (const [key, value] of Object.entries(input.headers as JsonRecord)) {
      if (value === undefined || value === null) continue;
      if (/authorization|api[-_]?key|token|secret/i.test(key)) {
        return { ok: false, error: "Raw credential headers are not accepted; use a declared secretHandle." };
      }
      headers.set(key, String(value));
      if (key.toLowerCase() === "content-type") hasContentType = true;
    }
  }

  const requestedHandle = typeof input.secretHandle === "string" && input.secretHandle.trim()
    ? input.secretHandle.trim()
    : allowedSecretHandles[0];
  if (requestedHandle) {
    const handle = requestedHandle;
    if (!allowedSecretHandles.includes(handle)) {
      return { ok: false, error: "Secret handle " + handle + " was not declared in the Tool Build request." };
    }
    if (!context?.resolveSecret) {
      return { ok: false, error: "No secret resolver is configured for credentialed API calls." };
    }
    const secret = await context.resolveSecret(handle);
    if (!secret) return { ok: false, error: "Secret handle " + handle + " could not be resolved." };
    const authHeaderName = typeof input.authHeaderName === "string" && input.authHeaderName.trim()
      ? input.authHeaderName.trim()
      : apiPreset?.defaultAuthHeaderName ?? "authorization";
    const authScheme = typeof input.authScheme === "string" ? input.authScheme.trim() : apiPreset?.defaultAuthScheme ?? "Bearer";
    headers.set(authHeaderName, authScheme ? authScheme + " " + secret : secret);
  }

  return { ok: true, headers, hasContentType };
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractScore(value: unknown): unknown {
  if (!isRecord(value) && !Array.isArray(value)) return undefined;
  if (apiPreset?.provider === "glprotocol" && isRecord(value) && value.totalFunds !== undefined) return value.totalFunds;
  if (isRecord(value) && value.score !== undefined) return value.score;

  const scores: unknown[] = [];
  collectNestedScores(value, scores);
  if (scores.length === 0) return undefined;

  const numericScores = scores
    .map((score) => typeof score === "number" ? score : typeof score === "string" ? Number(score) : Number.NaN)
    .filter((score) => Number.isFinite(score));
  if (numericScores.length > 0) return Math.max(...numericScores);
  if (scores.length === 1) return scores[0];
  return scores.slice(0, 10);
}

function collectNestedScores(value: unknown, scores: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNestedScores(item, scores);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (key.toLowerCase() === "score" && nested !== undefined && nested !== null) {
      scores.push(nested);
      continue;
    }
    collectNestedScores(nested, scores);
  }
}

function extractSources(value: unknown): Array<{ name: string; share?: number; score?: unknown }> {
  if (!isRecord(value) || !Array.isArray(value.sources)) return [];
  const byName = new Map<string, { name: string; share?: number; score?: unknown }>();
  for (const item of value.sources) {
    if (!isRecord(item)) continue;
    const funds = isRecord(item.funds) ? item.funds : {};
    const rawName = typeof item.name === "string"
      ? item.name
      : typeof funds.name === "string"
        ? funds.name
        : typeof item.type === "string"
          ? item.type
          : typeof item.listType === "string"
            ? item.listType
            : undefined;
    if (!rawName?.trim()) continue;
    const name = rawName.trim();
    const existing = byName.get(name);
    const share = normalizeShare(item.share ?? funds.share);
    const score = funds.score ?? item.score;
    const bestShare = share === undefined
      ? existing?.share
      : Math.max(existing?.share ?? 0, share);
    byName.set(name, {
      name,
      share: bestShare,
      score: existing?.score ?? score,
    });
  }
  return [...byName.values()].sort((a, b) => (b.share ?? 0) - (a.share ?? 0));
}

function numericValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeShare(value: unknown): number | undefined {
  const parsed = numericValue(value);
  if (parsed === undefined) return undefined;
  return parsed > 0 && parsed <= 1 ? parsed * 100 : parsed;
}
`;
}

function genericApiToolTestSource(
  modulePath: string,
  toolName: string,
  capability: string,
  allowedSecretHandles: string[],
  preset?: ApiEndpointPreset,
): string {
  const importPath = relative("tests/generated", modulePath).replace(/\\/g, "/").replace(/\.ts$/, ".js");
  const secretHandle = allowedSecretHandles[0];
  const sampleAddress = "0x9B43b2F8aa3217F3F3947C750d58A50ac24aFfD2";
  const isGlPreset = preset?.provider === "glprotocol";
  const runInput = isGlPreset
    ? `{
        baseUrl: "http://127.0.0.1:" + address.port,
        network: "ethereum",
        address: ${JSON.stringify(sampleAddress)}
      }`
    : `{
        url: "http://127.0.0.1:" + address.port + "/score",
        query: { address: ${JSON.stringify(sampleAddress)} }${secretHandle ? `,\n        secretHandle: ${JSON.stringify(secretHandle)}` : ""}
      }`;
  const expectedPath = isGlPreset
    ? `/api/report/address/${sampleAddress}`
    : "/score";
  const expectedAuth = secretHandle
    ? (isGlPreset ? "test-token" : "Bearer test-token")
    : null;
  const responseJson = isGlPreset
    ? `{
      path: url.pathname,
      totalFunds: 62,
      sources: [
        { funds: { name: "low-risk-source", score: 30 }, share: 0.25 },
        { funds: { name: "highest-risk-source", score: 60 }, share: 0.75 }
      ],
      auth: request.headers.authorization ?? request.headers["x-api-key"] ?? null
    }`
    : `{
      path: url.pathname,
      address: url.searchParams.get("address"),
      score: 42,
      auth: request.headers.authorization ?? request.headers["x-api-key"] ?? null
    }`;
  const expectedScore = isGlPreset ? 62 : 42;

  return `import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { tool } from "${importPath.startsWith(".") ? importPath : `./${importPath}`}";

test("${toolName} exposes a valid generated API tool contract", async () => {
  const health = await tool.healthcheck?.();

  assert.equal(tool.name, ${JSON.stringify(toolName)});
  assert.ok(tool.capabilities.includes(${JSON.stringify(capability)}));
  assert.ok(tool.capabilities.includes("api-http-json"));
  assert.equal(health?.ok, true);
});

test("${toolName} rejects invalid and unsafe inputs", async () => {
  const invalid = await tool.run({ url: "notaurl" });
  const unsafeHeader = await tool.run({
    url: "https://example.com/api",
    headers: { Authorization: "raw-secret" }
  });

  assert.equal(invalid.ok, false);
  assert.match(invalid.content, /Invalid API URL/);
  assert.equal(unsafeHeader.ok, false);
  assert.match(unsafeHeader.content, /Raw credential headers/);
});

test("${toolName} calls a JSON API endpoint with query and declared secret handles", async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(${responseJson}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    const result = await tool.run(
      ${runInput},
      {
        toolName: tool.name,
        now: new Date("2026-05-03T00:00:00.000Z"),
        resolveSecret: async (handle) => handle === ${JSON.stringify(secretHandle)} ? "test-token" : undefined
      }
    );
    const data = result.data as { score?: unknown; sources?: Array<{ name: string; share?: number }>; json?: { path?: string; address?: string | null; auth?: string | null; score?: number } } | undefined;

    assert.equal(result.ok, true);
    assert.equal(data?.json?.path, ${JSON.stringify(expectedPath)});
    ${isGlPreset ? "" : `assert.equal(data?.json?.address, ${JSON.stringify(sampleAddress)});`}
    ${isGlPreset ? "" : `assert.equal(data?.json?.score, ${expectedScore});`}
    assert.equal(data?.score, ${expectedScore});
    assert.match(result.content, /score: ${expectedScore}/);
    ${isGlPreset ? `assert.deepEqual(data?.sources?.map((source) => [source.name, source.share]), [["highest-risk-source", 75], ["low-risk-source", 25]]);` : ""}
    assert.equal(data?.json?.auth ?? null, ${JSON.stringify(expectedAuth)});
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
`;
}

function browserScreenshotToolSource(toolName: string, capability: string, version = "1.0.0"): string {
  return `import { chromium } from "@playwright/test";
import { Tool, ToolInput, ToolResult } from "../tool.js";

type ScreenshotData = {
  artifact: {
    filename: string;
    mimeType: "image/png";
    contentBase64: string;
    description: string;
  };
  url: string;
};

export const tool: Tool = {
  name: ${JSON.stringify(toolName)},
  version: ${JSON.stringify(version)},
  description: "Captures a browser screenshot and returns it as an artifact payload.",
  capabilities: [${JSON.stringify(capability)}, "browser-screenshot", "artifact-generation"],
  startupMode: "on-demand",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1 },
      filename: { type: "string" },
      fullPage: { type: "boolean" }
    },
    required: ["url"]
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: { type: "object", properties: { artifact: { type: "object" }, url: { type: "string" } } }
    },
    required: ["ok", "content"]
  },
  async healthcheck() {
    return { ok: true, detail: "Browser screenshot tool module is importable." };
  },
  async run(input: ToolInput): Promise<ToolResult> {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!url) return { ok: false, content: "browser screenshot requires a url input." };

    const parsed = parseHttpUrl(url);
    if (!parsed.ok) return { ok: false, content: parsed.error };

    const filename = typeof input.filename === "string" && input.filename.trim()
      ? safeFilename(input.filename)
      : screenshotFilename(parsed.url);
    const fullPage = typeof input.fullPage === "boolean" ? input.fullPage : true;
    const launchOptions = process.env.CHROMIUM_PATH
      ? { headless: true, executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] }
      : { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] };

    let browser;
    try {
      browser = await chromium.launch(launchOptions);
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto(parsed.url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(1000);
      const buffer = await page.screenshot({ type: "png", fullPage });
      const data: ScreenshotData = {
        artifact: {
          filename,
          mimeType: "image/png",
          contentBase64: buffer.toString("base64"),
          description: "Browser screenshot captured from " + parsed.url
        },
        url: parsed.url
      };

      return {
        ok: true,
        content: "Captured browser screenshot for " + parsed.url + ".",
        data
      };
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : "Browser screenshot failed."
      };
    } finally {
      await browser?.close();
    }
  }
};

export default tool;

function parseHttpUrl(value: string): { ok: true; url: string } | { ok: false; error: string } {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "Only http and https URLs are supported." };
    }
    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false, error: "Invalid URL." };
  }
}

function screenshotFilename(url: string): string {
  const parsed = new URL(url);
  const slug = [parsed.hostname, parsed.pathname]
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return (slug || "browser-page") + "-screenshot.png";
}

function safeFilename(value: string): string {
  const trimmed = value.trim().replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120);
  return trimmed.endsWith(".png") ? trimmed : trimmed + ".png";
}
`;
}

function browserScreenshotToolTestSource(modulePath: string, toolName: string): string {
  const importPath = relative("tests/generated", modulePath).replace(/\\/g, "/").replace(/\.ts$/, ".js");

  return `import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { tool } from "${importPath.startsWith(".") ? importPath : `./${importPath}`}";

test("${toolName} exposes a valid generated tool contract", async () => {
  const health = await tool.healthcheck?.();

  assert.equal(tool.name, ${JSON.stringify(toolName)});
  assert.ok(tool.capabilities.includes("browser-screenshot"));
  assert.equal(health?.ok, true);
});

test("${toolName} rejects invalid URLs without launching a browser", async () => {
  const result = await tool.run({ url: "notaurl" });

  assert.equal(result.ok, false);
  assert.match(result.content, /Invalid URL/);
});

test("${toolName} captures a local page screenshot artifact", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>smoke</title><main style='font: 24px sans-serif'>Browser screenshot smoke</main>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    const result = await tool.run({
      url: "http://127.0.0.1:" + address.port + "/",
      filename: "smoke.png",
      fullPage: false
    });
    const data = result.data as { artifact?: { contentBase64?: string; mimeType?: string } } | undefined;

    assert.equal(result.ok, true);
    assert.equal(data?.artifact?.mimeType, "image/png");
    assert.ok(Buffer.from(data?.artifact?.contentBase64 ?? "", "base64").byteLength > 1000);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
`;
}
