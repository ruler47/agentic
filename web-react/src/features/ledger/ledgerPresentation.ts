import type {
  EvidenceRecord,
  RunRetrospectiveRecord,
  WorkLedgerItem,
  WorkLedgerStatus,
} from "@/api/types";

export type LedgerAttentionItem = {
  id: string;
  kind: "work" | "evidence" | "retrospective";
  tone: "danger" | "warn" | "running" | "muted";
  title: string;
  summary: string;
  targetId: string;
  runId?: string;
};

export type LedgerHealth = {
  active: number;
  reusable: number;
  weakEvidence: number;
  proposedRetrospectives: number;
  duplicatedWork: number;
  headline: string;
};

export function summarizeLedgerHealth(input: {
  workItems: WorkLedgerItem[];
  evidence: EvidenceRecord[];
  retrospectives: RunRetrospectiveRecord[];
}): LedgerHealth {
  const active = input.workItems.filter((item) => isActiveWorkStatus(item.status)).length;
  const reusable = input.workItems.filter((item) => item.status === "completed" && (item.evidenceIds.length > 0 || item.artifactIds.length > 0)).length;
  const weakEvidence = input.evidence.filter((record) => record.qaStatus === "failed" || record.qaStatus === "blocked" || record.qaStatus === "partial").length;
  const proposedRetrospectives = input.retrospectives.filter((record) => record.status === "proposed").length;
  const duplicatedWork = input.retrospectives.reduce((sum, record) => sum + record.duplicatedWork.length, 0);
  const headline = active > 0
    ? `${active} active claim${active === 1 ? "" : "s"}`
    : weakEvidence > 0
      ? `${weakEvidence} weak evidence item${weakEvidence === 1 ? "" : "s"}`
      : proposedRetrospectives > 0
        ? `${proposedRetrospectives} retrospective${proposedRetrospectives === 1 ? "" : "s"} waiting review`
        : reusable > 0
          ? `${reusable} reusable result${reusable === 1 ? "" : "s"}`
          : "No ledger activity yet";
  return { active, reusable, weakEvidence, proposedRetrospectives, duplicatedWork, headline };
}

export function filterLedgerItems(input: {
  workItems: WorkLedgerItem[];
  evidence: EvidenceRecord[];
  retrospectives: RunRetrospectiveRecord[];
  search: string;
}) {
  const needle = input.search.trim().toLowerCase();
  if (!needle) return input;
  return {
    workItems: input.workItems.filter((item) => matchesNeedle([
      item.id,
      item.title,
      item.summary,
      item.inputSummary,
      item.outputSummary,
      item.workKey,
      item.kind,
      item.status,
      item.error,
      ...item.sourceUrls,
      ...item.artifactIds,
      ...item.evidenceIds,
    ], needle)),
    evidence: input.evidence.filter((record) => matchesNeedle([
      record.id,
      record.title,
      record.summary,
      record.contentPreview,
      record.kind,
      record.qaStatus,
      record.sourceUrl,
      record.toolName,
      record.provider,
      record.artifactId,
      ...record.limitations,
    ], needle)),
    retrospectives: input.retrospectives.filter((record) => matchesNeedle([
      record.id,
      record.runId,
      record.summary,
      record.status,
      record.runOutcome,
      ...record.whatWorked,
      ...record.whatFailed,
      ...record.suspectedRootCauses,
      ...record.duplicatedWork,
      ...record.weakTools,
      ...record.weakModels,
      ...record.missingCapabilities,
      ...record.proposedPolicyChanges,
      ...record.proposedPromptChanges,
    ], needle)),
  };
}

export function buildLedgerAttentionQueue(input: {
  workItems: WorkLedgerItem[];
  evidence: EvidenceRecord[];
  retrospectives: RunRetrospectiveRecord[];
}): LedgerAttentionItem[] {
  const workItems = input.workItems
    .filter((item) => item.status === "failed" || item.status === "stale" || isActiveWorkStatus(item.status))
    .map((item): LedgerAttentionItem => ({
      id: `work:${item.id}`,
      kind: "work",
      tone: item.status === "failed" ? "danger" : item.status === "stale" ? "warn" : "running",
      title: item.title,
      summary: item.error ?? item.outputSummary ?? item.inputSummary ?? item.workKey,
      targetId: item.id,
      runId: item.runId,
    }));

  const evidence = input.evidence
    .filter((record) => record.qaStatus === "failed" || record.qaStatus === "blocked" || record.qaStatus === "partial")
    .map((record): LedgerAttentionItem => ({
      id: `evidence:${record.id}`,
      kind: "evidence",
      tone: record.qaStatus === "partial" ? "warn" : "danger",
      title: record.title,
      summary: record.limitations[0] ?? record.summary ?? record.sourceUrl ?? record.id,
      targetId: record.id,
      runId: record.runId,
    }));

  const retrospectives = input.retrospectives
    .filter((record) => record.status === "proposed")
    .map((record): LedgerAttentionItem => {
      const signals = [
        ...record.whatFailed,
        ...record.suspectedRootCauses,
        ...record.duplicatedWork,
        ...record.weakTools,
        ...record.missingCapabilities,
      ];
      return {
        id: `retrospective:${record.id}`,
        kind: "retrospective",
        tone: signals.length > 0 ? "warn" : "muted",
        title: record.summary ?? `Retrospective for ${record.runOutcome} run`,
        summary: signals[0] ?? "Review proposed retrospective before it becomes durable guidance.",
        targetId: record.id,
        runId: record.runId,
      };
    });

  return [...workItems, ...evidence, ...retrospectives].slice(0, 12);
}

export function evidenceByWorkItem(records: EvidenceRecord[]): Map<string, EvidenceRecord[]> {
  const grouped = new Map<string, EvidenceRecord[]>();
  for (const record of records) {
    if (!record.workItemId) continue;
    const existing = grouped.get(record.workItemId) ?? [];
    existing.push(record);
    grouped.set(record.workItemId, existing);
  }
  return grouped;
}

export function isReusableWorkItem(item: WorkLedgerItem, linkedEvidence: EvidenceRecord[] = []): boolean {
  return item.status === "completed" && (
    item.evidenceIds.length > 0 ||
    item.artifactIds.length > 0 ||
    linkedEvidence.some((record) => record.qaStatus === "passed")
  );
}

export function workStatusTone(status: WorkLedgerStatus): "ok" | "running" | "warn" | "danger" | "muted" {
  if (status === "completed") return "ok";
  if (status === "claimed" || status === "running" || status === "planned") return "running";
  if (status === "stale") return "warn";
  if (status === "failed") return "danger";
  return "muted";
}

export function isActiveWorkStatus(status: WorkLedgerStatus): boolean {
  return status === "planned" || status === "claimed" || status === "running";
}

function matchesNeedle(values: Array<string | undefined>, needle: string): boolean {
  return values.filter(Boolean).join(" ").toLowerCase().includes(needle);
}
