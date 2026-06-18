import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQueries, useQueryClient } from "@tanstack/react-query";

import { useActivateToolVersion, useRejectToolVersion, type ToolVersionSummary } from "@/api/tools";
import type { AgentEvent, AgentRunRecord } from "@/api/types";
import { queryKeys } from "@/api/queryKeys";
import { apiFetch } from "@/lib/fetch";
import { formatRelative } from "@/lib/format";

type CandidateReviewItem = {
  eventId: string;
  toolName: string;
  toolVersion: string;
  replacesVersion?: string;
  promotionPolicy?: string;
  timestamp: string;
  detail?: string;
};

export function RunCandidateReviewPanel({ run }: { run: AgentRunRecord }) {
  const candidates = useMemo(() => collectCandidateReviews(run.events ?? []), [run.events]);
  const toolNames = useMemo(
    () => [...new Set(candidates.map((candidate) => candidate.toolName))],
    [candidates],
  );
  const versionQueries = useQueries({
    queries: toolNames.map((name) => ({
      queryKey: ["tool-versions", name],
      queryFn: () =>
        apiFetch<{ versions: ToolVersionSummary[] }>(
          `/api/tools/generated-modules/${encodeURIComponent(name)}/versions`,
        ).then((data) => data.versions ?? []),
      staleTime: 5_000,
      refetchInterval: 30_000,
    })),
  });
  const versionsByTool = useMemo(() => {
    const next = new Map<string, ToolVersionSummary[] | undefined>();
    toolNames.forEach((name, index) => next.set(name, versionQueries[index]?.data));
    return next;
  }, [toolNames, versionQueries]);
  const activateVersion = useActivateToolVersion();
  const rejectVersion = useRejectToolVersion();
  const queryClient = useQueryClient();
  const [localMessage, setLocalMessage] = useState<string | undefined>();

  if (candidates.length === 0) return null;

  const refreshRun = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.run(run.id) });
  };

  return (
    <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-app-accent">
            Tool candidate review
          </p>
          <h3 className="text-sm font-semibold">Run-scoped versions tested in this run</h3>
          <p className="mt-1 text-xs text-app-text-muted">
            These versions were available only to this run. Activate only after checking the
            trace, final answer, artifacts, and tool output.
          </p>
        </div>
        <Link
          to="/tools"
          className="w-fit rounded-md border border-app-border bg-app-surface-2 px-3 py-1 text-xs font-semibold hover:border-app-accent/40 hover:text-app-accent"
        >
          Open Tools
        </Link>
      </div>

      <div className="mt-4 grid gap-3">
        {candidates.map((candidate) => (
          <CandidateReviewCard
            key={candidate.eventId}
            candidate={candidate}
            versions={versionsByTool.get(candidate.toolName)}
            activatePending={activateVersion.isPending}
            rejectPending={rejectVersion.isPending}
            onActivate={() => {
              setLocalMessage(undefined);
              activateVersion.mutate(
                { name: candidate.toolName, version: candidate.toolVersion },
                {
                  onSuccess: () => {
                    setLocalMessage(`Activated ${candidate.toolName}@${candidate.toolVersion}.`);
                    refreshRun();
                  },
                },
              );
            }}
            onReject={(reason) => {
              setLocalMessage(undefined);
              rejectVersion.mutate(
                {
                  name: candidate.toolName,
                  version: candidate.toolVersion,
                  reason,
                },
                {
                  onSuccess: () => {
                    setLocalMessage(`Rejected ${candidate.toolName}@${candidate.toolVersion}.`);
                    refreshRun();
                  },
                },
              );
            }}
          />
        ))}
      </div>

      {localMessage ? <p className="mt-3 text-xs text-app-accent">{localMessage}</p> : null}
      {activateVersion.isError ? (
        <p className="mt-3 text-xs text-app-danger">{activateVersion.error.message}</p>
      ) : null}
      {rejectVersion.isError ? (
        <p className="mt-3 text-xs text-app-danger">{rejectVersion.error.message}</p>
      ) : null}
    </article>
  );
}

