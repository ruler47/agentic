import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ToolModuleMetadata } from "../../../tools/toolMetadataStore.js";
import type { ToolPackageWorkspaceFile } from "../../../tools/toolPackageWorkspaceStore.js";
import { isRecord, parseRequiredText } from "../../common/parsers.js";

export const STANDARD_SOURCE_BUNDLE_FILES = new Set([
  "tool.package.json",
  "README.md",
  "Dockerfile",
  "package.json",
  "tsconfig.json",
  ".gitignore",
]);

export function dependencyRecords(dependencies: Record<string, string>) {
  return Object.entries(dependencies).map(([name, versionRange]) => ({ name, versionRange }));
}

export async function readSourceBundleDependenciesForTool(
  tool: ToolModuleMetadata,
): Promise<Record<string, string>> {
  const manifest = tool.packageManifest;
  if (!manifest || manifest.package.type !== "source-bundle") return {};
  try {
    const packageDir = sourceBundlePackageDir(
      process.cwd(),
      process.env.TOOL_PACKAGE_WORKSPACE_ROOT ?? "tools",
      manifest.package.ref,
    );
    return packageJsonDependencies(await readFile(join(packageDir, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

export function packageJsonDependencies(content: string | undefined): Record<string, string> {
  if (!content) return {};
  const parsed = JSON.parse(content) as { dependencies?: Record<string, string> };
  return parsed.dependencies ?? {};
}

export function parseJsonFile(content: string | undefined, label: string): Record<string, unknown> | undefined {
  if (!content) return undefined;
  try {
    const parsed = JSON.parse(content);
    if (!isRecord(parsed)) throw new Error(`${label} must contain a JSON object`);
    return parsed;
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseSourceBundleFiles(value: unknown[]): ToolPackageWorkspaceFile[] {
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`files[${index}] must be an object`);
    const path = parseRequiredText(item.path, `files[${index}].path`);
    if (isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "")) {
      throw new Error(`files[${index}].path must stay inside the source bundle`);
    }
    return {
      path,
      content: parseRequiredText(item.content, `files[${index}].content`),
    };
  });
}

export function sourceBundlePackageDir(projectRoot: string, workspaceRoot: string, packageRef: string): string {
  if (isAbsolute(packageRef) || packageRef.includes("\\") || packageRef.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("source-bundle package ref must stay inside the tool package workspace");
  }
  const root = resolve(projectRoot, workspaceRoot);
  const absolute = resolve(root, packageRef);
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("source-bundle package ref escapes the tool package workspace");
  }
  return absolute;
}

export async function readSourceBundleFiles(packageDir: string): Promise<ToolPackageWorkspaceFile[]> {
  const files: ToolPackageWorkspaceFile[] = [];
  await readSourceBundleFilesInto(packageDir, packageDir, files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function readSourceBundleFilesInto(
  root: string,
  currentDir: string,
  out: ToolPackageWorkspaceFile[],
): Promise<void> {
  for (const entry of await readdir(currentDir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const absolute = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await readSourceBundleFilesInto(root, absolute, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const path = relative(root, absolute).replace(/\\/g, "/");
    out.push({ path, content: await readFile(absolute, "utf8") });
  }
}
