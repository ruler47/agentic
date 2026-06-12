import { existsSync } from "node:fs";
import { readFile, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { normalizeToolPackageManifest } from "./toolPackage.js";
import type { ArtifactCreateInput } from "../types.js";
import { inspectScreenshotArtifact } from "../artifacts/visualArtifactQuality.js";
import type { ToolStartupMode } from "./tool.js";
import {
  defaultSourceBundleRoots,
  exportedTool,
  findSourceBundlePackage,
} from "./toolPackageRunnerShared.js";

export type ToolPackageWorkspaceQaInput = {
  packageRef: string;
  manifestPath: string;
  files: string[];
};

export type ToolPackageWorkspaceQaReport = {
  ok: boolean;
  summary: string;
  checks: string[];
  warnings?: string[];
  issues?: ToolPackageWorkspaceQaIssue[];
  requiresManualLiveVerification?: boolean;
};

export type ToolPackageWorkspaceQaIssueKind =
  | "transient_network"
  | "provider_blocked"
  | "auth_missing"
  | "semantic_mismatch"
  | "tool_bug";

export type ToolPackageWorkspaceQaIssue = {
  phase: "behavior";
  kind: ToolPackageWorkspaceQaIssueKind;
  severity: "warning" | "error";
  label: string;
  detail: string;
  attempts: number;
  live: boolean;
};

export type ToolPackageBehaviorExpectation = {
  expectedOk?: boolean;
  expectedContent?: string;
  expectedContentIncludes?: string;
  expectedDataPath?: string;
  expectedDataEquals?: unknown;
  expectedDataIncludes?: string;
  expectedArtifactMimeType?: string;
  expectedArtifactVisualOk?: boolean;
};

export type ToolPackageBehaviorStep = ToolPackageBehaviorExpectation & {
  title?: string;
  input: Record<string, unknown>;
  saveAs?: string;
};

export type ToolPackageBehaviorExample = ToolPackageBehaviorExpectation & {
  title?: string;
  input?: Record<string, unknown>;
  steps?: ToolPackageBehaviorStep[];
};

export type ToolPackageWorkspaceBuildQaOptions = {
  linkNodeModulesFrom?: string;
  timeoutMs?: number;
  runBuild?: boolean;
  runTests?: boolean;
  installRuntimeDependencies?: boolean;
  behaviorExamples?: ToolPackageBehaviorExample[];
};

type RunnablePackageTool = {
  startupMode?: ToolStartupMode;
  run: (input: Record<string, unknown>, context?: unknown) => unknown;
  startService?: (context?: unknown) => unknown;
};

type BehaviorFailure = {
  detail: string;
  issue: ToolPackageWorkspaceQaIssue;
};

type BehaviorResult = {
  ok: boolean;
  checks: string[];
  warnings: string[];
  issues: ToolPackageWorkspaceQaIssue[];
  requiresManualLiveVerification: boolean;
  detail?: string;
};

const liveBehaviorMaxAttempts = 3;

export async function validateToolPackageWorkspace(
  projectRoot: string,
  workspace: ToolPackageWorkspaceQaInput,
): Promise<ToolPackageWorkspaceQaReport> {
  const checks: string[] = [];

  try {
    const manifestPath = safeProjectPath(projectRoot, workspace.manifestPath);
    const manifest = normalizeToolPackageManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    if (manifest.package.type !== "source-bundle") {
      return fail(checks, `Package manifest must be source-bundle, got ${manifest.package.type}.`);
    }
    if (manifest.package.ref !== workspace.packageRef) {
      return fail(checks, `Package manifest ref ${manifest.package.ref} does not match ${workspace.packageRef}.`);
    }
    checks.push(`package manifest ok: ${workspace.manifestPath}`);

    const packageDir = manifestPath.slice(0, -"/tool.package.json".length);
    const requiredFiles = [
      "index.ts",
      "package.json",
      "tsconfig.json",
      "Dockerfile",
      "README.md",
      "src/tools/tool.ts",
    ];
    for (const file of requiredFiles) {
      const path = join(packageDir, file);
      await readFile(path, "utf8");
      checks.push(`required package file present: ${relative(projectRoot, path).replace(/\\/g, "/")}`);
    }

    const toolContract = await readFile(join(packageDir, "src/tools/tool.ts"), "utf8");
    if (!toolContract.includes("export type Tool =")) {
      return fail(checks, "Package-local Tool contract is missing `export type Tool =`.");
    }
    checks.push("package-local Tool contract ok");

    if (!workspace.files.some((file) => file.startsWith(`${packageDirRelative(workspace.manifestPath)}/src/`))) {
      return fail(checks, "Package workspace does not include generated source files.");
    }
    checks.push("package source snapshot present");

    return {
      ok: true,
      summary: `Package workspace ${workspace.packageRef} passed structural QA.`,
      checks,
    };
  } catch (error) {
    return fail(checks, error instanceof Error ? error.message : String(error));
  }
}

export async function validateAndBuildToolPackageWorkspace(
  projectRoot: string,
  workspace: ToolPackageWorkspaceQaInput,
  options: ToolPackageWorkspaceBuildQaOptions = {},
): Promise<ToolPackageWorkspaceQaReport> {
  const structural = await validateToolPackageWorkspace(projectRoot, workspace);
  if (!structural.ok) return structural;

  const checks = [...structural.checks];
  const packageDir = safeProjectPath(projectRoot, packageDirRelative(workspace.manifestPath));
  const manifest = normalizeToolPackageManifest(
    JSON.parse(await readFile(safeProjectPath(projectRoot, workspace.manifestPath), "utf8")),
  );

  try {
    const hasRuntimeDependencies = await packageHasRuntimeDependencies(packageDir);
    if (hasRuntimeDependencies && options.installRuntimeDependencies !== false) {
      const installResult = await runCommand("npm", ["install"], packageDir, options.timeoutMs);
      checks.push(formatCommandCheck("package-local npm install", installResult));
      if (!installResult.ok) {
        return fail(checks, `Package-local npm install failed for ${workspace.packageRef}.`);
      }
    } else {
      await linkNodeModulesIfAvailable(packageDir, options.linkNodeModulesFrom ?? projectRoot);
    }

    if (options.runBuild !== false) {
      const buildResult = await runCommand("npm", ["run", "build"], packageDir, options.timeoutMs);
      checks.push(formatCommandCheck("package-local TypeScript build", buildResult));
      if (!buildResult.ok) {
        return fail(checks, `Package-local TypeScript build failed for ${workspace.packageRef}.`);
      }
    }

    if (options.runTests !== false) {
      const testResult = await runCommand("npm", ["test"], packageDir, options.timeoutMs);
      checks.push(formatCommandCheck("package-local tests", testResult));
      if (!testResult.ok) {
        return fail(checks, `Package-local tests failed for ${workspace.packageRef}.`);
      }
    }

    const runtimeContract = await validateBuiltPackageRuntimeContract(packageDir, manifest.startupMode);
    checks.push(...runtimeContract.checks);
    if (!runtimeContract.ok) {
      return fail(checks, runtimeContract.detail);
    }

    if (options.behaviorExamples?.length) {
      const behaviorResult = await runBehaviorExamples(packageDir, options.behaviorExamples);
      checks.push(...behaviorResult.checks);
      const warnings = behaviorResult.warnings;
      if (!behaviorResult.ok) {
        return fail(
          checks,
          `Package behavior examples failed for ${workspace.packageRef}: ${behaviorResult.detail}`,
          {
            issues: behaviorResult.issues,
            warnings,
            requiresManualLiveVerification: behaviorResult.requiresManualLiveVerification,
          },
        );
      }
      if (warnings.length > 0 || behaviorResult.requiresManualLiveVerification) {
        return {
          ok: true,
          summary: `Package workspace ${workspace.packageRef} passed structural, build, test, and behavior QA with live verification warnings.`,
          checks,
          warnings,
          issues: behaviorResult.issues,
          requiresManualLiveVerification: behaviorResult.requiresManualLiveVerification,
        };
      }
    }

    return {
      ok: true,
      summary: options.behaviorExamples?.length
        ? `Package workspace ${workspace.packageRef} passed structural, build, test, and behavior QA.`
        : `Package workspace ${workspace.packageRef} passed structural, build, and test QA.`,
      checks,
    };
  } catch (error) {
    return fail(checks, error instanceof Error ? error.message : String(error));
  }
}

export async function validateSourceBundleRuntimeContract(
  projectRoot: string,
  packageRef: string,
  startupMode: ToolStartupMode,
): Promise<{ ok: boolean; detail: string; checks: string[] }> {
  if (startupMode !== "always-on") {
    return { ok: true, detail: "Runtime service contract not required for on-demand package.", checks: [] };
  }
  const found = findSourceBundlePackage(projectRoot, defaultSourceBundleRoots(), packageRef, [
    "dist/index.js",
    "index.js",
  ]);
  if (!found?.moduleFile) {
    return {
      ok: false,
      detail: `Source-bundle package ${packageRef} has no loadable dist/index.js or index.js.`,
      checks: [],
    };
  }
  return validateExportedToolRuntimeContract(found.moduleFile, startupMode);
}

async function validateBuiltPackageRuntimeContract(
  packageDir: string,
  startupMode: ToolStartupMode,
): Promise<{ ok: boolean; detail: string; checks: string[] }> {
  if (startupMode !== "always-on") {
    return {
      ok: true,
      detail: "Runtime service contract not required for on-demand package.",
      checks: [],
    };
  }
  return validateExportedToolRuntimeContract(join(packageDir, "dist/index.js"), startupMode);
}

async function validateExportedToolRuntimeContract(
  moduleFile: string,
  startupMode: ToolStartupMode,
): Promise<{ ok: boolean; detail: string; checks: string[] }> {
  const checks: string[] = [];
  try {
    const entryUrl = await freshToolModuleUrl(moduleFile, "runtime-contract");
    const moduleValue = await import(entryUrl) as Record<string, unknown>;
    const tool = exportedTool(moduleValue) as RunnablePackageTool;
    checks.push("package-local exported Tool runtime contract ok");
    if (startupMode === "always-on" && typeof tool.startService !== "function") {
      return {
        ok: false,
        detail: "Always-on generated tool packages must export a Tool with startService().",
        checks,
      };
    }
    if (startupMode === "always-on") {
      checks.push("always-on service startService hook present");
    }
    return { ok: true, detail: "Package runtime contract ok.", checks };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      checks,
    };
  }
}

