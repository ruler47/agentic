import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useConversation, useCreateContinuationRun, useDeleteConversation } from "@/api/conversations";
import { useRuns } from "@/api/runs";
import { useToolServiceEvents } from "@/api/toolServices";
import { MarkdownContent } from "@/components/MarkdownContent";
import { GenericBadge, RunStatusBadge } from "@/components/StatusBadge";
import {
  artifactsForMessage,
  hydrateMarkdownArtifactLinks,
  unreferencedArtifacts,
} from "@/features/conversations/conversationArtifacts";
import {
  applyExternalActionRunMode,
  externalActionRunModeFromTask,
  type ExternalActionRunMode,
} from "@/features/runs/externalActionMode";
import { ExternalActionModeSelector } from "@/features/runs/ExternalActionModeSelector";
import { RunActionApprovalPanel } from "@/features/run-workspace/RunActionApprovalPanel";
import { formatDuration, formatRelative, formatTokenUsage, runDurationMs, truncate } from "@/lib/format";
import type {
  AgentArtifact,
  AgentRunRecord,
  ConversationThreadMessage,
  ToolServiceEventRecord,
} from "@/api/types";

export function ConversationDetailPage() {
  const params = useParams<{ threadId: string }>();
  const threadId = params.threadId;
  const conversation = useConversation(threadId);
  const runs = useRuns();
  const channelEvents = useToolServiceEvents({ limit: 200 });
  const create = useCreateContinuationRun();
  const remove = useDeleteConversation();
  const [task, setTask] = useState("");
  const [externalActionMode, setExternalActionMode] =
    useState<ExternalActionRunMode>("approval");

  if (!threadId) return <p className="text-sm text-app-text-muted">Thread id is missing.</p>;
  if (conversation.isLoading) return <p className="text-sm text-app-text-muted">Loading…</p>;
  if (conversation.isError)
    return <p className="text-sm text-app-danger">{conversation.error?.message ?? "Failed to load"}</p>;
  if (!conversation.data)
    return (
      <p className="text-sm text-app-text-muted">
        Thread not found.{" "}
        <Link to="/conversations" className="text-app-accent underline">
          back
        </Link>
      </p>
    );

  const thread = conversation.data;
  const threadRuns = (runs.data ?? []).filter((run) => run.threadId === thread.id);
  const threadMetrics = aggregateThreadMetrics(threadRuns);
  const threadRunIds = new Set(threadRuns.map((run) => run.id));
  const latestThreadRun =
    threadRuns.find((run) => run.id === thread.latestRunId) ?? threadRuns.at(-1);
  const linkedChannelEvents = (channelEvents.data ?? []).filter(
    (event) => event.threadId === thread.id || (event.runId ? threadRunIds.has(event.runId) : false),
  );

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!task.trim() || create.isPending) return;
    create.mutate(
      { threadId: thread.id, task: applyExternalActionRunMode(task, externalActionMode) },
      { onSuccess: () => setTask("") },
    );
  };

  return (
    <section className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)_300px]">
      <aside className="flex flex-col gap-2">
        <header>
          <h3 className="text-sm font-semibold">Thread runs</h3>
          <p className="mt-1 text-[11px] text-app-text-muted">
            {threadRuns.length} runs · {formatDuration(threadMetrics.elapsedMs)} · {threadMetrics.llmCalls} LLM ·{" "}
            {formatTokenUsage(threadMetrics.tokenUsage)}
          </p>
        </header>
        <ul className="flex flex-col gap-1.5">
          {threadRuns.map((run) => (
            <li key={run.id}>
              <Link
                to={`/run/${run.id}`}
                className="block rounded-md border border-app-border bg-app-surface-2 px-3 py-2 text-xs transition-colors hover:border-app-accent/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <RunStatusBadge status={run.status} />
                  {externalActionRunModeFromTask(run.task) === "auto" ? (
                    <GenericBadge tone="ok">automode</GenericBadge>
                  ) : null}
                  <span className="font-mono text-[10px] text-app-text-muted">
                    {formatDuration(run.metrics?.elapsedMs ?? runDurationMs(run))}
                  </span>
                </div>
                <p className="mt-1 font-mono text-[10px] text-app-text-muted">
                  {run.metrics?.llmCalls ?? 0} LLM · {formatTokenUsage(run.metrics?.tokenUsage)}
                </p>
                <p className="mt-1 line-clamp-2 text-[11px]">{truncate(run.task, 100)}</p>
                <span className="text-[10px] text-app-text-muted">
                  {formatRelative(run.createdAt)}
                </span>
              </Link>
            </li>
          ))}
          {threadRuns.length === 0 ? (
            <li className="text-[11px] text-app-text-muted">No runs in this thread.</li>
          ) : null}
        </ul>
      </aside>

      <article className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
        <header className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-words text-base font-semibold">{thread.title}</h2>
            <p className="mt-1 text-xs text-app-text-muted">
              {thread.requesterUserId} · {thread.channel} · {thread.status}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  `Delete thread "${thread.title}" and ${threadRuns.length} related run(s)? This cannot be undone.`,
                )
              ) {
                remove.mutate(thread.id, {
                  onSuccess: () => {
                    history.back();
                  },
                });
              }
            }}
            disabled={remove.isPending}
            className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-xs text-app-danger"
          >
            Delete thread
          </button>
        </header>
        <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
          {(thread.messages ?? []).map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              artifacts={message.role === "user" ? [] : artifactsForMessage(message, threadRuns)}
              run={message.runId ? threadRuns.find((run) => run.id === message.runId) : undefined}
            />
          ))}
          {(thread.messages ?? []).length === 0 ? (
            <p className="text-xs text-app-text-muted">No messages yet. Submit a continuation below.</p>
          ) : null}
        </div>
        {latestThreadRun ? <RunActionApprovalPanel run={latestThreadRun} /> : null}
        <form onSubmit={submit} className="mt-2 flex flex-col gap-2 border-t border-app-border pt-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[10px] uppercase tracking-wider text-app-text-muted">
              Continue thread
            </span>
            <textarea
              rows={3}
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder="Follow-up, clarification, or correction. New tasks belong on Dashboard."
              className="resize-y rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-sm outline-none focus:border-app-accent/60"
            />
          </label>
          <ExternalActionModeSelector
            value={externalActionMode}
            onChange={setExternalActionMode}
            compact
          />
          <div className="flex items-center justify-end gap-2">
            {create.isError ? (
              <p className="text-[11px] text-app-danger">{create.error.message}</p>
            ) : null}
            <button
              type="submit"
              disabled={!task.trim() || create.isPending}
              className="rounded-md bg-app-accent px-3 py-1.5 text-xs font-semibold text-app-bg disabled:opacity-50"
            >
              {create.isPending ? "Sending…" : "Continue"}
            </button>
          </div>
        </form>
      </article>

      <aside className="flex flex-col gap-3">
        <ContextBlock title="Summary" body={thread.summary} />
        <ContextBlock
          title="Accepted facts"
          body={(thread.acceptedFacts ?? []).join("\n") || "None yet."}
        />
        <ContextBlock
          title="Rejected attempts"
          body={(thread.rejectedAttempts ?? []).join("\n") || "None."}
        />
        <ContextBlock
          title="Open questions"
          body={(thread.openQuestions ?? []).join("\n") || "None."}
        />
        <ChannelActivityBlock events={linkedChannelEvents} />
      </aside>
    </section>
  );
}

