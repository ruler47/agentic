import type { ToolRegistry } from "../../../tools/registry.js";
import type { ExternalActionCommitExecutor } from "../../../types.js";
import type { ExternalActionExecutorBuildRequest } from "./action-proposals.shared.js";

export function findExistingExternalActionCommitExecutor(
  registry: ToolRegistry | undefined,
  input: ExternalActionExecutorBuildRequest,
): ExternalActionCommitExecutor | undefined {
  const requiredCapability = requiredExecutorCapability(input.capabilities);
  const candidates =
    registry
      ?.list()
      .filter((tool) =>
        requiredCapability
          ? tool.capabilities.includes(requiredCapability)
          : tool.capabilities.some((capability) =>
              input.capabilities.includes(capability),
            ),
      )
      .filter((tool) =>
        tool.capabilities.some(
          (capability) =>
            capability === "external-action-commit" ||
            capability.startsWith("external-action-commit-"),
        ),
      )
      .sort((a, b) => {
        const aExact =
          requiredCapability && a.capabilities.includes(requiredCapability)
            ? 1
            : 0;
        const bExact =
          requiredCapability && b.capabilities.includes(requiredCapability)
            ? 1
            : 0;
        return bExact - aExact || a.name.localeCompare(b.name);
      }) ?? [];
  const tool = candidates[0];
  if (!tool) return undefined;
  return {
    kind: "generated_tool",
    toolName: tool.name,
    toolVersion: tool.version,
    toolInput: input.toolInput,
    ready: true,
    risk: input.risk,
    reason:
      "An enabled generated commit tool is already registered for this external action capability.",
    missing: [],
    expectedProof: input.expectedProof,
  };
}

function requiredExecutorCapability(capabilities: string[]): string | undefined {
  if (capabilities.includes("external-action-commit-generic")) {
    return "external-action-commit-generic";
  }
  const specific = capabilities.filter(
    (capability) =>
      capability.startsWith("external-action-commit-") &&
      capability !== "external-action-commit",
  );
  return specific.find((capability) => capability.split("-").length > 4) ?? specific[0];
}
