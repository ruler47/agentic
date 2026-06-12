import { EvidenceRecord, WorkLedgerItem } from "./types.js";

export type EvidenceReusePolicyInput = {
  item: WorkLedgerItem;
  evidence?: readonly EvidenceRecord[];
  taskSummary?: string;
  metadata?: Record<string, unknown>;
};

export type EvidenceReusePolicyResult = {
  reusable: boolean;
  reason: string;
};

const HARD_NEGATIVE_RE =
  /\b(?:ungrounded|hallucinat|semantic mismatch|insufficient|not enough evidence|no usable|empty|blocked|bot[- ]?check|captcha|access denied|loader|failed semantic|unrelated|source mismatch)\b|недостаточн|галлюцин|не\s+подтвержд|не\s+хватает\s+доказ|капч|заблок|не\s+соответств/i;

const REQUIRED_CURRENT_RE =
  /\b(?:current|latest|fresh|today|now|recent|real[- ]?time|price|availability|available|book|appointment|reserve|reservation|schedule)\b|сейчас|сегодня|актуальн|последн|цена|доступн|заброни|запис/i;

/**
 * Generic reuse gate for completed Work Ledger items. The ledger can dedupe
 * expensive work, but it must not make weak/failed evidence look authoritative.
 * Domain-specific quality remains in the caller; this policy only rejects shapes
 * that are broadly unsafe to reuse.
 */
export function evaluateEvidenceReusePolicy(input: EvidenceReusePolicyInput): EvidenceReusePolicyResult {
  const { item } = input;
  const evidence = input.evidence ?? [];
  const haystack = evidenceText(item, evidence);

  if (item.status !== "completed") {
    return { reusable: false, reason: `Work item is ${item.status}, not completed.` };
  }
  if (item.error && item.error.trim()) {
    return { reusable: false, reason: "Completed work item carries an error string." };
  }
  if (HARD_NEGATIVE_RE.test(haystack)) {
    return { reusable: false, reason: "Prior work/evidence records contain blocker, mismatch, or hallucination signals." };
  }

  const positiveEvidence = evidence.filter((record) => isPositiveEvidence(record));
  const negativeEvidence = evidence.filter((record) => isNegativeEvidence(record));
  if (evidence.length > 0 && positiveEvidence.length === 0) {
    return { reusable: false, reason: "Prior work has evidence records, but none are positive reusable evidence." };
  }
  if (negativeEvidence.length > 0 && positiveEvidence.length === 0) {
    return { reusable: false, reason: "Prior work only has failed, blocked, or limitation evidence." };
  }

  if (item.kind === "search") {
    const requestedQualityVersion = numericMetadata(input.metadata, "evidenceQualityVersion");
    const itemQualityVersion = numericMetadata(item.metadata, "evidenceQualityVersion");
    if (requestedQualityVersion !== undefined && (itemQualityVersion ?? 0) < requestedQualityVersion) {
      return {
        reusable: false,
        reason: "Prior search evidence predates the requested evidence quality policy.",
      };
    }

    const urls = extractHttpUrls(haystack);
    if (urls.length === 0) {
      return { reusable: false, reason: "Prior search evidence has no source URL." };
    }
    const marketHints = stringArrayMetadata(input.metadata, "marketHints");
    const normalizedEvidenceText = normalizeForHintMatch(evidenceOnlyText(item, evidence));
    const missingHints = marketHints.filter((hint) => !normalizedEvidenceText.includes(normalizeForHintMatch(hint)));
    if (missingHints.length > 0) {
      return {
        reusable: false,
        reason: `Prior search evidence does not visibly support requested market/context hints: ${missingHints.join(", ")}.`,
      };
    }
    if (REQUIRED_CURRENT_RE.test(input.taskSummary ?? item.inputSummary ?? item.title)) {
      const sourceCount = new Set(urls.map(normalizedSourceKey).filter(Boolean)).size;
      if (sourceCount < 2 && !hasExplicitSingleSourceIntent(input.taskSummary ?? item.inputSummary ?? "")) {
        return { reusable: false, reason: "Current/broad search work needs at least two distinct reusable source URLs." };
      }
    }
  }

  return { reusable: true, reason: "Prior evidence is reusable." };
}

function isPositiveEvidence(record: EvidenceRecord): boolean {
  if (record.kind === "limitation") return false;
  if (record.qaStatus === "failed" || record.qaStatus === "blocked") return false;
  return Boolean(record.sourceUrl || record.artifactId || record.summary || record.contentPreview);
}

function isNegativeEvidence(record: EvidenceRecord): boolean {
  return record.kind === "limitation" || record.qaStatus === "failed" || record.qaStatus === "blocked";
}

function evidenceText(item: WorkLedgerItem, evidence: readonly EvidenceRecord[]): string {
  return [
    item.title,
    item.summary,
    item.inputSummary,
    item.outputSummary,
    item.error,
    ...item.sourceUrls,
    ...evidence.flatMap((record) => [
      record.title,
      record.summary,
      record.contentPreview,
      record.sourceUrl,
      record.qaStatus,
      ...record.limitations,
    ]),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
}

function evidenceOnlyText(item: WorkLedgerItem, evidence: readonly EvidenceRecord[]): string {
  return [
    item.outputSummary,
    item.error,
    ...item.sourceUrls,
    ...evidence.flatMap((record) => [
      record.title,
      record.summary,
      record.contentPreview,
      record.sourceUrl,
      record.qaStatus,
      ...record.limitations,
    ]),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
}

function extractHttpUrls(text: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>(),\]\[`]+/gi)) {
    const url = match[0].replace(/[.;:!?`)\]]+$/, "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function normalizedSourceKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function hasExplicitSingleSourceIntent(text: string): boolean {
  return /\b(?:this|that|same|specific|given)\s+(?:url|source|page|site)\b|по\s+этой\s+ссылк|на\s+этом\s+сайте/i.test(text);
}

function numericMetadata(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringArrayMetadata(metadata: Record<string, unknown> | undefined, key: string): string[] {
  const value = metadata?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeForHintMatch(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}
