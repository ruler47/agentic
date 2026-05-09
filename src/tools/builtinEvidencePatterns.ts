import { EvidencePattern } from "./tool.js";

/**
 * Phase 12 Slice B: the host scores that used to live as a regex switch
 * inside `scoreArtifactUrl` in `universalAgent.ts`. They moved here as data so
 * the runtime no longer hardcodes specific domains. New domain packs should
 * land as additional patterns (or, ultimately, on real registered tools that
 * declare their own `evidencePatterns`).
 *
 * Scores are kept identical to the pre-refactor values to preserve behaviour
 * for runs that DO infer `flight-search` or `medical-lookup`. Slice C lets
 * operators override / extend these via memory entries; Slice D moves URL
 * ranking to an LLM and uses these scores only as a fallback.
 */
export const BUILTIN_EVIDENCE_PATTERNS: EvidencePattern[] = [
  // Flight aggregators -----------------------------------------------------
  {
    intent: "flight-search",
    hosts: ["google.com"],
    pathPatterns: ["/travel/flights"],
    score: 120,
    notes: "Google Flights aggregator",
  },
  {
    intent: "flight-search",
    hosts: ["skyscanner.net", "skyscanner.com"],
    pathPatterns: ["routes", "flights"],
    score: 110,
    notes: "Skyscanner",
  },
  {
    intent: "flight-search",
    hosts: ["kayak.com"],
    pathPatterns: ["flight", "route"],
    score: 105,
    notes: "Kayak",
  },
  {
    intent: "flight-search",
    hosts: ["momondo.com", "kiwi.com", "expedia.com", "trip.com", "aviasales.com", "aviasales.ru"],
    pathPatterns: ["flight", "route"],
    score: 95,
    notes: "Tier-2 flight aggregators",
  },
  {
    intent: "flight-search",
    urlPatterns: ["pegasus", "turkishairlines", "ryanair", "easyjet", "vueling", "lufthansa"],
    score: 85,
    notes: "Direct airline carriers",
  },

  // Medical / doctor portals ----------------------------------------------
  {
    intent: "medical-lookup",
    hosts: ["doctolib.fr", "doctolib.de", "doctoralia.com", "jameda.de", "onedoc.ch", "topdoctors.es", "topdoctors.uk", "sanego.de", "miodottore.it"],
    score: 90,
    notes: "EU medical booking portals",
  },
  {
    intent: "medical-lookup",
    pathPatterns: [
      "find-?a-?doctor",
      "doctor",
      "doctors",
      "clinician",
      "specialist",
      "provider",
      "appointment",
      "booking",
      "aerzte",
      "arzt",
      "medecin",
      "especialista",
      "allergolog",
      "immunolog",
    ],
    score: 70,
    notes: "Path-level doctor / provider directory matches",
  },
  {
    intent: "medical-lookup",
    urlPatterns: ["hospital", "clinic", "medical", "health", "gesundheit", "hopital", "spital"],
    score: 45,
    notes: "Generic medical / health host fallback",
  },
  // NOTE: Phase 12 keeps the built-in seed deliberately small. Flights and
  // medical are the migration of pre-Phase 12 hardcodes; new domains
  // (product-comparison, restaurant, crypto, ...) must NOT be added here.
  // Instead they should arrive through (a) Tool.evidencePatterns when a
  // domain tool is registered, (b) memory entries (Slice C), or (c) the
  // LLM URL ranker (Slice D) which uses world knowledge over candidate
  // URL snippets and needs no host whitelist at all.
];

/**
 * Slice B: pure pattern matcher. No hardcoded domain knowledge — caller is
 * responsible for filtering patterns by active intents.
 *
 * Returns the highest score among patterns that match `url`, or 0 if none do.
 * Patterns whose `intent` is not in `intents` are skipped.
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

    if (!hadCheck) continue; // pattern with no checks is invalid; skip
    if (matched && pattern.score > best) best = pattern.score;
  }

  return best;
}

/**
 * `isGenericLandingUrl` formerly hardcoded the same flight aggregator list.
 * Slice B: a URL is "generic" when it is the bare host or "/" path of any
 * known evidence-pattern host. We keep the same semantics — discovery
 * downgrades a navigation to such a URL to a placeholder.
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
    // Bare landing page (no path) or just one of the well-known generic
    // landings the runtime previously special-cased.
    if (path === "" || path === "/" || path === "/flights" || path === "/travel/flights") {
      return true;
    }
  }
  return false;
}
