import { Link } from "react-router-dom";
import { useConversations } from "@/api/queries";
import { useDeleteConversation } from "@/api/conversations";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";

export function ConversationsPage() {
  const conversations = useConversations();
  const remove = useDeleteConversation();

  return (
    <section className="flex flex-col gap-4">
      <header className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
        <h2 className="text-base font-semibold">Conversations</h2>
        <p className="mt-1 text-xs text-app-text-muted">
          Each thread groups one initial task with its follow-ups, corrections, and clarifications.
          Deleting a thread removes its runs, trace events, and artifact metadata.
        </p>
      </header>
      {conversations.isLoading ? (
        <p className="text-sm text-app-text-muted">Loading…</p>
      ) : (conversations.data ?? []).length === 0 ? (
        <p className="text-sm text-app-text-muted">No conversations yet. Submit a task on Dashboard.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {conversations.data!.map((thread) => (
            <article
              key={thread.id}
              className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4 text-xs"
            >
              <div className="flex items-baseline justify-between gap-2">
                <GenericBadge tone={thread.status === "active" ? "ok" : "muted"}>
                  {thread.status}
                </GenericBadge>
                <span className="text-[10px] text-app-text-muted">
                  {formatRelative(thread.updatedAt)}
                </span>
              </div>
              <Link to={`/conversation/${thread.id}`} className="text-sm font-semibold hover:underline">
                {thread.title}
              </Link>
              <p className="text-[11px] text-app-text-muted">
                {thread.requesterUserId} · {thread.channel}
              </p>
              <p className="line-clamp-3 text-[11px]">{truncate(thread.summary, 220)}</p>
              <div className="grid grid-cols-3 gap-2 text-[10px] text-app-text-muted">
                <span>{thread.messages?.length ?? 0} msgs</span>
                <span>{thread.acceptedFacts?.length ?? 0} facts</span>
                <span>{thread.artifactIds?.length ?? 0} files</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-2">
                <Link
                  to={`/conversation/${thread.id}`}
                  className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-[11px] hover:border-app-accent/40"
                >
                  Open
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete thread "${thread.title}" and all its runs? This cannot be undone.`,
                      )
                    ) {
                      remove.mutate(thread.id);
                    }
                  }}
                  disabled={remove.isPending}
                  className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-[11px] text-app-danger"
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
