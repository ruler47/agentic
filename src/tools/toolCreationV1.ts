import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolPackageWorkspaceStore, type ToolPackageWorkspaceRecord } from "./toolPackageWorkspaceStore.js";
import {
  validateAndBuildToolPackageWorkspace,
  type ToolPackageBehaviorExample,
  type ToolPackageWorkspaceQaReport,
} from "./toolPackageWorkspaceQa.js";
import type { ToolPackageManifest } from "./toolPackage.js";
import { renderPackageFiles, renderReadme, runtimeDockerfile, runtimePackageJson } from "./toolCreationV1PackageFiles.js";
import type { ToolAdapterContract } from "./toolCreationStore.js";
import { normalizeToolIntegrationContract, type ToolIntegrationContract } from "./toolIntegrationContract.js";
import type { ToolSchema, ToolStartupMode } from "./tool.js";
import { generatedToolInputFromPackageManifest, type GeneratedToolModuleInput } from "./toolMetadataStore.js";

export type ToolCreationV1Kind = "echo" | "http-json" | "npm-default-function" | "browser-screenshot" | "browser-operate" | "web-search" | "web-read" | "service-adapter" | "external-action-prepare" | "external-action-commit";

export type ToolCreationV1Input = {
  name: string;
  displayName?: string;
  version?: string;
  description?: string;
  request?: string;
  kind?: ToolCreationV1Kind;
  capabilities?: string[];
  dependencies?: Record<string, string>;
  adapterPackageName?: string;
  adapterContract?: ToolAdapterContract;
  startupMode?: ToolStartupMode;
  requiredSecretHandles?: string[];
  requiredConfigurationKeys?: string[];
  settingsSchema?: ToolSchema;
  integrationContract?: ToolIntegrationContract;
  behaviorExamples?: ToolPackageBehaviorExample[];
};

export type ToolCreationV1AuthoredPackageInput = {
  readmeMarkdown?: string;
  dockerfile?: string;
  behaviorExamples?: ToolPackageBehaviorExample[];
  files: Array<{ path: string; content: string }>;
};

export type ToolCreationV1Result = {
  input: Required<Pick<ToolCreationV1Input, "name" | "version" | "description" | "kind">> & {
    displayName?: string;
    request?: string;
    capabilities: string[];
    dependencies: Record<string, string>;
    adapterPackageName?: string;
    adapterContract?: ToolAdapterContract;
    startupMode: ToolStartupMode;
    requiredSecretHandles: string[];
    requiredConfigurationKeys: string[];
    settingsSchema?: ToolSchema;
    integrationContract?: ToolIntegrationContract;
    behaviorExamples: ToolPackageBehaviorExample[];
  };
  workspace: ToolPackageWorkspaceRecord;
  qa: ToolPackageWorkspaceQaReport;
  generatedInput: GeneratedToolModuleInput;
};

export async function createToolPackageV1(
  rawInput: unknown,
  options: {
    projectRoot?: string;
    workspaceRoot?: string;
    linkNodeModulesFrom?: string;
    timeoutMs?: number;
    runBuild?: boolean;
    runTests?: boolean;
    authoredPackage?: ToolCreationV1AuthoredPackageInput;
    qaRepairAttempts?: number;
  } = {},
): Promise<ToolCreationV1Result> {
  let input = normalizeToolCreationV1Input(rawInput);
  let authoredPackage = options.authoredPackage;
  const maxAttempts = Math.max(1, Math.min(3, (options.qaRepairAttempts ?? 0) + 1));
  const repairChecks: string[] = [];
  const sourceLabel = toolCreationSourceLabel(rawInput);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await createToolPackageV1Attempt(input, options, authoredPackage, repairChecks, sourceLabel);
    if (result.qa.ok) return result;
    const repaired = repairToolCreationInputAfterQaFailure(input, result.qa, attempt);
    if (!repaired || attempt >= maxAttempts) return result;
    repairChecks.push(
      `package QA repair scheduled: attempt ${attempt + 1}/${maxAttempts} after ${result.qa.summary}`,
    );
    input = repaired;
    authoredPackage = undefined;
  }
  throw new Error("unreachable tool package creation repair loop state");
}

