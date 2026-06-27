import { createHash } from "node:crypto";

import type { ToolResult } from "../tools/tool.js";
import {
  classifySourceType,
  extractTitleLike,
  normalizeSourceUrl,
  sourceQualityScore,
  sourceUrlExclusionReason,
  type RunSourceType,
} from "./sourceQuality.js";

export type RunSourceReadStatus = "passed" | "failed" | "blocked" | "skipped_reuse";

export type RunSourceRecord = {
  sourceId: string;
  normalizedUrl: string;
  originalUrls: string[];
  title?: string;
  sourceType: RunSourceType;
  language?: string;
  discoveredBy: Array<{ eventId: string; toolName: string; query?: string }>;
  readAttempts: Array<{
    eventId: string;
    status: RunSourceReadStatus;
    reason?: string;
    maxBytes?: number;
    availability?: string; // in_stock | out_of_stock | unknown (from web.read result.data.availability)
  }>;
  extractedTextPreview?: string;
  evidenceIds?: string[];
  qualityScore?: number;
  qualityReasons?: string[];
};

export type SourceReadSkip = {
  record: RunSourceRecord;
  originalUrl: string;
  reason: string;
};

export class RunSourceRegistry {
  private readonly records = new Map<string, RunSourceRecord>();

  getByUrl(url: string): RunSourceRecord | undefined {
    const normalizedUrl = normalizeSourceUrl(url);
    return normalizedUrl ? this.records.get(normalizedUrl) : undefined;
  }

  // Verdict for a URL the final answer presents as a place to buy / a source, used by the
  // presented-link verify gate. `known` = the run discovered or read it at all; `passed` = a
  // successful read this run; `blocked` = a read attempt hit a bot-wall/403 (escape hatch:
  // acceptable if disclosed); `outOfStock` = the opened page signalled not-buyable.
  presentedLinkVerdict(url: string): {
    known: boolean;
    opened: boolean;
    passed: boolean;
    blocked: boolean;
    outOfStock: boolean;
  } {
    const record = this.getByUrl(url);
    if (!record) return { known: false, opened: false, passed: false, blocked: false, outOfStock: false };
    const attempts = record.readAttempts;
    const passed = attempts.some((attempt) => attempt.status === "passed");
    return {
      known: true,
      opened: attempts.length > 0,
      passed,
      blocked: attempts.some((attempt) => attempt.status === "blocked"),
      outOfStock: attempts.some((attempt) => attempt.availability === "out_of_stock"),
    };
  }

  // Breadth snapshot for the return-gate breadth check: how many distinct sources were
  // surfaced by search vs actually opened (any read attempt, incl. blocked/out-of-stock).
  coverageCounts(): { discovered: number; opened: number } {
    let discovered = 0;
    let opened = 0;
    for (const record of this.records.values()) {
      if (record.discoveredBy.length > 0) discovered += 1;
      if (record.readAttempts.length > 0) opened += 1;
    }
    return { discovered, opened };
  }

  shouldSkipRead(input: Record<string, unknown>): SourceReadSkip | undefined {
    const originalUrl = extractUrlFromToolInput(input);
    if (!originalUrl) return undefined;
    const normalizedUrl = normalizeSourceUrl(originalUrl);
    if (!normalizedUrl) return undefined;
    const record = this.records.get(normalizedUrl);
    if (!record) return undefined;
    const passed = record.readAttempts.find((attempt) => attempt.status === "passed");
    if (passed) {
      return {
        record,
        originalUrl,
        reason: "Source was already read successfully in this run; reuse the existing source record.",
      };
    }
    const blockedOrFailed = [...record.readAttempts].reverse().find((attempt) =>
      attempt.status === "blocked" || attempt.status === "failed"
    );
    if (blockedOrFailed && !hasMaterialRetrySignal(input)) {
      return {
        record,
        originalUrl,
        reason: `Source already ${blockedOrFailed.status} in this run; choose a different source or provide a materially different read strategy.`,
      };
    }
    return undefined;
  }

  recordDiscovery(input: {
    urls: string[];
    toolName: string;
    eventId: string;
    query?: string;
    title?: string;
    language?: string;
    result?: ToolResult;
  }): RunSourceRecord[] {
    const records: RunSourceRecord[] = [];
    for (const originalUrl of input.urls) {
      const normalizedUrl = normalizeSourceUrl(originalUrl);
      if (!normalizedUrl) continue;
      if (sourceUrlExclusionReason(normalizedUrl)) continue;
      const title = input.title ?? extractTitleLike(input.result?.data);
      const sourceType = classifySourceType({ url: normalizedUrl, title, snippet: input.result?.content });
      const record = this.ensureRecord({ normalizedUrl, originalUrl, title, sourceType, language: input.language });
      if (!record.discoveredBy.some((entry) => entry.eventId === input.eventId && entry.toolName === input.toolName)) {
        record.discoveredBy.push({ eventId: input.eventId, toolName: input.toolName, query: input.query });
      }
      record.qualityScore = sourceQualityScore({ sourceType: record.sourceType, url: normalizedUrl });
      record.qualityReasons = qualityReasons(record);
      records.push({ ...record, originalUrls: [...record.originalUrls], discoveredBy: [...record.discoveredBy], readAttempts: [...record.readAttempts] });
    }
    return records;
  }