async function runBehaviorExamples(
  packageDir: string,
  examples: ToolPackageBehaviorExample[],
): Promise<BehaviorResult> {
  const checks: string[] = [];
  const warnings: string[] = [];
  const issues: ToolPackageWorkspaceQaIssue[] = [];
  let requiresManualLiveVerification = false;
  const entryUrl = await freshToolModuleUrl(join(packageDir, "dist/index.js"), "qa");
  const moduleValue = await import(entryUrl) as { tool?: { run?: (input: Record<string, unknown>, context?: unknown) => unknown } };
  const tool = moduleValue.tool as RunnablePackageTool | undefined;
  if (!tool || typeof tool.run !== "function") {
    return { ok: false, checks, warnings, issues, requiresManualLiveVerification, detail: "dist/index.js does not export a runnable tool." };
  }

  for (const [index, example] of examples.entries()) {
    const label = example.title?.trim() || `behavior example ${index + 1}`;
    if (example.steps?.length) {
      const scenarioResult = await runBehaviorScenario(tool, label, example);
      checks.push(...scenarioResult.checks);
      warnings.push(...scenarioResult.warnings);
      issues.push(...scenarioResult.issues);
      requiresManualLiveVerification ||= scenarioResult.requiresManualLiveVerification;
      if (!scenarioResult.ok) {
        return { ok: false, checks, warnings, issues, requiresManualLiveVerification, detail: scenarioResult.detail };
      }
      continue;
    }
    const input = example.input;
    if (!input) {
      return { ok: false, checks, warnings, issues, requiresManualLiveVerification, detail: `${label} must include input or steps.` };
    }
    const stepResult = await runBehaviorStep(tool, label, { ...example, input }, {});
    checks.push(...stepResult.checks);
    if (stepResult.issue) issues.push(stepResult.issue);
    if (stepResult.warning) warnings.push(stepResult.warning);
    requiresManualLiveVerification ||= Boolean(stepResult.requiresManualLiveVerification);
    if (!stepResult.ok) {
      return { ok: false, checks, warnings, issues, requiresManualLiveVerification, detail: stepResult.detail };
    }
    checks.push(`package behavior example passed: ${label}`);
  }

  return { ok: true, checks, warnings, issues, requiresManualLiveVerification };
}

