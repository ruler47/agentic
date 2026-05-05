import { LlmClient } from "../llm/client.js";
import { Message } from "../types.js";
import { extractJson } from "../utils/json.js";
import { ToolBuildAttemptContext } from "./toolBuildWorkflow.js";
import { ToolBuildRequest } from "./toolBuildRequestStore.js";
import { ToolSchema, ToolStartupMode, ToolStorageContract, ToolExample } from "./tool.js";
import {
  genericToolPackageManifest,
  ToolBuildProvider,
  ToolBuildProviderOutput,
} from "./toolBuildProviders.js";
import { ToolPackageManifest, normalizeToolPackageManifest } from "./toolPackage.js";

type LlmToolBuilderResponse = {
  summary: string;
  displayName?: string;
  capabilities?: string[];
  inputSchema?: ToolSchema;
  outputSchema?: ToolSchema;
  requiredSecretHandles?: string[];
  requiredConfigurationKeys?: string[];
  settingsSchema?: ToolSchema;
  storage?: ToolStorageContract;
  docsMarkdown?: string;
  examples?: ToolExample[];
  packageManifest?: ToolPackageManifest;
  changeSummary?: string;
  files: Array<{
    path: string;
    content: string;
  }>;
};

export class LlmToolBuildProvider implements ToolBuildProvider {
  constructor(private readonly llm: Pick<LlmClient, "complete">) {}

  canBuild(request: ToolBuildRequest): boolean {
    return Boolean(request.reason.trim() && request.contract.modulePath && request.contract.testPath);
  }

  async build(
    request: ToolBuildRequest,
    context?: ToolBuildAttemptContext,
  ): Promise<ToolBuildProviderOutput> {
    const raw = await this.llm.complete(buildPrompt(request, context), {
      temperature: 0.1,
      modelTier: "XL",
    });
    const parsed = normalizeBuilderResponse(extractJson<unknown>(raw), request);
    const packageManifest =
      parsed.packageManifest ??
      genericToolPackageManifest({
        toolName: request.contract.toolName,
        displayName: parsed.displayName ?? request.displayName ?? request.contract.displayName,
        version: request.contract.version,
        description: request.contract.description,
        capabilities: parsed.capabilities ?? [request.capability],
        startupMode: request.contract.startupMode,
        modulePath: request.contract.modulePath,
        inputSchema: parsed.inputSchema ?? request.contract.inputSchema,
        outputSchema: parsed.outputSchema ?? request.contract.outputSchema,
        requiredConfigurationKeys: parsed.requiredConfigurationKeys,
        requiredSecretHandles: parsed.requiredSecretHandles ?? request.credentialHandles,
        settingsSchema: parsed.settingsSchema,
        storage: parsed.storage,
        docsMarkdown: parsed.docsMarkdown,
        examples: parsed.examples,
      });

    return {
      modulePath: request.contract.modulePath,
      testPath: request.contract.testPath,
      summary: parsed.summary,
      displayName: parsed.displayName ?? request.displayName ?? request.contract.displayName,
      capabilities: parsed.capabilities ?? [request.capability],
      inputSchema: parsed.inputSchema ?? request.contract.inputSchema,
      outputSchema: parsed.outputSchema ?? request.contract.outputSchema,
      requiredSecretHandles: parsed.requiredSecretHandles ?? request.credentialHandles,
      requiredConfigurationKeys: parsed.requiredConfigurationKeys,
      settingsSchema: parsed.settingsSchema,
      storage: parsed.storage,
      docsMarkdown: parsed.docsMarkdown,
      examples: parsed.examples,
      packageManifest,
      changeSummary: parsed.changeSummary,
      files: parsed.files,
    };
  }
}

