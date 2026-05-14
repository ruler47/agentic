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
  /**
   * Phase 16 Slice I: optional version of the existing tool the
   * rework should start from. When absent the council reads the
   * currently-active version's source (legacy behaviour). When
   * present, `readCurrentToolSource` reads the named version
   * directly from disk so the operator can request changes against
   * a specific older revision (e.g. roll back a regression in
   * v1.0.3 by editing v1.0.2 with new instructions, without first
   * having to manually re-activate v1.0.2).
   */
  existingToolVersion?: string;
  bugContext?: string;
  /**
   * On rework, the FULL source of the currently-active version of the
   * tool the operator is changing. Threaded into the brainstorm,
   * implement, and changeSummary prompts so the council edits this
   * source instead of regenerating the whole tool from scratch — that
   * was losing prior fixes every time the operator requested a
   * follow-up tweak.
   */
  existingToolSource?: string;
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
implemented; the rest review the code.

CRITICAL — match your response depth to the task's actual complexity. Do not over-engineer:

  • TRIVIAL fix (rename a field, change output formatting, swap a literal, fix a one-line
    bug): just describe the exact code change. ~3–6 sentences total. No architecture
    section, no dependency table, no test plan. The whole proposal can be a paragraph.

  • BUG fix (existing tool misbehaves; need a root-cause analysis): describe what is
    broken, your hypothesis for why, and the targeted code change. Skip dependencies and
    architecture unless the bug actually involves them. ~150 words.

  • NEW tool or NON-TRIVIAL change (new external API integration, new schema, new
    runtime mode): full proposal — architecture, dependencies, integrations, risk
    corners, test plan. ~300–600 words.

Start every proposal with one of: "Complexity: TRIVIAL" / "Complexity: BUG" / "Complexity: NEW".
Be concrete (name packages, name files, name fields). Do not invent context that isn't in
the prompt.`;

const VOTING_SYSTEM_PROMPT = `\
You are a senior backend engineer reviewing peer proposals for a tool. Rank them strictly
by which proposal will produce the most reliable, scalable, and testable tool. Reply
with a single JSON object: {"ranking": [<best>, <second>, ..., <worst>]} where each entry
is the proposal id. Do not include any other prose.`;

const REVIEW_SYSTEM_PROMPT = `\
You are a senior code reviewer. Inspect the code another council member wrote. Compare
it against the agreed proposal and the user's acceptance criteria. Reply with JSON:
{"verdict": "pass"|"needs_revision", "findings": ["…", "…"]}. Findings must be concrete:
file or symbol, what is wrong, how to fix.

Dependency-name awareness (Phase 28). When reviewing imports / packageJson.dependencies:
  - Do NOT demand renaming a package just because you don't recognize it. The npm
    registry contains thousands of valid packages outside your training set, and
    new ones are published every day. Trust the build phase (npm install + cold-start)
    to catch a name that doesn't resolve.
  - DO flag dep names ONLY when you have STRONG evidence they are wrong: clear typo
    of a well-known package, known typosquat, name that points at a deprecated stub
    you can identify with high confidence, or a name that obviously doesn't follow
    npm conventions (e.g. embedded spaces).
  - When in doubt, do NOT mark the proposal as needs_revision over deps. False
    positives waste a revise cycle and shake the implementer's confidence.

This applies to deps only. Behaviour bugs, missing input validation, ignored timeouts,
swallowed errors, and other code-quality issues should be flagged as usual.`;

const QA_ORACLE_SYSTEM_PROMPT = `\
You are a QA oracle. Given a tool's actual output and the operator's acceptance criteria,
decide whether the output satisfies every criterion. Reply with JSON:
{"verdict": "passed"|"failed", "failures": ["criterion: why it's not met", ...]}.

STRICT RULE — empty results are a FAILURE by default.

When a criterion implies the tool should produce data (e.g. "search works", "fetch list",
"scrape results", "extract entities", "convert image"), and the tool's output has any of:
  - data.results / data.items / data.records / data.entries that is an empty array, OR
  - data is null, undefined, or {}, OR
  - content explicitly says "no results", "not found", "0 items", "empty", "ничего не
    найдено", "пустой", or similar wording,
