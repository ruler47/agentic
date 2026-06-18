import { existsSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve, relative, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { Tool } from "./tool.js";
import type { ToolModuleMetadata } from "./toolMetadataStore.js";

const execFileAsync = promisify(execFile);

export function compiledModulePath(modulePath: string): string {
  return modulePath
    .replace(/^src\//, "dist/")
    .replace(/\.ts$/, ".js");
}

export function exportedTool(imported: Record<string, unknown>): Tool {
  const candidate = imported.default ?? imported.tool;
  if (isTool(candidate)) return candidate;

  for (const value of Object.values(imported)) {
    if (isTool(value)) return value;
  }

  throw new Error("Generated module must export a Tool as default, `tool`, or a named Tool export.");
}

export function validateToolAgainstMetadata(tool: Tool, metadata: ToolModuleMetadata): void {
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

export function safePackagePath(root: string, ref: string): string {
  if (isAbsolute(ref)) throw new Error("Source-bundle package.ref must be relative to TOOL_PACKAGE_ROOT.");
  const resolved = resolve(root, ref);
  const rel = relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Source-bundle package.ref must stay inside TOOL_PACKAGE_ROOT.");
  }
  return resolved;
}

export function findSourceBundlePackage(
  projectRoot: string,
  packageRoots: string[],
  ref: string,
  entrypoints: string[],
): { packageDir: string; moduleFile?: string } | undefined {
  const candidates = packageRoots.map((root) => {
    const packageDir = safePackagePath(resolve(projectRoot, root), ref);
    return {
      packageDir,
      moduleFile: firstExisting(entrypoints.map((entrypoint) => join(packageDir, entrypoint))),
    };
  });
  return candidates.find((candidate) => candidate.moduleFile);
}

export function findSourceBundlePackageDir(
  projectRoot: string,
  packageRoots: string[],
  ref: string,
): string | undefined {
  return packageRoots
    .map((root) => safePackagePath(resolve(projectRoot, root), ref))
    .find((packageDir) => existsSync(join(packageDir, "package.json")));
}

type SourceBundleBuildResult = {
  ok: boolean;
  detail: string;
};

export async function buildSourceBundlePackage(
  projectRoot: string,
  packageRoots: string[],
  ref: string,
): Promise<SourceBundleBuildResult> {
  const packageDir = findSourceBundlePackageDir(projectRoot, packageRoots, ref);
  if (!packageDir) {
    return {
      ok: false,
      detail: `Source-bundle package ${ref} has no package.json under: ${packageRoots.join(", ")}`,
    };
  }

  try {
    await linkRootNodeModulesIfAvailable(projectRoot, packageDir);
    const { stdout, stderr } = await execFileAsync("npm", ["run", "build"], {
      cwd: packageDir,
      timeout: sourceBundleBuildTimeoutMs(),
      maxBuffer: 1024 * 1024,
    });
    const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim().replace(/\s+/g, " ").slice(-500);
    return {
      ok: true,
      detail: `Built source-bundle package ${ref}${output ? `: ${output}` : ""}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `Source-bundle package ${ref} build failed: ${commandErrorDetail(error)}`,
    };
  }
}

async function linkRootNodeModulesIfAvailable(projectRoot: string, packageDir: string): Promise<void> {
  const packageNodeModules = join(packageDir, "node_modules");
  if (existsSync(packageNodeModules)) return;

  const rootNodeModules = join(resolve(projectRoot), "node_modules");
  if (!existsSync(rootNodeModules)) return;

  await symlink(rootNodeModules, packageNodeModules, "dir");
}

export function commandErrorDetail(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const detail = error as { message?: string; stdout?: string | Buffer; stderr?: string | Buffer };
  const output = `${detail.stdout ?? ""}\n${detail.stderr ?? ""}`.trim().replace(/\s+/g, " ").slice(-800);
  return redactRuntimeText(output || detail.message || String(error));
}

export function sourceBundleAutoBuildEnabled(): boolean {
  return process.env.TOOL_SOURCE_BUNDLE_AUTO_BUILD !== "disabled";
}

function sourceBundleBuildTimeoutMs(): number {
  const value = Number(process.env.TOOL_SOURCE_BUNDLE_BUILD_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(value) && value > 0 ? value : 120_000;
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path));
}

export function defaultSourceBundleRoots(): string[] {
  if (process.env.TOOL_PACKAGE_ROOT) return [process.env.TOOL_PACKAGE_ROOT];
  if (process.env.TOOL_PACKAGE_WORKSPACE_ROOT) return [process.env.TOOL_PACKAGE_WORKSPACE_ROOT];
  return ["tools", "tool-packages"];
}

export function redactRuntimeText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization|credential)\b\s*[:=]\s*['"]?[^'"\s,;)}]+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{8,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted-token]");
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