async function freshToolModuleUrl(entryModuleFile: string, label: string): Promise<string> {
  const source = await readFile(entryModuleFile, "utf8").catch(() => "");
  const reExport = source.match(/from\s+["'](\.\/src\/tools\/generated\/[^"']+\.js)["']/);
  const moduleFile = reExport ? join(dirname(entryModuleFile), reExport[1]) : entryModuleFile;
  return `${pathToFileURL(moduleFile).href}?${label}=${Date.now()}-${Math.random()}`;
}

async function runBehaviorScenario(
  tool: RunnablePackageTool,
  label: string,
  example: ToolPackageBehaviorExample,
): Promise<BehaviorResult> {
  const checks: string[] = [];
  const warnings: string[] = [];
  const issues: ToolPackageWorkspaceQaIssue[] = [];
  let requiresManualLiveVerification = false;
  const state: Record<string, unknown> = {};
  for (const [stepIndex, step] of (example.steps ?? []).entries()) {
    const stepLabel = `${label} step ${stepIndex + 1}${step.title ? ` (${step.title})` : ""}`;
    const result = await runBehaviorStep(tool, stepLabel, step, state);
    checks.push(...result.checks);
    if (result.issue) issues.push(result.issue);
    if (result.warning) warnings.push(result.warning);
    requiresManualLiveVerification ||= Boolean(result.requiresManualLiveVerification);
    if (!result.ok) return { ok: false, checks, warnings, issues, requiresManualLiveVerification, detail: result.detail };
    if (result.record) {
      state[`step${stepIndex + 1}`] = result.record;
      state.previous = result.record;
      if (step.saveAs) state[step.saveAs] = result.record;
    }
    checks.push(`package behavior scenario step passed: ${stepLabel}`);
  }
  checks.push(`package behavior scenario passed: ${label}`);
  return { ok: true, checks, warnings, issues, requiresManualLiveVerification };
}

