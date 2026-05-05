import { existsSync } from "node:fs";
import { readFile, symlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
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

export type ToolPackageWorkspaceBuildQaOptions = {
  linkNodeModulesFrom?: string;
  timeoutMs?: number;
  runBuild?: boolean;
  runTests?: boolean;
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

  try {
    await linkNodeModulesIfAvailable(packageDir, options.linkNodeModulesFrom ?? projectRoot);

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

    return {
      ok: true,
      summary: `Package workspace ${workspace.packageRef} passed structural, build, and test QA.`,
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
