import { Link, useParams } from "react-router-dom";

import {
  useEvidenceLedger,
  useRunRetrospectives,
  useWorkLedger,
} from "@/api/ledger";
import { useCancelRun, useRestartRun, useResumeRun, useRun, useRunWaits } from "@/api/runs";
import {
  useAutoRetryReworkWait,
  useResumeReworkWait,
} from "@/api/reworkWaits";
import { useRunStream } from "@/api/sse";
import { ArtifactGallery } from "@/components/ArtifactPreview";
import { MarkdownContent } from "@/components/MarkdownContent";
import { RunStatusBadge } from "@/components/StatusBadge";
import { formatDuration, formatRelative, runDurationMs, truncate } from "@/lib/format";
import type { AgentEvent, AgentRunRecord, ToolReworkWaitRecord } from "@/api/types";
import { retryRunLabel } from "@/features/tool-builds/reworkWaitPresentation";

export function RunWorkspacePage() {
  const params = useParams<{ runId: string }>();
  const runId = params.runId;
  const run = useRun(runId);
  const waits = useRunWaits(runId);
  const workLedger = useWorkLedger({ runId });
  const evidenceLedger = useEvidenceLedger({ runId });
  const retrospectives = useRunRetrospectives({ runId });
  const cancelRun = useCancelRun();
  const restartRun = useRestartRun();
  const resumeRun = useResumeRun();
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
  // Phase 12 follow-up: detect runs that look "stuck" — i.e. status=running
  // but no event arrived in the last 5 minutes. Operators commonly hit this
  // after a Docker / process restart left the coordinator promise dead.
  const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
  const lastUpdate = Date.parse(data.updatedAt);
  const isStuck =
    data.status === "running" &&
    Number.isFinite(lastUpdate) &&
    Date.now() - lastUpdate > STUCK_THRESHOLD_MS;
  // Restart is offered for any non-active terminal status, plus stuck runs.
  const canRestart = !isLive || isStuck;
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
            {canRestart ? (
              <>
                <button
                  type="button"
                  disabled={resumeRun.isPending}
                  onClick={() => {
                    resumeRun.mutate(data.id, {
                      onSuccess: (response) => {
                        window.location.assign(`/run/${response.resume.id}`);
                      },
                    });
                  }}
                  className="rounded-md border border-app-accent bg-app-accent px-3 py-1 text-xs font-semibold text-app-bg transition-colors hover:opacity-90 disabled:opacity-50"
                  title={
                    "Resume this run from where it left off. Classification, planning, and any subtask whose review verdict was 'pass' are skipped; only the missing/incomplete subtasks run again. The Work Ledger reuses cached external evidence (web.search, browser.operate)."
                  }
                >
                  {resumeRun.isPending ? "Resuming…" : "Resume run"}
                </button>
                <button
                  type="button"
                  disabled={restartRun.isPending}
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Restart redoes every phase from scratch (classification, planning, every subtask). Use 'Resume run' instead to continue from the last completed step. Restart anyway?",
                      )
                    ) {
                      return;
                    }
                    restartRun.mutate(data.id, {
                      onSuccess: (response) => {
                        window.location.assign(`/run/${response.restart.id}`);
                      },
                    });
                  }}
                  className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1 text-xs font-semibold text-app-text transition-colors hover:border-app-accent/40 hover:text-app-accent disabled:opacity-50"
                  title={
                    isStuck
                      ? "Run looks stuck (no events in 5+ min). Restart redoes every step from scratch."
                      : "Restart this run with the same task — every step will be redone."
                  }
                >
                  {restartRun.isPending
                    ? "Restarting…"
                    : isStuck
                    ? "Restart from scratch"
                    : "Restart from scratch"}
                </button>
              </>
            ) : null}
            {resumeRun.isError ? (
              <span className="text-[11px] text-app-danger">{resumeRun.error.message}</span>
            ) : null}
            {restartRun.isError ? (
              <span className="text-[11px] text-app-danger">{restartRun.error.message}</span>
            ) : null}
            <Link
              to={`/trace/${data.id}`}
              className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1 text-xs font-semibold text-app-text hover:border-app-accent/40 hover:text-app-accent"
            >
              Open Trace Lab
            </Link>
          </div>
        </header>

        <ChannelSourcePanel run={data} />

        {activeWaits.length > 0 ? <RunWaitPanel waits={activeWaits} runId={data.id} /> : null}

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

