import { SkillMemoryEntry } from "../types.js";
import { EvidencePattern } from "../tools/tool.js";
import { SkillMemoryStore, normalizeMemoryStatus } from "./skillMemory.js";

/**
 * Phase 12 Slice C: operators can publish evidence patterns as scoped memory
 * entries — same lifecycle (proposed → accepted) and audit trail as any other
 * memory. The runtime reads `accepted` entries tagged `evidence-pattern` plus
 * an `intent:<name>` tag, parses the JSON spec stored in `reusableProcedure`,
 * and merges the result with built-in patterns + tool-contract patterns.
 *
 * Memory entry layout convention:
 *
 *     {
 *       title: "Spain laptop retailers - product-comparison",
 *       tags: ["evidence-pattern", "intent:product-comparison"],
 *       summary: "Native EU stockists rank above generic blogs",
 *       reusableProcedure: JSON.stringify({
 *         hosts: ["pccomponentes.com", "amazon.es"],
 *         pathPatterns: ["laptop"],
 *         score: 95,
 *       }),
 *       scope: "global",
 *       status: "accepted",
 *       sensitivity: "normal",
 *     }
 *
 * The `intent` is read from the tag (single source of truth); the JSON body
 * may NOT override it. `score` defaults to 50 when omitted, room for both
 * promotion above built-ins (which top out at 120) and demotion below them.
 *
 * If the JSON cannot be parsed, the entry is silently ignored — operator
 * mistakes never crash the runtime. Parse errors are logged via a returned
 * `errors` array so callers can surface them in tracing/diagnostics.
 */

const EVIDENCE_PATTERN_TAG = "evidence-pattern";
const INTENT_TAG_PREFIX = "intent:";

export type ParsedEvidencePatternMemory = {
  pattern: EvidencePattern;
  memoryId: string;
  scope: SkillMemoryEntry["scope"];
  scopeId?: string;
};

export type EvidencePatternParseError = {
  memoryId: string;
  reason: string;
};

export type LoadEvidencePatternsResult = {
  patterns: EvidencePattern[];
  parsed: ParsedEvidencePatternMemory[];
  errors: EvidencePatternParseError[];
};

export function parseEvidencePatternMemory(
  entry: SkillMemoryEntry,
): ParsedEvidencePatternMemory | EvidencePatternParseError {
  const tags = (entry.tags ?? []).map((tag) => tag.toLowerCase());
  if (!tags.includes(EVIDENCE_PATTERN_TAG)) {
    return { memoryId: entry.id, reason: "missing evidence-pattern tag" };
  }
  const intentTag = tags.find((tag) => tag.startsWith(INTENT_TAG_PREFIX));
  if (!intentTag) {
    return { memoryId: entry.id, reason: "missing intent:<name> tag" };
  }
  const intent = intentTag.slice(INTENT_TAG_PREFIX.length).trim();
  if (!intent) {
    return { memoryId: entry.id, reason: "intent:<name> tag has empty value" };
  }

  const body = entry.reusableProcedure?.trim() ?? "";
  if (!body) {
    return { memoryId: entry.id, reason: "reusableProcedure is empty; expected JSON spec" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (error) {
    return {
      memoryId: entry.id,
      reason: `JSON parse failed: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { memoryId: entry.id, reason: "JSON body must be a single object" };
  }
  const obj = raw as Record<string, unknown>;

  const hosts = readStringArray(obj.hosts);
  const urlPatterns = readStringArray(obj.urlPatterns);
  const pathPatterns = readStringArray(obj.pathPatterns);
  if (!hosts && !urlPatterns && !pathPatterns) {
    return {
      memoryId: entry.id,
      reason: "JSON spec must include hosts, urlPatterns, or pathPatterns",
    };
  }

  const scoreRaw = obj.score;
  let score = 50;
  if (scoreRaw !== undefined && scoreRaw !== null) {
    const n = typeof scoreRaw === "number" ? scoreRaw : Number(scoreRaw);
    if (!Number.isFinite(n)) {
      return { memoryId: entry.id, reason: "score must be a finite number" };
    }
    score = Math.max(0, Math.min(200, Math.round(n)));
  }

  const notesRaw = obj.notes;
  const notes = typeof notesRaw === "string" ? notesRaw.slice(0, 280) : undefined;

  const pattern: EvidencePattern = {
    intent,
    score,
    ...(hosts ? { hosts } : {}),
    ...(urlPatterns ? { urlPatterns } : {}),
    ...(pathPatterns ? { pathPatterns } : {}),
    ...(notes ? { notes } : {}),
  };

  return {
    pattern,
    memoryId: entry.id,
    scope: entry.scope,
    scopeId: entry.scopeId,
  };
}

/**
 * Slice C: load every accepted memory entry that carries the
 * `evidence-pattern` + `intent:<X>` tag pair, parse it, and return the
 * collected patterns plus diagnostics. Caller filters by intent before
 * passing to `scoreUrlAgainstPatterns` — but typically the caller already
 * does that based on `inferTaskIntents(text)` output.
 */
export async function loadEvidencePatternsFromMemory(
  store: SkillMemoryStore,
  intents: readonly string[],
): Promise<LoadEvidencePatternsResult> {
  const result: LoadEvidencePatternsResult = { patterns: [], parsed: [], errors: [] };
  if (intents.length === 0) return result;
  const intentSet = new Set(intents.map((intent) => intent.toLowerCase()));

  // List once, filter in memory. Realistic memory volumes are small (hundreds
  // at most) so we avoid per-intent search round-trips. If a future store
  // exposes a richer query we can swap to that.
  const entries = await store.list({ status: "accepted", limit: 500 });
  for (const entry of entries) {
    if (normalizeMemoryStatus(entry.status) !== "accepted") continue;
    const parsed = parseEvidencePatternMemory(entry);
    if ("reason" in parsed) {
      // Only surface errors for memories that explicitly carry the tag —
      // others are simply unrelated entries and not parse failures.
      const tags = (entry.tags ?? []).map((tag) => tag.toLowerCase());
      if (tags.includes(EVIDENCE_PATTERN_TAG)) {
        result.errors.push(parsed);
      }
      continue;
    }
    if (!intentSet.has(parsed.pattern.intent.toLowerCase())) continue;
    result.patterns.push(parsed.pattern);
    result.parsed.push(parsed);
  }
  return result;
}

function readStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out.length > 0 ? out : undefined;
}
