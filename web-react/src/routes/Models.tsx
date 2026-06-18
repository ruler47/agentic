import { useEffect, useMemo, useState } from "react";

import {
  useCreateModelProvider,
  useDeleteModelProvider,
  useModelCatalog,
  useModelProviders,
  useModelTiers,
  useSaveModelTiers,
} from "@/api/models";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";
import type { ModelProviderInput, ModelProviderRecord, ModelTier, ModelTierSettings } from "@/api/types";
import type { ModelCatalogResponse } from "@/api/models";

const TIERS: ModelTier[] = ["S", "M", "L", "XL"];

const TIER_DESCRIPTION: Record<ModelTier, string> = {
  S: "Cheap classification, simple direct answers.",
  M: "Balanced planning and synthesis.",
  L: "High-stakes synthesis and review.",
  XL: "Generated tool builders, deep code review.",
};

export function ModelsPage() {
  const tiers = useModelTiers();
  const providers = useModelProviders();
  const catalog = useModelCatalog();
  const chatModelOptions = useMemo(
    () => collectChatModelOptions(catalog.data, providers.data),
    [catalog.data, providers.data],
  );

  return (
    <section className="flex flex-col gap-4">
      <CatalogPanel catalog={catalog.data} />
      <TiersPanel tiers={tiers.data} loading={tiers.isLoading} modelOptions={chatModelOptions} />
      <ProvidersPanel providers={providers.data} loading={providers.isLoading} />
    </section>
  );
}

function CatalogPanel({ catalog }: { catalog: ReturnType<typeof useModelCatalog>["data"] }) {
  const chatModels = catalog?.chat?.models ?? [];
  const embeddingModels = catalog?.embedding?.models ?? [];
  return (
    <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
      <header className="mb-3 flex items-baseline justify-between">
        <div>
          <h2 className="text-base font-semibold">Model catalog</h2>
          <p className="mt-1 text-xs text-app-text-muted">
            Discovered local OpenAI-compatible chat models and the active embedding provider.
          </p>
        </div>
        <span className="text-[11px] text-app-text-muted">
          {chatModels.length} chat · {embeddingModels.length} embedding
        </span>
      </header>
      <div className="grid gap-3 md:grid-cols-2">
        <article className="rounded-md border border-app-border bg-app-surface-2 p-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Chat endpoint</span>
            <span className="truncate font-mono text-[10px] text-app-text-muted">
              {catalog?.chat?.baseUrl ?? "—"}
            </span>
          </div>
          <h3 className="mt-1 text-sm font-semibold">Local chat models</h3>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            {chatModels.length === 0 ? (
              <span className="text-app-text-muted">
                No /models response. Configure providers below.
              </span>
            ) : (
              chatModels.map((model) => (
                <span key={model.id} className="rounded-full bg-app-surface px-2 py-0.5 font-mono">
                  {model.id}
                </span>
              ))
            )}
          </div>
        </article>
        <article className="rounded-md border border-app-border bg-app-surface-2 p-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Embedding</span>
            <span className="font-mono text-[10px] text-app-text-muted">
              {catalog?.embedding?.provider ?? "deterministic"}
            </span>
          </div>
          <h3 className="mt-1 text-sm font-semibold">
            {catalog?.embedding?.model ?? "Deterministic fallback"}
          </h3>
          <p className="mt-1 text-[11px] text-app-text-muted">
            {catalog?.embedding?.dimensions ?? 128} dimensions
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            {embeddingModels.length === 0 ? (
              <span className="text-app-text-muted">
                No embedding model catalog from the configured endpoint.
              </span>
            ) : (
              embeddingModels.map((model) => (
                <span key={model.id} className="rounded-full bg-app-surface px-2 py-0.5 font-mono">
                  {model.id}
                </span>
              ))
            )}
          </div>
        </article>
      </div>
    </article>
  );
}

