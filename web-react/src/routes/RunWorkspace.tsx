import { Link, useParams } from "react-router-dom";

import {
  useEvidenceLedger,
  useRunRetrospectives,
  useWorkLedger,
} from "@/api/ledger";
import { useCancelRun, useRun, useRunWaits } from "@/api/runs";
import {
  useAutoRetryReworkWait,
  useCreateRetryRunForWait,
  useResumeReworkWait,
} from "@/api/reworkWaits";
import { useRunStream } from "@/api/sse";
import { ArtifactGallery } from "@/components/ArtifactPreview";
import { MarkdownContent } from "@/components/MarkdownContent";
import { RunStatusBadge } from "@/components/StatusBadge";
import { formatDuration, formatRelative, runDurationMs, truncate } from "@/lib/format";
import type { AgentEvent, AgentRunRecord, ToolReworkWaitRecord } from "@/api/types";
import {
  canCreateRetryRun,
  retryRunLabel,
} from "@/features/tool-builds/reworkWaitPresentation";

export function RunWorkspacePage() {
  const params = useParams<{ runId: string }>();
  const runId = params.runId;
  const run = useRun(runId);
  const waits = useRunWaits(runId);
  const workLedger = useWorkLedger({ runId });
  const evidenceLedger = useEvidenceLedger({ runId });
  const retrospectives = useRunRetrospectives({ runId });
  const cancelRun = useCancelRun();
  useRunStream(runId);

  if (!runId) return <p className="text-sm text-app-text-muted">Run id is missing.</p>;
  if (run.isLoading)
    return <p className="text-sm text-app-text-muted">Loading run {runId}…</p>;
  if (run.isError)
    return (
      <p className="text-sm text-app-danger">
        {run.error?.message ?? "Failed to load run"}
      </p>
    );
  if (!run.data)
    return (
      <p className="text-sm text-app-text-muted">
        Run {runId} not found.{" "}
        <Link to="/runs" className="text-app-accent underline">
          back to runs
        </Link>
      </p>
    );

  const data = run.data;
  const activeWaits = (waits.data ?? []).filter(
    (wait) => wait.status !== "resumed" && wait.status !== "cancelled" && wait.status !== "failed",
  );
  const isLive = data.status === "queued" || data.status === "running";
  const finalAnswer = runStatusMessage(data);

  return (
    <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col gap-4">
        <header className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wider text-app-text-muted">Run</p>
              <h2 className="break-words text-lg font-semibold">{data.task}</h2>
              <p className="mt-1 text-xs text-app-text-muted">
                {data.requesterUserId ?? "user-admin"} · {data.channel ?? "web"} ·
                {" "}
                {data.threadId ? (
                  <Link to={`/conversation/${data.threadId}`} className="underline">
                    thread {truncate(data.threadId, 16)}
                  </Link>
                ) : (
                  "no thread"
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <RunStatusBadge status={data.status} />
              <span className="font-mono text-[11px] text-app-text-muted">
                {formatDuration(runDurationMs(data))}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/runs"
              className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1 text-xs font-semibold text-app-text hover:border-app-accent/40 hover:text-app-accent"
            >
              Back to Runs
            </Link>
            {data.threadId ? (
              <Link
                to={`/conversation/${data.threadId}`}
                className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1 text-xs font-semibold text-app-text hover:border-app-accent/40 hover:text-app-accent"
              >
                Open Conversation
              </Link>
            ) : null}
            {isLive ? (
              <button
                type="button"
                disabled={cancelRun.isPending}
                onClick={() => cancelRun.mutate({ id: data.id })}
                className="rounded-md border border-app-danger/40 bg-app-danger-soft px-3 py-1 text-xs font-semibold text-app-danger transition-colors hover:bg-app-danger-soft/70 disabled:opacity-50"
              >
                {cancelRun.isPending ? "Cancelling…" : "Cancel run"}
              </button>
            ) : null}
            <Link
              to={`/trace/${data.id}`}
              className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1 text-xs font-semibold text-app-text hover:border-app-accent/40 hover:text-app-accent"
            >
              Open Trace Lab
            </Link>
          </div>
        </header>

        {activeWaits.length > 0 ? <RunWaitPanel waits={activeWaits} /> : null}

        <RunLedgerPanel
          runId={data.id}
          workCount={workLedger.data?.length ?? 0}
          evidenceCount={evidenceLedger.data?.length ?? 0}
          retrospectiveCount={retrospectives.data?.length ?? 0}
          weakEvidenceCount={(evidenceLedger.data ?? []).filter((record) =>
            record.qaStatus === "failed" || record.qaStatus === "blocked" || record.qaStatus === "partial"
          ).length}
          proposedRetrospectiveCount={(retrospectives.data ?? []).filter((record) => record.status === "proposed").length}
        />

        <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
          <h3 className="text-sm font-semibold">Final answer</h3>
          <div className="mt-2">
            <MarkdownContent value={finalAnswer} />
          </div>
        </article>

        {data.result?.artifacts?.length ? (
          <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
            <h3 className="text-sm font-semibold">Artifacts</h3>
            <div className="mt-3">
              <ArtifactGallery artifacts={data.result.artifacts} />
            </div>
          </article>
        ) : null}
      </div>

      <aside className="flex flex-col gap-4">
        <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
          <h3 className="text-sm font-semibold">Run timeline</h3>
          <p className="mt-1 text-[11px] text-app-text-muted">
            Live SSE feed; falls back to 5s polling.
          </p>
          <ul className="mt-3 flex max-h-[60vh] flex-col gap-2 overflow-y-auto pr-1">
            {(data.events ?? []).slice(-25).reverse().map((event) => (
              <TimelineRow key={event.id} event={event} />
            ))}
            {(data.events ?? []).length === 0 ? (
              <li className="text-[11px] text-app-text-muted">No events yet.</li>
            ) : null}
          </ul>
        </article>
      </aside>
    </section>
  );
}

function RunLedgerPanel({
  runId,
  workCount,
  evidenceCount,
  retrospectiveCount,
  weakEvidenceCount,
  proposedRetrospectiveCount,
}: {
  runId: string;
  workCount: number;
  evidenceCount: number;
  retrospectiveCount: number;
  weakEvidenceCount: number;
  proposedRetrospectiveCount: number;
}) {
  const needsAttention = weakEvidenceCount > 0 || proposedRetrospectiveCount > 0;
  const headline = weakEvidenceCount > 0
    ? `${weakEvidenceCount} weak evidence item${weakEvidenceCount === 1 ? "" : "s"}`
    : proposedRetrospectiveCount > 0
      ? `${proposedRetrospectiveCount} retrospective${proposedRetrospectiveCount === 1 ? "" : "s"} waiting review`
      : "Run coordination record";
  return (
    <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
            Work / Evidence Ledger
          </p>
          <h3 className="text-sm font-semibold">
            {headline}
          </h3>
          <p className="mt-1 text-xs text-app-text-muted">
            {workCount} claims · {evidenceCount} evidence records · {retrospectiveCount} retrospectives
          </p>
        </div>
        <Link
          to={`/ledger?runId=${encodeURIComponent(runId)}`}
          className={[
            "rounded-md border px-3 py-1.5 text-xs font-semibold",
            needsAttention
              ? "border-app-warning/40 bg-app-warning-soft text-app-warning"
              : "border-app-border bg-app-surface-2 text-app-text hover:border-app-accent/40 hover:text-app-accent",
          ].join(" ")}
        >
          Open Ledger
        </Link>
      </div>
    </article>
  );
}

function runStatusMessage(run: AgentRunRecord): string {
  if (run.status === "failed") return run.error ?? "Run failed.";
  if (run.status === "cancelled") return run.error ?? "Run cancelled.";
  if (run.status === "waiting_tool_rework") {
    return run.error ?? "Run is waiting for a tool upgrade. See the panel above for details.";
  }
  return run.result?.finalAnswer ?? "Agent is working…";
}

function TimelineRow({ event }: { event: AgentEvent }) {
  const tone =
    event.status === "failed"
      ? "border-app-danger/40 bg-app-danger-soft text-app-danger"
      : event.status === "completed"
        ? "border-app-accent/30 bg-app-accent-soft/50"
        : "border-app-border bg-app-surface-2";
  return (
    <li className={["rounded-md border px-2.5 py-1.5 text-xs", tone].join(" ")}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-app-text-muted">
          {event.activity}
        </span>
        <span className="text-[10px] text-app-text-muted">
          {formatRelative(event.timestamp)}
        </span>
      </div>
      <p className="mt-0.5 break-words font-medium">{event.title}</p>
      {event.detail ? (
        <p className="mt-0.5 text-[11px] text-app-text-muted">{truncate(event.detail, 160)}</p>
      ) : null}
    </li>
  );
}

function RunWaitPanel({ waits }: { waits: ToolReworkWaitRecord[] }) {
  const resume = useResumeReworkWait();
  const createRetry = useCreateRetryRunForWait();
  const autoRetry = useAutoRetryReworkWait();
  return (
    <section className="rounded-[var(--radius-card)] border border-app-warning/40 bg-app-warning-soft p-5">
      <header className="mb-2 flex items-baseline justify-between">
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-app-warning">
            Tool rework wait
          </span>
          <h3 className="text-base font-semibold">Waiting for tool upgrade</h3>
        </div>
        <Link to="/tool-builds" className="text-xs text-app-warning underline">
          Open Tool Builds
        </Link>
      </header>
      <p className="text-xs text-app-text-muted">
        This run paused because a registered tool needs to be improved or rebuilt before retrying. Once the new tool version
        is promoted, you can create a linked retry run, force the auto-retry policy to re-check eligibility, or click{" "}
        <em>Mark ready for retry</em> to close the wait without spawning a retry.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {waits.map((wait) => (
          <li
            key={wait.id}
            className="rounded-md border border-app-warning/30 bg-app-surface-2 p-3 text-xs"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] text-app-text-muted">{wait.id}</span>
              <span className="rounded-full bg-app-warning-soft px-2 py-0.5 text-[10px] uppercase text-app-warning">
                {wait.status}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-app-text-muted">
              {wait.toolName ? (
                <>
                  Tool: <code>{wait.toolName}</code>
                  {wait.toolVersion ? <> v{wait.toolVersion}</> : null}
                  {wait.promotedVersion ? <> → v{wait.promotedVersion}</> : null}
                </>
              ) : (
                "Tool: not matched (manual ticket)"
              )}
            </p>
            <p className="mt-1 text-[11px]">{truncate(wait.reason, 220)}</p>
            {wait.retryRunId ? (
              <p className="mt-1 text-[11px] text-app-text-muted">
                {retryRunLabel(wait)}:{" "}
                <Link to={`/run/${wait.retryRunId}`} className="text-app-accent underline">
                  {wait.retryRunId}
                </Link>
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2">
              {canCreateRetryRun(wait) ? (
                <>
                  <button
                    type="button"
                    onClick={() => createRetry.mutate({ id: wait.id })}
                    disabled={createRetry.isPending}
                    className="rounded-md bg-app-accent px-2.5 py-1 text-[11px] font-semibold text-app-bg disabled:opacity-50"
                  >
                    {createRetry.isPending ? "Creating…" : "Create retry run"}
                  </button>
                  <button
                    type="button"
                    onClick={() => autoRetry.mutate({ id: wait.id })}
                    disabled={autoRetry.isPending}
                    className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px] hover:border-app-accent/40"
                  >
                    {autoRetry.isPending ? "Checking…" : "Force auto retry"}
                  </button>
                </>
              ) : null}
              {wait.retryRunId ? (
                <Link
                  to={`/run/${wait.retryRunId}`}
                  className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px] hover:border-app-accent/40"
                >
                  Open retry run
                </Link>
              ) : null}
              {wait.status === "promoted" ? (
                <button
                  type="button"
                  onClick={() => resume.mutate({ id: wait.id })}
                  disabled={resume.isPending}
                  className="rounded-md bg-app-accent px-2.5 py-1 text-[11px] font-semibold text-app-bg disabled:opacity-50"
                >
                  {resume.isPending ? "Closing…" : "Mark ready for retry"}
                </button>
              ) : null}
              <Link
                to="/tool-builds"
                className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px] hover:border-app-accent/40"
              >
                Open Tool Builds
              </Link>
            </div>
            {resume.isError ? (
              <p className="mt-1 text-[11px] text-app-danger">{resume.error.message}</p>
            ) : null}
            {[createRetry.error, autoRetry.error]
              .filter((error): error is Error => Boolean(error))
              .map((error, index) => (
                <p key={index} className="mt-1 text-[11px] text-app-danger">
                  {error.message}
                </p>
              ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