function CandidateReviewCard({
  candidate,
  versions,
  activatePending,
  rejectPending,
  onActivate,
  onReject,
}: {
  candidate: CandidateReviewItem;
  versions?: ToolVersionSummary[];
  activatePending: boolean;
  rejectPending: boolean;
  onActivate: () => void;
  onReject: (reason: string) => void;
}) {
  const version = versions?.find((item) => item.version === candidate.toolVersion);
  const decision = deriveCandidateDecision(version, versions);
  const canDecide = decision.status === "pending";
  return (
    <div className="rounded-md border border-app-border bg-app-surface-2 p-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold">
              {candidate.toolName}@{candidate.toolVersion}
            </span>
            <DecisionBadge decision={decision} />
            <span className="rounded-full bg-app-accent-soft px-2 py-0.5 text-[11px] font-semibold text-app-accent">
              tested here
            </span>
            {candidate.replacesVersion ? (
              <span className="rounded-full bg-app-surface px-2 py-0.5 text-[11px] text-app-text-muted">
                replaces {candidate.replacesVersion}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-app-text-muted">
            {decision.description}
          </p>
          <p className="mt-2 text-[11px] text-app-text-muted">
            policy: {candidate.promotionPolicy ?? "manual"} · {formatRelative(candidate.timestamp)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {canDecide ? (
            <>
              <button
                type="button"
                disabled={activatePending}
                onClick={onActivate}
                className="rounded-md border border-app-accent bg-app-accent px-3 py-1 text-xs font-semibold text-app-bg transition-colors hover:opacity-90 disabled:opacity-50"
              >
                {activatePending ? "Activating..." : "Activate tested version"}
              </button>
              <button
                type="button"
                disabled={rejectPending}
                onClick={() => {
                  const reason = window.prompt(
                    `Why reject ${candidate.toolName}@${candidate.toolVersion}?`,
                    "Candidate did not satisfy the originating run.",
                  );
                  if (!reason) return;
                  onReject(reason);
                }}
                className="rounded-md border border-app-danger/40 bg-app-danger-soft px-3 py-1 text-xs font-semibold text-app-danger transition-colors hover:bg-app-danger-soft/70 disabled:opacity-50"
              >
                {rejectPending ? "Rejecting..." : "Reject"}
              </button>
            </>
          ) : (
            <Link
              to="/tools"
              className="rounded-md border border-app-border bg-app-surface px-3 py-1 text-xs font-semibold hover:border-app-accent/40 hover:text-app-accent"
            >
              Review in Tools
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

type CandidateDecision = {
  status: "pending" | "activated" | "rejected" | "missing";
  label: string;
  description: string;
};

export function deriveCandidateDecision(
  version: ToolVersionSummary | undefined,
  versions: ToolVersionSummary[] | undefined,
): CandidateDecision {
  if (!versions) {
    return {
      status: "pending",
      label: "checking",
      description: "Loading current version lifecycle before operator decision.",
    };
  }
  if (!version) {
    return {
      status: "missing",
      label: "missing",
      description: "This version is not in the current tool version history.",
    };
  }
  const latestDecision = latestLifecycleDecision(version);
  if (latestDecision === "rejected" || version.reviewStatus === "rejected") {
    return {
      status: "rejected",
      label: "rejected",
      description: "Operator already rejected this candidate version.",
    };
  }
  if (
    version.active
    || version.reviewStatus === "accepted"
    || latestDecision === "activated"
    || latestDecision === "agent_accepted"
  ) {
    return {
      status: "activated",
      label: "activated",
      description: "This tested version has already been activated for future agents.",
    };
  }
  return {
    status: "pending",
    label: "needs review",
    description: "Candidate completed this run and still requires an operator decision.",
  };
}

function latestLifecycleDecision(version: ToolVersionSummary):
  | "activated"
  | "agent_accepted"
  | "rejected"
  | undefined {
  return [...(version.lifecycleEvents ?? [])]
    .filter((event) =>
      event.type === "activated" ||
      event.type === "agent_accepted" ||
      event.type === "rejected",
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.type as
      | "activated"
      | "agent_accepted"
      | "rejected"
      | undefined;
}

function DecisionBadge({ decision }: { decision: CandidateDecision }) {
  const className = {
    pending: "bg-app-warning-soft text-app-warning",
    activated: "bg-app-accent-soft text-app-accent",
    rejected: "bg-app-danger-soft text-app-danger",
    missing: "bg-app-surface text-app-text-muted",
  }[decision.status];
  return (
    <span className={["rounded-full px-2 py-0.5 text-[11px] font-semibold", className].join(" ")}>
      {decision.label}
    </span>
  );
}

function collectCandidateReviews(events: AgentEvent[]): CandidateReviewItem[] {
  const byVersion = new Map<string, CandidateReviewItem>();
  for (const event of [...events].reverse()) {
    if (event.type !== "tool-candidate-manual-review-required") continue;
    const payload = parseCandidatePayload(event.payload);
    if (!payload) continue;
    const key = `${payload.toolName}@${payload.toolVersion}`;
    if (byVersion.has(key)) continue;
    byVersion.set(key, {
      eventId: event.id,
      toolName: payload.toolName,
      toolVersion: payload.toolVersion,
      replacesVersion: payload.replacesVersion,
      promotionPolicy: payload.promotionPolicy,
      timestamp: event.completedAt ?? event.timestamp,
      detail: event.detail,
    });
  }
  return [...byVersion.values()];
}

function parseCandidatePayload(payload: unknown): {
  toolName: string;
  toolVersion: string;
  replacesVersion?: string;
  promotionPolicy?: string;
} | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const toolName = typeof record.toolName === "string" ? record.toolName : undefined;
  const toolVersion = typeof record.toolVersion === "string" ? record.toolVersion : undefined;
  if (!toolName || !toolVersion) return undefined;
  return {
    toolName,
    toolVersion,
    replacesVersion: typeof record.replacesVersion === "string" ? record.replacesVersion : undefined,
    promotionPolicy: typeof record.promotionPolicy === "string" ? record.promotionPolicy : undefined,
  };
}
