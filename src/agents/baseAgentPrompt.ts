import type { LlmToolSchema } from "../llm/client.js";
import type { Tool } from "../tools/tool.js";
import {
  buildToolCatalog,
  formatToolCatalogEntryForPrompt,
  renderToolSchemaDescription,
  type BaseAgentToolCatalogEntry,
} from "./agentToolCatalog.js";
import { limitText, safeToolName } from "./baseAgentToolMessages.js";
import type { BaseAgentRunContext } from "./baseAgentTypes.js";
import { formatContextForPrompt } from "./baseAgentTrace.js";
import { formatTaskFrameForPrompt, type TaskFrame } from "./taskFrame.js";

export function buildBaseAgentSystemPrompt(
  runContext: BaseAgentRunContext,
  tools: Tool[],
  toolCatalog: BaseAgentToolCatalogEntry[],
  taskFrame: TaskFrame,
): string {
  const runScopedCandidates = toolCatalog.filter((entry) => entry.visibility === "run_scoped_candidate");
  return [
    "You are the base Agentic agent.",
    "Solve the user's task with the minimum necessary actions that still satisfy the task frame quality bar.",
    "Before acting, use the task frame below as your internal contract: understand the ideal outcome, likely user disappointments, and evidence required before choosing tools or answering.",
    "Use registered tools only when they are needed for current data, files, screenshots, browser work, or artifacts.",
    "For current external facts such as prices, quotes, weather, or news, first use or request a search/fetch/data tool that returns text or structured data. A screenshot tool is proof only and must not be the primary data source.",
    "For broad, ambiguous, current, recommendation, comparison, or purchase-selection tasks, do not answer from one search result or one roundup. Build a small evidence set across independent sources and compare candidates against the user's criteria.",
    "When web.search returns candidate source URLs for broad research, call web.read/web.extract on the strongest source pages before finalizing claims; snippets are leads, not sufficient evidence for recommendations.",
    "For broad tasks, follow the task frame research plan: first clarify the ideal outcome and failure criteria, then gather freshness/candidate evidence, then verify finalists, then capture proof.",
    "Use the task frame answer contract as a return checklist. If your draft violates a mustAvoid item or lacks a mustDo item, keep working or state the limitation explicitly.",
    "For continuation or follow-up tasks inside an existing thread, treat the runtime thread summary, prior accepted facts, and prior artifact metadata as first-class context. Answer against that context before doing fresh research.",
    "When a follow-up asks to refine, compare, clarify, or choose from prior results, reuse the prior criteria/evidence unless the user asks for new facts or the prior evidence is stale/insufficient.",
    "For explicit local file/document/data tasks, use document.extract, data.transform, file.read, and file.write directly. Do not call web.search, web.read, browser.operate, or browser.screenshot unless the user explicitly asks for external discovery or visual proof.",
    "If the available search tool only returns shallow snippets and no web.read/web.extract tool is available, call request_tool_creation or request_tool_edit for a web read/extract capability instead of fabricating a high-confidence answer.",
    "If no available registered tool can satisfy a required capability, call request_tool_creation with a semantic tool name and a concrete behavior contract.",
    "If an available generated tool is relevant but insufficient, broken, or missing required behavior, call request_tool_edit with the existing tool name and a concrete change request.",
    "Do not call request_tool_creation for work you can answer directly or complete with an available tool.",
    "Do not call request_tool_edit when a new capability needs a new tool instead of a versioned change to an existing generated tool.",
    "A newly created, edited, or operator-attached tool version is callable inside the current run when the host returns a run-scoped candidate; use it to finish the original task before answering.",
    ...runScopedCandidatePromptLines(runScopedCandidates),
    "If the task frame includes an external action policy, do not execute prohibited actions without explicit operator approval. You may prepare options, forms, payloads, and confirmation checklists.",
    "When your answer depends on external/current web evidence and a proof artifact is possible, capture a focused viewport screenshot or equivalent artifact from one source URL before finishing.",
    "This proof requirement applies by default even when the user does not explicitly ask for proof; do not finish a source-backed/current answer while proof is still possible but missing.",
    "For API-only, HTTP, JSON, cURL, or endpoint tasks, structured/source evidence from the API response is the proof. Do not call browser.screenshot or browser.operate unless the user explicitly asks for visual proof of a web page.",
    "After one successful http.request that directly satisfies an API-only task, finish immediately with the requested field/status/body summary, source URL, and structured proof artifact; do not add web search, web read, or screenshots.",
    "If the runtime says the final answer is blocked for missing proof, call the requested proof tool before finishing.",
    "For proof screenshots, prefer fullPage:false and focus on the visible value/section that proves the answer; use focusText or selector when the tool supports it.",
    "If no screenshot/artifact tool is available but a source URL needs proof, request creation of browser.screenshot with url input, default viewport capture, optional focusText/selector, and PNG artifact output; then use it on the source URL.",
    "Do not repeat an identical tool call inside one run; reuse the prior result unless the input, source, or purpose is materially different.",
    "If a requested artifact or external action fails, be explicit; do not pretend the task succeeded.",
    "When finished, either call finish({ answer }) or return the final answer directly.",
    "",
    "Runtime context:",
    formatContextForPrompt(runContext),
    "",
    "Task frame:",
    formatTaskFrameForPrompt(taskFrame),
    "",
    "Available tools:",
    toolCatalog.length
      ? toolCatalog.map(formatToolCatalogEntryForPrompt).join("\n")
      : tools.length
        ? tools.map((tool) => `- ${tool.name}: ${limitText(tool.description || "No description.", 180)}`).join("\n")
      : "- No registered tools.",
  ].join("\n");
}

