import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { LlmClient } from "../llm/client.js";
import { Message, ModelTier } from "../types.js";
import { extractJson } from "../utils/json.js";
import { ToolBuildOutput, ToolBuildReviewer } from "./toolBuildWorkflow.js";
import {
  ToolBuildQaReport,
  ToolBuildRequest,
  ToolBuildReviewDecision,
  ToolBuildReviewKind,
  ToolBuildReviewReport,
} from "./toolBuildRequestStore.js";

export class DeterministicToolCodeReviewer implements ToolBuildReviewer {
  async review(request: ToolBuildRequest, output: ToolBuildOutput): Promise<ToolBuildReviewReport> {
    const findings: string[] = [];

    if (!output.modulePath.startsWith("src/tools/generated/") || !output.modulePath.endsWith("Tool.ts")) {
      findings.push(`Generated module path must stay under src/tools/generated and end with Tool.ts: ${output.modulePath}`);
    }
    if (!output.testPath.startsWith("tests/generated/") || !output.testPath.endsWith("Tool.test.ts")) {
      findings.push(`Generated test path must stay under tests/generated and end with Tool.test.ts: ${output.testPath}`);
    }
    if (output.capabilities && !output.capabilities.includes(request.capability)) {
      findings.push(`Output capabilities must include requested capability ${request.capability}.`);
    }
    for (const handle of output.requiredSecretHandles ?? []) {
      if (looksLikeRawSecret(handle)) {
        findings.push("Required secret handles must be stable handles, not raw credential material.");
      }
    }
    if (output.packageManifest) {
      if (output.packageManifest.name !== request.contract.toolName) {
        findings.push("Package manifest name must match the requested tool name.");
      }
      if (output.packageManifest.version !== request.contract.version) {
        findings.push("Package manifest version must match the requested contract version.");
      }
      if (!output.packageManifest.capabilities.includes(request.capability)) {
        findings.push(`Package manifest capabilities must include ${request.capability}.`);
      }
      if (
        output.packageManifest.package.type === "local-path" &&
        output.packageManifest.package.ref !== output.modulePath
      ) {
        findings.push("Local package manifest reference must point at the generated module path.");
      }
    }

    return {
      kind: "code",
      decision: findings.length === 0 ? "pass" : "needs_revision",
      summary:
        findings.length === 0
          ? "Generated source contract passed deterministic code review."
          : "Generated source contract needs repair before promotion.",
      findings,
    };
  }
}

export class DeterministicToolBehaviorReviewer implements ToolBuildReviewer {
  async review(
    request: ToolBuildRequest,
    _output: ToolBuildOutput,
    qaReport: ToolBuildQaReport,
  ): Promise<ToolBuildReviewReport> {
    const findings: string[] = [];

    if (!qaReport.ok) {
      findings.push("QA report did not pass.");
    }
    if (qaReport.checks.length === 0) {
      findings.push("QA report must include at least one check.");
    }
    if (!qaMentions(qaReport, "test")) {
      findings.push("QA evidence must mention generated-tool tests.");
    }
    if (!qaMentions(qaReport, "build")) {
      findings.push("QA evidence must mention a TypeScript build check.");
    }
    return {
      kind: "behavior",
      decision: findings.length === 0 ? "pass" : "needs_revision",
      summary:
        findings.length === 0
          ? "Generated tool behavior passed deterministic QA evidence review."
          : "Generated tool behavior needs stronger QA evidence before promotion.",
      findings,
    };
  }
}

export type LlmToolBuildReviewerOptions = {
  kind?: ToolBuildReviewKind;
  modelTier?: ModelTier;
  projectRoot?: string;
  maxFileChars?: number;
};

export class LlmToolBuildReviewer implements ToolBuildReviewer {
  private readonly kind: ToolBuildReviewKind;
  private readonly modelTier: ModelTier;
  private readonly projectRoot: string;
  private readonly maxFileChars: number;

  constructor(
    private readonly llm: LlmClient,
    options: LlmToolBuildReviewerOptions = {},
  ) {
    this.kind = options.kind ?? "behavior";
    this.modelTier = options.modelTier ?? "L";
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.maxFileChars = options.maxFileChars ?? 18_000;
  }

