export const PROOF_SOURCE_URL_LIMIT = 5;

export function isProofWorthySourceUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function uniqueProofWorthyUrls(urls: string[]): string[] {
  const unique = new Set<string>();
  for (const url of urls) {
    if (!isProofWorthySourceUrl(url)) continue;
    const normalized = normalizeUrlForComparison(url);
    if (normalized) unique.add(normalized);
  }
  return [...unique];
}

export function urlsReferToSamePage(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.hostname.toLowerCase() === b.hostname.toLowerCase()
      && normalizePathForProof(a.pathname) === normalizePathForProof(b.pathname);
  } catch {
    return left === right;
  }
}

function normalizeUrlForComparison(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase()}${normalizePathForProof(parsed.pathname)}`;
  } catch {
    return undefined;
  }
}

function normalizePathForProof(pathname: string): string {
  const normalized = pathname.replace(/\/+$/g, "");
  return normalized || "/";
}