async function createToolPackageV1Attempt(
  input: ToolCreationV1Result["input"],
  options: {
    projectRoot?: string;
    workspaceRoot?: string;
    linkNodeModulesFrom?: string;
    timeoutMs?: number;
    runBuild?: boolean;
    runTests?: boolean;
  },
  authoredPackage: ToolCreationV1AuthoredPackageInput | undefined,
  repairChecks: string[],
  sourceLabel: "agent" | "operator",
): Promise<ToolCreationV1Result> {
  const manifest = buildManifest(input);
  const store = new ToolPackageWorkspaceStore(options.projectRoot ?? process.cwd(), options.workspaceRoot);
  const workspace = await store.writeSourceBundlePackage({
    manifest,
    readmeMarkdown: authoredPackage?.readmeMarkdown ?? renderReadme(input, manifest),
    dockerfile: authoredPackage?.dockerfile ?? runtimeDockerfile(input),
    packageJson: runtimePackageJson(input, manifest),
    files: authoredPackage?.files ?? renderPackageFiles(input, manifest),
  });
  const qa = await validateAndBuildToolPackageWorkspace(
    options.projectRoot ?? process.cwd(),
    {
      packageRef: workspace.packageRef,
      manifestPath: workspace.manifestPath,
      files: workspace.files,
    },
    {
      linkNodeModulesFrom: options.linkNodeModulesFrom ?? options.projectRoot ?? process.cwd(),
      timeoutMs: options.timeoutMs,
      runBuild: options.runBuild,
      runTests: options.runTests,
      behaviorExamples: input.behaviorExamples,
    },
  );
  if (repairChecks.length > 0) {
    qa.checks = [...repairChecks, ...qa.checks];
  }
  const manifestWithQa: ToolPackageManifest = {
    ...workspace.manifest,
    qa: {
      summary: qa.summary,
      checks: qa.checks,
    },
  };
  if (qa.ok) {
    await writeFile(
      join(options.projectRoot ?? process.cwd(), workspace.manifestPath),
      `${JSON.stringify(manifestWithQa, null, 2)}\n`,
      "utf8",
    );
  }
  return {
    input,
    workspace: {
      ...workspace,
      manifest: manifestWithQa,
    },
    qa,
    generatedInput: generatedToolInputFromPackageManifest(
      manifestWithQa,
      `Created by Tool Creation V1 (${input.kind}) from ${sourceLabel} request.`,
    ),
  };
}

function repairToolCreationInputAfterQaFailure(
  input: ToolCreationV1Result["input"],
  qa: ToolPackageWorkspaceQaReport,
  attempt: number,
): ToolCreationV1Result["input"] | undefined {
  const detail = `${qa.summary}\n${qa.checks.join("\n")}`.toLowerCase();
  if (
    input.startupMode === "always-on" &&
    input.kind !== "service-adapter" &&
    /startservice|always-on generated tool packages must export/.test(detail)
  ) {
    return {
      ...input,
      kind: "service-adapter",
      capabilities: uniqueStrings([...input.capabilities, "always-on-service", "service-adapter"]),
      request: [
        input.request,
        `QA repair attempt ${attempt}: previous candidate failed always-on service runtime QA because startService() was missing.`,
        "Rebuild as a service-adapter package with an explicit startService() lifecycle hook.",
      ].filter((line): line is string => Boolean(line)).join("\n"),
    };
  }
  return undefined;
}

