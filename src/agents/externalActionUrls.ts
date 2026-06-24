import type { ExternalActionType } from "../types.js";
import { isProofWorthySourceUrl } from "./proofSourceUrls.js";

export function prioritizedExternalActionSourceUrls(input: {
  actionType: ExternalActionType;
  finalAnswer: string;
  sourceUrls: string[];
}): string[] {
  const finalAnswerCandidates = extractExternalActionUrlCandidates(input.finalAnswer)
    .map((candidate, index) => ({
      ...candidate,
      index,
      score:
        scoreExternalActionPreparationUrl(input.actionType, candidate.url) +
        scoreExternalActionUrlContext(input.actionType, candidate.context),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((candidate) => candidate.url);
  return uniqueProofWorthyFullUrls([
    ...finalAnswerCandidates,
    ...input.sourceUrls,
  ]);
}

export function selectExternalActionPreparationUrl(
  actionType: ExternalActionType,
  sourceUrls: string[],
): string | undefined {
  // Input order is authoritative: callers pass URLs already prioritized by
  // answer citations and context. URL-shape score only FILTERS implausible
  // candidates — re-sorting by shape let keyword-stuffed junk domains
  // ("...-online-booking-....html" demo sites) beat the provider page the
  // model itself cited (AGENTS.md: shape scoring must not make an
  // off-topic URL relevant).
  return sourceUrls.find(
    (url) => scoreExternalActionPreparationUrl(actionType, url) > 0,
  );
}

function uniqueProofWorthyFullUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of urls) {
    if (!isProofWorthySourceUrl(url)) continue;
    const key = externalActionUrlKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(url);
  }
  return result;
}

function extractExternalActionUrlCandidates(text: string): Array<{ url: string; context: string }> {
  const candidates: Array<{ url: string; context: string }> = [];
  const markdownLinkPattern = /\[([^\]]{1,240})\]\((https?:\/\/[^)\s]+)\)/giu;
  for (const match of text.matchAll(markdownLinkPattern)) {
    const label = match[1]?.trim() ?? "";
    const url = cleanExternalActionUrl(match[2] ?? "");
    if (!url) continue;
    candidates.push({
      url,
      context: `${label} ${lineAroundOffset(text, match.index ?? 0)}`.trim(),
    });
  }

  const bareUrlPattern = /https?:\/\/[^\s<>)\]]+/giu;
  for (const match of text.matchAll(bareUrlPattern)) {
    const url = cleanExternalActionUrl(match[0] ?? "");
    if (!url) continue;
    candidates.push({
      url,
      context: lineAroundOffset(text, match.index ?? 0),
    });
  }

  return candidates;
}

function cleanExternalActionUrl(rawUrl: string): string | undefined {
  const trimmed = rawUrl
    .trim()
    .replace(/^[<("'`*_]+/u, "")
    .replace(/[>"'`*_)\]}.,;:!?]+$/u, "");
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function lineAroundOffset(text: string, offset: number): string {
  const start = Math.max(0, text.lastIndexOf("\n", offset - 1) + 1);
  const nextBreak = text.indexOf("\n", offset);
  const end = nextBreak === -1 ? text.length : nextBreak;
  return text.slice(start, end).trim();
}

function scoreExternalActionUrlContext(
  actionType: ExternalActionType,
  context: string,
): number {
  const normalized = normalizeForExternalAction(context);
  let score = 0;
  if (/(?:\b(?:book|booking|reserve|reservation|schedule|appointment|checkout|order|cart|contact|form|submit|online)\b|брон|резерв|запис|заявк|заказ|купить|оформ|отправ|форма|ссылка\s+для|онлайн)/iu.test(normalized)) {
    score += 60;
  }
  score += scoreActionSpecificUrlHints(
    actionType,
    normalized.replace(/[-_./?=&]+/g, " "),
  );
  if (/(?:\bsource\b|\barticle\b|\bblog\b|\bguide\b|\breview\b|источник|статья|обзор|гид|справочник)/iu.test(normalized)) {
    score -= 20;
  }
  return score;
}

function scoreExternalActionPreparationUrl(
  actionType: ExternalActionType,
  rawUrl: string,
): number {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 0;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return 0;
  const normalized = decodeURIComponent(`${url.hostname} ${url.pathname} ${url.search}`)
    .toLowerCase()
    .replace(/[-_./?=&]+/g, " ");
  let score = url.protocol === "https:" ? 5 : 1;
  if (/\b(search|results?|serp|maps?|images?|video|cache)\b/.test(normalized)) {
    score -= 40;
  }
  // Editorial/listing pages are research sources, not action targets.
  if (/\b(blog|article|articles|guide|guides|review|reviews|news|wiki|top|best)\b/.test(normalized)) {
    score -= 40;
  }
  if (/(google|bing|yandex|duckduckgo)\./.test(url.hostname)) score -= 60;
  if (/\b(book|booking|reserve|reservation|reserva|reservar|schedule|appointment|checkout|order|cart|contact|form)\b/.test(normalized)) {
    score += 45;
  }
  score += scoreActionSpecificUrlHints(actionType, normalized);
  return Math.max(0, score);
}

function scoreActionSpecificUrlHints(
  actionType: ExternalActionType,
  normalizedUrl: string,
): number {
  switch (actionType) {
    case "reservation":
      return /\b(table|reservation|reserve|reserva|reservar|book|booking)\b/.test(
        normalizedUrl,
      ) ? 25 : 0;
    case "appointment":
      return /\b(appointment|schedule|calendar|book|booking)\b/.test(
        normalizedUrl,
      ) ? 25 : 0;
    case "purchase":
      return /\b(product|checkout|cart|order|buy|shop|delivery|pickup)\b/.test(
        normalizedUrl,
      ) ? 25 : 0;
    case "outbound_message":
      return /\b(contact|message|email|support|chat|compose)\b/.test(
        normalizedUrl,
      ) ? 25 : 0;
    case "api_write":
      return /\b(api|docs|swagger|openapi|mutation|post|webhook)\b/.test(
        normalizedUrl,
      ) ? 25 : 0;
    case "generic_external_action":
      return /\b(action|submit|form|request|workflow)\b/.test(normalizedUrl) ? 20 : 0;
  }
}

function externalActionUrlKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/g, "") || "/"}`;
  } catch {
    return undefined;
  }
}

function normalizeForExternalAction(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
