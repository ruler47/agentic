import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  useActivateToolVersion,
  useDeleteToolVersion,
  useMarkToolVersionAvailable,
  useRejectToolVersion,
  useRunToolVersionManually,
  useToolVersions,
  type ToolVersionSummary,
} from "@/api/tools";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";
import type { ToolModuleMetadata } from "@/api/types";

import { ManualRunResultDisplay } from "./ManualRunPanel";
import { buildSchemaExample, compareStringLists, compareVersionsDesc, factToneClass, statusTone } from "./toolsPageShared";

export function VersionsPanel({
  tool,
  activeVersion,
}: {
  tool: ToolModuleMetadata;
  activeVersion: string;
}) {
  const versionsQuery = useToolVersions(tool.name);
  const activate = useActivateToolVersion();
  const deleteVersion = useDeleteToolVersion();
  const markAvailable = useMarkToolVersionAvailable();
  const rejectVersion = useRejectToolVersion();

  if (versionsQuery.isLoading) {
    return <p className="text-xs text-app-text-muted">Loading versions…</p>;
  }
  const versions = versionsQuery.data ?? [];
  if (versions.length === 0) {
    return <p className="text-xs text-app-text-muted">No version history.</p>;
  }
  const active = versions.find((version) => version.version === activeVersion)
    ?? versions.find((version) => version.active)
    ?? versions[0];
  const candidate = versions.find((version) => !version.active && compareVersionsDesc(version.version, active.version) < 0)
    ?? active;

  return (
    <div className="flex flex-col gap-2">
      {active && candidate ? (
        <VersionReviewPanel
          active={active}
          candidate={candidate}
          onActivate={() => activate.mutate({ name: tool.name, version: candidate.version })}
          isActivatePending={activate.isPending}
        />
      ) : null}
      <ul className="flex flex-col gap-2">
        {versions.map((version) => (
          <VersionRow
            key={version.version}
            tool={tool}
            version={version}
            isActive={version.version === activeVersion}
            isSuperseded={!version.active && compareVersionsDesc(version.version, active.version) > 0}
            onActivate={() => activate.mutate({ name: tool.name, version: version.version })}
            isActivatePending={activate.isPending}
            onDelete={() =>
              deleteVersion.mutate({ name: tool.name, version: version.version })
            }
            isDeletePending={deleteVersion.isPending}
            onReject={(reason) =>
              rejectVersion.mutate({ name: tool.name, version: version.version, reason })
            }
            isRejectPending={rejectVersion.isPending}
            onMarkAvailable={() =>
              markAvailable.mutate({ name: tool.name, version: version.version })
            }
            isMarkAvailablePending={markAvailable.isPending}
          />
        ))}
      </ul>
      {activate.isError ? (
        <p className="text-[11px] text-app-danger">{activate.error.message}</p>
      ) : null}
      {deleteVersion.isError ? (
        <p className="text-[11px] text-app-danger">{deleteVersion.error.message}</p>
      ) : null}
      {rejectVersion.isError ? (
        <p className="text-[11px] text-app-danger">{rejectVersion.error.message}</p>
      ) : null}
      {markAvailable.isError ? (
        <p className="text-[11px] text-app-danger">{markAvailable.error.message}</p>
      ) : null}
    </div>
  );
}