async function runBehaviorStep(
  tool: RunnablePackageTool,
  label: string,
  expectation: ToolPackageBehaviorExpectation & { input: Record<string, unknown> },
  state: Record<string, unknown>,
): Promise<{
  ok: boolean;
  checks: string[];
  detail?: string;
  record?: { ok?: unknown; content?: unknown; data?: unknown };
  issue?: ToolPackageWorkspaceQaIssue;
  warning?: string;
  requiresManualLiveVerification?: boolean;
}> {
  const checks: string[] = [];
  const input = resolveBehaviorInput(expectation.input, state);
  const live = isLiveBehaviorInput(input);
  const maxAttempts = live ? liveBehaviorMaxAttempts : 1;
  let lastFailure: BehaviorFailure | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runBehaviorStepAttempt(tool, label, expectation, input, live, attempt);
    checks.push(...result.checks);
    if (result.ok) {
      if (attempt > 1) checks.push(`package live behavior retry recovered: ${label} attempt ${attempt}/${maxAttempts}`);
      return { ok: true, checks, record: result.record };
    }
    lastFailure = result.failure;
    if (!result.failure || !shouldRetryLiveBehavior(result.failure.issue.kind) || attempt >= maxAttempts) break;
    checks.push(`package live behavior retry scheduled: ${label} attempt ${attempt}/${maxAttempts} failed as ${result.failure.issue.kind}`);
    await delay(150 * attempt);
  }

  if (lastFailure && canDeferToManualLiveVerification(lastFailure.issue)) {
    const warning = `${label} needs manual live verification after ${lastFailure.issue.attempts} attempt(s): ${lastFailure.detail}`;
    return {
      ok: true,
      checks: [...checks, `package live behavior needs manual verification: ${label} (${lastFailure.issue.kind})`],
      warning,
      issue: { ...lastFailure.issue, severity: "warning" },
      requiresManualLiveVerification: true,
    };
  }

  return {
    ok: false,
    checks,
    detail: lastFailure?.detail ?? `${label} behavior check failed.`,
    issue: lastFailure?.issue,
  };
}

