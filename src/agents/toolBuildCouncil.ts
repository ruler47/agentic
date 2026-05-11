/**
 * Phase 14 — pure helpers for the tool-build council.
 *
 * No I/O here: every function is a deterministic transform that the
 * UniversalAgent orchestrator calls with pre-fetched LLM outputs. Keep
 * it that way so Phase B can be 100% unit-tested without spinning up
 * a runtime / fake LLM.
 *
 * Entrypoints:
 *   - `bordaScores(ballots, proposalCount)` → number[] aggregate.
 *   - `pickCouncilWinner(proposals, ballots)` → winning index + breakdown.
 *   - `brainstormPrompt(context, councilSize)`, `votePrompt(proposals)`,
 *     `implementPrompt(winner, context)`, `reviewPrompt(code, winner,
 *     context)`, `revisePrompt(code, reviews, context)`,
 *     `qaOraclePrompt(output, context)`, `repairPrompt(code, qaFailure,
 *     context)` → message arrays ready to hand to `LlmClient.complete`.
 */

import type { Message } from "../types.js";

/** Input gathered from the Tool Builds form (and the API endpoint). */
export type ToolBuildContext = {
  /** Canonical tool name, e.g. `weather.openmeteo`. */
  name: string;
  /** Plain-prose description = what the user wants the tool to do. */
  description: string;
  /** Optional secret handle the tool will read at runtime. */
  secretHandle?: string;
  /** QA acceptance criteria, one bullet per requirement. */
  qaCriteria: string[];
  /**
   * Reference docs the operator attached: OpenAPI specs, API READMEs,
   * PDF manuals, etc. Each entry is the EXTRACTED TEXT (the council
   * upstream already turned PDFs / non-text into utf-8 via reader
   * tools). The prompts embed these so models don't hallucinate the
   * external contract.
   */
  referenceDocs?: Array<{
    filename: string;
    mimeType: string;
    /** Plain-text content extracted from the file. */
    content: string;
  }>;
  /**
   * For rework / bugfix: existing tool name + context of what went wrong.
   * If both are present the prompts shift from "build new" to "fix this
   * existing tool".
   */
  existingToolName?: string;
  bugContext?: string;
  /**
   * Capability tags the registered tool MUST advertise (besides the
   * default `<name> + council-built` set). Used by the auto-spawned
   * reader-tool sub-builds — the parent build searches the registry
   * by capability so the freshly-built reader must include the right
   * `reads:<mime>` tag.
   */
  requiredCapabilities?: string[];
};

/** One council member's full ranked ballot. */
export type CouncilBallot = {
  voterModelId: string;
  /** Indices into the `proposals` array, ordered best→worst. */
  ranking: number[];
};

/** A brainstorm output the council voted on. */
export type CouncilProposal = {
  modelId: string;
  /** Free-form ТЗ text the model produced. */
  content: string;
  /** Optional structured hints the model declared. */
  packageList?: string[];
  externalDependencies?: string[];
};

export type CouncilWinner = {
  winnerIndex: number;
  winnerModelId: string;
  proposal: CouncilProposal;
  scores: number[];
  tieBrokenBy?: "scoresUnique" | "fewerExternalDeps" | "shorterPackageList" | "lexicographic";
};

/**
 * Borda count: each ballot ranks proposals best→worst. Best gets
 * (N-1) points, second gets (N-2), …, last gets 0. Aggregate scores
 * are summed across voters. Empty rankings contribute nothing.
 *
 * Returns an array of total scores, one per proposal index. The
 * highest score wins; tie-break is the caller's job (see
 * `pickCouncilWinner`).
 */
export function bordaScores(ballots: readonly CouncilBallot[], proposalCount: number): number[] {
  const scores = new Array<number>(proposalCount).fill(0);
  for (const ballot of ballots) {
    const seen = new Set<number>();
    for (let position = 0; position < ballot.ranking.length; position += 1) {
      const proposalIdx = ballot.ranking[position];
      if (proposalIdx === undefined) continue;
      if (proposalIdx < 0 || proposalIdx >= proposalCount) continue;
      if (seen.has(proposalIdx)) continue;
      seen.add(proposalIdx);
      // Top-1 = N-1 points, top-2 = N-2, …
      const points = proposalCount - 1 - position;
      if (points > 0) scores[proposalIdx] += points;
    }
  }
  return scores;
}