  recordRead(input: {
    url: string;
    toolName: string;
    eventId: string;
    status: RunSourceReadStatus;
    reason?: string;
    maxBytes?: number;
    result?: ToolResult;
  }): RunSourceRecord | undefined {
    const normalizedUrl = normalizeSourceUrl(input.url);
    if (!normalizedUrl) return undefined;
    const title = extractTitleLike(input.result?.data);
    const sourceType = classifySourceType({ url: normalizedUrl, title, snippet: input.result?.content });
    const record = this.ensureRecord({ normalizedUrl, originalUrl: input.url, title, sourceType });
    record.readAttempts.push({
      eventId: input.eventId,
      status: input.status,
      reason: input.reason,
      maxBytes: input.maxBytes,
      availability: availabilityFromResult(input.result),
    });
    record.extractedTextPreview = input.status === "passed"
      ? previewText(input.result?.content)
      : record.extractedTextPreview;
    record.qualityScore = sourceQualityScore({ sourceType: record.sourceType, readStatus: input.status, url: normalizedUrl });
    record.qualityReasons = qualityReasons(record, input.status, input.reason);
    return { ...record, originalUrls: [...record.originalUrls], discoveredBy: [...record.discoveredBy], readAttempts: [...record.readAttempts] };
  }

  private ensureRecord(input: {
    normalizedUrl: string;
    originalUrl: string;
    title?: string;
    sourceType: RunSourceType;
    language?: string;
  }): RunSourceRecord {
    const existing = this.records.get(input.normalizedUrl);
    if (existing) {
      if (!existing.originalUrls.includes(input.originalUrl)) existing.originalUrls.push(input.originalUrl);
      existing.title ??= input.title;
      existing.language ??= input.language;
      if (existing.sourceType === "unknown" && input.sourceType !== "unknown") existing.sourceType = input.sourceType;
      return existing;
    }
    const record: RunSourceRecord = {
      sourceId: sourceId(input.normalizedUrl),
      normalizedUrl: input.normalizedUrl,
      originalUrls: [input.originalUrl],
      title: input.title,
      sourceType: input.sourceType,
      language: input.language,
      discoveredBy: [],
      readAttempts: [],
      qualityScore: sourceQualityScore({ sourceType: input.sourceType, url: input.normalizedUrl }),
    };
    record.qualityReasons = qualityReasons(record);
    this.records.set(input.normalizedUrl, record);
    return record;
  }
}

export function extractUrlFromToolInput(input: Record<string, unknown>): string | undefined {
  for (const key of ["url", "sourceUrl", "href", "link"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function readStatusFromToolResult(result: ToolResult): RunSourceReadStatus {
  if (result.ok) return "passed";
  const text = `${result.content} ${JSON.stringify(result.data ?? {})}`.toLowerCase();
  if (/(?:captcha|cloudflare|security verification|access denied|forbidden|blocked|cookie consent|403|429)/i.test(text)) {
    return "blocked";
  }
  return "failed";
}

function hasMaterialRetrySignal(input: Record<string, unknown>): boolean {
  return typeof input.retryReason === "string" ||
    typeof input.strategy === "string" ||
    typeof input.selector === "string" ||
    Boolean(input.headers && typeof input.headers === "object" && !Array.isArray(input.headers));
}

function availabilityFromResult(result?: ToolResult): string | undefined {
  const data = result?.data;
  if (!data || typeof data !== "object") return undefined;
  const availability = (data as Record<string, unknown>).availability;
  if (!availability || typeof availability !== "object") return undefined;
  const status = (availability as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}

function sourceId(normalizedUrl: string): string {
  return `src_${createHash("sha1").update(normalizedUrl).digest("hex").slice(0, 12)}`;
}

function previewText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.replace(/\s+/g, " ").trim().slice(0, 500)
    : undefined;
}

function qualityReasons(
  record: RunSourceRecord,
  readStatus?: RunSourceReadStatus,
  reason?: string,
): string[] {
  const reasons = [`type=${record.sourceType}`];
  if (readStatus) reasons.push(`read=${readStatus}`);
  if (reason) reasons.push(reason.slice(0, 160));
  if (record.normalizedUrl !== record.originalUrls[0]) reasons.push("url normalized");
  return reasons;
}
