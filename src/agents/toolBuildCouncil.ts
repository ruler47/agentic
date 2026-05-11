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
   * For rework / bugfix: existing tool name + context of what went wrong.
   * If both are present the prompts shift from "build new" to "fix this
   * existing tool".
   */
  existingToolName?: string;
  bugContext?: string;
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
  const user = [
    `Tool name: ${context.name}`,
    `User task: ${context.description}`,
    context.qaCriteria.length > 0
      ? `Acceptance criteria:\n${context.qaCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`
      : undefined,
    context.secretHandle ? `Secret handle available: ${context.secretHandle}` : undefined,
    context.existingToolName
      ? `Rework target: ${context.existingToolName} (start from this tool, do not duplicate state).`
      : undefined,
    context.bugContext ? `Bug to fix:\n${context.bugContext}` : undefined,
    "",
    "Winning proposal (your own):",
    winner.content.trim(),
    "",
    "Now produce the production TypeScript module that implements this tool exactly per",
    "the proposal. Use the docker-tool-service envelope: export an HTTP server that",
    "speaks /describe, /health, /run, /service/start, /service/stop. Imports must stick",
    "to declared packages.",
    "",
    "Reply with a SINGLE JSON object only:",
    `{"files":[{"path":"src/server.ts","content":"…"},{"path":"package.json","content":"…"},`,
    `         {"path":"Dockerfile","content":"…"}]}`,
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
  const user = [
    `Tool name: ${context.name}`,
    `User task: ${context.description}`,
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
    "behaviour. Keep the same docker-tool-service envelope. Reply with the same",
    `JSON shape as in the initial implement call: {"files":[{"path","content"}, …]}.`,
  ].join("\n");
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

export function repairPrompt(
  context: ToolBuildContext,
  winner: CouncilProposal,
  code: string,
  qaFailures: readonly string[],
): Message[] {
  const user = [
    `Tool name: ${context.name}`,
    `User task: ${context.description}`,
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
    "Keep the docker-tool-service envelope. Reply with the same JSON files object as",
    "before. Do not change the tool name.",
  ].join("\n");
  return [
    { role: "system", content: COUNCIL_SYSTEM_PROMPT_DEFAULT },
    { role: "user", content: user },
  ];
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}
