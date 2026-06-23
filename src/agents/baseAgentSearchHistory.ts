import type { LlmToolReply } from "../llm/client.js";

export function findRepeatedSearchQuery(
  call: LlmToolReply["toolCalls"][number],
  history: Map<string, string>,
): { query: string; priorQuery: string } | undefined {
  const query = extractSearchQuery(call);
  if (!query) return undefined;
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return undefined;
  for (const [priorNormalized, priorQuery] of history) {
    if (normalized === priorNormalized || searchQuerySimilarity(normalized, priorNormalized) >= 0.82) {
      return { query, priorQuery };
    }
  }
  return undefined;
}

export function rememberSearchQuery(
  call: LlmToolReply["toolCalls"][number],
  history: Map<string, string>,
): void {
  const query = extractSearchQuery(call);
  if (!query) return;
  const normalized = normalizeSearchQuery(query);
  if (normalized && !history.has(normalized)) history.set(normalized, query);
}

function extractSearchQuery(call: LlmToolReply["toolCalls"][number]): string | undefined {
  if (!/(?:^|[._-])search$/i.test(call.name) && !/^web[_-]search$/i.test(call.name)) return undefined;
  const query = call.arguments.query;
  return typeof query === "string" && query.trim() ? query.trim() : undefined;
}

function normalizeSearchQuery(query: string): string {
  return query
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/["'`«»“”‘’()[\]{}]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token))
    .join(" ");
}

function searchQuerySimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  const leftTokens = new Set(left.split(/\s+/).filter(Boolean));
  const rightTokens = new Set(right.split(/\s+/).filter(Boolean));
  const tokenUnion = new Set([...leftTokens, ...rightTokens]);
  const tokenIntersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const tokenScore = tokenUnion.size ? tokenIntersection / tokenUnion.size : 0;
  return Math.max(tokenScore, ngramSimilarity(left, right));
}

function ngramSimilarity(left: string, right: string): number {
  const leftGrams = ngrams(left, 3);
  const rightGrams = ngrams(right, 3);
  if (!leftGrams.size || !rightGrams.size) return 0;
  const intersection = [...leftGrams].filter((gram) => rightGrams.has(gram)).length;
  const union = new Set([...leftGrams, ...rightGrams]).size;
  return intersection / union;
}

function ngrams(value: string, size: number): Set<string> {
  const compact = `  ${value.replace(/\s+/g, " ")}  `;
  const result = new Set<string>();
  for (let index = 0; index <= compact.length - size; index += 1) {
    result.add(compact.slice(index, index + size));
  }
  return result;
}

const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "best",
  "for",
  "in",
  "near",
  "of",
  "or",
  "query",
  "research",
  "search",
  "the",
  "to",
  "with",
  "найди",
  "поиск",
  "ресторан",
]);