then VERDICT MUST BE "failed". Reasoning: the tool is supposed to actually do the thing
the criterion describes — returning ok=true with zero output is almost always a broken
selector, wrong endpoint, silent provider error, or auth failure. Mark it failed and let
the repair loop investigate.

The ONLY way to accept an empty result is when an acceptance criterion EXPLICITLY says
empty is allowed (e.g. "returns ok=true with empty results when no match", "gracefully
handles zero-hit queries"). If you cannot point at a specific criterion that permits
empty output, fail the verdict.

When you fail an empty-result case, list the failure as:
  "criterion N: tool returned ok=true but data.results is empty / content says no
  results — criteria require the tool to actually produce output, not just respond."`;

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
    context.existingToolSource
      ? [
          "Current implementation (DO NOT rewrite from scratch — modify only what the",
          "bug context calls for; preserve every other behaviour):",
          "```ts",
          context.existingToolSource.length > 8000
            ? `${context.existingToolSource.slice(0, 8000)}\n…[truncated ${context.existingToolSource.length - 8000} chars]`
            : context.existingToolSource,
          "```",
        ].join("\n")
      : undefined,
    "",
    `This is one of ${councilSize} peer proposals.`,
    "",
    "STEP 1 — Pick your complexity bucket from the system prompt: TRIVIAL, BUG, or NEW.",
    "Be honest: a 'reverse the output string' rework is TRIVIAL, not NEW. A 'fix the",
    "timeout retry on /hourly' rework is BUG. A 'integrate the Stripe billing API' build",
    "is NEW. When in doubt, pick the smaller bucket — the reviewer will ask for more if",
    "they need it.",
    "",
    "STEP 2 — Write the proposal at the depth your bucket requires:",
    "  TRIVIAL → 3–6 sentences total. Just state what to change, where (file or symbol),",
    "             and the expected output. Skip architecture and dependencies entirely.",
    "  BUG     → ~150 words. State the symptom, your hypothesis for the root cause, and",
    "             the specific code change. Skip architecture unless the bug crosses",
    "             module boundaries.",
    "  NEW     → ~300–600 words, structured as:",
    "               Architecture: high-level shape, request/response contract.",
    "               Packages: minimal npm/pip/etc. dependencies you would add.",
    "               External integrations: services / APIs / models you will call.",
    "               Risk corners: timeouts, rate limits, secret handling, idempotency.",
    "               Test plan: how QA will verify each acceptance criterion.",
    "",
    "Start your proposal with one of these literal lines:",
    '  "Complexity: TRIVIAL" / "Complexity: BUG" / "Complexity: NEW".',
    "",
    "End your proposal with a single JSON line:",
    `{"packages": ["pkg1","pkg2"], "externalDependencies": ["api1","api2"]}`,
    "Empty arrays are fine — and for TRIVIAL fixes they usually are.",
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
      ? `Rework target: ${context.existingToolName} (start from the current source below).`
      : undefined,
    context.bugContext ? `Bug to fix:\n${context.bugContext}` : undefined,
    context.existingToolSource
      ? [
          "CURRENT IMPLEMENTATION — your starting point. Apply the bug context as a",
          "MINIMAL edit on top of this code. Preserve every behaviour that the bug",
          "context does not explicitly call out for change (input fields, output",
          "structure, validation rules, secret handling, helper functions, etc.).",
          "If a previous version added a feature (e.g., 'reverse the output'),",
          "keep it unless the bug context says otherwise.",
          "```ts",
          context.existingToolSource.length > 12000
            ? `${context.existingToolSource.slice(0, 12000)}\n…[truncated ${context.existingToolSource.length - 12000} chars]`
            : context.existingToolSource,
          "```",
        ].join("\n")
      : undefined,
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
    "  6. Imports are unrestricted: Node built-ins (node:http, node:fs, etc.),",
    "     `zod`, and ANY npm package you list in `packageJson.dependencies`",
    "     below. The runner runs `npm install` in the tool's own isolated",
    "     bundle before the first call, so whatever you declare gets",
    "     installed — including any postinstall script you wire up.",
    "  7. Keep the file self-contained — no top-level side effects, no helper files.",
    "",
    "Reply with a SINGLE JSON object containing the file body AND an optional",
    "package.json patch. The patch is MERGED into the runtime scaffold's canonical",
    "defaults: the model owns runtime concerns (`dependencies`, install",
    "`scripts.postinstall`, extra `devDependencies`); the scaffold owns the tsc",
    "build + HTTP-server wrapper. Shape:",
    "",
    "{",
    `  "files":[{"path":"${targetPath}","content":"…the file body…"}],`,
    `  "packageJson": {`,
    `    "dependencies": { "<npm-name>": "<semver-range>" },`,
    `    "scripts": { "postinstall": "<install command for any runtime binary you need>" }`,
    `  }`,
    "}",
    "",
    "Rules for `packageJson`:",
    "  - Pin runtime deps to a caret-range you trust (e.g. `^4.3.6`), NOT `latest`.",
    "    The runner falls back to `latest` only for deps it auto-extracts from",
    "    your `import` statements when you forgot to declare them.",
    "  - If your dep needs a runtime binary or native module the npm tarball",
    "    doesn't ship with, add the appropriate install command under",
    "    `scripts.postinstall`. Look up the command in the dep's own docs",
    "    rather than guessing.",
    "  - Use real, canonical package names that resolve on the npm registry.",
    "    If you are not 100% sure a name exists, issue a `<request_research>`",
    "    block to look it up — npm 404s waste a full repair cycle.",
    "  - `packageJson` is optional. Omit it for tools that only need built-ins",
    "    + zod. The scaffold's defaults still apply.",
    "",
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
    `path), wrapped in the same JSON envelope: {"files":[{"path","content"}], "packageJson"?:{...}}.`,
    "You MAY also adjust `packageJson.dependencies` / `packageJson.scripts.postinstall`",
    "if the review pointed at a dep/install issue. Omit packageJson to keep prior.",
    "Do not re-emit scaffolding (index.ts, runtime/server.ts, etc).",
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
  /** Previous version's source — for reworks, used to compute the real diff. */
  previousToolSource?: string;
  repairFailures: string[];
  qaPassed: boolean;
  isRework: boolean;
}): Message[] {
  const { context, toolBodyExcerpt, previousToolSource, repairFailures, qaPassed, isRework } = args;
  const user = [
    `Tool name: ${context.name}`,
    `Description: ${context.description}`,
    isRework && context.bugContext ? `Bug / change request:\n${context.bugContext}` : undefined,
    repairFailures.length > 0
      ? `QA failures the council repaired:\n${repairFailures.map((f) => `  - ${f}`).join("\n")}`
      : undefined,
    !qaPassed ? "Note: this build did NOT pass QA after all repair attempts." : undefined,
    "",
    isRework && previousToolSource
      ? [
          "PREVIOUS VERSION (what the tool used to do):",
          "```ts",
          previousToolSource.slice(0, 3000),
          previousToolSource.length > 3000 ? `…[truncated ${previousToolSource.length - 3000} chars]` : "",
          "```",
          "",
          "NEW VERSION (what it does now):",
        ].join("\n")
      : "Tool body (current source):",
    "```ts",
    toolBodyExcerpt.slice(0, 3000),
    toolBodyExcerpt.length > 3000 ? `…[truncated ${toolBodyExcerpt.length - 3000} chars]` : "",
    "```",
    "",
    isRework
      ? [
          "Produce a SINGLE 1-2 sentence changelog entry describing exactly WHAT CHANGED",
          "between the previous and new version. Focus on the diff, not on what the tool",
          "does in general. If the bug context introduced a new behaviour, name it; if",
          "the previous version's behaviour was preserved on top, mention that too.",
          "",
          "Style examples for reworks (notice each one points at a SPECIFIC change):",
          '  - "Added character count to output on a new line; reverse-output behaviour from v1.0.24 preserved."',
          '  - "Now returns ok=false on empty input instead of crashing; output formatting unchanged."',
          '  - "Switched validation from regex to zod schema; output is identical."',
        ].join("\n")
      : [
          "Produce a SINGLE 1-2 sentence changelog entry describing what this tool does.",
          "",
          "Style examples for initial releases:",
          '  - "Initial release: fetches hourly weather forecast for a city via the open-meteo public API."',
          '  - "Initial release: echoes user-provided text back as content, rejecting empty payloads."',
        ].join("\n"),
    "",
    "Constraints:",
    "  - Write in plain English (NOT Russian, NOT another language).",
    "  - 1-2 sentences total, max ~30 words.",
    "  - Do NOT wrap in quotes, JSON, backticks, or any envelope — emit raw prose.",
    "  - Do NOT mention the version number or `council-built` — those are in metadata already.",
    isRework
      ? "  - The summary MUST describe a delta. If you can't identify any actual change, say so: 'No functional change; refactored for clarity.'"
      : undefined,
    !qaPassed ? "  - Prefix the sentence with `(QA failed)` so the operator notices." : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    {
      role: "system",
      content:
        "You write tight, factual one-line changelog entries for a tool registry. " +
        "Always English, always under 30 words, always plain prose. " +
        "For reworks, ALWAYS describe the diff between previous and new — not just what the tool does.",
    },
    { role: "user", content: user },
  ];
}