  async review(
    request: ToolBuildRequest,
    output: ToolBuildOutput,
    qaReport: ToolBuildQaReport,
  ): Promise<ToolBuildReviewReport> {
    try {
      const messages = await this.buildMessages(request, output, qaReport);
      const raw = await this.llm.complete(messages, { modelTier: this.modelTier, temperature: 0 });
      return this.parseReview(raw);
    } catch (error) {
      return {
        kind: this.kind,
        decision: "needs_revision",
        summary: "LLM review could not produce a trusted pass decision.",
        findings: [error instanceof Error ? error.message : "Unknown LLM review failure."],
      };
    }
  }

  private async buildMessages(
    request: ToolBuildRequest,
    output: ToolBuildOutput,
    qaReport: ToolBuildQaReport,
  ): Promise<Message[]> {
    const moduleSource = await readProjectFilePreview(this.projectRoot, output.modulePath, this.maxFileChars);
    const testSource = await readProjectFilePreview(this.projectRoot, output.testPath, this.maxFileChars);
    return [
      {
        role: "system",
        content: [
          "You are a strict generated-tool reviewer.",
          "Review only the requested tool contract and generated evidence.",
          "Do not accept hidden side effects, raw secrets in source/tests, missing schemas, missing tests, weak behavior evidence, or tool code that imports Agentic internals beyond the public Tool contract.",
          "Return only JSON.",
        ].join("\n"),
      },
      {
        role: "user",
        content: `
Review kind: ${this.kind}

Tool build request:
${JSON.stringify(
  {
    id: request.id,
    capability: request.capability,
    displayName: request.displayName,
    reason: request.reason,
    feedback: request.feedback,
    startupMode: request.contract.startupMode,
    contract: request.contract,
  },
  null,
  2,
)}

Generated output metadata:
${JSON.stringify(output, null, 2)}

QA report:
${JSON.stringify(qaReport, null, 2)}

Generated module source:
\`\`\`ts
${moduleSource}
\`\`\`

Generated tests:
\`\`\`ts
${testSource}
\`\`\`

Return only JSON:
{
  "decision": "pass" | "needs_revision" | "fail",
  "summary": "one sentence",
  "findings": ["specific finding or empty when pass"]
}
`.trim(),
      },
    ];
  }

  private parseReview(raw: string): ToolBuildReviewReport {
    const value = extractJson(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("LLM review did not return a JSON object.");
    }
    const record = value as Record<string, unknown>;
    const decision = normalizeDecision(record.decision);
    const summary = typeof record.summary === "string" ? record.summary.trim() : "";
    const findings = Array.isArray(record.findings)
      ? record.findings.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
      : [];

    if (!decision) throw new Error("LLM review decision must be pass, needs_revision, or fail.");
    if (!summary) throw new Error("LLM review summary is required.");

    return {
      kind: this.kind,
      decision,
      summary,
      findings,
    };
  }
}

function qaMentions(qaReport: ToolBuildQaReport, text: string): boolean {
  const normalizedNeedle = normalize(text);
  const haystack = normalize([qaReport.summary, ...qaReport.checks].join("\n"));
  return normalizedNeedle
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .some((token) => haystack.includes(token));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function looksLikeRawSecret(value: string): boolean {
  return /(?:api[_-]?key|token|secret)[=:]/i.test(value) || /^[A-Za-z0-9_-]{32,}$/.test(value);
}

async function readProjectFilePreview(projectRoot: string, path: string, maxChars: number): Promise<string> {
  const absolutePath = resolve(projectRoot, path);
  const relativePath = relative(projectRoot, absolutePath);
  if (relativePath.startsWith("..") || relativePath === "" || absolutePath === projectRoot) {
    throw new Error(`Review file path escapes project root: ${path}`);
  }

  const content = await readFile(absolutePath, "utf8");
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n\n/* truncated: ${content.length - maxChars} chars omitted */`;
}

function normalizeDecision(value: unknown): ToolBuildReviewDecision | undefined {
  if (value === "pass" || value === "needs_revision" || value === "fail") return value;
  return undefined;
}