function aggregateThreadMetrics(runs: AgentRunRecord[]) {
  return runs.reduce(
    (sum, run) => {
      const metrics = run.metrics;
      sum.elapsedMs += metrics?.elapsedMs ?? runDurationMs(run);
      sum.llmCalls += metrics?.llmCalls ?? 0;
      sum.toolCalls += metrics?.toolCalls ?? 0;
      sum.artifacts += metrics?.artifacts ?? run.result?.artifacts?.length ?? 0;
      const usage = metrics?.tokenUsage;
      if (usage?.source && usage.source !== "unavailable") {
        sum.tokenUsage.source = usage.source === "provider" || sum.tokenUsage.source === "provider"
          ? "provider"
          : "estimated";
        sum.tokenUsage.promptTokens = addOptional(sum.tokenUsage.promptTokens, usage.promptTokens);
        sum.tokenUsage.completionTokens = addOptional(sum.tokenUsage.completionTokens, usage.completionTokens);
        sum.tokenUsage.totalTokens = addOptional(sum.tokenUsage.totalTokens, usage.totalTokens);
      }
      return sum;
    },
    {
      elapsedMs: 0,
      llmCalls: 0,
      toolCalls: 0,
      artifacts: 0,
      tokenUsage: { source: "unavailable" as const },
    },
  );
}

