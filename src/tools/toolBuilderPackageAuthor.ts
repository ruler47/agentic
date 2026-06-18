import type { LlmClient } from "../llm/client.js";
import type { Message } from "../types.js";
import type { ToolBuilderPlan } from "./toolBuilderAgent.js";
import type { ToolCreationV1AuthoredPackageInput } from "./toolCreationV1.js";
import type { ToolPackageBehaviorExample } from "./toolPackageWorkspaceQa.js";

export type ToolBuilderAuthoringMode = "auto" | "llm" | "scaffold";

export type ToolBuilderAuthoringResult =
  | {
      mode: "authored";
      package: ToolCreationV1AuthoredPackageInput;
      notes: string[];
    }
  | {
      mode: "scaffold";
      reason: string;
      notes: string[];
    };

type RawAuthoredPackage = {
  readmeMarkdown?: unknown;
  dockerfile?: unknown;
  behaviorExamples?: unknown;
  files?: unknown;
};

export async function authorToolPackageWithGuardrails(options: {
  plan: ToolBuilderPlan;
  llm?: LlmClient;
  mode?: ToolBuilderAuthoringMode;
  timeoutMs?: number;
}): Promise<ToolBuilderAuthoringResult> {
  const mode = options.mode ?? authoringModeFromEnv();
  if (mode === "scaffold") {
    return {
      mode: "scaffold",
      reason: "LLM package authoring is disabled; using guarded scaffold writer.",
      notes: ["Authoring mode scaffold: deterministic writer will produce the package files."],
    };
  }
  if (!options.llm) {
    return {
      mode: "scaffold",
      reason: "No LLM client is configured for package authoring.",
      notes: ["Builder package authoring fell back before prompting because no LLM client was available."],
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, options.timeoutMs ?? 20_000));
  try {
    const text = await options.llm.complete(authoringPrompt(options.plan), {
      modelTier: "XL",
      temperature: 0.1,
      signal: controller.signal,
    });
    const parsed = parseAuthoredPackageJson(text);
    return {
      mode: "authored",
      package: parsed,
      notes: [
        "LLM authored a complete source-bundle package snapshot.",
        "Snapshot passed local path/content guardrails before package QA.",
      ],
    };
  } catch (error) {
    return {
      mode: "scaffold",
      reason: error instanceof Error ? error.message : "LLM package authoring failed.",
      notes: [
        "LLM package authoring did not produce an accepted package snapshot.",
        "Falling back to guarded scaffold writer; package build/test QA still runs.",
      ],
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function parseAuthoredPackageJson(text: string): ToolCreationV1AuthoredPackageInput {
  const raw = extractJsonObject(text) as RawAuthoredPackage;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Authored package response must be a JSON object.");
  }
  const files = parseFiles(raw.files);
  validateRequiredPackageFiles(files);
  const readmeMarkdown = typeof raw.readmeMarkdown === "string" && raw.readmeMarkdown.trim()
    ? raw.readmeMarkdown
    : undefined;
  const dockerfile = typeof raw.dockerfile === "string" && raw.dockerfile.trim()
    ? raw.dockerfile
    : undefined;
  if (dockerfile) validateContent("Dockerfile", dockerfile);
  if (readmeMarkdown) validateContent("README.md", readmeMarkdown);
  return {
    readmeMarkdown,
    dockerfile,
    behaviorExamples: parseBehaviorExamples(raw.behaviorExamples),
    files,
  };
}

function authoringModeFromEnv(): ToolBuilderAuthoringMode {
  const raw = (process.env.TOOL_BUILDER_AUTHORING ?? process.env.TOOL_BUILDER_LLM_AUTHORING ?? "scaffold").toLowerCase();
  if (raw === "llm" || raw === "enabled" || raw === "true") return "llm";
  if (raw === "auto") return "auto";
  return "scaffold";
}

function authoringPrompt(plan: ToolBuilderPlan): Message[] {
  return [
    {
      role: "system",
      content: [
        "You are ToolBuilderAgent. Return only JSON for a complete portable TypeScript source-bundle tool package.",
        "Do not include markdown fences. Do not import Agentic app internals.",
        "The package must export `tool` from `index.ts`, expose a local HTTP runtime in `runtime/server.ts`, include a local `src/tools/tool.ts` contract, one generated tool implementation, and node:test tests.",
        "Allowed JSON shape: { readmeMarkdown?: string, dockerfile?: string, behaviorExamples?: [{ title?: string, input?: object, steps?: [{ title?: string, input: object, saveAs?: string, expectedOk?: boolean, expectedContent?: string, expectedContentIncludes?: string, expectedDataPath?: string, expectedDataEquals?: unknown, expectedDataIncludes?: string, expectedArtifactMimeType?: string, expectedArtifactVisualOk?: boolean }], expectedOk?: boolean, expectedContent?: string, expectedContentIncludes?: string, expectedDataPath?: string, expectedDataEquals?: unknown, expectedDataIncludes?: string, expectedArtifactMimeType?: string, expectedArtifactVisualOk?: boolean }], files: [{ path: string, content: string }] }.",
        "When the supplied plan has no behaviorExamples, infer concrete behaviorExamples from README/docs/package examples or from the original task. For API, multi-step, and chained-tool behavior, prefer steps that verify the source task outcome, not only that the package loads. Later step inputs may reference previous outputs with placeholders like {{created.data.id}} when an earlier step uses saveAs: \"created\".",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        request: plan.input.request,
        tool: {
          name: plan.input.name,
          version: plan.input.version,
          description: plan.input.description,
          capabilities: plan.input.capabilities,
          dependencies: plan.input.dependencies,
          kind: plan.input.kind,
          adapterPackageName: plan.input.adapterPackageName,
        },
        strategy: plan.strategy,
        contract: {
          result: "{ ok: boolean, content: string, data?: unknown }",
          health: "{ ok: boolean, detail: string }",
          runtime: "GET /health and POST /run with body { input, context }",
        },
      }, null, 2),
    },
  ];
}

function parseBehaviorExamples(value: unknown): ToolPackageBehaviorExample[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Authored package behaviorExamples must be an array.");
  const examples = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`behaviorExamples[${index}] must be an object.`);
    }
    const record = item as Record<string, unknown>;
    const steps = parseBehaviorSteps(record.steps, `behaviorExamples[${index}].steps`);
    if (!steps && (!record.input || typeof record.input !== "object" || Array.isArray(record.input))) {
      throw new Error(`behaviorExamples[${index}].input must be an object.`);
    }
    const title = optionalString(record.title, `behaviorExamples[${index}].title`);
    const expectedOk = optionalBoolean(record.expectedOk, `behaviorExamples[${index}].expectedOk`);
    const expectedContent = optionalString(record.expectedContent, `behaviorExamples[${index}].expectedContent`);
    const expectedContentIncludes = optionalString(record.expectedContentIncludes, `behaviorExamples[${index}].expectedContentIncludes`);
    const expectedDataPath = optionalString(record.expectedDataPath, `behaviorExamples[${index}].expectedDataPath`);
    const expectedDataIncludes = optionalString(record.expectedDataIncludes, `behaviorExamples[${index}].expectedDataIncludes`);
    const expectedArtifactMimeType = optionalString(record.expectedArtifactMimeType, `behaviorExamples[${index}].expectedArtifactMimeType`);
    const expectedArtifactVisualOk = optionalBoolean(record.expectedArtifactVisualOk, `behaviorExamples[${index}].expectedArtifactVisualOk`);
    if (
      !steps &&
      expectedContent === undefined &&
      expectedContentIncludes === undefined &&
      expectedDataPath === undefined &&
      expectedArtifactMimeType === undefined &&
      expectedArtifactVisualOk === undefined
    ) {
      throw new Error(`behaviorExamples[${index}] must include steps, expectedContent, expectedContentIncludes, expectedDataPath, expectedArtifactMimeType, or expectedArtifactVisualOk.`);
    }
    return {
      ...(title !== undefined ? { title } : {}),
      ...(record.input ? { input: record.input as Record<string, unknown> } : {}),
      ...(steps ? { steps } : {}),
      ...(expectedOk !== undefined ? { expectedOk } : {}),
      ...(expectedContent !== undefined ? { expectedContent } : {}),
      ...(expectedContentIncludes !== undefined ? { expectedContentIncludes } : {}),
      ...(expectedDataPath !== undefined ? { expectedDataPath } : {}),
      ...(Object.prototype.hasOwnProperty.call(record, "expectedDataEquals") ? { expectedDataEquals: record.expectedDataEquals } : {}),
      ...(expectedDataIncludes !== undefined ? { expectedDataIncludes } : {}),
      ...(expectedArtifactMimeType !== undefined ? { expectedArtifactMimeType } : {}),
      ...(expectedArtifactVisualOk !== undefined ? { expectedArtifactVisualOk } : {}),
    };
  });
  return examples.length > 0 ? examples.slice(0, 5) : undefined;
}

