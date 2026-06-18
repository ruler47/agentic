import type { Tool, ToolHealth } from "./tool.js";
import type { ToolModuleMetadata } from "./toolMetadataStore.js";
import type { ToolPackageReferenceType } from "./toolPackage.js";

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
  describe?(): ToolPackageRunnerInfo;
};

export type ToolPackageRunnerInfo = {
  name: string;
  type: ToolPackageRunner["type"];
  status: "available" | "disabled";
  detail: string;
  supportedPackageTypes: ToolPackageReferenceType[];
  root?: string;
};

export class MissingToolRuntimeRequirementsError extends Error {
  readonly code = "missing_tool_runtime_requirements";

  constructor(
    readonly missingConfigurationKeys: string[],
    readonly missingSecretHandles: string[],
  ) {
    const parts = [
      missingConfigurationKeys.length ? `configuration: ${missingConfigurationKeys.join(", ")}` : undefined,
      missingSecretHandles.length ? `secret handles: ${missingSecretHandles.join(", ")}` : undefined,
    ].filter(Boolean);
    super(`Missing required runtime values for external tool package (${parts.join("; ")}).`);
    this.name = "MissingToolRuntimeRequirementsError";
  }
}