async function runBehaviorStepAttempt(
  tool: RunnablePackageTool,
  label: string,
  expectation: ToolPackageBehaviorExpectation & { input: Record<string, unknown> },
  input: Record<string, unknown>,
  live: boolean,
  attempt: number,
): Promise<{ ok: true; checks: string[]; record: { ok?: unknown; content?: unknown; data?: unknown } } | { ok: false; checks: string[]; failure: BehaviorFailure }> {
  const checks: string[] = [];
  let result: unknown;
  try {
    result = await tool.run(input, { caller: "package-behavior-qa", now: new Date() }) as unknown;
  } catch (error) {
    const detail = `${label} threw during behavior QA: ${error instanceof Error ? error.message : String(error)}.`;
    return { ok: false, checks, failure: classifyBehaviorFailure(label, detail, input, live, attempt) };
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    const detail = `${label} returned a non-object result.`;
    return { ok: false, checks, failure: classifyBehaviorFailure(label, detail, input, live, attempt) };
  }
  const record = result as { ok?: unknown; content?: unknown; data?: unknown };
  const ok = record.ok === true;
  const content = typeof record.content === "string" ? record.content : "";
  const expectedOk = expectation.expectedOk ?? true;
  if (ok !== expectedOk) {
    const detail = `${label} expected ok=${expectedOk} but got ok=${String(record.ok)}${content ? ` with content ${JSON.stringify(content.slice(0, 500))}` : ""}.`;
    return { ok: false, checks, failure: classifyBehaviorFailure(label, detail, input, live, attempt, record) };
  }
  if (expectation.expectedContent !== undefined && content !== expectation.expectedContent) {
    const detail = `${label} expected content ${JSON.stringify(expectation.expectedContent)} but got ${JSON.stringify(content)}.`;
    return { ok: false, checks, failure: classifyBehaviorFailure(label, detail, input, live, attempt, record) };
  }
  if (expectation.expectedContentIncludes !== undefined && !content.includes(expectation.expectedContentIncludes)) {
    const detail = `${label} expected content to include ${JSON.stringify(expectation.expectedContentIncludes)} but got ${JSON.stringify(content)}.`;
    return { ok: false, checks, failure: classifyBehaviorFailure(label, detail, input, live, attempt, record) };
  }
  if (expectation.expectedDataPath !== undefined) {
    const dataValue = readDottedPath(record.data, expectation.expectedDataPath);
    if (dataValue === undefined) {
      const detail = `${label} expected data path ${expectation.expectedDataPath} but it was missing.`;
      return { ok: false, checks, failure: classifyBehaviorFailure(label, detail, input, live, attempt, record) };
    }
    if (Object.prototype.hasOwnProperty.call(expectation, "expectedDataEquals") && !deepEqual(dataValue, expectation.expectedDataEquals)) {
      const detail = `${label} expected data ${expectation.expectedDataPath} to equal ${JSON.stringify(expectation.expectedDataEquals)} but got ${JSON.stringify(dataValue)}.`;
      return { ok: false, checks, failure: classifyBehaviorFailure(label, detail, input, live, attempt, record) };
    }
    if (expectation.expectedDataIncludes !== undefined && !String(dataValue).includes(expectation.expectedDataIncludes)) {
      const detail = `${label} expected data ${expectation.expectedDataPath} to include ${JSON.stringify(expectation.expectedDataIncludes)} but got ${JSON.stringify(dataValue)}.`;
      return { ok: false, checks, failure: classifyBehaviorFailure(label, detail, input, live, attempt, record) };
    }
  }
  const artifact = extractBehaviorArtifact(record);
  if (expectation.expectedArtifactMimeType !== undefined) {
    if (!artifact) {
      const detail = `${label} expected artifact ${expectation.expectedArtifactMimeType} but got no artifact.`;
      return { ok: false, checks, failure: classifyBehaviorFailure(label, detail, input, live, attempt, record) };
    }
    if (artifact.mimeType !== expectation.expectedArtifactMimeType) {
      const detail = `${label} expected artifact MIME ${expectation.expectedArtifactMimeType} but got ${artifact.mimeType}.`;
      return { ok: false, checks, failure: classifyBehaviorFailure(label, detail, input, live, attempt, record) };
    }
  }
  if (expectation.expectedArtifactVisualOk !== undefined) {
    if (!artifact) {
      const detail = `${label} expected visual artifact QA but got no artifact.`;
      return { ok: false, checks, failure: classifyBehaviorFailure(label, detail, input, live, attempt, record) };
    }
    const visual = inspectScreenshotArtifact(artifact);
    if (visual.ok !== expectation.expectedArtifactVisualOk) {
      const detail = `${label} expected visual artifact ok=${expectation.expectedArtifactVisualOk} but got ok=${visual.ok}: ${visual.reason}`;
      return { ok: false, checks, failure: classifyBehaviorFailure(label, detail, input, live, attempt, record) };
    }
    checks.push(`package behavior artifact visual QA ${visual.ok ? "passed" : "failed as expected"}: ${label}`);
  }
  return { ok: true, checks, record };
}

