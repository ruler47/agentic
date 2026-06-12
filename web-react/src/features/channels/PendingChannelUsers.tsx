import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { useAllowChannelEventIdentity } from "@/api/toolServices";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";
import type { UserRecord } from "@/api/types";
import type { PendingChannelUser } from "@/features/channels/channelPresentation";

export function PendingChannelUsers({
  pending,
  users,
}: {
  pending: PendingChannelUser[];
  users: UserRecord[];
}) {
  return (
    <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold">Pending channel users</h3>
          <p className="mt-1 max-w-3xl text-xs text-app-text-muted">
            Unknown inbound senders wait here until you map them to a local user. Approval creates
            all discovered ids/aliases and replays the latest inbound event into a normal run.
          </p>
        </div>
        <GenericBadge tone={pending.length ? "warn" : "muted"}>
          {pending.length ? `${pending.length} pending` : "clear"}
        </GenericBadge>
      </header>
      <ul className="mt-3 grid gap-3 xl:grid-cols-2">
        {pending.map((item) => (
          <PendingChannelUserCard key={item.key} item={item} users={users} />
        ))}
        {pending.length === 0 ? (
          <li className="rounded-md border border-dashed border-app-border p-3 text-xs text-app-text-muted">
            No unknown inbound users in this view.
          </li>
        ) : null}
      </ul>
    </article>
  );
}

function PendingChannelUserCard({
  item,
  users,
}: {
  item: PendingChannelUser;
  users: UserRecord[];
}) {
  const allow = useAllowChannelEventIdentity();
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [userId, setUserId] = useState(users[0]?.id ?? "");
  const [displayName, setDisplayName] = useState(() => defaultDisplayName(item));
  const [role, setRole] = useState("member");
  const aliases = item.aliases.length ? item.aliases.join(", ") : "none";
  const canSubmitExisting = mode === "existing" && Boolean(userId);
  const canSubmitNew = mode === "new" && Boolean(displayName.trim());
  const selectedUser = useMemo(
    () => users.find((user) => user.id === userId),
    [users, userId],
  );

  useEffect(() => {
    if (!userId && users[0]) setUserId(users[0].id);
  }, [userId, users]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (allow.isPending) return;
    if (mode === "new") {
      allow.mutate({
        eventId: item.event.id,
        createUser: { displayName: displayName.trim(), role: role.trim() || "member" },
      });
      return;
    }
    if (userId) allow.mutate({ eventId: item.event.id, userId });
  };

  return (
    <li className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <GenericBadge tone={item.hasBlockedIdentity ? "danger" : "warn"}>
              {item.hasBlockedIdentity ? "blocked id" : "unknown"}
            </GenericBadge>
            <span className="font-mono text-[10px] text-app-text-muted">
              {formatRelative(item.latestAt)} · {item.messageCount} event(s)
            </span>
          </div>
          <p className="mt-2 break-all font-mono text-[11px]">
            {item.provider} · {item.sourceUserId}
          </p>
          <p className="mt-1 break-all font-mono text-[10px] text-app-text-muted">
            chat {item.event.sourceChatId ?? "unknown"} · aliases {aliases}
          </p>
          <p className="mt-2 break-words text-app-text-muted">{truncate(item.event.summary, 220)}</p>
        </div>
        <Link
          to={`/channels?service=${encodeURIComponent(item.provider)}&direction=inbound`}
          className="shrink-0 rounded border border-app-border bg-app-surface px-2 py-1 text-[10px] hover:border-app-accent/50"
        >
          Filter events
        </Link>
      </div>

      <form onSubmit={submit} className="mt-3 grid gap-2 border-t border-app-border pt-3">
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={mode === "existing"}
              onChange={() => setMode("existing")}
            />
            existing user
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} />
            create user
          </label>
        </div>

        {mode === "existing" ? (
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-app-text-muted">User</span>
            <select
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              className="rounded-md border border-app-border bg-app-surface px-2 py-1.5 outline-none focus:border-app-accent/60"
            >
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName} ({user.id})
                </option>
              ))}
            </select>
            {selectedUser ? (
              <span className="text-[10px] text-app-text-muted">
                Will map all discovered aliases to {selectedUser.displayName}.
              </span>
            ) : null}
          </label>
        ) : (
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px]">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-app-text-muted">
                Display name
              </span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                className="rounded-md border border-app-border bg-app-surface px-2 py-1.5 outline-none focus:border-app-accent/60"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Role</span>
              <input
                value={role}
                onChange={(event) => setRole(event.target.value)}
                className="rounded-md border border-app-border bg-app-surface px-2 py-1.5 outline-none focus:border-app-accent/60"
              />
            </label>
          </div>
        )}

        <button
          type="submit"
          disabled={allow.isPending || !(canSubmitExisting || canSubmitNew)}
          className="justify-self-start rounded-md bg-app-accent px-3 py-1.5 font-semibold text-app-bg disabled:opacity-50"
        >
          {allow.isPending ? "Approving..." : mode === "new" ? "Create and replay" : "Allow and replay"}
        </button>
        {allow.isError ? <p className="text-[11px] text-app-danger">{allow.error.message}</p> : null}
      </form>
    </li>
  );
}

function defaultDisplayName(item: PendingChannelUser): string {
  return item.aliases.find((alias) => !alias.startsWith("@")) ?? item.aliases[0] ?? item.sourceUserId;
}
