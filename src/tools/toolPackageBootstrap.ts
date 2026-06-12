import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  generatedToolInputFromPackageManifest,
  type ToolMetadataStore,
} from "./toolMetadataStore.js";
import { normalizeToolPackageManifest, type ToolPackageManifest } from "./toolPackage.js";

export type ToolPackageBootstrapResult = {
  name: string;
  version?: string;
  manifestPath: string;
  registered: boolean;
  detail: string;
};

export type ToolPackageBootstrapOptions = {
  projectRoot?: string;
  packageRoots?: string[];
};

const MANIFEST_FILE = "tool.package.json";
const MAX_SCAN_DEPTH = 6;
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".turbo"]);

export async function bootstrapGeneratedToolPackages(
  metadataStore: ToolMetadataStore,
  options: ToolPackageBootstrapOptions = {},
): Promise<ToolPackageBootstrapResult[]> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const roots = options.packageRoots ?? defaultGeneratedToolPackageRoots();
  const manifests = await discoverToolPackageManifests(projectRoot, roots);
  const results: ToolPackageBootstrapResult[] = [];
  const parsedManifests: Array<{ manifestPath: string; manifest: ToolPackageManifest }> = [];

  for (const manifestPath of manifests) {
    try {
      const manifest = normalizeToolPackageManifest(
        JSON.parse(await readFile(manifestPath, "utf8")),
      );
      validateDiscoveredSourceBundle(manifest, manifestPath, projectRoot, roots);
      parsedManifests.push({ manifestPath, manifest });
    } catch (error) {
      results.push({
        name: manifestPath,
        manifestPath,
        registered: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  parsedManifests.sort((a, b) =>
    a.manifest.name.localeCompare(b.manifest.name) ||
    compareVersionsDesc(a.manifest.version, b.manifest.version) ||
    a.manifestPath.localeCompare(b.manifestPath),
  );

  for (const { manifestPath, manifest } of parsedManifests) {
    try {
      const registered = await metadataStore.registerGenerated(
        generatedToolInputFromPackageManifest(
          manifest,
          `Bootstrapped generated source-bundle package ${manifest.name}@${manifest.version} from ${MANIFEST_FILE}.`,
        ),
      );
      results.push({
        name: registered.name,
        version: registered.version,
        manifestPath,
        registered: true,
        detail: `Registered ${registered.name}@${registered.version} from ${manifestPath}.`,
      });
    } catch (error) {
      results.push({
        name: manifestPath,
        manifestPath,
        registered: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

export function defaultGeneratedToolPackageRoots(): string[] {
  if (process.env.TOOL_PACKAGE_ROOT) return [process.env.TOOL_PACKAGE_ROOT];
  if (process.env.TOOL_PACKAGE_WORKSPACE_ROOT) return [process.env.TOOL_PACKAGE_WORKSPACE_ROOT];
  return ["tools", "tool-packages"];
}

export async function discoverToolPackageManifests(
  projectRoot: string,
  packageRoots = defaultGeneratedToolPackageRoots(),
): Promise<string[]> {
  const manifests: string[] = [];
  for (const packageRoot of packageRoots) {
    await collectManifests(resolve(projectRoot, packageRoot), manifests, 0);
  }
  return [...new Set(manifests)].sort();
}

async function collectManifests(dir: string, manifests: string[], depth: number): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) return;

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  if (entries.some((entry) => entry.isFile() && entry.name === MANIFEST_FILE)) {
    manifests.push(join(dir, MANIFEST_FILE));
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIPPED_DIRS.has(entry.name)) continue;
    await collectManifests(join(dir, entry.name), manifests, depth + 1);
  }
}

function validateDiscoveredSourceBundle(
  manifest: ToolPackageManifest,
  manifestPath: string,
  projectRoot: string,
  packageRoots: string[],
): void {
  if (manifest.package.type !== "source-bundle") {
    throw new Error(`Bootstrap only imports source-bundle manifests, got ${manifest.package.type}.`);
  }
  if (isAbsolute(manifest.package.ref) || manifest.package.ref.includes("\\")) {
    throw new Error("source-bundle package.ref must be a relative POSIX path.");
  }
  const manifestDir = dirname(manifestPath);
  const matchesRoot = packageRoots.some((packageRoot) => {
    const absoluteRoot = resolve(projectRoot, packageRoot);
    const expectedDir = resolve(absoluteRoot, manifest.package.ref);
    const rel = relative(absoluteRoot, expectedDir);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
    return expectedDir === manifestDir;
  });
  if (!matchesRoot) {
    throw new Error(
      `Manifest package.ref ${manifest.package.ref} does not point to its directory under configured package roots.`,
    );
  }
  if (!manifest.qa?.summary || !/passed/i.test(manifest.qa.summary)) {
    throw new Error("Bootstrap requires a source-bundle manifest with successful package QA evidence.");
  }
  if ((manifest.qa.checks ?? []).some((check) => /^failed:/i.test(check) || / failed /i.test(check))) {
    throw new Error("Bootstrap skipped source-bundle manifest because its QA checks include a failure.");
  }
}

function compareVersionsDesc(a: string, b: string): number {
  const left = a.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const right = b.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (right[index] || 0) - (left[index] || 0);
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
}
