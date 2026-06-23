import type { AgentEvent } from "../types.js";
import { sourceUrlExclusionReason } from "./sourceQuality.js";

export type WorkingDecisionSourceRecord = {
  sourceId: string;
  normalizedUrl: string;
  title?: string;
  sourceType?: string;
  qualityScore?: number;
  qualityReasons?: string[];
};

export function sourceRecordFromEvent(event: AgentEvent): WorkingDecisionSourceRecord | undefined {
  const source = recordAt(event.payload, ["source"]) ?? recordAt(event.payload, ["output", "source"]);
  const sourceId = stringValue(source?.sourceId);
  const normalizedUrl = stringValue(source?.normalizedUrl);
  if (!sourceId || !normalizedUrl) return undefined;
  const qualityScore = typeof source?.qualityScore === "number" ? source.qualityScore : undefined;
  const rawReasons = Array.isArray(source?.qualityReasons) ? source.qualityReasons : [];
  return {
    sourceId,
    normalizedUrl,
    title: stringValue(source?.title),
    sourceType: stringValue(source?.sourceType),
    qualityScore,
    qualityReasons: rawReasons.map((entry) => stringValue(entry)).filter((entry): entry is string => Boolean(entry)),
  };
}

export function extractCandidateUrls(value: unknown): string[] {
  return extractUrls(value).filter((url) => !sourceUrlExclusionReason(url));
}

export function shouldPromoteSource(source: {
  normalizedUrl: string;
  sourceType?: string;
  qualityScore?: number;
}): boolean {
  if (sourceUrlExclusionReason(source.normalizedUrl)) return false;
  if (source.sourceType === "social" || source.sourceType === "asset" || source.sourceType === "search_results") return false;
  return (source.qualityScore ?? 0.45) >= 0.35;
}

export function workingDecisionSourceQualityScore(url: string, actor: string, ok: boolean): number {
  let score = ok ? 0.55 : 0.2;
  if (/read|extract|http\.request|browser\.screenshot/i.test(actor)) score += ok ? 0.2 : 0;
  if (/^https:\/\//i.test(url)) score += 0.05;
  if (/(^|\.)((youtube|tiktok|instagram|facebook|x|twitter|reddit)\.com)$/i.test(hostname(url))) score -= 0.2;
  if (/\/(?:blog|news|article|top|best|review|guide|list)/i.test(url)) score -= 0.08;
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

export function workingDecisionUrlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return limit(url, 80);
  }
}

function extractUrls(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === undefined || value === null) return [];
  if (typeof value === "string") return urlsFromText(value);
  if (Array.isArray(value)) return unique(value.flatMap((entry) => extractUrls(entry, depth + 1))).slice(0, 12);
  if (typeof value !== "object") return [];
  return unique(Object.values(value).flatMap((entry) => extractUrls(entry, depth + 1))).slice(0, 12);
}

function urlsFromText(value: string): string[] {
  return unique([...value.matchAll(/https?:\/\/[^\s"'<>),\]]+/gi)].map((match) => match[0].replace(/[.,;:]+$/, "")));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function recordAt(value: unknown, path: string[]): Record<string, unknown> | undefined {
  const current = valueAt(value, path);
  return current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, unknown>
    : undefined;
}

function valueAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function limit(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
