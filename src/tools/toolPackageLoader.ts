import { bootstrapGeneratedToolPackages } from "./toolPackageBootstrap.js";
import type { ToolMetadataStore } from "./toolMetadataStore.js";
import type { ToolRegistry } from "./registry.js";
import { ExternalHttpToolPackageRunner } from "./toolPackageRunnerExternal.js";
import { LocalPathToolPackageRunner, SourceBundleHttpProcessToolPackageRunner, SourceBundleToolPackageRunner } from "./toolPackageRunnerSourceBundle.js";
import { OciImageToolPackageRunner } from "./toolPackageRunnerOci.js";
import type { ToolPackageRunner } from "./toolPackageRunnerTypes.js";

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
    new SourceBundleHttpProcessToolPackageRunner(),
    new SourceBundleToolPackageRunner(),
    new ExternalHttpToolPackageRunner(),
    new OciImageToolPackageRunner(),
  ],
): Promise<GeneratedToolLoadResult[]> {
  let modules = (await metadataStore.list()).filter((item) => item.source === "generated");
  const bootstrapped = modules.length === 0
    ? await bootstrapGeneratedToolPackages(metadataStore, { projectRoot })
    : [];
  if (bootstrapped.length > 0) {
    modules = (await metadataStore.list()).filter((item) => item.source === "generated");
  }
  const results: GeneratedToolLoadResult[] = bootstrapped
    .filter((entry) => !entry.registered)
    .map((entry) => ({
      name: entry.name,
      loaded: false,
      detail: entry.detail,
    }));
  for (const module of modules) {
    const runner = runners.find((candidate) => candidate.canLoad(module));
    if (!runner) {
      const packageType = module.packageManifest?.package.type ?? "legacy-local-path";
      const detail = `No generated-tool runner is available for ${packageType} package references yet.`;
      if (module.status !== "disabled") {
        await metadataStore.updateHealth(module.name, { ok: false, detail });
      }
      results.push({
        name: module.name,
        loaded: false,
        detail,
      });
      continue;
    }
    try {
      const result = await runner.load(module, projectRoot);
      if (result.health) await metadataStore.updateHealth(module.name, result.health);
      if (!result.loaded) {
        if (!result.health && module.status !== "disabled") {
          await metadataStore.updateHealth(module.name, { ok: false, detail: result.detail });
        }
        results.push({ name: module.name, loaded: false, detail: result.detail });
        continue;
      }
      if (!result.tool) {
        const detail = `Runner ${runner.type} reported success without returning a Tool.`;
        await metadataStore.updateHealth(module.name, { ok: false, detail });
        results.push({ name: module.name, loaded: false, detail });
        continue;
      }
      registry.register(result.tool);
      results.push({ name: module.name, loaded: true, detail: result.detail });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await metadataStore.updateHealth(module.name, { ok: false, detail });
      results.push({ name: module.name, loaded: false, detail });
    }
  }
  return results;
}
