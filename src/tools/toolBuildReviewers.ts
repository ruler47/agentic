import { ToolBuildOutput, ToolBuildReviewer } from "./toolBuildWorkflow.js";
import {
  ToolBuildQaReport,
  ToolBuildRequest,
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
