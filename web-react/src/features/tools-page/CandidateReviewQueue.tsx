import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  useActivateToolVersion,
  useRejectToolVersion,
  useRunToolVersionManually,
  type ToolVersionSummary,
} from "@/api/tools";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";
import type { ToolModuleMetadata } from "@/api/types";

import { buildPinnedRunInput } from "./toolsPageShared";

export type CandidateReviewStatus =
  | "needs_manual_run"
  | "ready_to_activate"
  | "activated"
  | "superseded"
  | "rejected"
  | "failed";

export type CandidateReviewItem = {
  tool: ToolModuleMetadata;
  version: ToolVersionSummary;
  status: CandidateReviewStatus;
  source: "agent" | "operator" | "import" | "unknown";
  originTraceRunId?: string;
  latestEvidenceRunId?: string;
  latestLifecycleRunId?: string;
};

export function CandidateReviewQueue({
  tools,
  onSelectTool,
}: {
  tools: ToolModuleMetadata[];
  onSelectTool: (name: string) => void;
}) {
  const [filter, setFilter] = useState<"actionable" | CandidateReviewStatus | "all">("actionable");
  const runVersion = useRunToolVersionManually();
  const activate = useActivateToolVersion();
  const rejectVersion = useRejectToolVersion();
  const items = useMemo(() => collectCandidateReviewItems(tools), [tools]);
  const counts = useMemo(() => countCandidateReviewItems(items), [items]);
  const visible = items.filter((item) => {
    if (filter === "all") return true;
    if (filter === "actionable") {
      return item.status === "needs_manual_run" || item.status === "ready_to_activate" || item.status === "failed";
    }
    return item.status === filter;
  });
  const totalActionable = counts.needs_manual_run + counts.ready_to_activate + counts.failed;

  if (items.length === 0) return null;

  return (
    <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-3 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-app-text-muted">
            Candidate review
          </h3>
          <p className="mt-1 text-[11px] text-app-text-muted">
            {totalActionable} actionable · {counts.rejected} rejected
            {counts.activated > 0 ? ` · ${counts.activated} activated` : ""}
            {counts.superseded > 0 ? ` · ${counts.superseded} superseded` : ""}
          </p>
        </div>
        <GenericBadge tone={totalActionable > 0 ? "warn" : "muted"}>
          {items.length} versions
        </GenericBadge>
      </div>

      <div className="mt-3 flex flex-wrap gap-1">
        {([
          ["actionable", `actionable ${totalActionable}`],
          ["needs_manual_run", `run ${counts.needs_manual_run}`],
          ["ready_to_activate", `activate ${counts.ready_to_activate}`],
          ["failed", `failed ${counts.failed}`],
          ["activated", `activated ${counts.activated}`],
          ["rejected", `rejected ${counts.rejected}`],
          ["superseded", `superseded ${counts.superseded}`],
          ["all", `all ${items.length}`],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={[
              "rounded-md border px-2 py-0.5 text-[10px]",
              filter === value
                ? "border-app-accent bg-app-accent-soft text-app-accent"
                : "border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-accent/40",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>

      <ul className="mt-3 flex max-h-[360px] flex-col gap-2 overflow-auto pr-1">
        {visible.length === 0 ? (
          <li className="rounded-md border border-app-border bg-app-surface-2 p-2 text-[11px] text-app-text-muted">
            No candidates in this view.
          </li>
        ) : (
          visible.map((item) => {
            const runInput = buildPinnedRunInput(item.tool, item.version);
            return (
              <li
                key={`${item.tool.name}@${item.version.version}`}
                className="rounded-md border border-app-border bg-app-surface-2 p-2"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words font-mono text-[11px]">
                      {item.tool.name}@{item.version.version}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <GenericBadge tone={candidateReviewTone(item.status)}>
                        {candidateReviewLabel(item.status)}
                      </GenericBadge>
                      <GenericBadge tone="muted">{item.source}</GenericBadge>
                    </div>
                    <p className="mt-1 text-[10px] text-app-text-muted">
                      {candidateReviewEvidenceLabel(item.version)}
                    </p>
                  </div>
                  <CandidateRunLinks item={item} />
                </div>
                {item.version.changeSummary ? (
                  <p className="mt-2 line-clamp-2 text-[11px] text-app-text-muted">
                    {item.version.changeSummary}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => onSelectTool(item.tool.name)}
                    className="rounded-md border border-app-border bg-app-surface px-2 py-0.5 text-[11px] hover:border-app-accent/40"
                  >
                    Select tool
                  </button>
                  {item.status === "needs_manual_run" ? (
                    <button
                      type="button"
                      disabled={runVersion.isPending}
                      onClick={() =>
                        runVersion.mutate({
                          name: item.tool.name,
                          version: item.version.version,
                          input: runInput,
                        })
                      }
                      title={`Input: ${truncate(JSON.stringify(runInput), 160)}`}
                      className="rounded-md border border-app-accent/40 bg-app-surface px-2 py-0.5 text-[11px] text-app-accent hover:border-app-accent disabled:opacity-50"
                    >
                      {runVersion.isPending ? "Running…" : "Run sample"}
                    </button>
                  ) : null}
                  {item.status === "ready_to_activate" ? (
                    <button
                      type="button"
                      disabled={activate.isPending}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Activate ${item.tool.name}@${item.version.version}? The current active version will become inactive.`,
                          )
                        ) {
                          activate.mutate({ name: item.tool.name, version: item.version.version });
                        }
                      }}
                      className="rounded-md border border-app-accent/40 bg-app-surface px-2 py-0.5 text-[11px] text-app-accent hover:border-app-accent disabled:opacity-50"
                    >
                      {activate.isPending ? "Activating…" : "Activate"}
                    </button>
                  ) : null}
                  {item.status !== "rejected" && item.status !== "activated" ? (
                    <button
                      type="button"
                      disabled={rejectVersion.isPending}
                      onClick={() => {
                        const reason = window.prompt(
                          `Why reject ${item.tool.name}@${item.version.version}?`,
                          "Candidate does not satisfy the requested behavior.",
                        );
                        if (!reason) return;
                        rejectVersion.mutate({
                          name: item.tool.name,
                          version: item.version.version,
                          reason,
                        });
                      }}
                      className="rounded-md border border-app-warning/50 bg-app-surface px-2 py-0.5 text-[11px] text-app-warning hover:border-app-warning disabled:opacity-50"
                    >
                      {rejectVersion.isPending ? "Rejecting…" : "Reject"}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })
        )}
      </ul>
      {runVersion.isError ? (
        <p className="mt-2 text-[11px] text-app-danger">{runVersion.error.message}</p>
      ) : null}
      {activate.isError ? (
        <p className="mt-2 text-[11px] text-app-danger">{activate.error.message}</p>
      ) : null}
      {rejectVersion.isError ? (
        <p className="mt-2 text-[11px] text-app-danger">{rejectVersion.error.message}</p>
      ) : null}
    </section>
  );
}


export function collectCandidateReviewItems(tools: ToolModuleMetadata[]): CandidateReviewItem[] {
  const items: CandidateReviewItem[] = [];
  for (const tool of tools) {
    if (tool.source !== "generated") continue;
    const versions = (tool.versions ?? []) as ToolVersionSummary[];
    for (const version of versions) {
      const status = candidateReviewStatus(version, tool.version);
      if (status === "activated" && !hasExplicitLifecycleDecision(version)) continue;
      const origin = version.lifecycleEvents?.find((event) => event.type === "created");
      const latestLifecycle = latestLifecycleRunEvent(version);
      items.push({
        tool,
        version,
        status,
        source: candidateReviewSource(version),
        originTraceRunId: origin?.traceRunId ?? origin?.runId,
        latestEvidenceRunId:
          version.runScopedCandidateEvidence?.latestSuccess?.runId
          ?? version.runScopedCandidateEvidence?.latestFailure?.runId,
        latestLifecycleRunId: latestLifecycle?.traceRunId ?? latestLifecycle?.runId,
      });
    }
  }
  return items.sort((left, right) =>
    candidateReviewRank(left.status) - candidateReviewRank(right.status)
    || right.version.updatedAt.localeCompare(left.version.updatedAt)
    || left.tool.name.localeCompare(right.tool.name),
  );
}

export function candidateReviewStatus(version: ToolVersionSummary, activeVersion: string): CandidateReviewStatus {
  if (version.reviewStatus === "rejected" || latestReviewDecision(version) === "rejected") {
    return "rejected";
  }
  if (version.active) return "activated";
  if (compareVersionsDesc(version.version, activeVersion) > 0) {
    return "superseded";
  }
  if (version.status === "failed") return "failed";
  if (hasActivationEvidence(version)) return "ready_to_activate";
  return "needs_manual_run";
}

function hasActivationEvidence(version: ToolVersionSummary): boolean {
  return Boolean(
    version.manualRunEvidence?.latestSuccess
      || version.runScopedCandidateEvidence?.latestSuccess,
  );
}

function candidateReviewEvidenceLabel(version: ToolVersionSummary): string {
  if (version.manualRunEvidence?.latestSuccess) {
    return `manual evidence ok ${formatRelative(version.manualRunEvidence.latestSuccess.ranAt)}`;
  }
  if (version.runScopedCandidateEvidence?.latestSuccess) {
    return `scoped run evidence ok ${formatRelative(version.runScopedCandidateEvidence.latestSuccess.ranAt)}`;
  }
  return "no successful activation evidence yet";
}

export function compareVersionsDesc(leftVersion: string, rightVersion: string): number {
  const left = leftVersion.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const right = rightVersion.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (right[index] || 0) - (left[index] || 0);
    if (diff !== 0) return diff;
  }
  return rightVersion.localeCompare(leftVersion);
}

export function latestReviewDecision(version: ToolVersionSummary): ToolVersionSummary["reviewStatus"] | undefined {
  const latest = [...(version.lifecycleEvents ?? [])]
    .filter((event) =>
      event.type === "rejected" ||
      event.type === "activated" ||
      event.type === "agent_accepted" ||
      event.type === "marked_available",
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (!latest) return undefined;
  if (latest.type === "rejected") return "rejected";
  return "accepted";
}

export function candidateReviewSource(version: ToolVersionSummary): CandidateReviewItem["source"] {
  const created = version.lifecycleEvents?.find((event) => event.type === "created");
  if (created?.actorType === "agent" || created?.actorId === "agent") return "agent";
  if (created?.actorId === "import") return "import";
  if (created?.actorId === "operator" || created?.actorType === "user") return "operator";
  return "unknown";
}

export function countCandidateReviewItems(items: CandidateReviewItem[]): Record<CandidateReviewStatus, number> {
  return items.reduce<Record<CandidateReviewStatus, number>>(
    (counts, item) => {
      counts[item.status] += 1;
      return counts;
    },
    {
      needs_manual_run: 0,
      ready_to_activate: 0,
      activated: 0,
      superseded: 0,
      rejected: 0,
      failed: 0,
    },
  );
}

export function candidateReviewRank(status: CandidateReviewStatus): number {
  switch (status) {
    case "ready_to_activate":
      return 0;
    case "needs_manual_run":
      return 1;
    case "failed":
      return 2;
    case "activated":
      return 3;
    case "superseded":
      return 4;
    case "rejected":
      return 5;
  }
}

export function candidateReviewLabel(status: CandidateReviewStatus): string {
  switch (status) {
    case "needs_manual_run":
      return "needs manual run";
    case "ready_to_activate":
      return "ready to activate";
    case "activated":
      return "activated";
    case "superseded":
      return "superseded";
    case "rejected":
      return "rejected";
    case "failed":
      return "failed";
  }
}

export function candidateReviewTone(status: CandidateReviewStatus): "ok" | "warn" | "danger" | "muted" {
  if (status === "ready_to_activate") return "ok";
  if (status === "needs_manual_run") return "warn";
  if (status === "failed") return "danger";
  if (status === "activated") return "ok";
  return "muted";
}

function CandidateRunLinks({ item }: { item: CandidateReviewItem }) {
  const links = candidateRunLinks(item);
  if (links.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-wrap justify-end gap-2 text-[11px]">
      {links.map((link) => (
        <Link
          key={`${link.label}:${link.to}`}
          to={link.to}
          className="text-app-accent hover:underline"
        >
          {link.label}
        </Link>
      ))}
    </div>
  );
}

export function candidateRunLinks(item: CandidateReviewItem): Array<{ label: string; to: string }> {
  const links: Array<{ label: string; to: string }> = [];
  const seen = new Set<string>();
  const add = (label: string, to: string | undefined) => {
    if (!to || seen.has(`${label}:${to}`)) return;
    seen.add(`${label}:${to}`);
    links.push({ label, to });
  };
  add("origin trace", item.originTraceRunId ? `/trace/${item.originTraceRunId}` : undefined);
  add("evidence run", item.latestEvidenceRunId ? `/run/${item.latestEvidenceRunId}` : undefined);
  add("evidence trace", item.latestEvidenceRunId ? `/trace/${item.latestEvidenceRunId}` : undefined);
  add("decision trace", item.latestLifecycleRunId ? `/trace/${item.latestLifecycleRunId}` : undefined);
  return links;
}

function hasExplicitLifecycleDecision(version: ToolVersionSummary): boolean {
  return Boolean(
    version.lifecycleEvents?.some((event) =>
      event.type === "activated" ||
      event.type === "agent_accepted" ||
      event.type === "rejected",
    ),
  );
}

function latestLifecycleRunEvent(version: ToolVersionSummary):
  | NonNullable<ToolVersionSummary["lifecycleEvents"]>[number]
  | undefined {
  return [...(version.lifecycleEvents ?? [])]
    .filter((event) =>
      event.type === "activated" ||
      event.type === "agent_accepted" ||
      event.type === "rejected",
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}
