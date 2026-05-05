import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { normalizeToolPackageManifest } from "./toolPackage.js";

export type ToolPackageWorkspaceQaInput = {
  packageRef: string;
  manifestPath: string;
  files: string[];
};

export type ToolPackageWorkspaceQaReport = {
  ok: boolean;
  summary: string;
  checks: string[];
};

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

function fail(checks: string[], detail: string): ToolPackageWorkspaceQaReport {
  return {
    ok: false,
    summary: `Package workspace QA failed: ${detail}`,
    checks: [...checks, `failed: ${detail}`],
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