function parseBehaviorSteps(value: unknown, field: string): ToolPackageBehaviorExample["steps"] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array.`);
  return value.slice(0, 8).map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${field}[${index}] must be an object.`);
    }
    const record = item as Record<string, unknown>;
    if (!record.input || typeof record.input !== "object" || Array.isArray(record.input)) {
      throw new Error(`${field}[${index}].input must be an object.`);
    }
    const expectedDataPath = optionalString(record.expectedDataPath, `${field}[${index}].expectedDataPath`);
    const title = optionalString(record.title, `${field}[${index}].title`);
    const saveAs = optionalString(record.saveAs, `${field}[${index}].saveAs`);
    const expectedOk = optionalBoolean(record.expectedOk, `${field}[${index}].expectedOk`);
    const expectedContent = optionalString(record.expectedContent, `${field}[${index}].expectedContent`);
    const expectedContentIncludes = optionalString(record.expectedContentIncludes, `${field}[${index}].expectedContentIncludes`);
    const expectedDataIncludes = optionalString(record.expectedDataIncludes, `${field}[${index}].expectedDataIncludes`);
    const expectedArtifactMimeType = optionalString(record.expectedArtifactMimeType, `${field}[${index}].expectedArtifactMimeType`);
    const expectedArtifactVisualOk = optionalBoolean(record.expectedArtifactVisualOk, `${field}[${index}].expectedArtifactVisualOk`);
    return {
      ...(title !== undefined ? { title } : {}),
      input: record.input as Record<string, unknown>,
      ...(saveAs !== undefined ? { saveAs } : {}),
      ...(expectedOk !== undefined ? { expectedOk } : {}),
      ...(expectedContent !== undefined ? { expectedContent } : {}),
      ...(expectedContentIncludes !== undefined ? { expectedContentIncludes } : {}),
      ...(expectedDataPath !== undefined ? { expectedDataPath } : {}),
      ...(Object.prototype.hasOwnProperty.call(record, "expectedDataEquals") ? { expectedDataEquals: record.expectedDataEquals } : {}),
      ...(expectedDataIncludes !== undefined ? { expectedDataIncludes } : {}),
      ...(expectedArtifactMimeType !== undefined ? { expectedArtifactMimeType } : {}),
      ...(expectedArtifactVisualOk !== undefined ? { expectedArtifactVisualOk } : {}),
    };
  });
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}

