import { Link, useParams } from "react-router-dom";

import {
  useEvidenceLedger,
  useRunRetrospectives,
  useWorkLedger,
} from "@/api/ledger";
import { useCancelRun, useRestartRun, useResumeRun, useRun } from "@/api/runs";
import { useRunStream } from "@/api/sse";
import { ArtifactGallery } from "@/components/ArtifactPreview";
import { MarkdownContent } from "@/components/MarkdownContent";
import { RunStatusBadge } from "@/components/StatusBadge";
import { RunActionApprovalPanel } from "@/features/run-workspace/RunActionApprovalPanel";
import { RunCandidateReviewPanel } from "@/features/run-workspace/RunCandidateReviewPanel";
import { WorkingDecisionBoard } from "@/features/run-workspace/WorkingDecisionBoard";
import { hydrateMarkdownArtifactLinks } from "@/features/conversations/conversationArtifacts";
import { formatDuration, formatRelative, formatTokenUsage, runDurationMs, truncate } from "@/lib/format";
import type { AgentEvent, AgentRunRecord, ProofLink } from "@/api/types";

export function RunWorkspacePage() {
  const params = useParams<{ runId: string }>();
  const runId = params.runId;
  const run = useRun(runId);
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
  const artifacts = data.result?.artifacts ?? [];
  const hydratedFinalAnswer = hydrateMarkdownArtifactLinks(finalAnswer, artifacts);

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
                {formatDuration(data.metrics?.elapsedMs ?? runDurationMs(data))}
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

        <RunMetricsPanel run={data} />

        <WorkingDecisionBoard events={data.events ?? []} />

        <ChannelSourcePanel run={data} />

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

        <RunCandidateReviewPanel run={data} />

        <RunActionApprovalPanel run={data} />

        <ProofPolicyPanel run={data} />

        <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
          <h3 className="text-sm font-semibold">Final answer</h3>
          <div className="mt-2">
            <MarkdownContent value={hydratedFinalAnswer} />
          </div>
        </article>

        {artifacts.length ? (
          <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
            <h3 className="text-sm font-semibold">Artifacts</h3>
            <div className="mt-3">
              <ArtifactGallery artifacts={artifacts} />
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

function ProofPolicyPanel({ run }: { run: AgentRunRecord }) {
  const plan = run.result?.proofPlan;
  const links = run.result?.proofLinks ?? [];
  if (!plan && links.length === 0) return null;
  return (
    <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
            Proof policy
          </p>
          <h3 className="text-sm font-semibold">
            {plan?.required ? "Proof required" : "Proof optional"} · {links.length} link{links.length === 1 ? "" : "s"}
          </h3>
          {plan?.reason ? (
            <p className="mt-1 text-xs text-app-text-muted">{plan.reason}</p>
          ) : null}
        </div>
        {plan ? (
          <dl className="grid min-w-0 gap-2 text-xs sm:grid-cols-2">
            <MetricItem label="preferred" value={plan.preferredModes.join(", ") || "none"} />
            <MetricItem label="acceptable" value={plan.acceptableModes.join(", ") || "none"} />
          </dl>
        ) : null}
      </div>
      {links.length ? (
        <ul className="mt-3 grid gap-2 text-xs">
          {links.map((link) => (
            <ProofLinkRow key={link.proofId} link={link} runId={run.id} />
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function ProofLinkRow({ link, runId }: { link: ProofLink; runId: string }) {
  const artifactUrl = link.artifactId
    ? `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(link.artifactId)}`
    : undefined;
  return (
    <li className="rounded-md border border-app-border bg-app-surface-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={["rounded-full px-2 py-0.5 text-[11px] font-semibold", proofStatusTone(link.status)].join(" ")}>
          {link.status}
        </span>
        <span className="font-mono text-[11px] text-app-text-muted">{link.mode}</span>
        {artifactUrl ? (
          <a href={artifactUrl} target="_blank" rel="noreferrer" className="text-app-accent underline">
            {link.artifactFilename ?? link.artifactId}
          </a>
        ) : null}
        {link.sourceUrl ? (
          <a href={link.sourceUrl} target="_blank" rel="noreferrer" className="min-w-0 truncate text-app-accent underline">
            source
          </a>
        ) : null}
      </div>
      <p className="mt-1 text-[11px] text-app-text-muted">{truncate(link.summary, 220)}</p>
      <p className="mt-1 break-all font-mono text-[10px] text-app-text-muted">
        {[link.sourceId, link.claimId, link.candidateId].filter(Boolean).join(" · ")}
      </p>
    </li>
  );
}

function proofStatusTone(status: ProofLink["status"]): string {
  if (status === "failed" || status === "blocked") return "bg-app-danger-soft text-app-danger";
  if (status === "partial") return "bg-app-warning-soft text-app-warning";
  return "bg-app-accent-soft text-app-accent";
}

function RunMetricsPanel({ run }: { run: AgentRunRecord }) {
  const metrics = run.metrics;
  if (!metrics) return null;
  const topModels = metrics.models.slice(0, 3);
  return (
    <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
            Run metrics
          </p>
          <h3 className="text-sm font-semibold">
            {formatDuration(metrics.elapsedMs)} · {metrics.llmCalls} LLM · {formatTokenUsage(metrics.tokenUsage)}
          </h3>
          <p className="mt-1 text-xs text-app-text-muted">
            {metrics.toolCalls} tool calls
            {metrics.failedToolCalls ? ` · ${metrics.failedToolCalls} failed` : ""} · {metrics.artifacts} artifacts
          </p>
        </div>
        <dl className="grid min-w-0 gap-2 text-xs sm:grid-cols-2">
          <MetricItem label="started" value={new Date(metrics.startedAt).toLocaleString()} />
          <MetricItem label="finished" value={metrics.completedAt ? new Date(metrics.completedAt).toLocaleString() : "running"} />
          <MetricItem
            label="models"
            value={topModels.length
              ? topModels.map((model) => `${model.model} (${model.calls})`).join(", ")
              : "none"}
          />
          <MetricItem
            label="slowest"
            value={metrics.slowestEvents[0]
              ? `${metrics.slowestEvents[0].title} · ${formatDuration(metrics.slowestEvents[0].durationMs)}`
              : "none"}
          />
        </dl>
      </div>
      {metrics.slowestEvents.length > 1 ? (
        <details className="mt-3 rounded-md border border-app-border bg-app-surface-2 px-3 py-2 text-xs">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-app-text-muted">
            Slowest steps
          </summary>
          <ul className="mt-2 space-y-1">
            {metrics.slowestEvents.map((event) => (
              <li key={`${event.eventId}-${event.spanId}`} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">{event.title}</span>
                <span className="shrink-0 font-mono text-app-text-muted">{formatDuration(event.durationMs)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

function MetricItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded border border-app-border bg-app-surface-2 px-2 py-1">
      <dt className="text-[10px] uppercase tracking-wider text-app-text-muted">{label}</dt>
      <dd className="truncate font-mono text-[11px]" title={value}>{value}</dd>
    </div>
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
  if (run.status === "waiting_approval") {
    return run.result?.finalAnswer ?? run.error ?? "Run is waiting for approval.";
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
      {event.activity === "tool" && toolVersionFromPayload(event.payload) ? (
        <p className="mt-0.5 font-mono text-[10px] text-app-text-muted">
          {event.actor}@{toolVersionFromPayload(event.payload)}
        </p>
      ) : null}
      {event.activity === "llm" ? (
        <p className="mt-0.5 font-mono text-[10px] text-app-text-muted">
          {llmModelFromPayload(event.payload) ?? "model unknown"} · {formatTokenUsage(llmUsageFromPayload(event.payload))}
          {typeof event.durationMs === "number" ? ` · ${formatDuration(event.durationMs)}` : ""}
        </p>
      ) : null}
      {event.detail ? (
        <p className="mt-0.5 text-[11px] text-app-text-muted">{truncate(event.detail, 160)}</p>
      ) : null}
    </li>
  );
}

function llmModelFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const direct = (payload as { model?: unknown }).model;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const output = (payload as { output?: unknown }).output;
  if (output && typeof output === "object") {
    const model = (output as { model?: unknown }).model;
    if (typeof model === "string" && model.trim()) return model.trim();
  }
  return undefined;
}

function llmUsageFromPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined;
  const direct = (payload as { usage?: unknown }).usage;
  if (direct && typeof direct === "object") return direct as Parameters<typeof formatTokenUsage>[0];
  const output = (payload as { output?: unknown }).output;
  if (output && typeof output === "object") {
    const usage = (output as { usage?: unknown }).usage;
    if (usage && typeof usage === "object") return usage as Parameters<typeof formatTokenUsage>[0];
  }
  return undefined;
}

function toolVersionFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as { toolVersion?: unknown }).toolVersion;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
