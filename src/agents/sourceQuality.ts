export type RunSourceType =
  | "asset"
  | "search_results"
  | "primary"
  | "official_docs"
  | "pricing"
  | "product"
  | "review"
  | "directory"
  | "roundup"
  | "social"
  | "unknown";

const TRACKING_QUERY_KEYS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "ref",
  "ref_src",
  "source",
  "spm",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
]);

export function normalizeSourceUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (shouldStripQueryKey(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/g, "");
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function classifySourceType(input: {
  url: string;
  title?: string;
  snippet?: string;
}): RunSourceType {
  const normalized = normalizeSourceUrl(input.url) ?? input.url;
  const haystack = `${normalized} ${input.title ?? ""} ${input.snippet ?? ""}`.toLowerCase();
  const host = hostname(normalized);
  if (sourceUrlExclusionReason(normalized) === "technical asset") return "asset";
  if (sourceUrlExclusionReason(normalized) === "search results page") return "search_results";
  if (isSocialHost(host)) return "social";
  if (/\b(?:docs?|documentation|reference|api|developer|developers|openapi|swagger|manual|guide\/api)\b/.test(haystack)) {
    return "official_docs";
  }
  if (/\b(?:pricing|prices?|tariff|plans?|shop|store|buy|checkout|cart|booking|appointment|reservation)\b/.test(haystack)) {
    return "pricing";
  }
  if (/\/(?:product|products|item|dp|p|sku)\b|\b(?:specs?|features?|datasheet)\b/.test(haystack)) {
    return "product";
  }
  if (/\b(?:review|benchmark|tested|hands[-\s]?on|comparison|vs\.?)\b/.test(haystack)) return "review";
  if (/\b(?:best|top|roundup|picks?|guide|list|alternatives)\b/.test(haystack)) return "roundup";
  if (/\b(?:directory|listing|search|nearby|places?|map|catalog|profiles?)\b/.test(haystack)) return "directory";
  return "unknown";
}

export function sourceQualityScore(input: {
  sourceType: RunSourceType;
  readStatus?: "passed" | "failed" | "blocked" | "skipped_reuse";
  url?: string;
}): number {
  let score = 0.45;
  if (input.readStatus === "passed") score += 0.25;
  if (input.readStatus === "blocked" || input.readStatus === "failed") score -= 0.25;
  if (input.readStatus === "skipped_reuse") score += 0.1;
  score += {
    asset: -0.45,
    search_results: -0.35,
    primary: 0.2,
    official_docs: 0.18,
    pricing: 0.12,
    product: 0.1,
    review: 0.04,
    directory: 0,
    unknown: 0,
    roundup: -0.08,
    social: -0.16,
  }[input.sourceType];
  if (input.url && /^https:\/\//i.test(input.url)) score += 0.03;
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

export function sourceUrlExclusionReason(rawUrl: string): "technical asset" | "search results page" | undefined {
  const normalized = normalizeSourceUrl(rawUrl);
  if (!normalized) return undefined;
  const parsed = new URL(normalized);
  const host = parsed.hostname.replace(/^www\./, "");
  const path = parsed.pathname.toLowerCase();
  if (/\.(?:woff2?|ttf|otf|eot|css|m?js|map|png|jpe?g|gif|webp|avif|ico|svg|mp4|webm|mov|mp3|wav)$/i.test(path)) {
    return "technical asset";
  }
  if (isSearchResultsPage(host, path, parsed.searchParams)) return "search results page";
  return undefined;
}

export function taskExplicitlyTargetsSourceHost(task: string, rawUrl: string): boolean {
  const normalized = normalizeSourceUrl(rawUrl);
  if (!normalized) return false;
  const host = hostname(normalized);
  const hostTokens = host.split(".").filter((token) => token.length > 2);
  const taskLower = task.toLowerCase();
  return hostTokens.some((token) => taskLower.includes(token)) ||
    /(?:reddit|youtube|ютуб|реддит|соцсет|форум|forum|video|видео)/i.test(task);
}

export function extractTitleLike(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["title", "pageTitle", "name", "label"]) {
    const nested = record[key];
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  for (const nested of Object.values(record)) {
    const found = extractTitleLike(nested);
    if (found) return found;
  }
  return undefined;
}

function shouldStripQueryKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return TRACKING_QUERY_KEYS.has(normalized) ||
    normalized.startsWith("utm_") ||
    /(?:token|api[-_]?key|secret|signature|session|password|auth)/i.test(normalized);
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isSocialHost(host: string): boolean {
  return /(?:^|\.)((facebook|instagram|linkedin|reddit|tiktok|twitter|x|youtube)\.com|youtu\.be)$/.test(host);
}

function isSearchResultsPage(host: string, path: string, searchParams: URLSearchParams): boolean {
  if (/^(?:google|bing|yahoo|duckduckgo|yandex)\./i.test(host) && (path.includes("search") || searchParams.has("q"))) {
    return true;
  }
  if (host === "youtube.com" && path.startsWith("/results")) return true;
  if (host === "reddit.com" && /\/search\/?$|\/search$/.test(path)) return true;
  if (host === "reddit.com" && /\/r\/[^/]+\/search\/?$/.test(path)) return true;
  if (host === "tiktok.com" && path.startsWith("/search")) return true;
  return false;
}