export function normalizeToolCreationV1Input(rawInput: unknown): ToolCreationV1Result["input"] {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    throw new Error("tool creation request must be an object");
  }
  const body = rawInput as Record<string, unknown>;
  const request = optionalText(body.request, "request");
  const name = toolName(requiredText(body.name, "name"));
  const version = optionalText(body.version, "version") ?? "0.1.0";
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("version must be semantic version-like, for example 0.1.0");
  }
  const kind = parseKind(body.kind, request);
  const description =
    optionalText(body.description, "description") ??
    (kind === "http-json"
      ? `Fetches an HTTP URL and returns the response preview for ${name}.`
      : kind === "web-search"
        ? `Searches the web and returns source snippets for ${name}.`
      : kind === "web-read"
        ? `Reads a known web page URL and extracts readable text for ${name}.`
      : kind === "browser-operate"
        ? `Operates browser pages in prepare mode for ${name}.`
      : kind === "external-action-prepare"
        ? `Safely prepares external-action proposals for operator review before final commit.`
      : kind === "external-action-commit"
        ? `Commits approved external-action proposals for ${name} through a provider-specific boundary.`
      : kind === "browser-screenshot"
        ? `Captures browser screenshots for ${name}.`
      : `Echoes text input for ${name}.`);
  const capabilities = stringArray(body.capabilities, "capabilities") ?? defaultCapabilities(name, kind);
  const dependencies = dependencyMap(body.dependencies);
  if ((kind === "browser-screenshot" || kind === "browser-operate" || kind === "external-action-prepare" || kind === "external-action-commit") && !dependencies["playwright-core"]) {
    dependencies["playwright-core"] = "^1.56.1";
  }
  const adapterPackageName = optionalText(body.adapterPackageName, "adapterPackageName");
  if (adapterPackageName && !Object.prototype.hasOwnProperty.call(dependencies, adapterPackageName)) {
    throw new Error("adapterPackageName must be present in dependencies");
  }
  const behaviorExamples = parseBehaviorExamples(body.behaviorExamples);
  const adapterContract = parseAdapterContract(body.adapterContract, adapterPackageName);
  const integrationContract = body.integrationContract === undefined && body.integration === undefined
    ? undefined
    : normalizeToolIntegrationContract(body.integrationContract ?? body.integration);
  const integrationSecretHandles = [
    ...(integrationContract?.auth?.requiredSecretHandles ?? []),
    ...(integrationContract?.operations.flatMap((operation) => operation.requiredSecretHandles ?? []) ?? []),
  ];
  const integrationConfigurationKeys = [
    ...(integrationContract?.auth?.requiredConfigurationKeys ?? []),
    ...(integrationContract?.operations.flatMap((operation) => operation.requiredConfigurationKeys ?? []) ?? []),
  ];
  return {
    name,
    displayName: optionalText(body.displayName, "displayName"),
    version,
    description,
    request,
    kind,
    capabilities,
    dependencies,
    adapterPackageName,
    adapterContract,
    startupMode: parseStartupMode(body.startupMode, kind),
    requiredSecretHandles: uniqueStrings([
      ...(optionalStringArray(body.requiredSecretHandles, "requiredSecretHandles") ?? []),
      ...integrationSecretHandles,
    ]),
    requiredConfigurationKeys: uniqueStrings([
      ...(optionalStringArray(body.requiredConfigurationKeys, "requiredConfigurationKeys") ?? []),
      ...integrationConfigurationKeys,
    ]),
    settingsSchema: optionalSchema(body.settingsSchema, "settingsSchema"),
    integrationContract,
    behaviorExamples,
  };
}

