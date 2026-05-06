import { ToolBuildRequest } from "./toolBuildRequestStore.js";
import { ToolBuildActivationReport, ToolActivationRunner } from "./toolBuildWorkflow.js";
import { ToolMetadataStore } from "./toolMetadataStore.js";

export type MetadataToolActivationRunnerOptions = {
  metadataStore: Pick<ToolMetadataStore, "activateVersion" | "deleteGenerated">;
  reloadGeneratedTools: () => Promise<void>;
};

export function createMetadataToolActivationRunner(
  options: MetadataToolActivationRunnerOptions,
): ToolActivationRunner {
  return {
    async activate(_request, _output, registeredToolName) {
      await options.reloadGeneratedTools();
      return {
        ok: true,
        summary: `Generated tool runtime reloaded for ${registeredToolName}.`,
        checks: ["loadGeneratedTools completed after registrar promotion"],
      };
    },
    async rollback(request, _output, registeredToolName, activationReport) {
      return rollbackMetadataActivation(options, request, registeredToolName, activationReport);
    },
  };
}

async function rollbackMetadataActivation(
  options: MetadataToolActivationRunnerOptions,
  request: ToolBuildRequest,
  registeredToolName: string,
  activationReport: ToolBuildActivationReport,
): Promise<ToolBuildActivationReport> {
  const checks = [`activation failure: ${activationReport.summary}`];
  try {
    if (request.replacesVersion) {
      await options.metadataStore.activateVersion(registeredToolName, request.replacesVersion);
      checks.push(`reactivated previous version ${request.replacesVersion}`);
    } else {
      const deleted = await options.metadataStore.deleteGenerated(registeredToolName);
      checks.push(deleted ? "removed failed initial generated metadata" : "failed initial generated metadata was already absent");
    }

    await options.reloadGeneratedTools();
    checks.push("loadGeneratedTools completed after activation rollback");
    return {
      ok: true,
      summary: request.replacesVersion
        ? `Previous version ${request.replacesVersion} restored for ${registeredToolName}.`
        : `Failed initial generated tool ${registeredToolName} removed from metadata.`,
      checks,
    };
  } catch (error) {
    return {
      ok: false,
      summary: error instanceof Error ? error.message : String(error),
      checks,
    };
  }
}
