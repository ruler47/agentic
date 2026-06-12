import { Subtask } from "../types.js";

/**
 * The base runtime does not regex-match the task text for specific domain
 * words. These helpers intentionally return empty generic intent hints until a
 * new LLM-driven intent layer is rebuilt.
 *
 * Future contributors: do NOT add regex here. If the model is not
 * available, intent stays empty and LLM/tool contracts cover the actual
 * decision.
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
