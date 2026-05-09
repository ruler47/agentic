import { useEffect, useMemo, useState } from "react";

import {
  useMemories,
  useEvaluateMemoryRetrieval,
  useMemoryReviews,
  useRebuildMemoryEmbeddings,
  useUpdateMemory,
  type MemoryReviewEntry,
} from "@/api/memory";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";
import type {
  MemoryScope,
  MemorySensitivity,
  MemoryStatus,
  SkillMemoryEntry,
} from "@/api/types";

const SCOPES: Array<MemoryScope | "all"> = ["all", "global", "group", "user", "thread", "run"];
const STATUSES: Array<MemoryStatus | "all"> = ["all", "proposed", "accepted", "rejected", "archived"];

export function MemoryPage() {
  const memories = useMemories();
  const reviews = useMemoryReviews();
  const rebuild = useRebuildMemoryEmbeddings();
  const evaluateRetrieval = useEvaluateMemoryRetrieval();
  const [scope, setScope] = useState<(typeof SCOPES)[number]>("all");
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>();

  const filtered = useMemo(() => {
    const list = memories.data ?? [];
    return list.filter((memory) => {
      if (scope !== "all" && (memory.scope ?? "global") !== scope) return false;
      if (status !== "all" && (memory.status ?? "accepted") !== status) return false;
      if (search.trim()) {
        const needle = search.trim().toLowerCase();
        const haystack = [memory.title, memory.summary, memory.reusableProcedure, ...(memory.tags ?? [])]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [memories.data, scope, status, search]);

  const selected = filtered.find((memory) => memory.id === selectedId) ?? filtered[0];

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
      <div className="flex min-w-0 flex-col gap-4">
        <header className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search memories…"
              className="min-w-[200px] flex-1 rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 outline-none focus:border-app-accent/60"
            />
            <FilterPills label="scope" value={scope} options={SCOPES} onChange={setScope} />
            <FilterPills label="status" value={status} options={STATUSES} onChange={setStatus} />
            <button
              type="button"
              onClick={() => rebuild.mutate()}
              disabled={rebuild.isPending}
              className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px]"
            >
              {rebuild.isPending ? "Rebuilding…" : "Rebuild embeddings"}
            </button>
            <button
              type="button"
              onClick={() => evaluateRetrieval.mutate(buildRetrievalEvaluationCases(filtered))}
              disabled={evaluateRetrieval.isPending || filtered.length === 0}
              className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px]"
            >
              {evaluateRetrieval.isPending ? "Evaluating…" : "Run retrieval eval"}
            </button>
          </div>
          {rebuild.isError ? (
            <p className="mt-1 text-[11px] text-app-danger">{rebuild.error.message}</p>
          ) : null}
          {rebuild.isSuccess ? (
            <p className="mt-1 text-[11px] text-app-accent">
              Rebuilt {rebuild.data.updated} memory vectors.
            </p>
          ) : null}
          {evaluateRetrieval.isError ? (
            <p className="mt-1 text-[11px] text-app-danger">{evaluateRetrieval.error.message}</p>
          ) : null}
          {evaluateRetrieval.isSuccess ? (
            <div className="mt-2 rounded-md border border-app-border bg-app-surface-2 p-2 text-[11px] text-app-text-muted">
              <p className={evaluateRetrieval.data.passed ? "text-app-accent" : "text-app-danger"}>
                Retrieval eval: {evaluateRetrieval.data.passedCases}/{evaluateRetrieval.data.totalCases} passed,
                average recall {Math.round(evaluateRetrieval.data.averageRecall * 100)}%.
              </p>
              {evaluateRetrieval.data.results.slice(0, 4).map((result) => (
                <p key={result.caseId} className="mt-1 truncate">
                  {result.passed ? "PASS" : "FAIL"} {result.caseId}: top hit{" "}
                  {result.topHitMatched ? "matched" : "missed"}
                  {result.missingMemoryIds.length ? `, missing ${result.missingMemoryIds.join(", ")}` : ""}
                </p>
              ))}
            </div>
          ) : null}
        </header>

        {(reviews.data ?? []).length > 0 ? (
          <ReviewQueuePanel reviews={reviews.data ?? []} />
        ) : null}

        <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface">
          {memories.isLoading ? (
            <p className="px-4 py-6 text-xs text-app-text-muted">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="px-4 py-6 text-xs text-app-text-muted">No memories match the filters.</p>
          ) : (
            <ul className="divide-y divide-app-border">
              {filtered.map((memory) => (
                <li key={memory.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(memory.id)}
                    className={[
                      "grid w-full grid-cols-[auto_1fr_auto_auto] items-center gap-3 px-4 py-2 text-left text-xs transition-colors",
                      memory.id === selected?.id ? "bg-app-accent-soft/30" : "hover:bg-app-surface-2",
                    ].join(" ")}
                  >
                    <GenericBadge tone={statusTone(memory.status ?? "accepted")}>
                      {memory.status ?? "accepted"}
                    </GenericBadge>
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{memory.title}</p>
                      <p className="truncate text-[11px] text-app-text-muted">
                        {truncate(memory.summary, 120)}
                      </p>
                    </div>
                    <span className="font-mono text-[10px] text-app-text-muted">
                      {memory.scope ?? "global"}
                    </span>
                    <span className="text-[10px] text-app-text-muted">
                      {formatRelative(memory.updatedAt ?? memory.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </article>
      </div>

      <aside className="min-w-0">
        {selected ? <MemoryEditor memory={selected} /> : (
          <p className="rounded-[var(--radius-card)] border border-dashed border-app-border bg-app-surface p-5 text-sm text-app-text-muted">
            Select a memory on the left to inspect or edit.
          </p>
        )}
      </aside>
    </section>
  );
}

function MemoryEditor({ memory }: { memory: SkillMemoryEntry }) {
  const update = useUpdateMemory();
  const [title, setTitle] = useState(memory.title);
  const [summary, setSummary] = useState(memory.summary);
  const [reusableProcedure, setReusableProcedure] = useState(memory.reusableProcedure);
  const [tags, setTags] = useState((memory.tags ?? []).join(", "));
  const [scope, setScope] = useState<MemoryScope>(memory.scope ?? "global");
  const [scopeId, setScopeId] = useState(memory.scopeId ?? "");
  const [status, setStatus] = useState<MemoryStatus>(memory.status ?? "accepted");
  const [confidence, setConfidence] = useState(memory.confidence ?? 0.75);
  const [sensitivity, setSensitivity] = useState<MemorySensitivity>(memory.sensitivity ?? "normal");
  const [evidence, setEvidence] = useState((memory.evidence ?? []).join("\n"));

  // Reset draft when the selected memory changes.
  useEffect(() => {
    setTitle(memory.title);
    setSummary(memory.summary);
    setReusableProcedure(memory.reusableProcedure);
    setTags((memory.tags ?? []).join(", "));
    setScope(memory.scope ?? "global");
    setScopeId(memory.scopeId ?? "");
    setStatus(memory.status ?? "accepted");
    setConfidence(memory.confidence ?? 0.75);
    setSensitivity(memory.sensitivity ?? "normal");
    setEvidence((memory.evidence ?? []).join("\n"));
    update.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memory.id]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    update.mutate({
      id: memory.id,
      update: {
        title: title.trim(),
        summary: summary.trim(),
        reusableProcedure: reusableProcedure.trim(),
        tags: tags.split(",").map((value) => value.trim()).filter(Boolean),
        scope,
        scopeId: scopeId.trim() || null,
        status,
        confidence,
        sensitivity,
        evidence: evidence.split("\n").map((value) => value.trim()).filter(Boolean),
      },
    });
  };

  return (
    <article className="flex max-h-[calc(100vh-200px)] flex-col gap-3 overflow-y-auto rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4 text-xs">
      <header>
        <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Memory</span>
        <h3 className="text-sm font-semibold">{memory.title}</h3>
        <p className="mt-1 font-mono text-[10px] text-app-text-muted">{memory.id}</p>
      </header>
      {memory.match ? (
        <p className="rounded border border-app-accent/30 bg-app-accent-soft/40 p-2 text-[11px]">
          Last match: {memory.match.reason}
        </p>
      ) : null}
      <form onSubmit={submit} className="flex flex-col gap-2">
        <Field label="Title">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full rounded border border-app-border bg-app-surface-2 px-2 py-1"
          />
        </Field>
        <Field label="Summary">
          <textarea
            rows={3}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            className="w-full resize-y rounded border border-app-border bg-app-surface-2 px-2 py-1"
          />
        </Field>
        <Field label="Reusable procedure">
          <textarea
            rows={5}
            value={reusableProcedure}
            onChange={(event) => setReusableProcedure(event.target.value)}
            className="w-full resize-y rounded border border-app-border bg-app-surface-2 px-2 py-1"
          />
        </Field>
        <Field label="Tags (comma-separated)">
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            className="w-full rounded border border-app-border bg-app-surface-2 px-2 py-1 font-mono"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Scope">
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value as MemoryScope)}
              className="w-full rounded border border-app-border bg-app-surface-2 px-2 py-1"
            >
              {(["global", "group", "user", "thread", "run"] as MemoryScope[]).map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </Field>
          <Field label="Scope id">
            <input
              value={scopeId}
              onChange={(event) => setScopeId(event.target.value)}
              placeholder={scope === "global" ? "(unused)" : "id within scope"}
              disabled={scope === "global"}
              className="w-full rounded border border-app-border bg-app-surface-2 px-2 py-1 font-mono disabled:opacity-50"
            />
          </Field>
          <Field label="Status">
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as MemoryStatus)}
              className="w-full rounded border border-app-border bg-app-surface-2 px-2 py-1"
            >
              {(["proposed", "accepted", "rejected", "archived"] as MemoryStatus[]).map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </Field>
          <Field label="Sensitivity">
            <select
              value={sensitivity}
              onChange={(event) => setSensitivity(event.target.value as MemorySensitivity)}
              className="w-full rounded border border-app-border bg-app-surface-2 px-2 py-1"
            >
              {(["normal", "sensitive", "private"] as MemorySensitivity[]).map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={`Confidence: ${confidence.toFixed(2)}`}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={confidence}
            onChange={(event) => setConfidence(Number(event.target.value))}
          />
        </Field>
        <Field label="Evidence (one per line)">
          <textarea
            rows={3}
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
            className="w-full resize-y rounded border border-app-border bg-app-surface-2 px-2 py-1 font-mono"
          />
        </Field>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-app-text-muted">
            updated {formatRelative(memory.updatedAt ?? memory.createdAt)}
          </span>
          <div className="flex gap-2">
            {update.isError ? (
              <span className="text-[11px] text-app-danger">{update.error.message}</span>
            ) : null}
            {update.isSuccess ? (
              <span className="text-[11px] text-app-accent">Saved.</span>
            ) : null}
            <button
              type="submit"
              disabled={update.isPending}
              className="rounded-md bg-app-accent px-3 py-1.5 text-xs font-semibold text-app-bg disabled:opacity-50"
            >
              {update.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </form>
    </article>
  );
}

function ReviewQueuePanel({ reviews }: { reviews: MemoryReviewEntry[] }) {
  const update = useUpdateMemory();
  const validReviews = reviews.filter(
    (entry): entry is MemoryReviewEntry & { memory: NonNullable<MemoryReviewEntry["memory"]> } => Boolean(entry.memory),
  );
  const invalidCount = reviews.length - validReviews.length;
  return (
    <article className="rounded-[var(--radius-card)] border border-app-warning/40 bg-app-warning-soft p-4 text-xs">
      <h3 className="text-sm font-semibold text-app-warning">Review queue</h3>
      <p className="mt-1 text-[11px] text-app-text-muted">
        Proposed memories waiting for an operator decision. Accept to retrieve them at runtime;
        reject to keep them out of agent prompts.
      </p>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {validReviews.map((entry) => (
          <article
            key={entry.memory.id}
            className="rounded-md border border-app-warning/30 bg-app-surface-2 p-3"
          >
            <strong className="text-[12px]">{entry.memory.title}</strong>
            <p className="mt-1 text-[11px] text-app-text-muted">
              {entry.memory.scope}
              {entry.memory.scopeId ? `:${entry.memory.scopeId}` : ""} · confidence{" "}
              {(entry.memory.confidence ?? 0).toFixed(2)}
            </p>
            <p className="mt-1 text-[11px]">{truncate(entry.memory.summary, 200)}</p>
            {entry.warnings.length > 0 ? (
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] text-app-warning">
                {entry.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            ) : null}
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={update.isPending}
                onClick={() => update.mutate({ id: entry.memory.id, update: { status: "accepted" } })}
                className="rounded-md bg-app-accent px-2.5 py-1 text-[11px] font-semibold text-app-bg disabled:opacity-50"
              >
                Accept
              </button>
              <button
                type="button"
                disabled={update.isPending}
                onClick={() => update.mutate({ id: entry.memory.id, update: { status: "rejected" } })}
                className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px]"
              >
                Reject
              </button>
            </div>
          </article>
        ))}
        {invalidCount > 0 ? (
          <article className="rounded-md border border-app-danger/30 bg-app-danger-soft p-3 text-[11px] text-app-danger">
            {invalidCount} review queue entr{invalidCount === 1 ? "y references" : "ies reference"} a memory that is no
            longer available. Refreshing or rejecting the stale proposal from the backend will clear it.
          </article>
        ) : null}
        {validReviews.length === 0 && invalidCount === 0 ? (
          <p className="text-[11px] text-app-text-muted">No proposed memories are waiting.</p>
        ) : null}
      </div>
    </article>
  );
}

function FilterPills<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex items-center gap-1 text-[10px] text-app-text-muted">
      <span className="font-semibold uppercase tracking-wider">{label}</span>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={[
            "rounded-full px-2 py-0.5 transition-colors",
            value === option
              ? "bg-app-accent-soft text-app-accent"
              : "bg-app-surface-2 hover:bg-app-surface-2/70",
          ].join(" ")}
        >
          {option}
        </button>
      ))}
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

function statusTone(status: MemoryStatus): "ok" | "warn" | "danger" | "muted" {
  switch (status) {
    case "accepted":
      return "ok";
    case "proposed":
      return "warn";
    case "rejected":
      return "danger";
    case "archived":
      return "muted";
  }
}

function buildRetrievalEvaluationCases(memories: SkillMemoryEntry[]) {
  return memories
    .filter((memory) => (memory.status ?? "accepted") === "accepted")
    .slice(0, 25)
    .map((memory) => ({
      id: memory.id,
      query: [memory.title, ...(memory.tags ?? []), memory.summary].filter(Boolean).join(" "),
      expectedMemoryIds: [memory.id],
      limit: 5,
      minRecall: 1,
    }));
}