function classifyBehaviorFailure(
  label: string,
  detail: string,
  input: Record<string, unknown>,
  live: boolean,
  attempt: number,
  record?: { ok?: unknown; content?: unknown; data?: unknown },
): BehaviorFailure {
  const combined = `${detail} ${typeof record?.content === "string" ? record.content : ""}`.toLowerCase();
  const kind: ToolPackageWorkspaceQaIssueKind =
    /\bexpected (content|data|artifact|visual artifact|artifact mime)\b/.test(combined)
      ? "semantic_mismatch"
      : /\b(missing|required)\b.*\b(secret|api key|token|credential|authorization|auth)\b|\b401\b|\b403\b/.test(combined)
      ? "auth_missing"
      : /\b(429|rate limit|too many requests|captcha|cloudflare|blocked|forbidden|access denied|consent|cookie)\b/.test(combined)
        ? "provider_blocked"
      : /\b(fetch failed|network|timeout|timed out|abort|aborted|econnreset|econnrefused|etimedout|eai_again|enotfound|socket|und_err|http 5\d\d|502|503|504)\b/.test(combined)
        ? "transient_network"
      : /\bexpected\b/.test(combined)
        ? "semantic_mismatch"
      : "tool_bug";
  return {
    detail,
    issue: {
      phase: "behavior",
      kind,
      severity: canDeferToManualLiveVerificationKind(kind, live) ? "warning" : "error",
      label,
      detail,
      attempts: attempt,
      live,
    },
  };
}

function shouldRetryLiveBehavior(kind: ToolPackageWorkspaceQaIssueKind): boolean {
  return kind === "transient_network" || kind === "provider_blocked";
}

function canDeferToManualLiveVerification(issue: ToolPackageWorkspaceQaIssue): boolean {
  return canDeferToManualLiveVerificationKind(issue.kind, issue.live);
}

function canDeferToManualLiveVerificationKind(kind: ToolPackageWorkspaceQaIssueKind, live: boolean): boolean {
  return live && (kind === "transient_network" || kind === "provider_blocked" || kind === "auth_missing");
}

function isLiveBehaviorInput(input: Record<string, unknown>): boolean {
  let hasExternalUrl = false;
  let hasExternalOperationHint = false;
  visitInput(input, (value) => {
    if (typeof value !== "string") return;
    try {
      const url = new URL(value);
      if ((url.protocol === "http:" || url.protocol === "https:") && !isLocalHostname(url.hostname)) {
        hasExternalUrl = true;
      }
    } catch {
      // Ignore non-URL strings.
    }
  });
  if (typeof input.query === "string" && input.query.trim()) hasExternalOperationHint = true;
  if (typeof input.operationId === "string" && input.operationId.trim()) hasExternalOperationHint = true;
  return hasExternalUrl || hasExternalOperationHint;
}

function visitInput(value: unknown, visit: (value: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) visitInput(item, visit);
    return;
  }
  if (isRecord(value)) {
    for (const nested of Object.values(value)) visitInput(nested, visit);
  }
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname.endsWith(".localhost");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function resolveBehaviorInput(value: unknown, state: Record<string, unknown>): Record<string, unknown> {
  const resolved = resolvePlaceholders(value, state);
  return isRecord(resolved) ? resolved : {};
}

