/**
 * Phase 12 Slice E: every regex that names a specific domain (flight
 * aggregators, medical portals, ...) lives ONLY in this file. The rest of
 * `src/agents/*.ts` is enforced clean by `tests/banDomainTokensInAgents.test.ts`.
 *
 * This file is the documented placeholder for the LLM-driven intent
 * classifier from the full Slice A plan: when the classification step
 * starts emitting `intent: string[]` directly, callers will replace
 * `inferTaskIntents` with `classification.intent` and the regex can be
 * deleted in one shot.
 *
 * Until then the regex must stay narrow enough that:
 * - tech tokens like `GPU`, `RAM`, `LLM`, `EUR`, `domain specialist` do not
 *   accidentally trip the flight or medical intent (the
 *   `run_1778320304262_oanslhzc` regression);
 * - and full-word matches still fire on real flight / medical phrasing in
 *   English and Russian.
 */

import { Subtask } from "../types.js";

export const KNOWN_INTENTS = ["flight-search", "medical-lookup"] as const;

export type KnownIntent = (typeof KNOWN_INTENTS)[number];

/**
 * Returns the subset of {@link KNOWN_INTENTS} that the raw text matches.
 * Order is stable; intents not in the list are never inferred (a future
 * `domain-pack` style extension can reuse the same shape).
 */
export function inferTaskIntents(text: string): string[] {
  const intents: string[] = [];
  // ASCII anchors use `\b` (works for English/Latin words). Cyrillic anchors
  // use `(?<![\p{L}])` because JS `\b` is ASCII-only and treats Cyrillic
  // characters as non-word. Stem patterns drop the trailing boundary so
  // `аллерголог`, `allergologist`, and `авиабилеты` are caught.
  const flightWord = /\b(?:flight|flights|airline|airlines|airport|airports|aviasales|skyscanner|kayak|momondo|expedia|ryanair|easyjet|vueling|lufthansa|turkishairlines|pegasus|kiwi\.com|trip\.com)\b/i;
  const flightCyr = /(?<![\p{L}])(?:рейс|авиа|перел[её]т|билет на самол[её]т)/iu;
  if (flightWord.test(text) || flightCyr.test(text)) {
    intents.push("flight-search");
  }
  const medicalWord = /\b(?:doctor|doctors|clinician|physician|clinic|hospital|doctolib|jameda|onedoc|topdoctors|aerzte|arzt|medecin|especialista)\b/i;
  const medicalStem = /\b(?:allerg|immunolog|allergolog)/i;
  const medicalCyr = /(?<![\p{L}])(?:врач|клиник|госпитал|аллерг|иммунолог|поликлиник)/iu;
  if (medicalWord.test(text) || medicalStem.test(text) || medicalCyr.test(text)) {
    intents.push("medical-lookup");
  }
  return intents;
}

/**
 * Discovery activation: should we bother running browser-operate against
 * search results? Generic discovery keywords (find / search / collect / ...)
 * are intent-neutral. Domain-specific triggers move into `inferTaskIntents`
 * — when no known intent matches, discovery still fires because the generic
 * keywords are a strong signal on their own.
 */
export function isDiscoveryText(text: string): boolean {
  const generic = /(find|search|identify|discover|collect|candidate|profile|directory|listing|catalog|найди|поиск|подбери|кандидат|профил|каталог|справочник|листинг)/i;
  return generic.test(text);
}

/**
 * Caller-known signal that the text wants interactive sources (booking /
 * provider directories / portal pages) rather than a static article. This
 * used to be a domain-flooded regex; here we keep only generic structural
 * markers and let `inferTaskIntents` cover domain ones.
 */
export function wantsInteractiveSource(text: string): boolean {
  const generic = /(directory|profile|listing|catalog|portal|booking|provider|staff|каталог|профил|портал|бронир|персонал|расписан)/i;
  return generic.test(text);
}

/**
 * Slice E: domain-specific search query expansion that used to inline regex
 * inside `buildSearchQueries`. Stays here behind explicit intent gates so
 * the runtime cannot trip them by accident.
 */
export function expandSearchQueriesByIntent(
  intents: string[],
  subtask: Pick<Subtask, "title" | "prompt">,
  contextHints: string,
  leadLine: string,
  cleanSearchQuery: (value: string) => string,
): string[] {
  const queries: string[] = [];

  if (
    intents.includes("medical-lookup") &&
    contextHints &&
    /doctor|clinic|allerg|immunolog|врач|клиник|аллерг|иммунолог/i.test(
      `${subtask.title} ${leadLine} ${contextHints}`,
    )
  ) {
    queries.push(
      cleanSearchQuery(
        `${subtask.title} ${leadLine} ${contextHints} doctor directory hospital staff Doctolib Jameda OneDoc`,
      ),
    );
  }

  if (intents.includes("flight-search")) {
    const iataCodes = [...new Set(subtask.prompt.match(/\b[A-Z]{3}\b/g) ?? [])];
    if (iataCodes.length >= 2) {
      queries.push(cleanSearchQuery(`${iataCodes.slice(0, 3).join(" ")} flights Google Flights Skyscanner Kayak`));
    }
    const routeMatch = subtask.prompt.match(
      /from\s+([A-Za-zА-Яа-яÁÉÍÓÚáéíóúñü\s-]+).*?\bto\s+([A-Za-zА-Яа-яÁÉÍÓÚáéíóúñü\s-]+)/i,
    );
    if (routeMatch) {
      queries.push(cleanSearchQuery(`${routeMatch[1]} to ${routeMatch[2]} flights Google Flights Skyscanner Kayak`));
    }
  }

  return queries;
}

/**
 * Slice E: intent-gated source-hint filter. Was a regex inside
 * `buildSearchQueries`. Returns the joined matching prompt lines or an
 * empty string when no intent allows the hints.
 */
export function extractIntentSourceHints(intents: string[], promptLines: string[]): string {
  if (!intents.includes("flight-search")) return "";
  return promptLines
    .filter((line) =>
      /google flights|skyscanner|kayak|momondo|booking|source|источник|ссылка/i.test(line),
    )
    .join(" ");
}
