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
  if (!hasPreparedCommitContext(input.toolInput)) {
    return {
      kind: "generated_tool",
      toolName: tool.name,
      toolVersion: tool.version,
      toolInput: input.toolInput,
      ready: false,
      risk: input.risk,
      reason:
        "A commit tool is registered, but no prepared external-action session is available yet.",
      missing: [
        "prepared browser/API session",
        "proof artifact",
        "concrete provider submit target",
      ],
      expectedProof: input.expectedProof,
    };
  }
  return {
    kind: "generated_tool",
    toolName: tool.name,
    toolVersion: tool.version,
    toolInput: input.toolInput,
    ready: true,
    risk: input.risk,
    reason:
      "An enabled commit tool is already registered for this external action capability.",
    missing: [],
    expectedProof: input.expectedProof,
  };
}

function hasPreparedCommitContext(toolInput: Record<string, unknown>): boolean {
  const preparedSession = toolInput.preparedSession;
  return (
    typeof preparedSession === "object" &&
    preparedSession !== null &&
    !Array.isArray(preparedSession)
  );
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