export function VersionReviewPanel({
  active,
  candidate,
  onActivate,
  isActivatePending,
}: {
  active: ToolVersionSummary;
  candidate: ToolVersionSummary;
  onActivate: () => void;
  isActivatePending: boolean;
}) {
  const sameVersion = active.version === candidate.version;
  const qaSummary = candidate.packageManifest?.qa?.summary;
  const qaChecks = candidate.packageManifest?.qa?.checks ?? [];
  const capabilityDiff = compareStringLists(active.capabilities ?? [], candidate.capabilities ?? []);
  const manualEvidence = candidate.manualRunEvidence;
  const scopedEvidence = candidate.runScopedCandidateEvidence;
  const manualRuns = (manualEvidence?.successCount ?? 0) + (manualEvidence?.failureCount ?? 0);
  const scopedRuns = (scopedEvidence?.successCount ?? 0) + (scopedEvidence?.failureCount ?? 0);
  const candidateRejected = candidate.reviewStatus === "rejected";
  const canActivate = sameVersion
    || (!candidateRejected && candidate.status !== "failed" && hasActivationEvidence(candidate));

  return (
    <div className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-app-text-muted">
            Version review
          </h4>
          <p className="mt-1 text-[11px] text-app-text-muted">
            Compare the active version with the next inactive candidate before promotion.
          </p>
        </div>
        {!sameVersion ? (
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  `Activate v${candidate.version}? The current active version v${active.version} will become inactive.`,
                )
              ) {
                onActivate();
              }
            }}
            disabled={isActivatePending || !canActivate}
            className="rounded-md bg-app-accent px-3 py-1 font-semibold text-app-bg disabled:cursor-not-allowed disabled:opacity-50"
            title={
              canActivate
                ? "Activate this verified version"
                : candidateRejected
                  ? "Rejected candidates cannot be activated"
                : "Run this exact candidate version successfully before activation"
            }
          >
            {isActivatePending
              ? "Activating…"
              : canActivate
                ? `Activate v${candidate.version}`
                : "Run candidate first"}
          </button>
        ) : null}
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <VersionReviewCard label="Active" version={active} tone="ok" />
        <VersionReviewCard
          label={sameVersion ? "No candidate" : "Candidate"}
          version={candidate}
          tone={sameVersion ? "muted" : candidateRejected || candidate.status === "failed" ? "danger" : "warn"}
        />
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-4">
        <ReviewFact
          label="Capability diff"
          value={
            capabilityDiff.length > 0
              ? capabilityDiff.join(" · ")
              : "same declared capabilities"
          }
        />
        <ReviewFact
          label="Candidate QA"
          value={qaSummary ?? "no package QA summary recorded"}
          tone={qaSummary ? "ok" : "warn"}
        />
        <ReviewFact
          label="Candidate manual runs"
          value={
            manualEvidence?.latestSuccess
              ? `${manualRuns} pinned run${manualRuns === 1 ? "" : "s"} · latest ok ${formatRelative(manualEvidence.latestSuccess.ranAt)}`
              : `${manualRuns} pinned run${manualRuns === 1 ? "" : "s"} · successful pinned run required`
          }
          tone={
            manualEvidence?.latestSuccess
              ? "ok"
              : manualEvidence?.failureCount
                ? "danger"
                : "warn"
          }
        />
        <ReviewFact
          label="Scoped run evidence"
          value={
            scopedEvidence?.latestSuccess
              ? `${scopedRuns} scoped run${scopedRuns === 1 ? "" : "s"} · latest ok ${formatRelative(scopedEvidence.latestSuccess.ranAt)}`
              : `${scopedRuns} scoped run${scopedRuns === 1 ? "" : "s"} · no successful run-scoped test yet`
          }
          tone={
            scopedEvidence?.latestSuccess
              ? "ok"
              : scopedEvidence?.failureCount
                ? "danger"
                : "warn"
          }
        />
      </div>

      {qaChecks.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-app-text-muted">
            Candidate QA checks ({qaChecks.length})
          </summary>
          <ul className="mt-1 max-h-40 overflow-auto space-y-1 rounded border border-app-border bg-app-surface p-2 font-mono text-[10px] text-app-text-muted">
            {qaChecks.map((check, index) => (
              <li key={`${check}-${index}`}>{check}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function VersionReviewCard({
  label,
  version,
  tone,
}: {
  label: string;
  version: ToolVersionSummary;
  tone: "ok" | "warn" | "danger" | "muted";
}) {
  const total = (version.successCount ?? 0) + (version.failureCount ?? 0);
  return (
    <div className="rounded-md border border-app-border bg-app-surface p-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
          {label}
        </span>
        <GenericBadge tone={tone}>v{version.version}</GenericBadge>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <GenericBadge tone={statusTone(version.status)}>{version.status}</GenericBadge>
        {version.active ? <GenericBadge tone="ok">active</GenericBadge> : null}
        <span className="font-mono text-[10px] text-app-text-muted">
          {version.packageManifest?.package?.type ?? "package"} · {version.packageManifest?.package?.ref ?? "no ref"}
        </span>
      </div>
      {version.changeSummary ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-[11px]">
          {version.changeSummary}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1">
        {(version.capabilities ?? []).map((capability) => (
          <span key={capability} className="rounded bg-app-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-app-text-muted">
            {capability}
          </span>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-app-text-muted">
        {total} runs · {version.successCount ?? 0} ok · {version.failureCount ?? 0} failed
      </p>
      {version.lastHealthDetail ? (
        <p className="mt-1 text-[10px] text-app-text-muted">
          health: {truncate(version.lastHealthDetail, 110)}
        </p>
      ) : null}
    </div>
  );
}

export function ReviewFact({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "danger" | "muted";
}) {
  return (
    <div className="rounded-md border border-app-border bg-app-surface p-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
        {label}
      </p>
      <p className={["mt-1 text-[11px]", factToneClass(tone)].join(" ")}>
        {value}
      </p>
    </div>
  );
}

function hasActivationEvidence(version: ToolVersionSummary): boolean {
  return Boolean(
    version.manualRunEvidence?.latestSuccess
      || version.runScopedCandidateEvidence?.latestSuccess,
  );
}

export function VersionRow({
  tool,
  version,
  isActive,
  isSuperseded,
  onActivate,
  isActivatePending,
  onDelete,
  isDeletePending,
  onReject,
  isRejectPending,
  onMarkAvailable,
  isMarkAvailablePending,
}: {
  tool: ToolModuleMetadata;
  version: ToolVersionSummary;
  isActive: boolean;
  isSuperseded: boolean;
  onActivate: () => void;
  isActivatePending: boolean;
  onDelete: () => void;
  isDeletePending: boolean;
  onReject: (reason: string) => void;
  isRejectPending: boolean;
  onMarkAvailable: () => void;
  isMarkAvailablePending: boolean;
}) {
  const success = version.successCount ?? 0;
  const failure = version.failureCount ?? 0;
  const total = success + failure;
  const hasEvidence = hasActivationEvidence(version);
  const isRejected = version.reviewStatus === "rejected";
  const [showRun, setShowRun] = useState(false);
  return (
    <li
      className={[
        "rounded-md border p-3 text-xs",
        isActive
          ? "border-app-accent bg-app-accent-soft/30"
          : "border-app-border bg-app-surface-2",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-[13px] font-semibold">v{version.version}</span>
          <GenericBadge tone={statusTone(version.status)}>{version.status}</GenericBadge>
          {isActive ? <GenericBadge tone="ok">active</GenericBadge> : null}
          {isRejected ? <GenericBadge tone="danger">rejected</GenericBadge> : null}
          {!isActive && !isRejected && isSuperseded ? <GenericBadge tone="muted">superseded</GenericBadge> : null}
          {!isActive && !isRejected && !isSuperseded ? <GenericBadge tone="muted">candidate</GenericBadge> : null}
          <span className="text-app-text-muted">
            promoted {formatRelative(version.updatedAt)}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {version.status === "loaded" ? (
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    `Mark v${version.version} as available? Use this only if you've manually verified the tool works (e.g. via Manual Run). Skips a fresh council QA cycle.`,
                  )
                ) {
                  onMarkAvailable();
                }
              }}
              disabled={isMarkAvailablePending}
              className="rounded-md border border-app-accent/40 bg-app-surface px-2.5 py-1 text-[11px] text-app-accent hover:border-app-accent disabled:opacity-50"
            >
              {isMarkAvailablePending ? "Marking…" : "Mark available"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setShowRun((value) => !value)}
            className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px] hover:border-app-accent/40"
          >
            {showRun ? "Hide run" : "Run this version"}
          </button>
          {!isActive ? (
            <>
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      `Activate v${version.version}? The current active version will become inactive.`,
                    )
                ) {
                  onActivate();
                }
              }}
                disabled={isActivatePending || version.status === "failed" || isRejected || !hasEvidence}
                title={
                  isRejected
                    ? "Rejected candidates cannot be activated"
                    : isSuperseded && hasEvidence
                    ? "Rollback to this previously verified version"
                    : hasEvidence
                    ? "Activate this verified version"
                    : "Run this exact version successfully before activation"
                }
                className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px] hover:border-app-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isActivatePending ? "Activating…" : hasEvidence ? isSuperseded ? "Rollback" : "Activate" : "Run first"}
              </button>
              {!isRejected ? (
                <button
                  type="button"
                  onClick={() => {
                    const reason = window.prompt(
                      `Why reject v${version.version}? This keeps the version in history but prevents agents from reusing it.`,
                      "Candidate does not satisfy the requested behavior.",
                    );
                    if (!reason) return;
                    onReject(reason);
                  }}
                  disabled={isRejectPending}
                  className="rounded-md border border-app-warn/50 bg-app-surface px-2.5 py-1 text-[11px] text-app-warn hover:border-app-warn disabled:opacity-50"
                >
                  {isRejectPending ? "Rejecting…" : "Reject candidate"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete v${version.version}? This removes it from the version history and cannot be undone.`,
                    )
                  ) {
                    onDelete();
                  }
                }}
                disabled={isDeletePending}
                className="rounded-md border border-app-danger/40 bg-app-surface px-2.5 py-1 text-[11px] text-app-danger hover:border-app-danger disabled:opacity-50"
              >
                {isDeletePending ? "Deleting…" : "Delete"}
              </button>
            </>
          ) : null}
        </div>
      </div>
      {version.changeSummary ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-[11px] text-app-text">
          {version.changeSummary}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-app-text-muted">
        {total > 0 ? (
          <>
            <span>runs: {total}</span>
            <span className="text-app-accent">{success} ok</span>
            <span className={failure > 0 ? "text-app-danger" : "text-app-text-muted"}>
              failures: {failure}
            </span>
            <span>({total > 0 ? Math.round((success / total) * 100) : 0}% success)</span>
          </>
        ) : (
          <span>no runs recorded</span>
        )}
        {version.lastHealthDetail ? (
          <span className="text-app-text-muted">
            health: {truncate(version.lastHealthDetail, 80)}
          </span>
        ) : null}
      </div>
      {version.manualRunEvidence ? (
        <p className="mt-2 text-[11px] text-app-text-muted">
          pinned manual evidence:{" "}
          {version.manualRunEvidence.latestSuccess
            ? `ok ${formatRelative(version.manualRunEvidence.latestSuccess.ranAt)}`
            : "no successful pinned run yet"}
          {" · "}
          {version.manualRunEvidence.successCount} ok / {version.manualRunEvidence.failureCount} failed
        </p>
      ) : null}
      {version.runScopedCandidateEvidence ? (
        <p className="mt-1 text-[11px] text-app-text-muted">
          run-scoped candidate evidence:{" "}
          {version.runScopedCandidateEvidence.latestSuccess ? (
            <>
              ok{" "}
              <Link
                to={`/run/${version.runScopedCandidateEvidence.latestSuccess.runId}`}
                className="text-app-accent underline"
              >
                {version.runScopedCandidateEvidence.latestSuccess.runId}
              </Link>
              {" · "}
              {formatRelative(version.runScopedCandidateEvidence.latestSuccess.ranAt)}
            </>
          ) : (
            "no successful scoped run yet"
          )}
          {" · "}
          {version.runScopedCandidateEvidence.successCount} ok / {version.runScopedCandidateEvidence.failureCount} failed
        </p>
      ) : null}
      {version.lifecycleEvents?.length ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-app-text-muted">
            Version lifecycle ({version.lifecycleEvents.length})
          </summary>
          <ol className="mt-2 space-y-1 border-l border-app-border pl-3">
            {version.lifecycleEvents.map((event) => (
              <li key={event.id} className="text-[11px]">
                <div className="flex flex-wrap items-baseline gap-2">
                  <GenericBadge tone={lifecycleEventTone(event.status)}>
                    {lifecycleEventLabel(event.type)}
                  </GenericBadge>
                  <span className="text-app-text-muted">{formatRelative(event.createdAt)}</span>
                  {event.traceRunId ? (
                    <a
                      href={`/trace/${event.traceRunId}`}
                      className="text-app-accent hover:underline"
                    >
                      trace
                    </a>
                  ) : null}
                  {event.runId ? (
                    <a
                      href={`/run/${event.runId}`}
                      className="text-app-accent hover:underline"
                    >
                      source run
                    </a>
                  ) : null}
                </div>
                <p className="mt-1 text-app-text-muted">{event.summary}</p>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {showRun ? (
        <div className="mt-2">
          <PinnedVersionRunPanel tool={tool} version={version.version} />
        </div>
      ) : null}
    </li>
  );
}

export function lifecycleEventLabel(type: NonNullable<ToolVersionSummary["lifecycleEvents"]>[number]["type"]): string {
  switch (type) {
    case "created":
      return "created";
    case "manual_run":
      return "manual run";
    case "marked_available":
      return "available";
    case "activated":
      return "activated";
    case "agent_accepted":
      return "agent accepted";
    case "rejected":
      return "rejected";
    case "deleted":
      return "deleted";
    default:
      return type;
  }
}

export function lifecycleEventTone(
  status: NonNullable<ToolVersionSummary["lifecycleEvents"]>[number]["status"],
): "ok" | "warn" | "danger" | "muted" {
  if (status === "success") return "ok";
  if (status === "failure") return "danger";
  return "muted";
}

export function PinnedVersionRunPanel({
  tool,
  version,
}: {
  tool: ToolModuleMetadata;
  version: string;
}) {
  const run = useRunToolVersionManually();
  const initialDraft = useMemo(() => {
    const example = tool.examples?.[0];
    if (example?.input && typeof example.input === "object") {
      return JSON.stringify(example.input, null, 2);
    }
    return JSON.stringify(buildSchemaExample(tool.inputSchema, tool.name), null, 2);
  }, [tool]);
  const [draft, setDraft] = useState(initialDraft);
  const [parseError, setParseError] = useState<string | undefined>();

  const submit = () => {
    setParseError(undefined);
    let parsed: Record<string, unknown>;
    try {
      const candidate = JSON.parse(draft || "{}");
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("Input must be a JSON object.");
      }
      parsed = candidate as Record<string, unknown>;
    } catch (error) {
      setParseError(error instanceof Error ? error.message : "Invalid JSON");
      return;
    }
    run.mutate({ name: tool.name, version, input: parsed });
  };

  return (
    <div className="rounded-md border border-app-border bg-app-surface p-2 text-[11px]">
      <label className="flex flex-col gap-1">
        <span className="text-app-text-muted">Pinned v{version} input</span>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={4}
          spellCheck={false}
          className="rounded border border-app-border bg-app-surface-2 px-2 py-1 font-mono text-[10px] outline-none focus:border-app-accent/60"
        />
      </label>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={run.isPending}
          className="rounded bg-app-accent px-2.5 py-1 font-semibold text-app-bg disabled:opacity-50"
        >
          {run.isPending ? "Running…" : "Run v" + version}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(initialDraft);
            setParseError(undefined);
            run.reset();
          }}
          disabled={run.isPending}
          className="rounded border border-app-border bg-app-surface-2 px-2.5 py-1 disabled:opacity-50"
        >
          Reset
        </button>
        {parseError ? (
          <span className="text-app-danger">{parseError}</span>
        ) : run.isError ? (
          <span className="text-app-danger">{run.error.message}</span>
        ) : null}
      </div>
      {run.data ? (
        <>
          {run.data.loadDetail ? (
            <p className="mt-1 text-[10px] text-app-text-muted">
              {truncate(run.data.loadDetail, 140)}
            </p>
          ) : null}
          <ManualRunResultDisplay response={run.data} />
        </>
      ) : null}
    </div>
  );
}
