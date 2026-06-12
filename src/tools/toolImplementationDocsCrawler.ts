type FetchLike = typeof fetch;

type CrawledDocsPage = {
  url: string;
  text: string;
};

export async function fetchDocumentationPages(options: {
  urls: string[];
  fetchImpl: FetchLike;
  signal: AbortSignal | undefined;
  maxPages?: number;
}): Promise<CrawledDocsPage[]> {
  const maxPages = Math.max(1, options.maxPages ?? 6);
  const queue = normalizeSeedUrls(options.urls).slice(0, 3);
  const seen = new Set<string>();
  const pages: CrawledDocsPage[] = [];
  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const text = await fetchDocsUrl(url, options.fetchImpl, options.signal);
    if (!text) continue;
    pages.push({ url, text });
    for (const next of extractDocsLinks(text, url)) {
      if (pages.length + queue.length >= maxPages) break;
      if (!seen.has(next) && !queue.includes(next)) queue.push(next);
    }
  }
  return pages;
}

function normalizeSeedUrls(urls: string[]): string[] {
  return urls
    .map((url) => normalizeDocsUrl(url))
    .filter((url): url is string => Boolean(url));
}

async function fetchDocsUrl(
  url: string,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(url, { signal });
    const text = await response.text();
    if (!response.ok || !text.trim()) return undefined;
    return text.slice(0, 200_000);
  } catch {
    return undefined;
  }
}

function extractDocsLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const out: string[] = [];
  const seen = new Set<string>();
  const pattern = /<a\b[^>]*\bhref\s*=\s*(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/giu;
  for (const match of html.matchAll(pattern)) {
    const href = decodeHtml(match[2] ?? "").trim();
    const label = stripTags(decodeHtml(match[3] ?? "")).trim();
    if (!isRelevantDocsLink(href, label)) continue;
    const normalized = normalizeDocsUrl(href, base);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.slice(0, 8);
}

function normalizeDocsUrl(raw: string, base?: URL): string | undefined {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (base && url.origin !== base.origin) return undefined;
    if (/\.(?:png|jpe?g|gif|svg|webp|pdf|zip|gz|tgz|mp4|mov)$/i.test(url.pathname)) return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function isRelevantDocsLink(href: string, label: string): boolean {
  const haystack = `${href} ${label}`.toLowerCase();
  if (!haystack.trim()) return false;
  return /\b(api|auth|authentication|authorization|endpoint|reference|operation|request|response|example|quickstart|guide|docs?|webhook|openapi)\b/.test(haystack);
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