/**
 * Phase 14 follow-up: descriptionPrompt synthesizes the canonical
 * tool description that EVERY OTHER AGENT sees when picking tools
 * from the registry. The operator's form input is just a hint —
 * after the council registers the actual implementation, we ask a
 * fast model to read the final source and write a 2-3 sentence
 * description focused on shape (inputs, outputs) so a downstream
 * worker can choose this tool without seeing the source. Re-runs on
 * every rework so the description follows the code.
 */
export function descriptionPrompt(args: {
  context: ToolBuildContext;
  toolBodyExcerpt: string;
}): Message[] {
  const { context, toolBodyExcerpt } = args;
  const user = [
    `Tool name: ${context.name}`,
    `Operator hint (may be outdated — the code is the source of truth):`,
    context.description,
    "",
    "Tool source:",
    "```ts",
    toolBodyExcerpt.slice(0, 4000),
    toolBodyExcerpt.length > 4000 ? `…[truncated ${toolBodyExcerpt.length - 4000} chars]` : "",
    "```",
    "",
    "Write a 2-3 sentence description for the tool registry. Other agents read this",
    "when deciding whether to call the tool, so it must be CONCRETE about shape:",
    "  - What the tool does (one sentence).",
    "  - What input it accepts (required fields by name + type).",
    "  - What it returns on success (content + data shape).",
    "",
    "Style examples:",
    '  - "Fetches hourly weather forecast for a city via the open-meteo public API. ' +
      'Input: {city: string, hours?: number}. Output: ok=true with content=<summary> and ' +
      'data.forecast: Array<{time, temp, precipitation}>."',
    '  - "Renders an SVG line chart from numeric data points (no external libraries). ' +
      'Input: {title: string, points: Array<{x: number, y: number}>}. Output: ok=true ' +
      'with content being the SVG markup."',
    "",
    "Constraints:",
    "  - Plain English. 2-3 sentences total, max ~60 words.",
    "  - No quotes / no backticks / no JSON envelope — emit raw prose.",
    "  - Do NOT mention the version number or `council-built`.",
    "  - If the code has obvious limits (max input size, supported MIME types,",
    "    upstream URL), mention them in one short clause.",
  ].join("\n");
  return [
    {
      role: "system",
      content:
        "You write canonical tool descriptions for an agent registry. Every other agent " +
        "will see your output and decide whether to call the tool based on it — so be " +
        "concrete about input/output shape, not marketing-speak. Always English, always " +
        "under 60 words.",
    },
    { role: "user", content: user },
  ];
}

