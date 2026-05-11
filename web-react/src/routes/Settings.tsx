import { useEffect, useState } from "react";

import { useInstance } from "@/api/queries";
import {
  useCreateSecretHandle,
  useDeleteSecretHandle,
  useSecretHandles,
} from "@/api/secretHandles";
import { useCodingCouncil, useUpdateCodingCouncil } from "@/api/codingCouncil";
import { useModelTiers } from "@/api/models";
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

      <CodingCouncilSection />
    </section>
  );
}

function CodingCouncilSection() {
  const config = useCodingCouncil();
  const tiers = useModelTiers();
  const update = useUpdateCodingCouncil();
  const [draft, setDraft] = useState({
    tier: "L" as "S" | "M" | "L" | "XL",
    maxRevisionAttempts: 3,
    maxQaRepairAttempts: 5,
    qaTimeoutMs: 30000,
    brainstormSystemPrompt: "",
  });
  const [dirty, setDirty] = useState(false);

  // Initialize draft once the server config loads.
  useEffect(() => {
    if (!config.data) return;
    setDraft({
      tier: config.data.tier,
      maxRevisionAttempts: config.data.maxRevisionAttempts,
      maxQaRepairAttempts: config.data.maxQaRepairAttempts,
      qaTimeoutMs: config.data.qaTimeoutMs,
      brainstormSystemPrompt: config.data.brainstormSystemPrompt ?? "",
    });
    setDirty(false);
  }, [config.data?.updatedAt]);

  // Resolve which models will actually act as council members for the
  // selected tier. Sourced from model_tier_settings.<tier>.models so the
  // operator can see who'll vote without crossing pages.
  const tierRow = (tiers.data ?? []).find((row) => row.tier === draft.tier);
  const councilModels = tierRow?.models ?? [];

  const onUpdate = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const save = () => {
    update.mutate(
      {
        tier: draft.tier,
        maxRevisionAttempts: draft.maxRevisionAttempts,
        maxQaRepairAttempts: draft.maxQaRepairAttempts,
        qaTimeoutMs: draft.qaTimeoutMs,
        brainstormSystemPrompt: draft.brainstormSystemPrompt,
      },
      { onSuccess: () => setDirty(false) },
    );
  };

  return (
    <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Coding council</h3>
          <p className="mt-1 text-xs text-app-text-muted">
            The pool of LLMs that compete to build a tool. Brainstorm → vote → implement →
            review → revise → QA → repair. Council members come from
            <code className="mx-1">model_tier_settings.&lt;tier&gt;.models</code> — add or
            remove models on the Models page; pick the tier here.
          </p>
        </div>
        {config.data ? (
          <span className="text-[10px] text-app-text-muted">
            updated {formatRelative(config.data.updatedAt)}
          </span>
        ) : null}
      </header>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Field label="Council tier">
          <select
            value={draft.tier}
            onChange={(event) => onUpdate("tier", event.target.value as typeof draft.tier)}
            className="rounded-md border border-app-border bg-app-surface-2 px-2 py-1 text-xs"
          >
            {(["S", "M", "L", "XL"] as const).map((tier) => (
              <option key={tier} value={tier}>
                {tier}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[10px] text-app-text-muted">
            {councilModels.length > 0
              ? `${councilModels.length} model${councilModels.length === 1 ? "" : "s"} in this tier: ${councilModels.join(", ")}`
              : "No models registered for this tier yet. Add some on Models → Tier settings."}
          </p>
        </Field>
        <Field label="Max review revision attempts (1-10)">
          <input
            type="number"
            min={1}
            max={10}
            value={draft.maxRevisionAttempts}
            onChange={(event) => onUpdate("maxRevisionAttempts", Number(event.target.value))}
            className="rounded-md border border-app-border bg-app-surface-2 px-2 py-1 text-xs"
          />
        </Field>
        <Field label="Max QA repair attempts (1-10)">
          <input
            type="number"
            min={1}
            max={10}
            value={draft.maxQaRepairAttempts}
            onChange={(event) => onUpdate("maxQaRepairAttempts", Number(event.target.value))}
            className="rounded-md border border-app-border bg-app-surface-2 px-2 py-1 text-xs"
          />
        </Field>
        <Field label="QA timeout (ms, 1000-600000)">
          <input
            type="number"
            min={1000}
            max={600000}
            step={1000}
            value={draft.qaTimeoutMs}
            onChange={(event) => onUpdate("qaTimeoutMs", Number(event.target.value))}
            className="rounded-md border border-app-border bg-app-surface-2 px-2 py-1 text-xs"
          />
        </Field>
        <div className="md:col-span-2">
          <Field label="Brainstorm system prompt (optional override)">
            <textarea
              value={draft.brainstormSystemPrompt}
              onChange={(event) => onUpdate("brainstormSystemPrompt", event.target.value)}
              rows={3}
              placeholder="Leave empty to use the built-in default."
              className="rounded-md border border-app-border bg-app-surface-2 px-2 py-1 text-xs"
            />
          </Field>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          disabled={!dirty || update.isPending || councilModels.length < 2}
          onClick={save}
          className="rounded-md bg-app-accent px-3 py-1.5 text-xs font-semibold text-app-bg disabled:opacity-50"
          title={
            councilModels.length < 2
              ? "Need at least 2 models in this tier for a council vote."
              : "Save coding-council config."
          }
        >
          {update.isPending ? "Saving…" : "Save"}
        </button>
        {update.isError ? (
          <span className="text-[11px] text-app-danger">{update.error.message}</span>
        ) : null}
        {councilModels.length < 2 ? (
          <GenericBadge tone="warn">add more models in tier</GenericBadge>
        ) : null}
      </div>
    </article>
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