/**
 * Pick the council winner from proposals + ballots.
 *
 * Tie-break rules, applied in order until a unique winner emerges:
 *   1. Higher Borda score (the primary signal).
 *   2. Fewer declared `externalDependencies`.
 *   3. Shorter `packageList`.
 *   4. Lexicographically smaller `modelId` — stable + reproducible.
 */
export function pickCouncilWinner(
  proposals: readonly CouncilProposal[],
  ballots: readonly CouncilBallot[],
): CouncilWinner {
  if (proposals.length === 0) {
    throw new Error("Council winner requested but the proposal list is empty.");
  }
  const scores = bordaScores(ballots, proposals.length);
  const maxScore = Math.max(...scores);
  const topIndices = scores
    .map((score, index) => ({ score, index }))
    .filter((entry) => entry.score === maxScore)
    .map((entry) => entry.index);

  if (topIndices.length === 1) {
    const winnerIndex = topIndices[0]!;
    return {
      winnerIndex,
      winnerModelId: proposals[winnerIndex]!.modelId,
      proposal: proposals[winnerIndex]!,
      scores,
      tieBrokenBy: "scoresUnique",
    };
  }

  // Tie-break 1: fewer external deps.
  const byExtDeps = pickMin(topIndices, (idx) => (proposals[idx]!.externalDependencies ?? []).length);
  if (byExtDeps.length === 1) {
    const winnerIndex = byExtDeps[0]!;
    return {
      winnerIndex,
      winnerModelId: proposals[winnerIndex]!.modelId,
      proposal: proposals[winnerIndex]!,
      scores,
      tieBrokenBy: "fewerExternalDeps",
    };
  }

  // Tie-break 2: shorter package list.
  const byPkgList = pickMin(byExtDeps, (idx) => (proposals[idx]!.packageList ?? []).length);
  if (byPkgList.length === 1) {
    const winnerIndex = byPkgList[0]!;
    return {
      winnerIndex,
      winnerModelId: proposals[winnerIndex]!.modelId,
      proposal: proposals[winnerIndex]!,
      scores,
      tieBrokenBy: "shorterPackageList",
    };
  }

  // Tie-break 3: lexicographic modelId — deterministic & reproducible.
  const sorted = [...byPkgList].sort((a, b) =>
    proposals[a]!.modelId.localeCompare(proposals[b]!.modelId),
  );
  const winnerIndex = sorted[0]!;
  return {
    winnerIndex,
    winnerModelId: proposals[winnerIndex]!.modelId,
    proposal: proposals[winnerIndex]!,
    scores,
    tieBrokenBy: "lexicographic",
  };
}

function pickMin<T>(items: readonly T[], score: (item: T) => number): T[] {
  if (items.length === 0) return [];
  let minScore = Infinity;
  for (const item of items) {
    const value = score(item);
    if (value < minScore) minScore = value;
  }
  return items.filter((item) => score(item) === minScore);
}

// ──────────────────────────────────────────────────────────────────────
// Prompt builders.
// All emit `Message[]` ready for LlmClient.complete. They embed every slot
// the orchestrator needs so the council members don't have to "remember"
// the user's task across calls — each prompt is self-contained.
// ──────────────────────────────────────────────────────────────────────

const COUNCIL_SYSTEM_PROMPT_DEFAULT = `\
You are a senior backend engineer participating in a peer council that builds a single
tool for an autonomous agent platform. Every member of the council sees the same task
and produces an independent proposal. Other members vote; the winning proposal is
implemented; the rest review the code. Be concrete, name packages, and design for
testability.`;

