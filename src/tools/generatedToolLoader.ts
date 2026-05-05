import { ToolRegistry } from "./registry.js";
import { ToolMetadataStore, ToolModuleMetadata } from "./toolMetadataStore.js";
import {
  compiledModulePath,
  LocalPathToolPackageRunner,
  SourceBundleToolPackageRunner,
  ToolPackageRunner,
} from "./toolPackageRunner.js";

export type GeneratedToolLoadResult = {
  name: string;
  loaded: boolean;
  detail: string;
};

export async function loadGeneratedTools(
  registry: ToolRegistry,
  metadataStore: ToolMetadataStore,
  projectRoot = process.cwd(),
  runners: ToolPackageRunner[] = [
    new LocalPathToolPackageRunner(),
    new SourceBundleToolPackageRunner(),
  ],
): Promise<GeneratedToolLoadResult[]> {
  const modules = (await metadataStore.list()).filter((item) => item.source === "generated");
  const results: GeneratedToolLoadResult[] = [];

  for (const module of modules) {
    const result = await loadGeneratedTool(module, registry, metadataStore, projectRoot, runners);
    results.push(result);
  }

  return results;
}

async function loadGeneratedTool(
  metadata: ToolModuleMetadata,
  registry: ToolRegistry,
  metadataStore: ToolMetadataStore,
  projectRoot: string,
  runners: ToolPackageRunner[],
): Promise<GeneratedToolLoadResult> {
  const runner = runners.find((candidate) => candidate.canLoad(metadata));
  if (!runner) {
    const packageType = metadata.packageManifest?.package.type ?? "legacy-local-path";
    return {
      name: metadata.name,
      loaded: false,
      detail: `No generated-tool runner is available for ${packageType} package references yet.`,
    };
  }

  try {
    const result = await runner.load(metadata, projectRoot);
    if (result.health) await metadataStore.updateHealth(metadata.name, result.health);

    if (!result.loaded) {
      return { name: metadata.name, loaded: false, detail: result.detail };
    }

    if (!result.tool) {
      const detail = `Runner ${runner.type} reported success without returning a Tool.`;
      await metadataStore.updateHealth(metadata.name, { ok: false, detail });
      return { name: metadata.name, loaded: false, detail };
    }

    registry.register(result.tool);
    return { name: metadata.name, loaded: true, detail: result.detail };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await metadataStore.updateHealth(metadata.name, { ok: false, detail });
    return { name: metadata.name, loaded: false, detail };
  }
}

export { compiledModulePath };