function buildPrompt(request: ToolBuildRequest, context?: ToolBuildAttemptContext): Message[] {
  const repairContext = context?.previousQaReport
    ? [
        "Previous generated output failed QA. Repair the implementation instead of repeating the same failure.",
        `Previous QA summary: ${context.previousQaReport.summary}`,
        `Previous QA checks:\n${context.previousQaReport.checks.join("\n")}`,
        context.previousOutput
          ? `Previous output files: ${context.previousOutput.modulePath}, ${context.previousOutput.testPath}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n\n")
    : "No previous QA failure.";

  const contractJson = JSON.stringify(
    {
      request: {
        id: request.id,
        capability: request.capability,
        displayName: request.displayName,
        reason: request.reason,
        taskSummary: request.taskSummary,
        requiredInputs: request.requiredInputs,
        requiredOutputs: request.requiredOutputs,
        credentialHandles: request.credentialHandles,
        reworkOf: request.reworkOf,
        feedback: request.feedback,
      },
      contract: request.contract,
      repairContext,
    },
    null,
    2,
  );

  return [
    {
      role: "system",
      content: [
        "You are a senior TypeScript Tool Builder for Agentic.",
        "Generate a reusable, self-contained Tool module and a focused node:test test file.",
        "Return only one JSON object. No Markdown outside JSON.",
        "The generated source must implement the Tool interface from ../tool.js.",
        "Do not import Agentic private runtime internals except ../tool.js types.",
        "Never include raw secrets. Use only declared secret handles and context.resolveSecret.",
        "Expected bad inputs must return { ok: false, content: string }, not throw.",
        "Always include tests for contract, success behavior, and at least one failure path.",
        "For always-on integrations, implement startService(context), healthcheck, start/stop behavior, and neutral event docs.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Build a tool from this contract.",
        contractJson,
        "Required JSON response shape:",
        JSON.stringify(
          {
            summary: "short build summary",
            displayName: request.displayName ?? request.contract.displayName,
            capabilities: [request.capability],
            inputSchema: request.contract.inputSchema,
            outputSchema: request.contract.outputSchema,
            requiredSecretHandles: request.credentialHandles ?? [],
            requiredConfigurationKeys: [],
            settingsSchema: undefined,
            storage: undefined,
            docsMarkdown: "operator and agent-readable docs",
            examples: [{ title: "example", input: {}, output: { ok: true } }],
            changeSummary: "version changelog",
            packageManifest: undefined,
            files: [
              { path: request.contract.modulePath, content: "TypeScript source" },
              { path: request.contract.testPath, content: "node:test source" },
            ],
          },
          null,
          2,
        ),
      ].join("\n\n"),
    },
  ];
}

function normalizeBuilderResponse(value: unknown, request: ToolBuildRequest): LlmToolBuilderResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("LLM Tool Builder response must be a JSON object.");
  }
  const candidate = value as Record<string, unknown>;
  const summary = readRequiredText(candidate.summary, "summary");
  const files = readFiles(candidate.files, request);
  const capabilities = readOptionalStringArray(candidate.capabilities, "capabilities");
  const requiredSecretHandles = readOptionalStringArray(candidate.requiredSecretHandles, "requiredSecretHandles");
  const requiredConfigurationKeys = readOptionalStringArray(
    candidate.requiredConfigurationKeys,
    "requiredConfigurationKeys",
  );
  const examples = readOptionalExamples(candidate.examples);
  const packageManifest = candidate.packageManifest
    ? normalizeToolPackageManifest(candidate.packageManifest)
    : undefined;

  if (capabilities && !capabilities.includes(request.capability)) {
    throw new Error(`LLM Tool Builder capabilities must include requested capability ${request.capability}.`);
  }
  if (requiredSecretHandles) {
    for (const handle of requiredSecretHandles) {
      if (looksLikeRawSecret(handle)) {
        throw new Error("LLM Tool Builder returned a raw-looking secret instead of a secret handle.");
      }
    }
  }
  if (packageManifest) {
    validatePackageManifest(packageManifest, request);
  }

  return {
    summary,
    displayName: readOptionalText(candidate.displayName, "displayName"),
    capabilities,
    inputSchema: readOptionalSchema(candidate.inputSchema, "inputSchema"),
    outputSchema: readOptionalSchema(candidate.outputSchema, "outputSchema"),
    requiredSecretHandles,
    requiredConfigurationKeys,
    settingsSchema: readOptionalSchema(candidate.settingsSchema, "settingsSchema"),
    storage: readOptionalRecord<ToolStorageContract>(candidate.storage, "storage"),
    docsMarkdown: readOptionalText(candidate.docsMarkdown, "docsMarkdown"),
    examples,
    packageManifest,
    changeSummary: readOptionalText(candidate.changeSummary, "changeSummary"),
    files,
  };
}

function readFiles(value: unknown, request: ToolBuildRequest): LlmToolBuilderResponse["files"] {
  if (!Array.isArray(value)) throw new Error("files must be an array.");
  const files = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`files[${index}] must be an object.`);
    }
    const candidate = item as Record<string, unknown>;
    return {
      path: readRequiredText(candidate.path, `files[${index}].path`),
      content: readRequiredText(candidate.content, `files[${index}].content`),
    };
  });
  const expected = new Set([request.contract.modulePath, request.contract.testPath]);
  const actual = new Set(files.map((file) => file.path));
  for (const path of expected) {
    if (!actual.has(path)) throw new Error(`LLM Tool Builder must return required file ${path}.`);
  }
  for (const file of files) {
    if (!expected.has(file.path)) {
      throw new Error(`LLM Tool Builder returned unexpected file path ${file.path}.`);
    }
    if (file.path.includes("..") || file.path.startsWith("/") || file.path.includes("\\")) {
      throw new Error(`LLM Tool Builder returned unsafe file path ${file.path}.`);
    }
  }
  return files;
}

function validatePackageManifest(manifest: ToolPackageManifest, request: ToolBuildRequest): void {
  if (manifest.name !== request.contract.toolName) {
    throw new Error("LLM Tool Builder package manifest name must match the requested tool name.");
  }
  if (manifest.version !== request.contract.version) {
    throw new Error("LLM Tool Builder package manifest version must match the requested tool version.");
  }
  if (manifest.startupMode !== request.contract.startupMode) {
    throw new Error("LLM Tool Builder package manifest startup mode must match the requested contract.");
  }
  if (!manifest.capabilities.includes(request.capability)) {
    throw new Error(`LLM Tool Builder package manifest must include requested capability ${request.capability}.`);
  }
  if (manifest.package.type === "local-path" && manifest.package.ref !== request.contract.modulePath) {
    throw new Error("LLM Tool Builder local-path package manifest must point at the requested module path.");
  }
  for (const handle of manifest.requiredSecretHandles ?? []) {
    if (looksLikeRawSecret(handle)) {
      throw new Error("LLM Tool Builder package manifest returned a raw-looking secret handle.");
    }
  }
}

function readOptionalExamples(value: unknown): ToolExample[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("examples must be an array.");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`examples[${index}] must be an object.`);
    }
    const candidate = item as Record<string, unknown>;
    return {
      title: readRequiredText(candidate.title, `examples[${index}].title`),
      input: readOptionalRecord<Record<string, unknown>>(candidate.input, `examples[${index}].input`) ?? {},
      output: candidate.output,
    };
  });
}

function readOptionalSchema(value: unknown, field: string): ToolSchema | undefined {
  return readOptionalRecord<ToolSchema>(value, field);
}

function readOptionalRecord<T extends object>(value: unknown, field: string): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as T;
}

function readOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((item, index) => readRequiredText(item, `${field}[${index}]`));
}

function readRequiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function readOptionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function looksLikeRawSecret(value: string): boolean {
  return /(?:api[_-]?key|token|secret)[=:]/i.test(value) || /^[A-Za-z0-9_-]{32,}$/.test(value);
}
