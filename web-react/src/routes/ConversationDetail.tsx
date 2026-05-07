import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useConversation, useCreateContinuationRun, useDeleteConversation } from "@/api/conversations";
import { useRuns } from "@/api/runs";
import { RunStatusBadge } from "@/components/StatusBadge";
import { formatDuration, formatRelative, runDurationMs, truncate } from "@/lib/format";
import type { ConversationThreadMessage } from "@/api/types";

export function ConversationDetailPage() {
  const params = useParams<{ threadId: string }>();
  const threadId = params.threadId;
  const conversation = useConversation(threadId);
  const runs = useRuns();
  const create = useCreateContinuationRun();
  const remove = useDeleteConversation();
  const [task, setTask] = useState("");

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

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!task.trim() || create.isPending) return;
    create.mutate(
      { threadId: thread.id, task: task.trim() },
      { onSuccess: () => setTask("") },
    );
  };

  return (
    <section className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)_300px]">
      <aside className="flex flex-col gap-2">
        <header>
          <h3 className="text-sm font-semibold">Thread runs</h3>
          <p className="mt-1 text-[11px] text-app-text-muted">{threadRuns.length} runs</p>
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
                  <span className="font-mono text-[10px] text-app-text-muted">
                    {formatDuration(runDurationMs(run))}
                  </span>
                </div>
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
            <MessageBubble key={message.id} message={message} />
          ))}
          {(thread.messages ?? []).length === 0 ? (
            <p className="text-xs text-app-text-muted">No messages yet. Submit a continuation below.</p>
          ) : null}
        </div>
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
      </aside>
    </section>
  );
}

function MessageBubble({ message }: { message: ConversationThreadMessage }) {
  const tone =
    message.role === "user"
      ? "border-app-info/30 bg-[rgba(110,168,255,0.06)]"
      : message.role === "assistant"
        ? "border-app-accent/30 bg-app-accent-soft/40"
        : "border-app-border bg-app-surface-2";
  return (
    <article className={["rounded-md border p-3 text-xs", tone].join(" ")}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
          {message.role}
        </span>
        <span className="text-[10px] text-app-text-muted">{formatRelative(message.createdAt)}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap">{message.content}</p>
    </article>
  );
}

function ContextBlock({ title, body }: { title: string; body: string }) {
  return (
    <section className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">{title}</h4>
      <p className="mt-1 whitespace-pre-wrap">{body || "—"}</p>
    </section>
  );
}
