import { EvidencePattern } from "./tool.js";

/**
 * Phase 12 final: the universal agent has no built-in domain knowledge.
 * Specific host whitelists (flight aggregators, medical portals, retailers,
 * …) used to live here as a regex switch in `scoreArtifactUrl`. They were
 * removed because they encoded private case knowledge into the runtime,
 * which the "Capability Platform, Not Case Patches" principle forbids.
 *
 * Patterns now arrive through three universal channels:
 *   (a) `Tool.evidencePatterns` declared by registered tools — a flight
 *       tool brings its own host list with it,
 *   (b) scoped `evidence-pattern` memory entries — operators publish
 *       group-specific knowledge through the regular memory lifecycle,
 *   (c) the LLM URL ranker (`rankDiscoveryUrls`) — the model picks the
 *       best candidate URL for the subtask using world knowledge over
 *       result snippets. No host list needed.
 *
 * The CI lint in `tests/banDomainTokensInAgents.test.ts` keeps this file
 * empty by failing the build if a known aggregator/portal token reappears.
 */
export const BUILTIN_EVIDENCE_PATTERNS: EvidencePattern[] = [];

/**
 * Pure pattern matcher. Caller filters patterns by active intents and
 * passes the resulting array. Returns the highest score among patterns
 * that match `url`, or 0 when none do.
 */
export function scoreUrlAgainstPatterns(
  url: string,
  intents: readonly string[],
  patterns: readonly EvidencePattern[],
): number {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 0;
  }
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const fullUrl = url.toLowerCase();
  let best = 0;

  for (const pattern of patterns) {
    if (!intents.includes(pattern.intent)) continue;
    let matched = true;
    let hadCheck = false;

    if (pattern.hosts && pattern.hosts.length > 0) {
      hadCheck = true;
      const hostMatch = pattern.hosts.some((entry) => {
        const target = entry.replace(/^www\./, "").toLowerCase();
        return host === target || host.endsWith(`.${target}`);
      });
      if (!hostMatch) matched = false;
    }

    if (matched && pattern.pathPatterns && pattern.pathPatterns.length > 0) {
      hadCheck = true;
      const pathMatch = pattern.pathPatterns.some((re) => {
        try {
          return new RegExp(re, "i").test(path);
        } catch {
          return false;
        }
      });
      if (!pathMatch) matched = false;
    }

    if (matched && pattern.urlPatterns && pattern.urlPatterns.length > 0) {
      hadCheck = true;
      const urlMatch = pattern.urlPatterns.some((re) => {
        try {
          return new RegExp(re, "i").test(fullUrl);
        } catch {
          return false;
        }
      });
      if (!urlMatch) matched = false;
    }

    if (!hadCheck) continue;
    if (matched && pattern.score > best) best = pattern.score;
  }

  return best;
}

/**
 * Detect bare aggregator landings. With an empty built-in seed this only
 * fires for hosts that appear in tool-contract or memory-supplied
 * patterns. The result is intentionally pattern-driven: there is no
 * domain knowledge in the runtime; the data decides.
 */
export function isGenericLandingUrl(url: string, patterns: readonly EvidencePattern[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const path = parsed.pathname.toLowerCase().replace(/\/+$/, "");

  for (const pattern of patterns) {
    if (!pattern.hosts) continue;
    const hostHit = pattern.hosts.some((entry) => {
      const target = entry.replace(/^www\./, "").toLowerCase();
      return host === target || host.endsWith(`.${target}`);
    });
    if (!hostHit) continue;
    if (path === "" || path === "/") return true;
  }
  return false;
}