function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function MessageBubble({
  message,
  artifacts,
  run,
}: {
  message: ConversationThreadMessage;
  artifacts: AgentArtifact[];
  run?: AgentRunRecord;
}) {
  const tone =
    message.role === "user"
      ? "border-app-info/30 bg-[rgba(110,168,255,0.06)]"
      : message.role === "assistant"
        ? "border-app-accent/30 bg-app-accent-soft/40"
        : "border-app-border bg-app-surface-2";
  const hydratedContent = hydrateMarkdownArtifactLinks(message.content, artifacts);
  const extraArtifacts = unreferencedArtifacts(hydratedContent, artifacts);
  return (
    <article className={["rounded-md border p-3 text-xs", tone].join(" ")}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
          {message.role}
        </span>
        <span className="text-[10px] text-app-text-muted">{formatRelative(message.createdAt)}</span>
      </div>
      <div className="mt-1">
        <MarkdownContent value={hydratedContent} />
      </div>
      {extraArtifacts.length > 0 ? (
        <MessageArtifacts artifacts={extraArtifacts} run={run} />
      ) : null}
    </article>
  );
}

function MessageArtifacts({
  artifacts,
  run,
}: {
  artifacts: AgentArtifact[];
  run?: AgentRunRecord;
}) {
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {artifacts.map((artifact) => (
        <MessageArtifactCard key={artifact.id} artifact={artifact} run={run} />
      ))}
    </div>
  );
}

function MessageArtifactCard({
  artifact,
  run,
}: {
  artifact: AgentArtifact;
  run?: AgentRunRecord;
}) {
  const isImage = artifact.mimeType.startsWith("image/");
  const sizeKb = Math.max(0, Math.round(artifact.sizeBytes / 1024));
  const downloadUrl = artifactDownloadUrl(artifact.url);
  return (
    <div className="rounded-md border border-app-border bg-app-surface-2 p-2 text-[11px]">
      {isImage ? (
        <a href={artifact.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded border border-app-border">
          <img src={artifact.url} alt={artifact.filename} loading="lazy" className="h-32 w-full object-cover" />
        </a>
      ) : artifact.contentPreview ? (
        <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded border border-app-border bg-app-surface px-2 py-1 font-mono text-[10px]">
          {truncate(artifact.contentPreview, 400)}
        </pre>
      ) : null}
      <div className="mt-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-all font-medium">{artifact.filename}</p>
          <p className="font-mono text-[10px] text-app-text-muted">
            {artifact.mimeType} · {sizeKb} KB
          </p>
        </div>
        <GenericBadge tone={artifact.kind === "output" ? "ok" : "muted"}>{artifact.kind}</GenericBadge>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <a href={artifact.url} target="_blank" rel="noreferrer" className="rounded border border-app-border bg-app-surface px-2 py-0.5">
          {isImage ? "Preview" : "Open"}
        </a>
        <a href={downloadUrl} download={artifact.filename} className="rounded border border-app-border bg-app-surface px-2 py-0.5">
          Download
        </a>
        {run ? (
          <Link to={`/run/${run.id}`} className="rounded border border-app-border bg-app-surface px-2 py-0.5">
            Run
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function artifactDownloadUrl(url: string): string {
  return url.includes("?") ? `${url}&download=1` : `${url}?download=1`;
}

function ContextBlock({ title, body }: { title: string; body: string }) {
  return (
    <section className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">{title}</h4>
      <p className="mt-1 whitespace-pre-wrap">{body || "—"}</p>
    </section>
  );
}

function ChannelActivityBlock({ events }: { events: ToolServiceEventRecord[] }) {
  return (
    <section className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
        Channel activity
      </h4>
      <ul className="mt-2 flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
        {events.map((event) => (
          <li key={event.id} className="rounded border border-app-border bg-app-surface px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <GenericBadge tone={event.direction === "outbound" ? "ok" : event.direction === "inbound" ? "warn" : "muted"}>
                {event.direction}
              </GenericBadge>
              <GenericBadge tone={event.status === "failed" ? "danger" : event.status === "sent" ? "ok" : "muted"}>
                {event.status}
              </GenericBadge>
              <span className="text-[10px] text-app-text-muted">{formatRelative(event.createdAt)}</span>
            </div>
            <p className="mt-1 break-words">{truncate(event.summary, 180)}</p>
            <p className="mt-1 break-all font-mono text-[10px] text-app-text-muted">
              {event.toolName}
              {event.sourceUserId ? ` · user ${event.sourceUserId}` : ""}
              {event.sourceMessageId ? ` · message ${event.sourceMessageId}` : ""}
            </p>
            {event.runId ? (
              <Link to={`/run/${event.runId}`} className="mt-1 inline-block text-[10px] text-app-accent underline">
                open run
              </Link>
            ) : null}
          </li>
        ))}
        {events.length === 0 ? (
          <li className="text-[11px] text-app-text-muted">No channel-linked events yet.</li>
        ) : null}
      </ul>
    </section>
  );
}
