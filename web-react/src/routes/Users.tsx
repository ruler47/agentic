import { useState } from "react";

import {
  useCreateChannelIdentity,
  useCreateUser,
  useDeleteChannelIdentity,
  useDeleteUser,
  useUpdateChannelIdentity,
  useUpdateUser,
  useUsers,
} from "@/api/users";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative } from "@/lib/format";
import type { UserRecord } from "@/api/types";

export function UsersPage() {
  const users = useUsers();
  const create = useCreateUser();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ id: "", displayName: "", role: "admin" });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    create.mutate(
      {
        id: draft.id.trim() || undefined,
        displayName: draft.displayName.trim(),
        role: draft.role.trim() || undefined,
      },
      {
        onSuccess: () => {
          setDraft({ id: "", displayName: "", role: "admin" });
          setOpen(false);
        },
      },
    );
  };

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-base font-semibold">Users</h2>
          <p className="mt-1 text-xs text-app-text-muted">
            Members of this instance and their channel identities (Telegram numeric ids,
            handles, or generic provider mappings).
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1 text-xs"
        >
          {open ? "Close form" : "Add user"}
        </button>
      </header>

      {open ? (
        <form
          onSubmit={submit}
          className="grid gap-3 rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4 text-xs md:grid-cols-3"
        >
          <Field label="ID (optional)">
            <input
              value={draft.id}
              onChange={(event) => setDraft((prev) => ({ ...prev, id: event.target.value }))}
              placeholder="user-family"
              className="w-full rounded border border-app-border bg-app-surface-2 px-2 py-1 font-mono"
            />
          </Field>
          <Field label="Display name">
            <input
              required
              value={draft.displayName}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, displayName: event.target.value }))
              }
              className="w-full rounded border border-app-border bg-app-surface-2 px-2 py-1"
            />
          </Field>
          <Field label="Role">
            <input
              value={draft.role}
              onChange={(event) => setDraft((prev) => ({ ...prev, role: event.target.value }))}
              className="w-full rounded border border-app-border bg-app-surface-2 px-2 py-1"
            />
          </Field>
          {create.isError ? (
            <p className="md:col-span-3 text-[11px] text-app-danger">{create.error.message}</p>
          ) : null}
          <div className="md:col-span-3 flex justify-end">
            <button
              type="submit"
              disabled={create.isPending || !draft.displayName.trim()}
              className="rounded-md bg-app-accent px-3 py-1.5 font-semibold text-app-bg disabled:opacity-50"
            >
              {create.isPending ? "Adding…" : "Add user"}
            </button>
          </div>
        </form>
      ) : null}

      {users.isLoading ? (
        <p className="text-xs text-app-text-muted">Loading…</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {(users.data ?? []).map((user) => (
            <UserCard key={user.id} user={user} />
          ))}
          {(users.data ?? []).length === 0 ? (
            <p className="text-xs text-app-text-muted">No users yet.</p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function UserCard({ user }: { user: UserRecord }) {
  const update = useUpdateUser();
  const remove = useDeleteUser();
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState(user.role);

  const recentRequests = (user as { recentRequests?: Array<{ id: string; task: string; status: string }> })
    .recentRequests ?? [];

  return (
    <article className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4 text-xs">
      <header className="flex items-baseline justify-between gap-2">
        <div>
          <strong className="text-sm">{user.displayName}</strong>
          <p className="font-mono text-[10px] text-app-text-muted">
            {user.id} · {user.role} · {(user.roles ?? []).join(", ")}
          </p>
        </div>
        <span className="text-[10px] text-app-text-muted">
          updated {formatRelative(user.updatedAt)}
        </span>
      </header>

      {editing ? (
        <div className="grid gap-2 rounded-md border border-app-border bg-app-surface-2 p-2">
          <Field label="Display name">
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="w-full rounded border border-app-border bg-app-surface px-2 py-1"
            />
          </Field>
          <Field label="Role">
            <input
              value={role}
              onChange={(event) => setRole(event.target.value)}
              className="w-full rounded border border-app-border bg-app-surface px-2 py-1"
            />
          </Field>
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                setDisplayName(user.displayName);
                setRole(user.role);
                setEditing(false);
              }}
              className="rounded border border-app-border bg-app-surface px-2 py-0.5"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={update.isPending}
              onClick={() =>
                update.mutate(
                  { id: user.id, update: { displayName: displayName.trim(), role: role.trim() } },
                  { onSuccess: () => setEditing(false) },
                )
              }
              className="rounded bg-app-accent px-2 py-0.5 font-semibold text-app-bg disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      ) : null}

      <ChannelIdentitiesList user={user} />

      {recentRequests.length > 0 ? (
        <details className="rounded-md border border-app-border bg-app-surface-2 p-2 text-[11px]">
          <summary>Recent requests ({recentRequests.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {recentRequests.map((request) => (
              <li key={request.id} className="font-mono text-[10px] text-app-text-muted">
                {request.status} · {request.task}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="mt-1 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setEditing((prev) => !prev)}
          className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-[11px]"
        >
          {editing ? "Cancel edit" : "Edit"}
        </button>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Delete user ${user.id}?`)) remove.mutate(user.id);
          }}
          disabled={remove.isPending}
          className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-[11px] text-app-danger"
        >
          Delete
        </button>
      </div>
      {[update.error, remove.error]
        .filter((error): error is Error => Boolean(error))
        .map((error, index) => (
          <p key={index} className="text-[11px] text-app-danger">
            {error.message}
          </p>
        ))}
    </article>
  );
}

function ChannelIdentitiesList({ user }: { user: UserRecord }) {
  const create = useCreateChannelIdentity();
  const update = useUpdateChannelIdentity();
  const remove = useDeleteChannelIdentity();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    provider: "channel.telegram.bot",
    providerUserId: "",
  });

  return (
    <section className="rounded-md border border-app-border bg-app-surface-2 p-2 text-[11px]">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
          Channel identities
        </h4>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="rounded border border-app-border bg-app-surface px-2 py-0.5 text-[10px]"
        >
          {open ? "Cancel" : "Add"}
        </button>
      </div>
      {open ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.providerUserId.trim()) return;
            create.mutate(
              {
                userId: user.id,
                input: {
                  provider: draft.provider,
                  providerUserId: draft.providerUserId.trim(),
                  userId: user.id,
                },
              },
              {
                onSuccess: () => {
                  setDraft((prev) => ({ ...prev, providerUserId: "" }));
                  setOpen(false);
                },
              },
            );
          }}
          className="mt-1 grid gap-1"
        >
          <input
            value={draft.provider}
            onChange={(event) => setDraft((prev) => ({ ...prev, provider: event.target.value }))}
            placeholder="provider (e.g. channel.telegram.bot)"
            className="rounded border border-app-border bg-app-surface px-2 py-1 font-mono text-[10px]"
          />
          <input
            value={draft.providerUserId}
            onChange={(event) =>
              setDraft((prev) => ({ ...prev, providerUserId: event.target.value }))
            }
            placeholder="provider user id (numeric or @handle)"
            className="rounded border border-app-border bg-app-surface px-2 py-1 font-mono text-[10px]"
            required
          />
          <button
            type="submit"
            disabled={create.isPending}
            className="self-end rounded bg-app-accent px-2 py-0.5 font-semibold text-app-bg disabled:opacity-50"
          >
            {create.isPending ? "Adding…" : "Add identity"}
          </button>
          {create.isError ? (
            <p className="text-[10px] text-app-danger">{create.error.message}</p>
          ) : null}
        </form>
      ) : null}

      <ul className="mt-2 space-y-1">
        {(user.identities ?? []).length === 0 ? (
          <li className="text-app-text-muted">No identities.</li>
        ) : (
          user.identities!.map((identity) => (
            <li
              key={identity.id}
              className="flex flex-wrap items-center gap-2 rounded border border-app-border bg-app-surface px-2 py-1"
            >
              <GenericBadge tone={identity.allowStatus === "allowed" ? "ok" : "danger"}>
                {identity.allowStatus}
              </GenericBadge>
              <span className="font-mono text-[10px]">
                {identity.provider} · {identity.providerUserId}
              </span>
              <span className="ml-auto flex gap-1">
                <button
                  type="button"
                  onClick={() =>
                    update.mutate({
                      id: identity.id,
                      update: {
                        allowStatus: identity.allowStatus === "allowed" ? "blocked" : "allowed",
                      },
                    })
                  }
                  disabled={update.isPending}
                  className="rounded border border-app-border bg-app-surface px-1.5 py-0.5 text-[10px]"
                >
                  {identity.allowStatus === "allowed" ? "Block" : "Allow"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm("Delete this identity?")) remove.mutate(identity.id);
                  }}
                  className="rounded border border-app-border bg-app-surface px-1.5 py-0.5 text-[10px] text-app-danger"
                >
                  Del
                </button>
              </span>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-app-text-muted">{label}</span>
      {children}
    </label>
  );
}