function resolvePlaceholders(value: unknown, state: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/u);
    if (exact?.[1]) return readDottedPath(state, exact[1]);
    return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/gu, (_match, path: string) => {
      const resolved = readDottedPath(state, path);
      return resolved === undefined ? "" : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolvePlaceholders(item, state));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, resolvePlaceholders(nested, state)]));
  }
  return value;
}

function readDottedPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".").filter(Boolean)) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function extractBehaviorArtifact(record: { data?: unknown }): ArtifactCreateInput | undefined {
  const data = isRecord(record.data) ? record.data : undefined;
  const raw = isRecord(data?.artifact) ? data.artifact : undefined;
  if (!raw) return undefined;
  const mimeType = typeof raw.mimeType === "string" ? raw.mimeType : undefined;
  if (!mimeType) return undefined;
  const filename = typeof raw.filename === "string" && raw.filename.trim() ? raw.filename.trim() : "artifact";
  const description = typeof raw.description === "string" ? raw.description : undefined;
  const contentBase64 = typeof raw.contentBase64 === "string" ? raw.contentBase64 : undefined;
  const content = Buffer.isBuffer(raw.content)
    ? raw.content
    : typeof raw.content === "string"
      ? Buffer.from(raw.content)
      : contentBase64
        ? Buffer.from(contentBase64, "base64")
        : undefined;
  if (!content) return undefined;
  return {
    filename,
    mimeType,
    content,
    description,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(
  checks: string[],
  detail: string,
  extra: Pick<ToolPackageWorkspaceQaReport, "issues" | "warnings" | "requiresManualLiveVerification"> = {},
): ToolPackageWorkspaceQaReport {
  return {
    ok: false,
    summary: `Package workspace QA failed: ${detail}`,
    checks: [...checks, `failed: ${detail}`],
    ...(extra.warnings?.length ? { warnings: extra.warnings } : {}),
    ...(extra.issues?.length ? { issues: extra.issues } : {}),
    ...(extra.requiresManualLiveVerification ? { requiresManualLiveVerification: true } : {}),
  };
}

function safeProjectPath(projectRoot: string, filePath: string): string {
  if (filePath.includes("..") || filePath.includes("\\") || isAbsolute(filePath)) {
    throw new Error(`Package workspace path must be project-relative: ${filePath}`);
  }
  const root = resolve(projectRoot);
  const absolutePath = resolve(root, filePath);
  const rel = relative(root, absolutePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Package workspace path escapes project root: ${filePath}`);
  }
  return absolutePath;
}

function packageDirRelative(manifestPath: string): string {
  return manifestPath.replace(/\/tool\.package\.json$/, "");
}

type CommandResult = {
  ok: boolean;
  exitCode: number | null;
  output: string;
};

async function linkNodeModulesIfAvailable(packageDir: string, dependencyRoot: string): Promise<void> {
  const packageNodeModules = join(packageDir, "node_modules");
  if (existsSync(packageNodeModules)) return;

  const rootNodeModules = join(resolve(dependencyRoot), "node_modules");
  if (!existsSync(rootNodeModules)) return;

  await symlink(rootNodeModules, packageNodeModules, "dir");
}

async function packageHasRuntimeDependencies(packageDir: string): Promise<boolean> {
  const packageJson = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, unknown>;
  };
  return Object.keys(packageJson.dependencies ?? {}).length > 0;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
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
      resolveCommand({ ok: false, exitCode: null, output: `Command timed out after ${timeoutMs} ms.` });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveCommand({ ok: false, exitCode: null, output: error.message });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const output = Buffer.concat(chunks).toString("utf8").slice(-6000);
      resolveCommand({ ok: exitCode === 0, exitCode, output });
    });
  });
}

function formatCommandCheck(label: string, result: CommandResult): string {
  const status = result.ok ? "passed" : "failed";
  const output = result.output.trim().replace(/\s+/g, " ").slice(0, 500);
  return `${label} ${status} with exit ${result.exitCode ?? "none"}${output ? `: ${output}` : ""}`;
}
