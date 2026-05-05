import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Tool, ToolHealth } from "./tool.js";
import { ToolModuleMetadata } from "./toolMetadataStore.js";
import { ToolPackageReferenceType } from "./toolPackage.js";

export type ToolPackageLoadResult = {
  loaded: boolean;
  detail: string;
  tool?: Tool;
  health?: ToolHealth;
};

export type ToolPackageRunner = {
  type: ToolPackageReferenceType | "legacy-local-path";
  canLoad(metadata: ToolModuleMetadata): boolean;
  load(metadata: ToolModuleMetadata, projectRoot: string): Promise<ToolPackageLoadResult>;
};

export class LocalPathToolPackageRunner implements ToolPackageRunner {
  readonly type = "local-path";

  canLoad(metadata: ToolModuleMetadata): boolean {
    const packageType = metadata.packageManifest?.package.type;
    return packageType === "local-path" || (!packageType && Boolean(metadata.modulePath));
  }

  async load(metadata: ToolModuleMetadata, projectRoot: string): Promise<ToolPackageLoadResult> {
    const modulePath = metadata.modulePath ?? metadata.packageManifest?.package.ref;
    if (!modulePath) {
      return {
        loaded: false,
        detail: "Generated tool metadata has no modulePath or local package ref.",
        health: { ok: false, detail: "Generated tool metadata has no modulePath or local package ref." },
      };
    }

    const moduleFile = resolve(projectRoot, compiledModulePath(modulePath));
    if (!existsSync(moduleFile)) {
      const detail = `Compiled generated module not found: ${moduleFile}`;
      return { loaded: false, detail, health: { ok: false, detail } };
    }

    const imported = await import(pathToFileURL(moduleFile).href);
    const tool = exportedTool(imported);
    validateToolAgainstMetadata(tool, metadata);
    const health = tool.healthcheck ? await tool.healthcheck() : { ok: true, detail: "No healthcheck registered." };

    if (!health.ok) {
      return { loaded: false, detail: health.detail, health };
    }

    return { loaded: true, detail: `Loaded ${metadata.name} from ${moduleFile}`, tool, health };
  }
}

export function compiledModulePath(modulePath: string): string {
  return modulePath
    .replace(/^src\//, "dist/")
    .replace(/\.ts$/, ".js");
}

function exportedTool(imported: Record<string, unknown>): Tool {
  const candidate = imported.default ?? imported.tool;
  if (isTool(candidate)) return candidate;

  for (const value of Object.values(imported)) {
    if (isTool(value)) return value;
  }

  throw new Error("Generated module must export a Tool as default, `tool`, or a named Tool export.");
}

function validateToolAgainstMetadata(tool: Tool, metadata: ToolModuleMetadata): void {
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