function parseFiles(value: unknown): ToolCreationV1AuthoredPackageInput["files"] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Authored package must include non-empty files array.");
  }
  if (value.length > 50) throw new Error("Authored package has too many files.");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`files[${index}] must be an object.`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string" || typeof record.content !== "string") {
      throw new Error(`files[${index}] requires path and content strings.`);
    }
    const path = safePackagePath(record.path);
    validateContent(path, record.content);
    return { path, content: record.content };
  });
}

function validateRequiredPackageFiles(files: ToolCreationV1AuthoredPackageInput["files"]): void {
  const paths = new Set(files.map((file) => file.path));
  const required = ["index.ts", "runtime/server.ts", "src/tools/tool.ts"];
  for (const path of required) {
    if (!paths.has(path)) throw new Error(`Authored package is missing ${path}.`);
  }
  if (![...paths].some((path) => /^src\/tools\/generated\/.+Tool\.ts$/.test(path))) {
    throw new Error("Authored package must include a generated tool implementation.");
  }
  if (![...paths].some((path) => /^tests\/.+\.test\.ts$/.test(path))) {
    throw new Error("Authored package must include node:test coverage.");
  }
}

function safePackagePath(value: string): string {
  const path = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path || path.includes("\0") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe authored package path: ${value}`);
  }
  if (path.startsWith("node_modules/") || path.startsWith("dist/") || path === "package.json" || path === "tool.package.json" || path === "tsconfig.json") {
    throw new Error(`Authored package may not write managed file: ${path}`);
  }
  if (!/^(index\.ts|runtime\/.+\.ts|src\/.+\.ts|tests\/.+\.test\.ts)$/.test(path)) {
    throw new Error(`Authored package path is outside the allowed TypeScript package surface: ${path}`);
  }
  return path;
}

function validateContent(path: string, content: string): void {
  if (content.length > 80_000) throw new Error(`${path} is too large.`);
  const lower = content.toLowerCase();
  if (lower.includes("from \"../../../") || lower.includes("from '../../../") || lower.includes("@/") || lower.includes("agentic-rewrite-next")) {
    throw new Error(`${path} appears to import Agentic app internals.`);
  }
  if (/sk-[a-z0-9]{20,}/i.test(content) || /(api[_-]?key|token|secret)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(content)) {
    throw new Error(`${path} appears to contain a raw secret.`);
  }
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("LLM authoring response did not contain JSON.");
    return JSON.parse(candidate.slice(start, end + 1));
  }
}