function buildManifest(input: ToolCreationV1Result["input"]): Omit<ToolPackageManifest, "package"> {
  const inputSchema = input.kind === "http-json"
    ? {
        type: "object" as const,
        properties: {
          url: { type: "string", minLength: 1, description: "Absolute HTTP or HTTPS URL to call." },
          target: { type: "string", description: "Optional named API target from the integration contract." },
          baseUrl: { type: "string", description: "Base URL used with path when url is not supplied." },
          path: { type: "string", description: "API path used with baseUrl." },
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "GET" },
          operationId: { type: "string", description: "Optional operation identifier from docs/OpenAPI." },
          headers: { type: "object", description: "Optional non-secret request headers." },
          query: { type: "object", description: "Optional query parameters appended to the URL." },
          body: { type: "object", description: "Optional JSON request body for non-GET calls." },
          maxLength: { type: "number", minimum: 1, maximum: 20000, default: 4000 },
        },
      }
    : input.kind === "web-search"
      ? {
          type: "object" as const,
          properties: {
            query: { type: "string", minLength: 1, description: "Search query." },
            limit: { type: "number", minimum: 1, maximum: 10, default: 5 },
          },
          required: ["query"],
        }
    : input.kind === "web-read"
      ? {
          type: "object" as const,
          properties: {
            url: { type: "string", minLength: 1, description: "HTTP or HTTPS URL to read." },
            maxLength: { type: "number", minimum: 200, maximum: 50000, default: 8000 },
            focusText: { type: "string", description: "Optional term to center the extracted snippet around." },
            includeLinks: { type: "boolean", default: true },
            timeoutMs: { type: "number", minimum: 1000, maximum: 60000, default: 15000 },
          },
          required: ["url"],
        }
    : input.kind === "browser-operate" || input.kind === "external-action-prepare"
      ? {
          type: "object" as const,
          properties: {
            url: { type: "string", description: "Optional HTTP or HTTPS URL to navigate before commands." },
            commands: {
              type: "array",
              description: "Ordered browser commands: navigate, dismissDialogs, click, fill, type, selectOption, waitForSelector, waitForText, extractText, extractLinks, screenshot.",
              items: { type: "object" },
            },
            prepareOnly: { type: "boolean", default: true, description: "When true, block final booking/payment/send/submit/confirm actions." },
            actionType: { type: "string", description: "Neutral external action type such as reservation, appointment, purchase, outbound_message, api_write, or generic_external_action." },
            proposal: { type: "object", description: "Optional neutral action proposal used to plan safe preparation." },
            preparation: { type: "object", description: "Optional previously collected inputs and target details." },
            width: { type: "number", minimum: 320, maximum: 3840, default: 1280 },
            height: { type: "number", minimum: 240, maximum: 2160, default: 720 },
            timeoutMs: { type: "number", minimum: 1000, maximum: 60000, default: 30000 },
            maxCommands: { type: "number", minimum: 1, maximum: 40, default: 20 },
          },
        }
    : input.kind === "external-action-commit"
      ? {
          type: "object" as const,
          properties: {
            proposalId: { type: "string", minLength: 1 },
            runId: { type: "string" },
            threadId: { type: "string" },
            actionType: { type: "string", minLength: 1 },
            target: { type: "object", description: "Neutral external target descriptor." },
            proposedAction: { type: "object", description: "Approved action payload to commit." },
            payloadPreview: { type: "string" },
            preparation: { type: "object", description: "Preparation result summary." },
            commitBoundary: { type: "object", description: "Safety and confirmation constraints." },
            preparedSession: { type: "object", description: "Latest prepared browser/provider session." },
            replaySteps: { type: "array", items: { type: "object" } },
            sourceUrls: { type: "array", items: { type: "string" } },
            artifactIds: { type: "array", items: { type: "string" } },
            operatorInput: { type: "object", description: "Operator-supplied fixture or provider-specific commit input." },
          },
          required: ["proposalId", "actionType", "proposedAction"],
        }
    : input.kind === "browser-screenshot"
      ? {
          type: "object" as const,
          properties: {
            url: { type: "string", minLength: 1, description: "HTTP or HTTPS URL to capture." },
            fullPage: { type: "boolean", default: false, description: "Capture the whole page only when explicitly requested. Default proof screenshots capture the viewport." },
            focusText: { type: "string", description: "Optional visible text to scroll into view before capturing, for example a price, heading, or label relevant to the task." },
            selector: { type: "string", description: "Optional CSS selector to scroll into view before capturing." },
            width: { type: "number", minimum: 320, maximum: 3840, default: 1280 },
            height: { type: "number", minimum: 240, maximum: 2160, default: 720 },
            waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle"], default: "load" },
            timeoutMs: { type: "number", minimum: 1000, maximum: 60000, default: 30000 },
            filename: { type: "string", description: "Optional output filename." },
          },
          required: ["url"],
        }
    : input.kind === "service-adapter"
      ? {
          type: "object" as const,
          properties: {
            event: { type: "object", description: "Normalized inbound provider event." },
            text: { type: "string", description: "Optional direct message text for manual smoke tests." },
            sourceChannelId: { type: "string" },
            sourceUserId: { type: "string" },
          },
        }
    : input.kind === "npm-default-function"
      ? input.adapterContract?.inputSchema ?? {
          type: "object" as const,
          properties: {
            text: { type: "string", minLength: 1, description: "Text passed to the npm package function." },
            options: { type: "object", description: "Optional options object passed as the second function argument." },
          },
          required: ["text"],
        }
      : {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Text to echo." },
        },
      };
  return {
    schemaVersion: "agentic.tool-package.v1",
    name: input.name,
    displayName: input.displayName,
    version: input.version,
    description: input.description,
    capabilities: input.capabilities,
    startupMode: input.startupMode,
    inputSchema,
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        content: { type: "string" },
        data: { type: "object" },
      },
      required: ["ok", "content"],
    },
    requiredSecretHandles: input.requiredSecretHandles,
    requiredConfigurationKeys: input.requiredConfigurationKeys,
    settingsSchema: input.settingsSchema,
    integration: input.integrationContract,
    examples: [
      ...(input.behaviorExamples.length > 0
        ? input.behaviorExamples.map((example) => ({
            title: example.title ?? "Behavior QA example",
            ...(example.input ? { input: example.input } : {}),
            ...(example.steps ? { steps: example.steps } : {}),
            expected: {
              ok: example.expectedOk ?? true,
              content: example.expectedContent,
              contentIncludes: example.expectedContentIncludes,
              dataPath: example.expectedDataPath,
              dataEquals: example.expectedDataEquals,
              dataIncludes: example.expectedDataIncludes,
              artifactMimeType: example.expectedArtifactMimeType,
              artifactVisualOk: example.expectedArtifactVisualOk,
            },
          }))
        : [{
          title: input.kind === "http-json"
          ? "Fetch example.com"
          : input.kind === "web-search"
            ? "Search example query"
          : input.kind === "web-read"
            ? "Read example.com"
          : input.kind === "browser-operate"
            ? "Prepare page interaction example"
          : input.kind === "external-action-prepare"
            ? "Prepare external action safely"
          : input.kind === "external-action-commit"
            ? "Commit fixture external action"
          : input.kind === "browser-screenshot"
            ? "Screenshot example.com"
            : input.kind === "npm-default-function"
              ? "Transform text"
              : "Echo text",
          input: input.kind === "http-json"
          ? { url: "https://example.com", maxLength: 1000 }
          : input.kind === "web-search"
            ? { query: "OpenAI latest news", limit: 3 }
          : input.kind === "web-read"
            ? { url: "https://example.com", maxLength: 4000, includeLinks: true }
          : input.kind === "browser-operate"
            ? { url: "https://example.com", commands: [{ action: "extractText" }, { action: "screenshot" }], prepareOnly: true }
          : input.kind === "external-action-prepare"
            ? { url: "https://example.com", actionType: "generic_external_action", commands: [{ action: "extractText" }, { action: "extractLinks" }, { action: "extractForms" }, { action: "screenshot" }], prepareOnly: true }
          : input.kind === "external-action-commit"
            ? { proposalId: "proposal-1", actionType: "fixture", proposedAction: { summary: "approved fixture action" }, operatorInput: { fixtureConfirmation: "fixture-confirmed-1" } }
          : input.kind === "browser-screenshot"
            ? { url: "https://example.com", fullPage: false, width: 1280, height: 720 }
            : input.kind === "npm-default-function"
              ? { text: "Hello world", options: {} }
              : { text: "hello" },
        }]),
    ],
  };
}

