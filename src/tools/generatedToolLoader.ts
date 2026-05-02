import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Tool } from "./tool.js";
import { ToolRegistry } from "./registry.js";
import { ToolMetadataStore, ToolModuleMetadata } from "./toolMetadataStore.js";

export type GeneratedToolLoadResult = {
  name: string;
  loaded: boolean;
  detail: string;
};

export async function loadGeneratedTools(
  registry: ToolRegistry,
  metadataStore: ToolMetadataStore,
  projectRoot = process.cwd(),
): Promise<GeneratedToolLoadResult[]> {
  const modules = (await metadataStore.list()).filter((item) => item.source === "generated");
  const results: GeneratedToolLoadResult[] = [];

  for (const module of modules) {
    const result = await loadGeneratedTool(module, registry, metadataStore, projectRoot);
    results.push(result);
  }

  return results;
}

async function loadGeneratedTool(
  metadata: ToolModuleMetadata,
  registry: ToolRegistry,
  metadataStore: ToolMetadataStore,
  projectRoot: string,
): Promise<GeneratedToolLoadResult> {
  if (!metadata.modulePath) {
    const detail = "Generated tool metadata has no modulePath.";
    await metadataStore.updateHealth(metadata.name, { ok: false, detail });
    return { name: metadata.name, loaded: false, detail };
  }

  const moduleFile = resolve(projectRoot, compiledModulePath(metadata.modulePath));
  if (!existsSync(moduleFile)) {
    const detail = `Compiled generated module not found: ${moduleFile}`;
    await metadataStore.updateHealth(metadata.name, { ok: false, detail });
    return { name: metadata.name, loaded: false, detail };
  }

  try {
    const imported = await import(pathToFileURL(moduleFile).href);
    const tool = exportedTool(imported);
    validateToolAgainstMetadata(tool, metadata);
    const health = tool.healthcheck ? await tool.healthcheck() : { ok: true, detail: "No healthcheck registered." };
    await metadataStore.updateHealth(metadata.name, health);

    if (!health.ok) {
      return { name: metadata.name, loaded: false, detail: health.detail };
    }

    registry.register(tool);
    return { name: metadata.name, loaded: true, detail: `Loaded ${metadata.name} from ${moduleFile}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await metadataStore.updateHealth(metadata.name, { ok: false, detail });
    return { name: metadata.name, loaded: false, detail };
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
