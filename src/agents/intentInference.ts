import { Subtask } from "../types.js";

/**
 * Phase 12 final: the universal agent does not regex-match the task text
 * for specific domain words. Task intent comes from the classifier model
 * via `TaskComplexity.intent[]` (see `classifyPrompt` in `prompts.ts`).
 * The runtime caches that list per run in
 * `UniversalAgent.runScopedIntents` and reads it through
 * `resolveTaskIntents(text, runId)`.
 *
 * The functions exported here remain only as compatibility shims so
 * legacy callers (CLI smokes, fixtures, recursive child invocations
 * that bypass `classify()`) get a defined value instead of a runtime
 * crash. They return empty results — the runtime then runs without any
 * domain-specific behaviour, which is the correct universal default.
 *
 * Future contributors: do NOT add regex here. If the model is not
 * available, intent stays empty and tier-2 LLM URL ranking + memory
 * patterns + tool contracts cover the actual decision.
 */

export const KNOWN_INTENTS = [] as const;

export type KnownIntent = string;

/** Compatibility shim: classifier output is the source of truth. */
export function inferTaskIntents(_text: string): string[] {
  return [];
}

/** Generic discovery signals. No domain anchors, no host names. */
export function isDiscoveryText(text: string): boolean {
  return /(find|search|identify|discover|collect|candidate|profile|directory|listing|catalog|найди|поиск|подбери|кандидат|профил|каталог|справочник|листинг)/i.test(
    text,
  );
}

/** Generic interactive-source signals. No domain anchors, no host names. */
export function wantsInteractiveSource(text: string): boolean {
  return /(directory|profile|listing|catalog|portal|booking|provider|staff|каталог|профил|портал|бронир|персонал|расписан)/i.test(
    text,
  );
}

/**
 * Compatibility shim. The previous regex-driven flight/medical query
 * expansion was removed; the planner-generated subtask prompt and the
 * search engine's own ranking carry that signal now.
 */
export function expandSearchQueriesByIntent(
  _intents: string[],
  _subtask: Pick<Subtask, "title" | "prompt">,
  _contextHints: string,
  _leadLine: string,
  _cleanSearchQuery: (value: string) => string,
): string[] {
  return [];
}

/** Compatibility shim. */
export function extractIntentSourceHints(_intents: string[], _promptLines: string[]): string {
  return "";
}
