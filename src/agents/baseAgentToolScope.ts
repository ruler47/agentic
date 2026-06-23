import type { Tool } from "../tools/tool.js";
import type { BaseAgentToolCatalogEntry } from "./agentToolCatalog.js";
import { shouldAnswerWithoutTools, type ExplicitToolNeed } from "./baseAgentToolChoice.js";
import type { TaskFrame } from "./taskFrame.js";

export function scopedToolsForTaskFrame(input: {
  tools: Tool[];
  toolCatalog: BaseAgentToolCatalogEntry[];
  taskFrame: TaskFrame;
  hasRunScopedCandidates: boolean;
  explicitToolNeed?: ExplicitToolNeed;
}): { tools: Tool[]; toolCatalog: BaseAgentToolCatalogEntry[]; noToolOnly: boolean } {
  const noToolOnly = shouldAnswerWithoutTools({
    step: 1,
    taskFrame: input.taskFrame,
    hasRunScopedCandidates: input.hasRunScopedCandidates,
    requiresToolCapability: Boolean(input.explicitToolNeed),
  });
  if (noToolOnly) return { tools: [], toolCatalog: [], noToolOnly };

  const allowedNames = new Set(
    input.tools
      .filter((tool) => shouldOfferToolForFrame(tool, input.taskFrame, input.toolCatalog, input.explicitToolNeed))
      .map((tool) => tool.name),
  );
  for (const entry of input.toolCatalog) {
    if (entry.visibility === "run_scoped_candidate") allowedNames.add(entry.name);
  }
  const tools = input.tools.filter((tool) => allowedNames.has(tool.name));
  const toolCatalog = input.toolCatalog.filter((entry) => allowedNames.has(entry.name));
  return { tools, toolCatalog, noToolOnly };
}

function shouldOfferToolForFrame(
  tool: Tool,
  frame: TaskFrame,
  catalog: BaseAgentToolCatalogEntry[],
  explicitToolNeed?: ExplicitToolNeed,
): boolean {
  const entry = catalog.find((candidate) => candidate.name === tool.name);
  if (entry?.visibility === "run_scoped_candidate") return true;
  const text = `${tool.name} ${tool.description} ${tool.capabilities.join(" ")}`.toLowerCase();

  if (explicitToolNeed === "screenshot") {
    return /browser[.\s-]*screenshot|browser-screenshot|artifact-image|screenshot/.test(text);
  }

  if (frame.mode === "local_utility") {
    return /(?:^|\b)(?:file|document|data)[.\s-]|file-|document-|data-/.test(text);
  }

  if (frame.externalActionPolicy) {
    return /(web[.\s-]*(?:search|read|extract)|browser[.\s-]*(?:operate|screenshot)|external[.\s-]*action[.\s-]*prepare|http[.\s-]*request)/.test(text);
  }

  if (frame.mode === "current_lookup") {
    return /(web[.\s-]*(?:search|read|extract)|http[.\s-]*request|browser[.\s-]*screenshot)/.test(text);
  }

  if (frame.mode === "product_selection" || frame.mode === "exploratory_research") {
    return /(web[.\s-]*(?:search|read|extract)|browser[.\s-]*screenshot)/.test(text);
  }

  if (frame.mode === "tool_build_or_rework") return false;
  return true;
}
