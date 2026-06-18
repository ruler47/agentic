import type { ExternalActionType } from "../../../types.js";

export function selectAdaptivePreparationUrl(input: {
  actionType: ExternalActionType;
  currentUrl?: string;
  links: Array<{ text?: string; href: string }>;
}): string | undefined {
  const current = parseUrl(input.currentUrl);
  return input.links
    .map((link, index) => ({
      href: link.href,
      index,
      score: scoreAdaptivePreparationLink(input.actionType, link, current),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .at(0)?.href;
}

function scoreAdaptivePreparationLink(
  actionType: ExternalActionType,
  link: { text?: string; href: string },
  current: URL | undefined,
): number {
  const target = parseUrl(link.href);
  if (!target) return 0;
  if (target.protocol !== "http:" && target.protocol !== "https:") return 0;
  if (current && sameUrlWithoutHash(current, target)) return 0;

  const text = normalizeLinkText(link.text);
  const hrefText = decodeURIComponent(
    `${target.hostname} ${target.pathname} ${target.search} ${target.hash}`,
  )
    .toLowerCase()
    .replace(/[-_./?=&:#%]+/g, " ");
  const combined = `${text} ${hrefText}`;
  if (!isExternalActionLink(actionType, combined)) return 0;
  let score = 0;
  if (current && target.hostname === current.hostname) score += 20;
  if (current && target.hostname !== current.hostname) score -= 25;
  if (
    /(facebook|instagram|tripadvisor|google|michelin|yelp|maps)\./i.test(
      target.hostname,
    )
  ) {
    score -= 40;
  }
  score += 50;
  if (isCommitOnlyLink(combined)) score -= 35;
  if (/^\s*$/.test(text) && !isExternalActionLink(actionType, hrefText)) {
    score -= 10;
  }
  return Math.max(0, score);
}

function isExternalActionLink(
  actionType: ExternalActionType,
  value: string,
): boolean {
  switch (actionType) {
    case "reservation":
      return /\b(reservation|reservations|reserve|reserva|reservar|booking|book|table|make your reservation)\b/i.test(value);
    case "appointment":
      return /\b(appointment|schedule|calendar|booking|book|availability|cita|reservar)\b/i.test(value);
    case "purchase":
      return /\b(product|cart|checkout|order|buy|shop|delivery|pickup)\b/i.test(value);
    case "outbound_message":
      return /\b(contact|message|email|support|chat|whatsapp|telegram)\b/i.test(value);
    case "api_write":
      return /\b(api|docs|swagger|openapi|mutation|post|webhook|console)\b/i.test(value);
    case "generic_external_action":
      return /\b(form|request|submit|workflow|action)\b/i.test(value);
  }
}

function isCommitOnlyLink(value: string): boolean {
  return /\b(confirm|submit|pay|payment|checkout|send|place order|finalize)\b/i.test(value);
}

function parseUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function sameUrlWithoutHash(left: URL, right: URL): boolean {
  return (
    left.protocol === right.protocol &&
    left.hostname === right.hostname &&
    left.pathname.replace(/\/+$/g, "") === right.pathname.replace(/\/+$/g, "") &&
    left.search === right.search
  );
}

function normalizeLinkText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}
