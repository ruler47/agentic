import type { SecretHandleStore } from "../secrets/secretHandleStore.js";
import type { ToolRuntimeSettingsStore } from "../settings/toolRuntimeSettings.js";
import type {
  ToolModuleMetadata,
  ToolModuleStatus,
  ToolRuntimeReadiness,
} from "./toolMetadataStore.js";
import { resolveToolRuntimeReadiness } from "./toolRuntimeReadiness.js";

export type ToolCatalogLayer =
  | "core"
  | "generated-active"
  | "generated-inactive"
  | "legacy-reference";

export type ToolAgentEligibilityReason =
  | "ready"
  | "not_registered"
  | "status_not_available"
  | "runtime_not_ready"
  | "health_failed"
  | "guarded_external_action_commit";

export type ToolAgentEligibility = {
  offered: boolean;
  reason: ToolAgentEligibilityReason;
  detail: string;
};

export type ToolCatalogEntry = ToolModuleMetadata & {
  catalogLayer: ToolCatalogLayer;
  catalogSortRank: number;
  agentEligibility: ToolAgentEligibility;
  healthSummary: string;
};

export type BuildToolCatalogViewInput = {
  metadataTools: ToolModuleMetadata[];
  registeredToolNames: Iterable<string>;
  runtimeSettings?: ToolRuntimeSettingsStore;
  secretHandles?: SecretHandleStore;
  environment?: Record<string, string | undefined>;
};

export async function buildToolCatalogView(
  input: BuildToolCatalogViewInput,
): Promise<ToolCatalogEntry[]> {
  const registered = new Set(input.registeredToolNames);
  const entries = await Promise.all(
    input.metadataTools.map(async (tool) => {
      const runtimeReadiness = tool.runtimeReadiness ?? await resolveToolRuntimeReadiness(tool, {
        runtimeSettings: input.runtimeSettings,
        secretHandles: input.secretHandles,
        environment: input.environment,
      });
      return toToolCatalogEntry(tool, registered, runtimeReadiness);
    }),
  );
  return sortToolCatalogEntries(entries);
}

export function toToolCatalogEntry(
  tool: ToolModuleMetadata,
  registeredToolNames: ReadonlySet<string>,
  runtimeReadiness: ToolRuntimeReadiness,
): ToolCatalogEntry {
  const agentEligibility = deriveToolAgentEligibility(tool, registeredToolNames, runtimeReadiness);
  const catalogLayer = catalogLayerForTool(tool, agentEligibility, registeredToolNames);
  return {
    ...tool,
    runtimeReadiness,
    catalogLayer,
    catalogSortRank: catalogLayerRank(catalogLayer),
    agentEligibility,
    healthSummary: healthSummary(tool, runtimeReadiness, agentEligibility),
  };
}

export function deriveToolAgentEligibility(
  tool: ToolModuleMetadata,
  registeredToolNames: ReadonlySet<string>,
  runtimeReadiness: ToolRuntimeReadiness,
): ToolAgentEligibility {
  if (!registeredToolNames.has(tool.name)) {
    return {
      offered: false,
      reason: "not_registered",
      detail: "Tool metadata exists, but no implementation is registered in the active ToolRegistry.",
    };
  }
  if (tool.status !== "available") {
    return {
      offered: false,
      reason: "status_not_available",
      detail: `Tool status is ${tool.status}; only available tools are offered to agents.`,
    };
  }
  if (isGuardedExternalActionCommitTool(tool)) {
    return {
      offered: false,
      reason: "guarded_external_action_commit",
      detail: "External action commit tools are guarded and are attached only after approval.",
    };
  }
  if (!runtimeReadiness.ok) {
    return {
      offered: false,
      reason: "runtime_not_ready",
      detail: runtimeReadiness.message,
    };
  }
  if (tool.lastHealthOk === false) {
    return {
      offered: false,
      reason: "health_failed",
      detail: tool.lastHealthDetail ?? "Last healthcheck failed.",
    };
  }
  return {
    offered: true,
    reason: "ready",
    detail: "Tool is available, registered, runtime-ready, and eligible for agent prompts.",
  };
}

export function isGuardedExternalActionCommitTool(tool: Pick<ToolModuleMetadata, "capabilities">): boolean {
  return tool.capabilities.some(
    (capability) =>
      capability === "external-action-commit" ||
      capability.startsWith("external-action-commit-"),
  );
}

function catalogLayerForTool(
  tool: ToolModuleMetadata,
  eligibility: ToolAgentEligibility,
  registeredToolNames: ReadonlySet<string>,
): ToolCatalogLayer {
  if (tool.source === "builtin") return registeredToolNames.has(tool.name) ? "core" : "legacy-reference";
  if (tool.source === "generated") return eligibility.offered ? "generated-active" : "generated-inactive";
  return "legacy-reference";
}

function sortToolCatalogEntries(entries: ToolCatalogEntry[]): ToolCatalogEntry[] {
  return [...entries].sort(
    (a, b) =>
      a.catalogSortRank - b.catalogSortRank ||
      statusRank(a.status) - statusRank(b.status) ||
      a.name.localeCompare(b.name),
  );
}

function catalogLayerRank(layer: ToolCatalogLayer): number {
  switch (layer) {
    case "core":
      return 0;
    case "generated-active":
      return 1;
    case "generated-inactive":
      return 2;
    case "legacy-reference":
      return 3;
  }
}

function statusRank(status: ToolModuleStatus): number {
  switch (status) {
    case "available":
      return 0;
    case "loaded":
      return 1;
    case "disabled":
      return 2;
    case "failed":
      return 3;
  }
}

function healthSummary(
  tool: ToolModuleMetadata,
  readiness: ToolRuntimeReadiness,
  eligibility: ToolAgentEligibility,
): string {
  if (!eligibility.offered) return eligibility.detail;
  if (tool.lastHealthOk === true) return tool.lastHealthDetail ?? "Last healthcheck passed.";
  return readiness.message;
}