function toolCreationSourceLabel(rawInput: unknown): "agent" | "operator" {
  return rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
    && (rawInput as Record<string, unknown>).source === "agent"
    ? "agent"
    : "operator";
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const parsed = value.map((item, index) => requiredText(item, `${field}[${index}]`));
  if (parsed.length === 0) throw new Error(`${field} must not be empty`);
  return parsed;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => requiredText(item, `${field}[${index}]`));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function optionalSchema(value: unknown, field: string): ToolSchema | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as ToolSchema;
}

function parseStartupMode(value: unknown, kind?: ToolCreationV1Kind): ToolStartupMode {
  if (value === undefined) return kind === "service-adapter" ? "always-on" : "on-demand";
  if (value === "on-demand" || value === "always-on" || value === "ephemeral") return value;
  throw new Error("startupMode must be on-demand, always-on, or ephemeral");
}

function dependencyMap(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dependencies must be an object mapping package names to version ranges");
  }
  const out: Record<string, string> = {};
  for (const [name, rawRange] of Object.entries(value as Record<string, unknown>)) {
    const packageName = name.trim();
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(packageName)) {
      throw new Error(`Invalid npm dependency name: ${name}`);
    }
    const versionRange = requiredText(rawRange, `dependencies.${name}`);
    if (versionRange.includes("file:") || versionRange.includes("git+") || versionRange.includes("http:") || versionRange.includes("https:")) {
      throw new Error(`Dependency ${name} must use a registry version range, not a file/git/http reference`);
    }
    out[packageName] = versionRange;
  }
  return out;
}

