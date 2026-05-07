import { useState } from "react";

import { useInstance } from "@/api/queries";
import {
  useCreateSecretHandle,
  useDeleteSecretHandle,
  useSecretHandles,
} from "@/api/secretHandles";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative } from "@/lib/format";
import type { SecretHandleInput, SecretHandleProvider } from "@/api/types";

export function SettingsPage() {
  const instance = useInstance();
  const handles = useSecretHandles();
  const create = useCreateSecretHandle();
  const remove = useDeleteSecretHandle();

  const [draft, setDraft] = useState<SecretHandleInput>({
    handle: "",
    label: "",
    provider: "env",
    secretRef: "",
    scopes: [],
  });
  const [scopes, setScopes] = useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    create.mutate(
      {
        ...draft,
        handle: draft.handle?.trim() || undefined,
        scopes: scopes.split(",").map((value) => value.trim()).filter(Boolean),
      },
      {
        onSuccess: () => {
          setDraft({ handle: "", label: "", provider: "env", secretRef: "", scopes: [] });
          setScopes("");
        },
      },
    );
  };

  return (
    <section className="flex flex-col gap-4">
      <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
        <h2 className="text-base font-semibold">Instance</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <Definition label="ID">{instance.data?.id ?? "—"}</Definition>
          <Definition label="Name">{instance.data?.name ?? "—"}</Definition>
          <Definition label="Locale">{instance.data?.locale ?? "—"}</Definition>
          <Definition label="Time zone">{instance.data?.timeZone ?? "—"}</Definition>
        </dl>
      </article>

      <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
        <header className="mb-3 flex items-baseline justify-between">
          <div>
            <h2 className="text-base font-semibold">Secret handles</h2>
            <p className="mt-1 text-xs text-app-text-muted">
              Named pointers to credentials (env vars, vault paths, scoped inline values).
              The API rejects raw <code>token</code>/<code>password</code>/<code>apiKey</code>
              fields — use a handle here and reference it from tool / provider configuration.
            </p>
          </div>
          <span className="text-[11px] text-app-text-muted">
            {(handles.data ?? []).length} handles
          </span>
        </header>
        <div className="grid gap-3 lg:grid-cols-2">
          {(handles.data ?? []).map((handle) => (
            <article
              key={handle.handle}
              className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs"
            >
              <div className="flex items-baseline justify-between gap-2">
                <strong className="break-all">{handle.handle}</strong>
                <GenericBadge tone={providerTone(handle.provider)}>{handle.provider}</GenericBadge>
              </div>
              <p className="mt-1 break-all font-mono text-[10px] text-app-text-muted">
                {handle.secretRef}
              </p>
              <p className="mt-1 text-[11px] text-app-text-muted">{handle.label}</p>
              {(handle.scopes ?? []).length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                  {handle.scopes!.map((scope) => (
                    <span key={scope} className="rounded-full bg-app-surface px-2 py-0.5 font-mono">
                      {scope}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="mt-2 flex items-center justify-between">
                <span className="font-mono text-[10px] text-app-text-muted">
                  updated {formatRelative(handle.updatedAt)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Delete secret handle ${handle.handle}?`)) {
                      remove.mutate(handle.handle);
                    }
                  }}
                  disabled={remove.isPending}
                  className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-app-danger"
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
          {(handles.data ?? []).length === 0 ? (
            <p className="text-xs text-app-text-muted">No handles yet.</p>
          ) : null}
        </div>

        <form
          onSubmit={submit}
          className="mt-4 grid gap-3 rounded-md border border-app-border bg-app-surface-2 p-3 text-xs md:grid-cols-2"
        >
          <h3 className="md:col-span-2 text-sm font-semibold">Add secret handle</h3>
          <Field label="Handle (optional, derived if blank)">
            <input
              value={draft.handle ?? ""}
              onChange={(event) => setDraft((prev) => ({ ...prev, handle: event.target.value }))}
              placeholder="secret.api.x"
              className="w-full rounded border border-app-border bg-app-surface px-2 py-1 font-mono"
            />
          </Field>
          <Field label="Label">
            <input
              required
              value={draft.label}
              onChange={(event) => setDraft((prev) => ({ ...prev, label: event.target.value }))}
              placeholder="OpenAI API key"
              className="w-full rounded border border-app-border bg-app-surface px-2 py-1"
            />
          </Field>
          <Field label="Provider">
            <select
              value={draft.provider}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, provider: event.target.value as SecretHandleProvider }))
              }
              className="w-full rounded border border-app-border bg-app-surface px-2 py-1"
            >
              <option value="env">env</option>
              <option value="external">external</option>
              <option value="inline">inline</option>
            </select>
          </Field>
          <Field label="Secret ref (env var / vault path / handle name)">
            <input
              required
              value={draft.secretRef}
              onChange={(event) => setDraft((prev) => ({ ...prev, secretRef: event.target.value }))}
              placeholder="OPENAI_API_KEY"
              className="w-full rounded border border-app-border bg-app-surface px-2 py-1 font-mono"
            />
          </Field>
          <Field label="Scopes (comma-separated)">
            <input
              value={scopes}
              onChange={(event) => setScopes(event.target.value)}
              placeholder="instance-local, tool:browser.operate"
              className="w-full rounded border border-app-border bg-app-surface px-2 py-1 font-mono"
            />
          </Field>
          {create.isError ? (
            <p className="md:col-span-2 text-[11px] text-app-danger">{create.error.message}</p>
          ) : null}
          <div className="md:col-span-2 flex justify-end">
            <button
              type="submit"
              disabled={create.isPending}
              className="rounded-md bg-app-accent px-3 py-1.5 text-xs font-semibold text-app-bg disabled:opacity-50"
            >
              {create.isPending ? "Adding…" : "Add handle"}
            </button>
          </div>
        </form>
      </article>
    </section>
  );
}

function Definition({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-app-border bg-app-surface-2 p-3">
      <dt className="text-[10px] uppercase tracking-wider text-app-text-muted">{label}</dt>
      <dd className="mt-1 break-all font-mono text-[11px]">{children}</dd>
    </div>
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

function providerTone(provider: SecretHandleProvider): "ok" | "warn" | "muted" {
  if (provider === "env") return "ok";
  if (provider === "external") return "warn";
  return "muted";
}