/**
 * Phase 28 — BUILD-PHASE fix prompt (narrow).
 *
 * Fired ONLY when the tool's bundle could not install + compile + start
 * (npm 404, tsc compile error, install-probe subprocess crash). The
 * model's job here is laser-focused: get the bundle to LOAD, period.
 * It does NOT see QA acceptance criteria — those are irrelevant until
 * the tool actually runs. It does NOT change behaviour for behaviour's
 * sake — only what's required to make `npm install + tsc -p . + start`
 * succeed.
 *
 * Distinct from `repairPrompt` (QA-FIX), which fires AFTER the bundle
 * already starts and only its OUTPUT needs work. Mixing the two used to
 * confuse the model — it would refactor logic to "fix" an npm-install
 * error, or add a missing package while also tweaking the algorithm.
 * The split gives each LLM exactly one concern.
 */
export function buildFixPrompt(args: {
  context: ToolBuildContext;
  winner: CouncilProposal;
  code: string;
  packageJsonText: string | undefined;
  buildError: string;
  attempt: number;
  maxAttempts: number;
}): Message[] {
  const { context, winner, code, packageJsonText, buildError, attempt, maxAttempts } = args;
  const refsBlock = formatReferenceDocsBlock(context.referenceDocs);
  const user = [
    `Tool name: ${context.name}`,
    "",
    "BUILD-PHASE FIX — your one job is to make this bundle install + compile + start.",
    `Attempt ${attempt}/${maxAttempts}. If you fail again, the run aborts.`,
    "",
    refsBlock,
    "Original winning proposal (do not redesign — preserve intent):",
    winner.content.trim(),
    "",
    "Current tool source:",
    code.trim(),
    "",
    packageJsonText
      ? `Current packageJson dependencies/scripts/devDependencies (model-owned slice):\n${packageJsonText}`
      : "No model packageJson patch yet — scaffold defaults are in effect.",
    "",
    "BUILD ERROR (raw stderr from npm install / tsc / cold-start probe — fix THIS):",
    "```",
    buildError.slice(0, 4000),
    buildError.length > 4000 ? `…[truncated ${buildError.length - 4000} chars]` : "",
    "```",
    "",
    "Rules for this fix:",
    "  - Goal: make the bundle install + compile + start. Nothing else.",
    "  - You MAY change package names, add dependencies, add scripts.postinstall,",
    "    fix import paths, add tsc type annotations, narrow types. You MAY change",
    "    a few lines of code if that's the cleanest fix.",
    "  - You MUST NOT redesign the tool's algorithm, change its inputSchema /",
    "    outputSchema, alter what it returns, or 'improve' behaviour beyond what",
    "    the build error literally requires.",
    "  - Wrong-name packages (npm 404): the dep does NOT exist on the registry.",
    "    Do not retry name variants without verifying. Issue a `<request_research>`",
    "    block to look up the canonical name when uncertain, then swap it.",
    "  - Missing runtime binary (`Executable doesn't exist`): add a postinstall",
    "    that fetches the binary into the tool's own node_modules.",
    "  - tsc strict-mode errors (`Parameter 'x' implicitly has an 'any' type`,",
    "    `Cannot find name 'process'`): add the missing type annotations or",
    "    types. Do not weaken tsconfig.",
    "  - module-not-found at runtime: either the package is missing from",
    "    dependencies, or the import path is wrong.",
    "",
    "Emit the FULL revised tool body (same single file at the same path), wrapped",
    `in the JSON envelope: {"files":[{"path","content"}], "packageJson"?:{...}}.`,
    "Include packageJson ONLY if the build error involves install / deps / postinstall.",
    "Do not re-emit scaffolding (index.ts, runtime/server.ts, tsconfig.json).",
    "Do not change the tool name.",
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: COUNCIL_SYSTEM_PROMPT_DEFAULT },
    { role: "user", content: user },
  ];
}