function TiersPanel({
  tiers,
  loading,
  modelOptions,
}: {
  tiers: ModelTierSettings[] | undefined;
  loading: boolean;
  modelOptions: ModelOption[];
}) {
  const save = useSaveModelTiers();
  const [draft, setDraft] = useState<Record<ModelTier, string[]>>({ S: [], M: [], L: [], XL: [] });
  const [maxAttempts, setMaxAttempts] = useState<Record<ModelTier, number>>({ S: 2, M: 2, L: 2, XL: 2 });
  const [escalate, setEscalate] = useState<Record<ModelTier, boolean>>({
    S: true, M: true, L: true, XL: true,
  });

  useEffect(() => {
    if (!tiers) return;
    const nextDraft: Record<ModelTier, string[]> = { S: [], M: [], L: [], XL: [] };
    const nextAttempts: Record<ModelTier, number> = { S: 2, M: 2, L: 2, XL: 2 };
    const nextEscalate: Record<ModelTier, boolean> = { S: true, M: true, L: true, XL: true };
    for (const tier of tiers) {
      nextDraft[tier.tier] = tier.models;
      nextAttempts[tier.tier] = tier.maxAttempts;
      nextEscalate[tier.tier] = tier.escalateOnFailure;
    }
    setDraft(nextDraft);
    setMaxAttempts(nextAttempts);
    setEscalate(nextEscalate);
  }, [tiers]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    save.mutate({
      tiers: TIERS.map((tier) => ({
        tier,
        models: draft[tier].map((value) => value.trim()).filter(Boolean),
        maxAttempts: maxAttempts[tier],
        escalateOnFailure: escalate[tier],
      })),
    });
  };

  return (
    <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
      <header className="mb-3 flex items-baseline justify-between">
        <div>
          <h2 className="text-base font-semibold">Model tier policy</h2>
          <p className="mt-1 text-xs text-app-text-muted">
            Select fallback models from discovered local `/models` responses and manually
            registered providers. The runtime tries them in order with up to{" "}
            <code>maxAttempts</code> retries; <code>escalate</code> moves to the next tier
            on persistent failure.
          </p>
        </div>
        {save.isSuccess ? (
          <span className="text-[11px] text-app-accent">Saved {formatRelative(Date.now())}</span>
        ) : null}
      </header>
      {loading ? (
        <p className="text-xs text-app-text-muted">Loading…</p>
      ) : (
        <form onSubmit={submit} className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-4">
          {TIERS.map((tier) => (
            <fieldset
              key={tier}
              className="min-w-0 overflow-hidden rounded-md border border-app-border bg-app-surface-2 p-3 text-xs"
            >
              <div className="flex min-w-0 flex-col gap-2">
              <legend className="px-1 text-sm font-semibold leading-tight">Tier {tier}</legend>
              <p className="break-words text-[11px] text-app-text-muted">{TIER_DESCRIPTION[tier]}</p>
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wider text-app-text-muted">
                  fallback models
                </span>
                <TierModelSelector
                  tier={tier}
                  value={draft[tier]}
                  modelOptions={mergeCurrentModelOptions(modelOptions, draft[tier])}
                  onChange={(models) => setDraft((prev) => ({ ...prev, [tier]: models }))}
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-wider text-app-text-muted">
                  max attempts
                </span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={maxAttempts[tier]}
                  onChange={(event) =>
                    setMaxAttempts((prev) => ({ ...prev, [tier]: Number(event.target.value) }))
                  }
                  className="w-20 rounded border border-app-border bg-app-surface px-2 py-1 font-mono outline-none focus:border-app-accent/60"
                />
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={escalate[tier]}
                  onChange={(event) =>
                    setEscalate((prev) => ({ ...prev, [tier]: event.target.checked }))
                  }
                />
                <span>Escalate on failure</span>
              </label>
              </div>
            </fieldset>
          ))}
          <div className="flex items-center justify-end gap-2 lg:col-span-2 2xl:col-span-4">
            {save.isError ? (
              <p className="text-[11px] text-app-danger">{save.error.message}</p>
            ) : null}
            <button
              type="submit"
              disabled={save.isPending}
              className="rounded-md bg-app-accent px-4 py-1.5 text-xs font-semibold text-app-bg disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : "Save tier policy"}
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

type ModelOption = {
  id: string;
  label: string;
  source: string;
};

function TierModelSelector({
  tier,
  value,
  modelOptions,
  onChange,
}: {
  tier: ModelTier;
  value: string[];
  modelOptions: ModelOption[];
  onChange: (models: string[]) => void;
}) {
  const available = modelOptions.filter((option) => !value.includes(option.id));
  return (
    <div className="min-w-0 max-w-full overflow-hidden flex flex-col gap-2">
      <div className="flex min-w-0 max-w-full flex-wrap gap-1.5 overflow-hidden">
        {value.length === 0 ? (
          <span className="rounded border border-dashed border-app-border px-2 py-1 text-[11px] text-app-text-muted">
            No model selected
          </span>
        ) : (
          value.map((modelId, index) => (
            <span
              key={`${modelId}-${index}`}
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-app-surface px-2 py-0.5 font-mono text-[10px]"
            >
              <span className="min-w-0 truncate">{modelId}</span>
              <button
                type="button"
                onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
                className="text-app-text-muted hover:text-app-danger"
                title={`Remove ${modelId}`}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>
      <select
        value=""
        onChange={(event) => {
          const modelId = event.target.value;
          if (!modelId) return;
          onChange([...value, modelId]);
          event.currentTarget.value = "";
        }}
        className="min-w-0 w-full max-w-full rounded border border-app-border bg-app-surface px-2 py-1 font-mono outline-none focus:border-app-accent/60"
        aria-label={`Add model to tier ${tier}`}
      >
        <option value="">Add fallback model…</option>
        {available.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      {modelOptions.length === 0 ? (
        <p className="text-[11px] text-app-warning">
          No discovered or registered chat models yet. Add a provider below or start the local model endpoint.
        </p>
      ) : null}
    </div>
  );
}

function collectChatModelOptions(
  catalog: ModelCatalogResponse | undefined,
  providers: ModelProviderRecord[] | undefined,
): ModelOption[] {
  const options = new Map<string, ModelOption>();
  for (const model of catalog?.chat?.models ?? []) {
    if (!model.id) continue;
    options.set(model.id, {
      id: model.id,
      label: `${model.id} · local catalog`,
      source: "local catalog",
    });
  }
  for (const provider of providers ?? []) {
    if (provider.kind !== "chat") continue;
    for (const modelId of provider.modelIds ?? []) {
      if (!modelId) continue;
      const source = provider.label || provider.id;
      options.set(modelId, {
        id: modelId,
        label: `${modelId} · ${source}`,
        source,
      });
    }
  }
  return [...options.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function mergeCurrentModelOptions(options: ModelOption[], current: string[]): ModelOption[] {
  const merged = new Map(options.map((option) => [option.id, option]));
  for (const modelId of current) {
    if (!modelId || merged.has(modelId)) continue;
    merged.set(modelId, {
      id: modelId,
      label: `${modelId} · saved setting`,
      source: "saved setting",
    });
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function ProvidersPanel({
  providers,
  loading,
}: {
  providers: ModelProviderRecord[] | undefined;
  loading: boolean;
}) {
  const create = useCreateModelProvider();
  const [draft, setDraft] = useState<ModelProviderInput>({
    label: "",
    kind: "chat",
    providerType: "openai-compatible",
    baseUrl: "",
    modelIds: [],
    apiKeySecretHandle: "",
  });
  const [modelIds, setModelIds] = useState("");

  const sortedProviders = useMemo(
    () => (providers ?? []).slice().sort((a, b) => a.label.localeCompare(b.label)),
    [providers],
  );

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    create.mutate(
      {
        ...draft,
        modelIds: modelIds.split(",").map((value) => value.trim()).filter(Boolean),
      },
      {
        onSuccess: () => {
          setDraft({
            label: "",
            kind: "chat",
            providerType: "openai-compatible",
            baseUrl: "",
            modelIds: [],
            apiKeySecretHandle: "",
          });
          setModelIds("");
        },
      },
    );
  };

  return (
    <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
      <header className="mb-3 flex items-baseline justify-between">
        <div>
          <h2 className="text-base font-semibold">Provider registry</h2>
          <p className="mt-1 text-xs text-app-text-muted">
            Local and remote OpenAI-compatible providers. Store credentials as secret
            handles in Settings; never paste raw API keys here.
          </p>
        </div>
        <span className="text-[11px] text-app-text-muted">{sortedProviders.length} providers</span>
      </header>
      {loading ? (
        <p className="text-xs text-app-text-muted">Loading…</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {sortedProviders.map((provider) => (
            <ProviderCard key={provider.id} provider={provider} />
          ))}
        </div>
      )}
      <form
        onSubmit={submit}
        className="mt-4 grid gap-3 rounded-md border border-app-border bg-app-surface-2 p-3 text-xs md:grid-cols-2"
      >
        <h3 className="md:col-span-2 text-sm font-semibold">Add provider</h3>
        <Field label="Label">
          <input
            required
            value={draft.label}
            onChange={(event) => setDraft((prev) => ({ ...prev, label: event.target.value }))}
            className="w-full rounded border border-app-border bg-app-surface px-2 py-1"
          />
        </Field>
        <Field label="Kind">
          <select
            value={draft.kind}
            onChange={(event) =>
              setDraft((prev) => ({ ...prev, kind: event.target.value as ModelProviderInput["kind"] }))
            }
            className="w-full rounded border border-app-border bg-app-surface px-2 py-1"
          >
            <option value="chat">Chat</option>
            <option value="embedding">Embedding</option>
          </select>
        </Field>
        <Field label="Provider type">
          <select
            value={draft.providerType}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                providerType: event.target.value as ModelProviderInput["providerType"],
              }))
            }
            className="w-full rounded border border-app-border bg-app-surface px-2 py-1"
          >
            <option value="local">Local</option>
            <option value="remote">Remote</option>
            <option value="openai-compatible">OpenAI-compatible</option>
            <option value="deterministic">Deterministic (embedding only)</option>
          </select>
        </Field>
        <Field label="Base URL">
          <input
            value={draft.baseUrl ?? ""}
            onChange={(event) => setDraft((prev) => ({ ...prev, baseUrl: event.target.value }))}
            placeholder="https://api.openai.com/v1"
            className="w-full rounded border border-app-border bg-app-surface px-2 py-1 font-mono"
          />
        </Field>
        <Field label="Model ids (comma-separated)">
          <input
            value={modelIds}
            onChange={(event) => setModelIds(event.target.value)}
            placeholder="gpt-5.2, gpt-5.2-mini"
            className="w-full rounded border border-app-border bg-app-surface px-2 py-1 font-mono"
          />
        </Field>
        <Field label="API key secret handle">
          <input
            value={draft.apiKeySecretHandle ?? ""}
            onChange={(event) =>
              setDraft((prev) => ({ ...prev, apiKeySecretHandle: event.target.value }))
            }
            placeholder="secret.openai.api-key"
            className="w-full rounded border border-app-border bg-app-surface px-2 py-1 font-mono"
          />
        </Field>
        {create.isError ? (
          <p className="md:col-span-2 text-[11px] text-app-danger">{create.error.message}</p>
        ) : null}
        <div className="md:col-span-2 flex justify-end">
          <button
            type="submit"
            disabled={create.isPending || !draft.label.trim()}
            className="rounded-md bg-app-accent px-3 py-1.5 text-xs font-semibold text-app-bg disabled:opacity-50"
          >
            {create.isPending ? "Adding…" : "Add provider"}
          </button>
        </div>
      </form>
    </article>
  );
}

function ProviderCard({ provider }: { provider: ModelProviderRecord }) {
  const remove = useDeleteModelProvider();
  return (
    <article className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <strong className="text-sm">{provider.label}</strong>
        <GenericBadge tone={provider.status === "available" ? "ok" : provider.status === "failed" ? "danger" : "muted"}>
          {provider.status}
        </GenericBadge>
      </div>
      <p className="mt-1 font-mono text-[10px] text-app-text-muted">
        {provider.kind} · {provider.providerType}
      </p>
      {provider.baseUrl ? (
        <p className="mt-1 break-all font-mono text-[10px] text-app-text-muted">{provider.baseUrl}</p>
      ) : null}
      {(provider.modelIds ?? []).length > 0 ? (
        <p className="mt-1 break-all font-mono text-[10px]">
          {(provider.modelIds ?? []).join(", ")}
        </p>
      ) : null}
      {provider.apiKeySecretHandle ? (
        <p className="mt-1 font-mono text-[10px] text-app-text-muted">
          handle: {provider.apiKeySecretHandle}
        </p>
      ) : null}
      {provider.healthDetail ? (
        <p className="mt-1 text-[11px] text-app-text-muted">{truncate(provider.healthDetail, 200)}</p>
      ) : null}
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`Delete provider ${provider.label}?`)) {
              remove.mutate(provider.id);
            }
          }}
          className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-app-danger"
        >
          Delete
        </button>
      </div>
      {remove.isError ? (
        <p className="mt-1 text-[11px] text-app-danger">{remove.error.message}</p>
      ) : null}
    </article>
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