const VOTING_SYSTEM_PROMPT = `\
You are a senior backend engineer reviewing peer proposals for a tool. Rank them strictly
by which proposal will produce the most reliable, scalable, and testable tool. Reply
with a single JSON object: {"ranking": [<best>, <second>, ..., <worst>]} where each entry
is the proposal id. Do not include any other prose.`;

const REVIEW_SYSTEM_PROMPT = `\
You are a senior code reviewer. Inspect the code another council member wrote. Compare
it against the agreed proposal and the user's acceptance criteria. Reply with JSON:
{"verdict": "pass"|"needs_revision", "findings": ["…", "…"]}. Findings must be concrete:
file or symbol, what is wrong, how to fix.`;

const QA_ORACLE_SYSTEM_PROMPT = `\
You are a QA oracle. Given a tool's actual output and the operator's acceptance criteria,
decide whether the output satisfies every criterion. Reply with JSON:
{"verdict": "passed"|"failed", "failures": ["criterion: why it's not met", ...]}.`;

/** Shown to council members so they emit code matching the runtime contract. */
const TOOL_INTERFACE_SNIPPET = `\
export type ToolResult = { ok: boolean; content: string; data?: unknown };
export type ToolInput = Record<string, unknown>;
export type ToolExecutionContext = {
  toolName?: string; now?: Date; caller?: string; signal?: AbortSignal;
  logger?: { info(msg: string, data?: unknown): void; warn(msg: string, data?: unknown): void; error(msg: string, data?: unknown): void };
  resolveSecret?: (handle: string) => Promise<string | undefined>;
  resolveConfiguration?: (key: string, toolName?: string) => Promise<string | undefined>;
  [key: string]: unknown;
};
export type Tool = {
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  startupMode?: "on-demand" | "always-on" | "ephemeral";
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  healthcheck?: () => Promise<{ ok: boolean; detail: string }> | { ok: boolean; detail: string };
  run: (input: ToolInput, ctx?: ToolExecutionContext) => Promise<ToolResult> | ToolResult;
};`;

function sanitizeForFileName(value: string): string {
  return (value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || "council_tool");
}

/**
 * Render the operator-attached reference docs as a single block the
 * model can read. We cap each doc at 12 000 chars to keep the prompt
 * from blowing the context window; the model gets a "[truncated …]"
 * marker so it knows there's more content available if it asks.
 *
 * Returns undefined when there are no docs — the caller filters
 * undefined entries out of the prompt so an empty block doesn't show.
 */