export function repairPrompt(
  context: ToolBuildContext,
  winner: CouncilProposal,
  code: string,
  qaFailures: readonly string[],
  toolOutput?: { ok: boolean; content: string; data?: unknown },
): Message[] {
  const refsBlock = formatReferenceDocsBlock(context.referenceDocs);
  // The literal tool output (stderr / runtime exception text) is FAR
  // more diagnostic than the oracle's high-level "failures" summary
  // — it tells the model exactly which import is broken, which field
  // is missing, which stack frame faulted. Without it the repair
  // loop has historically gotten stuck repeating the same import bug
  // because the oracle only described the SYMPTOM ("ok=false") and
  // never the root cause.
  const outputBlock = toolOutput
    ? [
        "Actual tool output from the last QA attempt:",
        `  ok: ${toolOutput.ok}`,
        `  content: ${truncate(toolOutput.content || "(empty)", 1500)}`,
        toolOutput.data !== undefined
          ? `  data: ${truncate(JSON.stringify(toolOutput.data ?? {}, null, 2), 600)}`
          : undefined,
        "",
        "If `content` contains a SyntaxError, runtime stack trace, or 'Source-bundle HTTP",
        "runtime exited before healthcheck' message, FIX THAT specific error first — the",
        "QA oracle only sees ok=false and cannot tell you which import / syntax / module",
        "is broken.",
      ]
        .filter(Boolean)
        .join("\n")
    : undefined;
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
    outputBlock,
    "QA failures (what the oracle reported):",
    ...qaFailures.map((f) => `  - ${f}`),
    "",
    "Apply targeted fixes that make every criterion pass without breaking the others.",
    "",
    // Phase 22 Slice B — explicit research-trigger hint. The most
    // common QA loop wedge is "the LLM keeps reapplying the same
    // wrong library call because its training data was a year out
    // of date". The repair prompt now nudges the model to verify
    // its API assumptions via the research delegate (if available
    // it's already documented in the appended system block) BEFORE
    // it writes another fix. We don't force it — high-confidence
    // models that genuinely know the right API skip the research
    // hop with no penalty.
    "Before you edit, check whether the QA failure suggests you misused a third-party",
    "library or API (wrong plugin init, wrong option name, missing await, removed since",
    "your training cutoff). If so AND a `Research (optional)` block was appended below,",
    "EMIT a `<request_research>` block with the question first — pulling current docs",
    "is much cheaper than burning another QA attempt on the same wrong assumption.",
    "",
    "Emit the FULL revised tool body (same single file at the same path), wrapped",
    `in the JSON envelope: {"files":[{"path","content"}], "packageJson"?:{...}}.`,
    "When the QA failure is install-shape, fix it via the `packageJson` block.",
    "Install-shape covers any signal that the bundle could not LOAD or START:",
    "  - npm install returned 404 (dependency name doesn't exist on the registry),",
    "  - npm install completed but `Source-bundle HTTP runtime exited before healthcheck`",
    "    (top-level `throw` from the imported module, native binding mismatch),",
    "  - subprocess started but `Cannot find module` / `ERR_MODULE_NOT_FOUND` /",
    "    `Executable doesn't exist` surfaced at runtime,",
    "  - tsc reported a strict-mode error you cannot fix without changing the dep,",
    "  - a per-dep dynamic-import probe flagged one of your declared deps as broken.",
    "",
    "What to do (without guessing — use the research delegate when uncertain):",
    "  - WRONG NAME (404, typosquatter stub, deprecated placeholder): find the",
    "    canonical package name yourself. Do NOT keep retrying name variants —",
    "    issue a `<request_research>` block first to look up what the real",
    "    package is called on the npm registry. When you have the answer,",
    "    REMOVE the bad name from `packageJson.dependencies`, ADD the correct",
    "    one, and update the source import to match. Source and packageJson",
    "    must agree.",
    "  - MISSING DEPENDENCY: add the missing package to `packageJson.dependencies`,",
    "    or remove the unnecessary import.",
    "  - MISSING RUNTIME BINARY: add a `scripts.postinstall` that fetches the",
    "    binary into the tool's own node_modules (per the dep's own docs —",
    "    look it up if you don't remember the exact command).",
    "  - NATIVE BUILD ERROR: pin a known-working version range, or swap the",
    "    dep for a JS-only alternative.",
    "  - tsc errors are NOT install-shape: fix them in the tool source.",
    "",
    "Never patch the scaffold's `build` / `start` scripts or its tsc devDependencies.",
    "Omit `packageJson` when the fix is purely in the tool source.",
    "Do not re-emit scaffolding (index.ts, runtime/server.ts, tsconfig.json).",
    "Do not change the tool name.",
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
