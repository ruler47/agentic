/**
 * Phase 12 Slice C UI: parser and validator for evidence-pattern memory
 * entries. Mirrors the runtime parser in
 * `src/memory/evidencePatternMemory.ts` so operators get instant feedback
 * before saving.
 *
 * Pattern memory layout convention:
 *
 *     {
 *       tags: ["evidence-pattern", "intent:<name>"],
 *       reusableProcedure: '{"hosts":[...],"score":N,...}',
 *     }
 *
 * The intent comes from the `intent:<X>` tag — NOT from the JSON body —
 * to keep a single source of truth.
 */

export type EvidencePatternSpec = {
  hosts?: string[];
  urlPatterns?: string[];
  pathPatterns?: string[];
  score: number;
  notes?: string;
};

export type ParsedEvidencePattern = {
  spec: EvidencePatternSpec | null;
  errors: string[];
  warnings: string[];
};

export const EVIDENCE_PATTERN_TAG = "evidence-pattern";
export const INTENT_TAG_PREFIX = "intent:";

export const SUGGESTED_INTENTS = [
  "flight-search",
  "medical-lookup",
  "product-comparison",
  "market-research",
  "code-generation",
  "geopolitical-assessment",
  "travel-planning",
  "restaurant-booking",
  "data-analysis",
  "content-summarization",
  "translation",
] as const;

export function isEvidencePatternMemory(tags: readonly string[] | undefined): boolean {
  return (tags ?? []).map((tag) => tag.toLowerCase()).includes(EVIDENCE_PATTERN_TAG);
}

export function readIntentTag(tags: readonly string[] | undefined): string | undefined {
  const lower = (tags ?? []).map((tag) => tag.toLowerCase());
  const intentTag = lower.find((tag) => tag.startsWith(INTENT_TAG_PREFIX));
  if (!intentTag) return undefined;
  const value = intentTag.slice(INTENT_TAG_PREFIX.length).trim();
  return value || undefined;
}

export function parseEvidencePatternSpec(reusableProcedure: string): ParsedEvidencePattern {
  const errors: string[] = [];
  const warnings: string[] = [];
  const trimmed = (reusableProcedure ?? "").trim();
  if (!trimmed) {
    return {
      spec: null,
      errors: ["reusableProcedure is empty — paste a JSON object with hosts/urlPatterns/pathPatterns + score."],
      warnings: [],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (error) {
    return {
      spec: null,
      errors: [`Invalid JSON: ${error instanceof Error ? error.message : "parse failed"}`],
      warnings: [],
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { spec: null, errors: ["JSON body must be a single object."], warnings: [] };
  }
  const obj = raw as Record<string, unknown>;
  const hosts = readStringArray(obj.hosts, "hosts", errors);
  const urlPatterns = readStringArray(obj.urlPatterns, "urlPatterns", errors);
  const pathPatterns = readStringArray(obj.pathPatterns, "pathPatterns", errors);
  if (errors.length === 0 && !hosts && !urlPatterns && !pathPatterns) {
    errors.push("Provide at least one of: hosts, urlPatterns, pathPatterns.");
  }

  let score = 50;
  if (obj.score !== undefined && obj.score !== null) {
    const n = typeof obj.score === "number" ? obj.score : Number(obj.score);
    if (!Number.isFinite(n)) {
      errors.push("score must be a finite number.");
    } else if (n < 0 || n > 200) {
      warnings.push(`score ${n} clamped to [0..200].`);
      score = Math.max(0, Math.min(200, Math.round(n)));
    } else {
      score = Math.round(n);
    }
  } else {
    warnings.push("score omitted; defaulting to 50.");
  }

  let notes: string | undefined;
  if (obj.notes !== undefined && obj.notes !== null) {
    if (typeof obj.notes !== "string") {
      errors.push("notes must be a string when provided.");
    } else if (obj.notes.length > 280) {
      warnings.push(`notes truncated to 280 chars (was ${obj.notes.length}).`);
      notes = obj.notes.slice(0, 280);
    } else {
      notes = obj.notes;
    }
  }

  if (urlPatterns) {
    for (const re of urlPatterns) {
      try { new RegExp(re); } catch (error) {
        errors.push(`urlPatterns: invalid regex "${re}" — ${error instanceof Error ? error.message : "parse failed"}`);
      }
    }
  }
  if (pathPatterns) {
    for (const re of pathPatterns) {
      try { new RegExp(re); } catch (error) {
        errors.push(`pathPatterns: invalid regex "${re}" — ${error instanceof Error ? error.message : "parse failed"}`);
      }
    }
  }

  if (errors.length > 0) return { spec: null, errors, warnings };
  return {
    spec: {
      ...(hosts ? { hosts } : {}),
      ...(urlPatterns ? { urlPatterns } : {}),
      ...(pathPatterns ? { pathPatterns } : {}),
      score,
      ...(notes ? { notes } : {}),
    },
    errors,
    warnings,
  };
}

export function serializeEvidencePatternSpec(spec: EvidencePatternSpec): string {
  // Stable key order so saves do not produce noisy diffs.
  const ordered: Record<string, unknown> = {};
  if (spec.hosts && spec.hosts.length > 0) ordered.hosts = spec.hosts;
  if (spec.urlPatterns && spec.urlPatterns.length > 0) ordered.urlPatterns = spec.urlPatterns;
  if (spec.pathPatterns && spec.pathPatterns.length > 0) ordered.pathPatterns = spec.pathPatterns;
  ordered.score = spec.score;
  if (spec.notes) ordered.notes = spec.notes;
  return JSON.stringify(ordered, null, 2);
}

function readStringArray(value: unknown, field: string, errors: string[]): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of strings.`);
    return undefined;
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      errors.push(`${field} must contain only strings.`);
      return undefined;
    }
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}