function formatReferenceDocsBlock(
  docs: ToolBuildContext["referenceDocs"] | undefined,
): string | undefined {
  if (!docs || docs.length === 0) return undefined;
  const sections = docs.map((doc, i) => {
    const truncated = doc.content.length > 12000;
    const body = truncated
      ? `${doc.content.slice(0, 12000)}\n…[truncated ${doc.content.length - 12000} chars]`
      : doc.content;
    return `--- Reference #${i + 1}: ${doc.filename} (${doc.mimeType}) ---\n${body}`;
  });
  return [
    "Reference materials the operator attached (API docs, OpenAPI specs, READMEs, etc.).",
    "Treat these as ground truth for any external contract — endpoints, payload shapes,",
    "field names, auth, error codes. Do not invent details that contradict them.",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

export function brainstormPrompt(
  context: ToolBuildContext,
  councilSize: number,
  systemOverride?: string,
): Message[] {
  const system = (systemOverride && systemOverride.trim()) || COUNCIL_SYSTEM_PROMPT_DEFAULT;
  const user = [
    `Tool name: ${context.name}`,
    `Description (what the user wants): ${context.description}`,
    context.secretHandle ? `Secret handle the tool may read: ${context.secretHandle}` : undefined,
    context.qaCriteria.length > 0
      ? `QA acceptance criteria:\n${context.qaCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`
      : undefined,
    formatReferenceDocsBlock(context.referenceDocs),
    context.existingToolName
      ? `Rework target — existing tool: ${context.existingToolName}`
      : undefined,
    context.bugContext ? `Bug / change context:\n${context.bugContext}` : undefined,
    "",
    `This is one of ${councilSize} peer proposals. Produce a focused proposal (~300-600 words)`,
    "structured as:",
    "  Architecture: high-level shape, request/response contract, integration with the agent runtime.",
    "  Packages: minimal npm/pip/etc. dependencies you would add.",
    "  External integrations: services / APIs / models you will call (if any).",
    "  Risk corners: timeouts, rate limits, secret handling, idempotency.",
    "  Test plan: how QA will verify each acceptance criterion.",
    "",
    "End your proposal with a single JSON line:",
    `{"packages": ["pkg1","pkg2"], "externalDependencies": ["api1","api2"]}`,
    "Empty arrays are fine when the proposal has none.",
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export function votePrompt(
  context: ToolBuildContext,
  proposals: readonly CouncilProposal[],
): Message[] {
  const proposalsBlock = proposals
    .map(
      (proposal, index) =>
        `--- Proposal #${index} (by ${proposal.modelId}) ---\n${proposal.content.trim()}\n`,
    )
    .join("\n");
  const user = [
    `Tool name: ${context.name}`,
    `Description: ${context.description}`,
    context.qaCriteria.length > 0
      ? `Acceptance criteria:\n${context.qaCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`
      : undefined,
    "",
    `Here are the ${proposals.length} peer proposals to rank. Reply with the JSON ranking`,
    "object only — no commentary.",
    "",
    proposalsBlock,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: VOTING_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

export function implementPrompt(
  context: ToolBuildContext,
  winner: CouncilProposal,
): Message[] {
  const sanitized = sanitizeForFileName(context.name);
  const targetPath = `src/tools/generated/${sanitized}Tool.ts`;
  const user = [
    `Tool name: ${context.name}`,
    `User task: ${context.description}`,
    context.qaCriteria.length > 0
      ? `Acceptance criteria:\n${context.qaCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`
      : undefined,
    context.secretHandle ? `Secret handle available: ${context.secretHandle}` : undefined,
    formatReferenceDocsBlock(context.referenceDocs),
    context.existingToolName
      ? `Rework target: ${context.existingToolName} (start from this tool, do not duplicate state).`
      : undefined,
    context.bugContext ? `Bug to fix:\n${context.bugContext}` : undefined,
    "",
    "Winning proposal (your own):",
    winner.content.trim(),
    "",
    "Produce ONE TypeScript file: the Tool definition itself. The runtime",
    "automatically wraps it with an HTTP server, type definitions, package.json,",
    "and tsconfig.json — DO NOT emit those. The file must export a `tool` const",
    "matching this exact interface:",
    "",
    TOOL_INTERFACE_SNIPPET,
    "",
    "Constraints on your file:",
    `  1. Path MUST be: ${targetPath}`,
    `  2. First line: import { Tool, ToolExecutionContext, ToolInput, ToolResult } from "../tool.js";`,
    `  3. Export: \`export const tool: Tool = { name: "${context.name}", version: "1.0.0", ... };\``,
    "  4. tool.run must return { ok: boolean; content: string; data?: unknown }.",
    "     `content` MUST be a string — never null, never undefined. On error,",
    "     return an error message string ('Invalid input', 'Empty payload', …).",
    "     Do NOT add extra fields beyond { ok, content, data, artifacts } — the",
    "     ToolResult type has no `error` field; put error messages inside `content`.",
    "  5. Declare `inputSchema` as a JSON Schema object with `type: \"object\"`,",
    "     a `properties` map (each property typed), and `required: [...]`. This",
    "     drives the Tools-page Manual Run form, so be explicit about what the",
    "     tool accepts.",
    "  6. Allowed imports: Node built-ins (node:http, node:fs, node:path,",
    "     global `fetch`, etc.) AND `zod` for runtime input validation.",
    "     Do NOT import any OTHER npm package — only Node built-ins + zod are guaranteed",
    "     to be resolvable at runtime.",
    "  7. Keep the file self-contained — no top-level side effects, no helper files.",
    "",
    "Reply with a SINGLE JSON object only:",
    `{"files":[{"path":"${targetPath}","content":"…the file body…"}]}`,
    "Do not wrap the JSON in backticks. Do not add commentary.",
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: COUNCIL_SYSTEM_PROMPT_DEFAULT },
    { role: "user", content: user },
  ];
}

export function reviewPrompt(
  context: ToolBuildContext,
  winner: CouncilProposal,
  code: string,
): Message[] {
  const user = [
    `Tool name: ${context.name}`,
    `User task: ${context.description}`,
    context.qaCriteria.length > 0
      ? `Acceptance criteria:\n${context.qaCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`
      : undefined,
    "",
    "Winning proposal:",
    winner.content.trim(),
    "",
    "Submitted code:",
    code.trim(),
    "",
    "Decide: does this code satisfy the proposal and the acceptance criteria? Reply with",
    `JSON: {"verdict": "pass"|"needs_revision", "findings": [...]}`,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: REVIEW_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

export function revisePrompt(
  context: ToolBuildContext,
  winner: CouncilProposal,
  code: string,
  reviewFindings: readonly string[],
): Message[] {
  const refsBlock = formatReferenceDocsBlock(context.referenceDocs);
  const user = [
    `Tool name: ${context.name}`,
    `User task: ${context.description}`,
    refsBlock,
    "Proposal:",
    winner.content.trim(),
    "",
    "Current code:",
    code.trim(),
    "",
    "Council reviewers raised these findings:",
    ...reviewFindings.map((f) => `  - ${f}`),
    "",
    "Apply targeted fixes that satisfy every finding without regressing prior",
    "behaviour. Emit the FULL revised tool body (same single file at the same",
    `path), wrapped in the same JSON envelope: {"files":[{"path","content"}]}.`,
    "Do not re-emit scaffolding (index.ts, runtime/server.ts, package.json, etc).",
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: COUNCIL_SYSTEM_PROMPT_DEFAULT },
    { role: "user", content: user },
  ];
}

export function qaOraclePrompt(
  context: ToolBuildContext,
  toolOutput: { ok: boolean; content: string; data?: unknown },
): Message[] {
  const user = [
    `Tool name: ${context.name}`,
    `User task: ${context.description}`,
    context.qaCriteria.length > 0
      ? `Acceptance criteria:\n${context.qaCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`
      : undefined,
    "",
    "Tool output to evaluate:",
    `  ok: ${toolOutput.ok}`,
    `  content: ${truncate(toolOutput.content, 600)}`,
    `  data: ${truncate(JSON.stringify(toolOutput.data ?? {}, null, 2), 1200)}`,
    "",
    "Decide if every acceptance criterion is satisfied. Reply with JSON only:",
    `{"verdict": "passed"|"failed", "failures": [...]}.`,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: QA_ORACLE_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

/**
 * Synthesize a realistic test input for QA. The legacy stub returned
 * `{ task, query }` which almost never matched a tool's declared
 * inputSchema — most tools then threw at runtime and QA judged the
 * resulting error message, not the tool's actual behaviour. This
 * prompt asks a fast model to read the tool body and produce a JSON
 * input that exercises the main path.
 */
export function synthesizeQaInputPrompt(
  context: ToolBuildContext,
  toolBodyExcerpt: string,
): Message[] {
  const user = [
    `Tool name: ${context.name}`,
    `Description: ${context.description}`,
    context.qaCriteria.length > 0
      ? `Acceptance criteria:\n${context.qaCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`
      : undefined,
    "",
    "Tool source (focus on the `inputSchema` and the `run(input, …)` signature):",
    toolBodyExcerpt.slice(0, 4000),
    "",
    "Produce a JSON input object that:",
    "  1. Matches the declared inputSchema — include every required field with a plausible value.",
    "  2. Lets the QA oracle judge whether the acceptance criteria are met.",
    "  3. Stays compact (a single short call, no huge strings).",
    "",
    "Reply with a SINGLE JSON object only — no commentary, no backticks.",
    'Example shape: {"text":"hello world"}',
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: "You produce realistic JSON test inputs for autonomous-agent tools." },
    { role: "user", content: user },
  ];
}

/**
 * Phase 14 / changeSummary: after the council registers a new version,
 * ask a fast S-tier model to produce a 1-2 sentence human-readable
 * summary of what this version adds or fixes. The Tools page renders
 * this verbatim as the "what changed" caption on each version row,
 * so the operator can scan history without diff'ing source.
 *
 * Three shapes of summary, depending on context:
 *   - Initial build (no prior version): "Initial release: <one-liner
 *     of what the tool does>."
 *   - Rework (existingToolName + bugContext supplied): "Fixed <what>;
 *     <how>." anchored on the bugContext + the QA findings the
 *     council had to repair through.
 *   - QA-failed registrations: same as rework but also notes that QA
 *     didn't pass so the operator knows the version is not yet trusted.
 */
export function changeSummaryPrompt(args: {
  context: ToolBuildContext;
  toolBodyExcerpt: string;
  repairFailures: string[];
  qaPassed: boolean;
  isRework: boolean;
}): Message[] {
  const { context, toolBodyExcerpt, repairFailures, qaPassed, isRework } = args;
  const user = [
    `Tool name: ${context.name}`,
    `Description: ${context.description}`,
    isRework && context.bugContext ? `Bug / change request:\n${context.bugContext}` : undefined,
    repairFailures.length > 0
      ? `QA failures the council repaired:\n${repairFailures.map((f) => `  - ${f}`).join("\n")}`
      : undefined,
    !qaPassed ? "Note: this build did NOT pass QA after all repair attempts." : undefined,
    "",
    "Tool body (current source):",
    toolBodyExcerpt.slice(0, 4000),
    "",
    "Produce a SINGLE 1-2 sentence changelog entry for this version, in English.",
    "Style examples:",
    isRework
      ? '  - "Added precipitation_probability handling on /hourly; added a 5s timeout retry on upstream 5xx."'
      : '  - "Initial release: fetches hourly weather forecast for a city via the open-meteo public API."',
    isRework
      ? '  - "Fixed validation crash when text was empty; now returns ok=false with a descriptive content message."'
      : '  - "Initial release: echoes user-provided text back as content, rejecting empty payloads."',
    "",
    "Constraints:",
    "  - Write in plain English (NOT Russian, NOT another language).",
    "  - 1-2 sentences total, max ~25 words.",
    "  - Do NOT wrap in quotes, JSON, backticks, or any envelope — emit raw prose.",
    "  - Do NOT mention the version number or `council-built` — those are in metadata already.",
    !qaPassed ? "  - Prefix the sentence with `(QA failed)` so the operator notices." : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    {
      role: "system",
      content:
        "You write tight, factual one-line changelog entries for a tool registry. " +
        "Always English, always under 25 words, always plain prose.",
    },
    { role: "user", content: user },
  ];
}

export function repairPrompt(
  context: ToolBuildContext,
  winner: CouncilProposal,
  code: string,
  qaFailures: readonly string[],
): Message[] {
  const refsBlock = formatReferenceDocsBlock(context.referenceDocs);
  const user = [
    `Tool name: ${context.name}`,
    `User task: ${context.description}`,
    refsBlock,
    "Proposal:",
    winner.content.trim(),
    "",
    "Current code:",
    code.trim(),
    "",
    "QA failures (what the oracle reported):",
    ...qaFailures.map((f) => `  - ${f}`),
    "",
    "Apply targeted fixes that make every criterion pass without breaking the others.",
    "Emit the FULL revised tool body (same single file at the same path), wrapped",
    `in the same JSON envelope: {"files":[{"path","content"}]}. Do not re-emit`,
    "scaffolding (index.ts, runtime/server.ts, package.json, etc). Do not change",
    "the tool name.",
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: COUNCIL_SYSTEM_PROMPT_DEFAULT },
    { role: "user", content: user },
  ];
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}