function ChannelSourcePanel({ run }: { run: AgentRunRecord }) {
  const hasSource =
    run.channel ||
    run.sourceUserId ||
    run.sourceChatId ||
    run.sourceMessageId ||
    run.sourceThreadId;
  if (!hasSource || run.channel === "web") return null;
  return (
    <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-app-accent">
            Channel source
          </p>
          <h3 className="text-sm font-semibold">Run was created from an external service event</h3>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <ChannelSourceItem label="channel" value={run.channel ?? "unknown"} />
            <ChannelSourceItem label="requester" value={run.requesterUserId ?? "unresolved"} />
            <ChannelSourceItem label="source user" value={run.sourceUserId ?? "—"} />
            <ChannelSourceItem label="chat" value={run.sourceChatId ?? "—"} />
            <ChannelSourceItem label="message" value={run.sourceMessageId ?? "—"} />
            <ChannelSourceItem label="source thread" value={run.sourceThreadId ?? "—"} />
          </dl>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 text-xs">
          {run.channel ? (
            <Link
              to={`/channels?service=${encodeURIComponent(run.channel)}`}
              className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1 font-semibold hover:border-app-accent/40 hover:text-app-accent"
            >
              Open channel
            </Link>
          ) : null}
          {run.threadId ? (
            <Link
              to={`/conversation/${run.threadId}`}
              className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1 font-semibold hover:border-app-accent/40 hover:text-app-accent"
            >
              Open conversation
            </Link>
          ) : null}
          <Link
            to={`/trace/${run.id}`}
            className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1 font-semibold hover:border-app-accent/40 hover:text-app-accent"
          >
            Open trace
          </Link>
        </div>
      </div>
    </article>
  );
}

function ChannelSourceItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded border border-app-border bg-app-surface-2 px-2 py-1">
      <dt className="text-[10px] uppercase tracking-wider text-app-text-muted">{label}</dt>
      <dd className="break-all font-mono text-[11px]">{value}</dd>
    </div>
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

function RunWaitPanel({ waits, runId }: { waits: ToolReworkWaitRecord[]; runId: string }) {
  const resume = useResumeReworkWait();
  const autoRetry = useAutoRetryReworkWait();
  const resumeRun = useResumeRun();
  const allPromoted = waits.length > 0 && waits.every((w) => w.status === "promoted" || w.status === "resumed");
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
        This run paused because a registered tool needs to be improved or rebuilt before continuing. When all required tools
        are promoted the run resumes automatically — picking up where it stopped, reusing classifier output, plan, and any
        completed subtask. You can also force an auto-retry pass per wait, or trigger a manual resume from above.
      </p>
      {allPromoted ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-app-accent/40 bg-app-accent-soft/40 p-2 text-xs">
          <span className="font-semibold text-app-accent">All waits promoted.</span>
          <span className="text-app-text-muted">Resume should fire automatically — click below if it does not.</span>
          <button
            type="button"
            onClick={() => {
              resumeRun.mutate(runId, {
                onSuccess: (response) => {
                  window.location.assign(`/run/${response.resume.id}`);
                },
              });
            }}
            disabled={resumeRun.isPending}
            className="ml-auto rounded-md bg-app-accent px-3 py-1 text-[11px] font-semibold text-app-bg disabled:opacity-50"
          >
            {resumeRun.isPending ? "Resuming…" : "Resume now"}
          </button>
        </div>
      ) : null}
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
              {/* Phase 12 follow-up: a single «Force auto retry» button now triggers the
                  auto-retry coordinator which prefers RESUMING the parent run over
                  creating a separate retry run. The legacy «Create retry run» action
                  has been removed in favour of resume + the per-run «Resume now»
                  button at the top of the panel. */}
              {wait.status === "promoted" || wait.status === "waiting" || wait.status === "build_running" ? (
                <button
                  type="button"
                  onClick={() => autoRetry.mutate({ id: wait.id })}
                  disabled={autoRetry.isPending}
                  className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px] hover:border-app-accent/40"
                  title="Re-run the auto-retry policy decision for this wait. If all run waits are promoted, the parent run will resume from where it stopped."
                >
                  {autoRetry.isPending ? "Checking…" : "Force auto retry"}
                </button>
              ) : null}
              {wait.retryRunId ? (
                <Link
                  to={`/run/${wait.retryRunId}`}
                  className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px] hover:border-app-accent/40"
                >
                  Open resumed run
                </Link>
              ) : null}
              {wait.status === "promoted" ? (
                <button
                  type="button"
                  onClick={() => resume.mutate({ id: wait.id })}
                  disabled={resume.isPending}
                  className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px] hover:border-app-accent/40"
                  title="Close this wait without triggering a resume. Use only when you want to abandon this rework."
                >
                  {resume.isPending ? "Closing…" : "Close wait"}
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
            {[autoRetry.error]
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