function parseBehaviorExamples(value: unknown): ToolPackageBehaviorExample[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("behaviorExamples must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`behaviorExamples[${index}] must be an object`);
    }
    const example = item as Record<string, unknown>;
    const steps = parseBehaviorSteps(example.steps, `behaviorExamples[${index}].steps`);
    if (!steps && (!example.input || typeof example.input !== "object" || Array.isArray(example.input))) {
      throw new Error(`behaviorExamples[${index}].input must be an object`);
    }
    return {
      title: optionalText(example.title, `behaviorExamples[${index}].title`),
      ...(example.input ? { input: example.input as Record<string, unknown> } : {}),
      ...(steps ? { steps } : {}),
      expectedOk: optionalBoolean(example.expectedOk, `behaviorExamples[${index}].expectedOk`),
      expectedContent: optionalText(example.expectedContent, `behaviorExamples[${index}].expectedContent`),
      expectedContentIncludes: optionalText(example.expectedContentIncludes, `behaviorExamples[${index}].expectedContentIncludes`),
      expectedDataPath: optionalText(example.expectedDataPath, `behaviorExamples[${index}].expectedDataPath`),
      ...(Object.prototype.hasOwnProperty.call(example, "expectedDataEquals") ? { expectedDataEquals: example.expectedDataEquals } : {}),
      expectedDataIncludes: optionalText(example.expectedDataIncludes, `behaviorExamples[${index}].expectedDataIncludes`),
      expectedArtifactMimeType: optionalText(example.expectedArtifactMimeType, `behaviorExamples[${index}].expectedArtifactMimeType`),
      expectedArtifactVisualOk: optionalBoolean(example.expectedArtifactVisualOk, `behaviorExamples[${index}].expectedArtifactVisualOk`),
    };
  });
}