function runScopedCandidatePromptLines(entries: BaseAgentToolCatalogEntry[]): string[] {
  if (!entries.length) return [];
  return [
    "Run-scoped candidate requirement:",
    ...entries.map((entry) => {
      const safeName = safeToolName(entry.name);
      const policy = entry.promotionPolicy === "manual"
        ? "It is manual-promotion evidence and must not be treated as globally enabled."
        : "It can be accepted only if it helps complete this run.";
      return `- Call ${safeName} (${entry.name}${entry.version ? `@${entry.version}` : ""}) for this task before using fallback tools or finishing. ${policy}`;
    }),
    "If a run-scoped candidate fails or returns unusable data, report that exact tool result and then use fallback evidence only as a degraded answer.",
  ];
}

export function buildBaseAgentToolSchemas(
  tools: Tool[],
  toolCatalog: BaseAgentToolCatalogEntry[] = buildToolCatalog(tools, undefined),
): LlmToolSchema[] {
  const catalogByName = new Map(toolCatalog.map((entry) => [entry.name, entry]));
  const schemas = tools.map((tool) => {
    const safeName = safeToolName(tool.name);
    const catalogEntry = catalogByName.get(tool.name);
    const parameters = tool.inputSchema && typeof tool.inputSchema === "object"
      ? tool.inputSchema as Record<string, unknown>
      : { type: "object", properties: {}, additionalProperties: true };
    return {
      type: "function" as const,
      function: {
        name: safeName,
        description: renderToolSchemaDescription(tool, catalogEntry),
        parameters,
      },
    };
  });
  schemas.push({
    type: "function",
    function: {
      name: "request_tool_creation",
      description: "Request creation of a new portable generated tool when no available registered tool can satisfy a required capability. Use this only when the task cannot be completed correctly with the current tool catalog.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Semantic tool name, for example browser.screenshot, document.pdf.read, web.search.",
          },
          version: {
            type: "string",
            description: "Optional semantic version for a brand-new tool. Omit for normal requests so the host can reuse the best existing candidate or choose the next version.",
          },
          request: {
            type: "string",
            description: "Concrete capability request and expected behavior for the builder agent.",
          },
          description: {
            type: "string",
            description: "Short user-facing tool description.",
          },
          capabilities: {
            type: "array",
            items: { type: "string" },
            description: "Capability tags the agent should later use to find this tool.",
          },
          dependencies: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Optional package-local npm dependencies when the model already knows a specific package should be wrapped.",
          },
          behaviorExamples: {
            type: "array",
            description: "Optional concrete behavior QA examples the generated tool must pass before it can be attached. Include examples when the original task has known input/output.",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                input: { type: "object", additionalProperties: true },
                expectedOk: { type: "boolean" },
                expectedContent: { type: "string" },
                expectedContentIncludes: { type: "string" },
              },
              required: ["input"],
            },
          },
          authoringMode: {
            type: "string",
            enum: ["auto", "llm", "scaffold"],
            description: "Use llm for unknown/custom capabilities, scaffold for deterministic smoke packages, auto when unsure.",
          },
        },
        required: ["name", "request"],
      },
    },
  });
  schemas.push({
    type: "function",
    function: {
      name: "request_tool_edit",
      description: "Request a new version of an existing generated tool when that tool is relevant but insufficient, broken, or missing required behavior. The active version remains unchanged until an operator manually verifies and activates the candidate.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Existing generated tool name to edit, for example browser.screenshot or document.pdf.read.",
          },
          version: {
            type: "string",
            description: "Optional semantic version for the candidate. Omit to bump the patch version.",
          },
          request: {
            type: "string",
            description: "Concrete versioned change request, including what failed or what behavior is missing.",
          },
          description: {
            type: "string",
            description: "Optional updated user-facing tool description.",
          },
          capabilities: {
            type: "array",
            items: { type: "string" },
            description: "Optional updated capability tags.",
          },
          dependencies: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Optional package-local npm dependencies for the edited version.",
          },
          behaviorExamples: {
            type: "array",
            description: "Optional concrete behavior QA examples the edited tool version must pass before it can be attached.",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                input: { type: "object", additionalProperties: true },
                expectedOk: { type: "boolean" },
                expectedContent: { type: "string" },
                expectedContentIncludes: { type: "string" },
              },
              required: ["input"],
            },
          },
          authoringMode: {
            type: "string",
            enum: ["auto", "llm", "scaffold"],
            description: "Use llm for unknown/custom edits, scaffold for deterministic smoke edits, auto when unsure.",
          },
        },
        required: ["name", "request"],
      },
    },
  });
  schemas.push({
    type: "function",
    function: {
      name: "finish",
      description: "Return the final answer to the user.",
      parameters: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    },
  });
  return schemas;
}

/**
 * System nudge for the FINAL budgeted loop step: the model must stop
 * requesting tools and synthesize the answer from collected evidence.
 * Paired with toolChoice "none" on the same step — without this, runs end
 * with a step-limit failure stub instead of a usable answer.
 */
export const FINAL_STEP_WRAP_UP_NUDGE =
  "Step budget reached: this is your FINAL step. Do not request any more tools. " +
  "Write the complete final answer for the user now from the evidence already collected above. " +
  "If a detail could not be verified, say so honestly instead of guessing.";