function parseBehaviorSteps(value: unknown, field: string): ToolPackageBehaviorExample["steps"] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${field}[${index}] must be an object`);
    }
    const step = item as Record<string, unknown>;
    if (!step.input || typeof step.input !== "object" || Array.isArray(step.input)) {
      throw new Error(`${field}[${index}].input must be an object`);
    }
    const title = optionalText(step.title, `${field}[${index}].title`);
    const saveAs = optionalText(step.saveAs, `${field}[${index}].saveAs`);
    const expectedOk = optionalBoolean(step.expectedOk, `${field}[${index}].expectedOk`);
    const expectedContent = optionalText(step.expectedContent, `${field}[${index}].expectedContent`);
    const expectedContentIncludes = optionalText(step.expectedContentIncludes, `${field}[${index}].expectedContentIncludes`);
    const expectedDataPath = optionalText(step.expectedDataPath, `${field}[${index}].expectedDataPath`);
    const expectedDataIncludes = optionalText(step.expectedDataIncludes, `${field}[${index}].expectedDataIncludes`);
    const expectedArtifactMimeType = optionalText(step.expectedArtifactMimeType, `${field}[${index}].expectedArtifactMimeType`);
    const expectedArtifactVisualOk = optionalBoolean(step.expectedArtifactVisualOk, `${field}[${index}].expectedArtifactVisualOk`);
    return {
      ...(title !== undefined ? { title } : {}),
      input: step.input as Record<string, unknown>,
      ...(saveAs !== undefined ? { saveAs } : {}),
      ...(expectedOk !== undefined ? { expectedOk } : {}),
      ...(expectedContent !== undefined ? { expectedContent } : {}),
      ...(expectedContentIncludes !== undefined ? { expectedContentIncludes } : {}),
      ...(expectedDataPath !== undefined ? { expectedDataPath } : {}),
      ...(Object.prototype.hasOwnProperty.call(step, "expectedDataEquals") ? { expectedDataEquals: step.expectedDataEquals } : {}),
      ...(expectedDataIncludes !== undefined ? { expectedDataIncludes } : {}),
      ...(expectedArtifactMimeType !== undefined ? { expectedArtifactMimeType } : {}),
      ...(expectedArtifactVisualOk !== undefined ? { expectedArtifactVisualOk } : {}),
    };
  });
}

function parseAdapterContract(value: unknown, adapterPackageName: string | undefined): ToolAdapterContract | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("adapterContract must be an object");
  }
  const contract = value as Record<string, unknown>;
  const packageName = optionalText(contract.packageName, "adapterContract.packageName") ?? adapterPackageName;
  if (!packageName || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(packageName)) {
    throw new Error("adapterContract.packageName must be a valid npm package name");
  }
  if (adapterPackageName && packageName !== adapterPackageName) {
    throw new Error("adapterContract.packageName must match adapterPackageName");
  }
  const importStyle = contract.importStyle;
  if (importStyle !== "default" && importStyle !== "named" && importStyle !== "namespace") {
    throw new Error("adapterContract.importStyle must be default, named, or namespace");
  }
  const exportName = optionalText(contract.exportName, "adapterContract.exportName");
  const memberName = optionalText(contract.memberName, "adapterContract.memberName");
  if (importStyle === "named" && !exportName) throw new Error("adapterContract.exportName is required for named imports");
  if (importStyle === "namespace" && !memberName) throw new Error("adapterContract.memberName is required for namespace imports");
  if (exportName && !isIdentifier(exportName)) throw new Error("adapterContract.exportName must be a JavaScript identifier");
  if (memberName && !isIdentifier(memberName)) throw new Error("adapterContract.memberName must be a JavaScript identifier");
  if (
    contract.inputMode !== undefined &&
    contract.inputMode !== "text-options" &&
    contract.inputMode !== "object"
  ) {
    throw new Error("adapterContract.inputMode must be text-options or object");
  }
  const inputMode = contract.inputMode === "object" ? "object" : "text-options";
  const inputSchema = parseAdapterInputSchema(contract.inputSchema);
  const inputExample = parseAdapterInputExample(contract.inputExample);
  if (inputMode === "object" && !inputSchema) {
    throw new Error("adapterContract.inputSchema is required for object input mode");
  }
  return {
    packageName,
    importStyle,
    exportName,
    memberName,
    inputMode,
    inputSchema,
    inputExample,
    evidence: optionalText(contract.evidence, "adapterContract.evidence") ?? "Adapter contract supplied by Tool Builder.",
  };
}

function parseAdapterInputSchema(value: unknown): ToolAdapterContract["inputSchema"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("adapterContract.inputSchema must be an object schema");
  }
  const schema = value as Record<string, unknown>;
  if (schema.type !== "object") throw new Error("adapterContract.inputSchema.type must be object");
  if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    throw new Error("adapterContract.inputSchema.properties must be an object");
  }
  const properties = schema.properties as Record<string, unknown>;
  for (const key of Object.keys(properties)) {
    if (!isInputFieldName(key)) throw new Error(`adapterContract.inputSchema property is invalid: ${key}`);
  }
  const required = schema.required === undefined
    ? undefined
    : parseRequiredInputFields(schema.required, properties);
  return {
    type: "object",
    properties,
    required,
  };
}

function parseRequiredInputFields(value: unknown, properties: Record<string, unknown>): string[] {
  if (!Array.isArray(value)) throw new Error("adapterContract.inputSchema.required must be an array");
  return value.map((item, index) => {
    const field = requiredText(item, `adapterContract.inputSchema.required[${index}]`);
    if (!isInputFieldName(field)) throw new Error(`adapterContract.inputSchema.required field is invalid: ${field}`);
    if (!Object.prototype.hasOwnProperty.call(properties, field)) {
      throw new Error(`adapterContract.inputSchema.required field has no property schema: ${field}`);
    }
    return field;
  });
}

function parseAdapterInputExample(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("adapterContract.inputExample must be an object");
  }
  return value as Record<string, unknown>;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function isInputFieldName(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(value);
}

function toolName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(normalized)) {
    throw new Error("name must be a stable lowercase tool identifier");
  }
  return normalized;
}

function parseKind(value: unknown, request: string | undefined): ToolCreationV1Kind {
  if (
    value === "echo" ||
    value === "http-json" ||
    value === "npm-default-function" ||
    value === "browser-screenshot" ||
    value === "browser-operate" ||
    value === "web-search" ||
    value === "web-read" ||
    value === "service-adapter" ||
    value === "external-action-prepare" ||
    value === "external-action-commit"
  ) {
    return value;
  }
  if (value !== undefined) throw new Error("kind must be echo, http-json, npm-default-function, browser-screenshot, browser-operate, web-search, web-read, service-adapter, external-action-prepare, or external-action-commit");
  const lower = request?.toLowerCase() ?? "";
  if (/\bexternal-action-prepare\b|\bprepare external action\b|\bsafe external action preparation\b|\bprepared action draft\b|\bstop before final commit\b/.test(lower)) return "external-action-prepare";
  if (/\bexternal-action-commit\b|\bcommit executor\b|\bapproved proposal commit\b|\bcommit approved external action\b/.test(lower)) return "external-action-commit";
  if (/\b(web\s+search|internet\s+search|search\s+engine|search results?|current (?:news|price|prices|information|data)|real-time|realtime)\b/.test(lower)) return "web-search";
  if (/\b(read|extract|scrape|parse)\b.*\b(web\s+page|page|url|html|article|document)\b|\b(web\s+read|web\s+extract|page\s+extract|article\s+text)\b/.test(lower)) return "web-read";
  if (/\b(bot|telegram|whatsapp|slack|discord|webhook|listener|listen|poll|always[-\s]?on|receive messages?|incoming messages?|inbound)\b/.test(lower)) return "service-adapter";
  if (/\b(browser[.\s_-]*operate|browser\s+operation|click|fill|type|select|submit|form|booking form|appointment form|prepare[-\s]?only|stop before commit|web automation)\b/.test(lower)) return "browser-operate";
  if (/\b(browser|screenshot|capture|page image|web page)\b/.test(lower)) return "browser-screenshot";
  if (/\b(api|http|json|fetch|url|endpoint)\b/.test(lower)) return "http-json";
  return "echo";
}

function defaultCapabilities(name: string, kind: ToolCreationV1Kind): string[] {
  const base = name.split(/[._-]+/).filter(Boolean).join("-");
  if (kind === "npm-default-function") return [base, "npm-package", "text-transform"];
  if (kind === "browser-screenshot") return [base, "browser-automation", "browser-screenshot", "artifact-image"];
  if (kind === "browser-operate") return [base, "browser-automation", "browser-operate", "dom-extraction", "artifact-image"];
  if (kind === "external-action-prepare") return [base, "external-action-prepare", "browser-automation", "browser-operate", "browser-field-candidates", "browser-form-schema", "dom-extraction", "artifact-image"];
  if (kind === "web-search") return [base, "web-search", "information-retrieval"];
  if (kind === "web-read") return [base, "web-read", "web-extract", "information-retrieval"];
  if (kind === "service-adapter") return [base, "always-on-service", "integration-adapter"];
  if (kind === "external-action-commit") return [base, "external-action-commit", "external-action-commit-generic"];
  return kind === "http-json"
    ? [base, "http-json", "api-client"]
    : [base, "echo", "text-transform"];
}
