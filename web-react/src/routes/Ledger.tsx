import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import {
  useClaimWork,
  useEvidenceLedger,
  useRunRetrospectives,
  useUpdateRetrospective,
  useUpdateWorkItem,
  useWorkLedger,
  type ClaimWorkInput,
  type LedgerScope,
} from "@/api/ledger";
import { useRuns } from "@/api/runs";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";
import type {
  EvidenceRecord,
  RunRetrospectiveRecord,
  WorkLedgerItem,
  WorkLedgerStatus,
} from "@/api/types";
import {
  filterLedgerItems,
  summarizeLedgerHealth,
  workStatusTone,
} from "@/features/ledger/ledgerPresentation";

const WORK_STATUSES: WorkLedgerStatus[] = ["planned", "claimed", "running", "completed", "failed", "stale", "cancelled"];
const CLAIM_KINDS: ClaimWorkInput["kind"][] = ["search", "url_visit", "api_call", "browser_screenshot", "artifact_generation", "file_read", "file_write", "tool_call", "other"];

export function LedgerPage() {
  const [params, setParams] = useSearchParams();
  const runs = useRuns();
  const latestRunId = runs.data?.[0]?.id;
  const [search, setSearch] = useState("");
  const [scopeMode, setScopeMode] = useState<"run" | "thread" | "workKey">(
    params.get("threadId") ? "thread" : params.get("workKey") ? "workKey" : "run",
  );
  const scope: LedgerScope = useMemo(() => {
    const runId = params.get("runId") || latestRunId || "";
    const threadId = params.get("threadId") || "";
    const workKey = params.get("workKey") || "";
    if (scopeMode === "thread") return { threadId };
    if (scopeMode === "workKey") return { workKey };
    return { runId };
  }, [latestRunId, params, scopeMode]);

  const work = useWorkLedger(scope);
  const evidence = useEvidenceLedger(scope);
  const retrospectives = useRunRetrospectives(scope);
  const filtered = useMemo(
    () => filterLedgerItems({
      workItems: work.data ?? [],
      evidence: evidence.data ?? [],
      retrospectives: retrospectives.data ?? [],
      search,
    }),
    [evidence.data, retrospectives.data, search, work.data],
  );
  const health = useMemo(
    () => summarizeLedgerHealth({
      workItems: work.data ?? [],
      evidence: evidence.data ?? [],
      retrospectives: retrospectives.data ?? [],
    }),
    [evidence.data, retrospectives.data, work.data],
  );
  const selectedRun = runs.data?.find((run) => run.id === scope.runId);

  function updateScope(nextMode: "run" | "thread" | "workKey", value: string) {
    setScopeMode(nextMode);
    const next = new URLSearchParams();
    if (value.trim()) next.set(nextMode === "run" ? "runId" : nextMode === "thread" ? "threadId" : "workKey", value.trim());
    setParams(next, { replace: true });
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-app-accent">Analysis</p>
            <h2 className="text-lg font-semibold">Work / Evidence Ledger</h2>
            <p className="mt-1 max-w-3xl text-xs text-app-text-muted">
              Machine-readable task state for recursive agents: what was claimed, what evidence exists, what can be reused, and which retrospectives need review.
            </p>
          </div>
          <div className="grid gap-2 text-xs md:grid-cols-4">
            <Metric label="Health" value={health.headline} />
            <Metric label="Reusable" value={String(health.reusable)} />
            <Metric label="Weak evidence" value={String(health.weakEvidence)} tone={health.weakEvidence ? "danger" : "muted"} />
            <Metric label="Review queue" value={String(health.proposedRetrospectives)} tone={health.proposedRetrospectives ? "warn" : "muted"} />
          </div>
        </div>

        <div className="mt-4 grid gap-2 lg:grid-cols-[auto_minmax(220px,420px)_minmax(220px,1fr)] lg:items-center">
          <div className="flex flex-wrap gap-1 rounded-md border border-app-border bg-app-surface-2 p-1 text-xs">
            {(["run", "thread", "workKey"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => updateScope(mode, scopeValueForMode(scope, mode))}
                className={[
                  "rounded px-2.5 py-1 capitalize",
                  scopeMode === mode ? "bg-app-accent text-app-bg" : "text-app-text-muted hover:bg-app-surface",
                ].join(" ")}
              >
                {mode === "workKey" ? "Work key" : mode}
              </button>
            ))}
          </div>
          {scopeMode === "run" ? (
            <select
              value={scope.runId ?? ""}
              onChange={(event) => updateScope("run", event.target.value)}
              className="rounded-md border border-app-border bg-app-surface-2 px-3 py-2 text-sm outline-none focus:border-app-accent/60"
            >
              {(runs.data ?? []).map((run) => (
                <option key={run.id} value={run.id}>{truncate(run.task, 80)} · {run.id}</option>
              ))}
            </select>
          ) : (
            <input
              value={scopeMode === "thread" ? scope.threadId ?? "" : scope.workKey ?? ""}
              onChange={(event) => updateScope(scopeMode, event.target.value)}
              placeholder={scopeMode === "thread" ? "thread id" : "work key"}
              className="rounded-md border border-app-border bg-app-surface-2 px-3 py-2 text-sm outline-none focus:border-app-accent/60"
            />
          )}
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search work, evidence, retrospective text…"
            className="rounded-md border border-app-border bg-app-surface-2 px-3 py-2 text-sm outline-none focus:border-app-accent/60"
          />
        </div>
        {selectedRun ? (
          <p className="mt-2 text-[11px] text-app-text-muted">
            Selected run: <Link to={`/run/${selectedRun.id}`} className="text-app-accent underline">{truncate(selectedRun.task, 120)}</Link>
            {selectedRun.threadId ? <> · <Link to={`/conversation/${selectedRun.threadId}`} className="underline">conversation</Link></> : null}
            <> · <Link to={`/trace/${selectedRun.id}`} className="underline">trace</Link></>
          </p>
        ) : null}
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <WorkLedgerPanel scope={scope} items={filtered.workItems} loading={work.isLoading} error={work.error} />
          <EvidencePanel records={filtered.evidence} loading={evidence.isLoading} error={evidence.error} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <ClaimPanel scope={scope} />
          <RetrospectivePanel scope={scope} records={filtered.retrospectives} loading={retrospectives.isLoading} error={retrospectives.error} />
        </div>
      </div>
    </section>
  );
}

function WorkLedgerPanel({ scope, items, loading, error }: { scope: LedgerScope; items: WorkLedgerItem[]; loading: boolean; error: Error | null }) {
  const update = useUpdateWorkItem(scope);
  return (
    <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface">
      <PanelHeader title="Work claims" subtitle={`${items.length} visible claim${items.length === 1 ? "" : "s"}`} />
      {loading ? <EmptyLine>Loading work ledger…</EmptyLine> : error ? <ErrorLine error={error} /> : items.length === 0 ? <EmptyLine>No work claims for this scope.</EmptyLine> : (
        <ul className="divide-y divide-app-border">
          {items.map((item) => (
            <li key={item.id} className="p-4 text-xs">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <GenericBadge tone={workStatusTone(item.status)}>{item.status}</GenericBadge>
                    <span className="font-mono text-[10px] uppercase tracking-wider text-app-text-muted">{item.kind}</span>
                    {item.confidence !== undefined ? <span className="text-[11px] text-app-text-muted">confidence {Math.round(item.confidence * 100)}%</span> : null}
                  </div>
                  <h3 className="mt-1 break-words text-sm font-semibold">{item.title}</h3>
                  <p className="mt-1 break-all font-mono text-[10px] text-app-text-muted">{item.workKey}</p>
                </div>
                <span className="text-[10px] text-app-text-muted">{formatRelative(item.updatedAt)}</span>
              </div>
              {item.summary || item.inputSummary || item.outputSummary || item.error ? (
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  <TextBlock label="Input" value={item.inputSummary ?? item.summary} />
                  <TextBlock label={item.error ? "Error" : "Output"} value={item.error ?? item.outputSummary} danger={Boolean(item.error)} />
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-app-text-muted">
                {item.evidenceIds.length ? <span>{item.evidenceIds.length} evidence</span> : null}
                {item.artifactIds.length ? <span>{item.artifactIds.length} artifacts</span> : null}
                {item.sourceUrls.length ? <span>{item.sourceUrls.length} source URLs</span> : null}
                {item.ownerSpanId ? <span>span <code>{truncate(item.ownerSpanId, 28)}</code></span> : null}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {WORK_STATUSES.map((status) => (
                  <button
                    key={status}
                    type="button"
                    disabled={update.isPending || item.status === status}
                    onClick={() => update.mutate({ id: item.id, update: { status } })}
                    className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-[11px] hover:border-app-accent/40 disabled:opacity-40"
                  >
                    {status}
                  </button>
                ))}
                {item.runId ? <Link to={`/run/${item.runId}`} className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-[11px] hover:border-app-accent/40">Run</Link> : null}
                {item.runId ? <Link to={`/trace/${item.runId}`} className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-[11px] hover:border-app-accent/40">Trace</Link> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function EvidencePanel({ records, loading, error }: { records: EvidenceRecord[]; loading: boolean; error: Error | null }) {
  return (
    <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface">
      <PanelHeader title="Evidence" subtitle={`${records.length} visible evidence record${records.length === 1 ? "" : "s"}`} />
      {loading ? <EmptyLine>Loading evidence ledger…</EmptyLine> : error ? <ErrorLine error={error} /> : records.length === 0 ? <EmptyLine>No evidence for this scope.</EmptyLine> : (
        <ul className="divide-y divide-app-border">
          {records.map((record) => (
            <li key={record.id} className="p-4 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <GenericBadge tone={evidenceTone(record.qaStatus)}>{record.qaStatus}</GenericBadge>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-app-text-muted">{record.kind}</span>
                  {record.toolName ? <span className="font-mono text-[10px] text-app-text-muted">{record.toolName}</span> : null}
                </div>
                <span className="text-[10px] text-app-text-muted">{formatRelative(record.createdAt)}</span>
              </div>
              <h3 className="mt-1 break-words text-sm font-semibold">{record.title}</h3>
              {record.summary ? <p className="mt-1 break-words text-app-text-muted">{truncate(record.summary, 260)}</p> : null}
              {record.contentPreview ? <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-md border border-app-border bg-app-surface-2 p-2 font-mono text-[10px] text-app-text-muted">{truncate(record.contentPreview, 1200)}</pre> : null}
              {record.sourceUrl ? <a href={record.sourceUrl} target="_blank" rel="noreferrer" className="mt-2 block break-all text-[11px] text-app-accent underline">{record.sourceUrl}</a> : null}
              {record.limitations.length ? <p className="mt-2 whitespace-pre-wrap break-words text-[11px] text-app-warning">{record.limitations.join("\n")}</p> : null}
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-app-text-muted">
                {record.workItemId ? <span>work <code>{record.workItemId}</code></span> : null}
                {record.artifactId ? <span>artifact <code>{record.artifactId}</code></span> : null}
                {record.runId ? <Link to={`/run/${record.runId}`} className="underline">run</Link> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function RetrospectivePanel({ scope, records, loading, error }: { scope: LedgerScope; records: RunRetrospectiveRecord[]; loading: boolean; error: Error | null }) {
  const update = useUpdateRetrospective(scope);
  return (
    <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface">
      <PanelHeader title="Run retrospectives" subtitle={`${records.length} reflection${records.length === 1 ? "" : "s"}`} />
      {loading ? <EmptyLine>Loading retrospectives…</EmptyLine> : error ? <ErrorLine error={error} /> : records.length === 0 ? <EmptyLine>No retrospectives for this scope.</EmptyLine> : (
        <ul className="divide-y divide-app-border">
          {records.map((record) => (
            <li key={record.id} className="p-4 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <GenericBadge tone={record.status === "proposed" ? "warn" : record.status === "reviewed" ? "ok" : "muted"}>{record.status}</GenericBadge>
                  <GenericBadge tone={record.runOutcome === "completed" ? "ok" : record.runOutcome === "failed" ? "danger" : "warn"}>{record.runOutcome}</GenericBadge>
                </div>
                <span className="text-[10px] text-app-text-muted">{formatRelative(record.updatedAt)}</span>
              </div>
              {record.summary ? <p className="mt-2 break-words text-sm">{record.summary}</p> : null}
              <RetrospectiveList title="Worked" values={record.whatWorked} />
              <RetrospectiveList title="Failed" values={record.whatFailed} tone="danger" />
              <RetrospectiveList title="Likely causes" values={record.suspectedRootCauses} tone="warn" />
              <RetrospectiveList title="Duplicated work" values={record.duplicatedWork} tone="warn" />
              <RetrospectiveList title="Weak tools" values={record.weakTools} tone="warn" />
              <RetrospectiveList title="Missing capabilities" values={record.missingCapabilities} tone="danger" />
              <RetrospectiveList title="Policy proposals" values={record.proposedPolicyChanges} />
              <RetrospectiveList title="Prompt proposals" values={record.proposedPromptChanges} />
              <div className="mt-3 flex flex-wrap gap-2">
                {record.status !== "reviewed" ? (
                  <button type="button" disabled={update.isPending} onClick={() => update.mutate({ id: record.id, update: { status: "reviewed" } })} className="rounded-md bg-app-accent px-2.5 py-1 text-[11px] font-semibold text-app-bg disabled:opacity-50">Mark reviewed</button>
                ) : null}
                {record.status !== "archived" ? (
                  <button type="button" disabled={update.isPending} onClick={() => update.mutate({ id: record.id, update: { status: "archived" } })} className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-[11px] hover:border-app-accent/40 disabled:opacity-50">Archive</button>
                ) : null}
                <Link to={`/run/${record.runId}`} className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-[11px] hover:border-app-accent/40">Run</Link>
                <Link to={`/trace/${record.runId}`} className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-[11px] hover:border-app-accent/40">Trace</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function ClaimPanel({ scope }: { scope: LedgerScope }) {
  const claim = useClaimWork(scope);
  const [kind, setKind] = useState<ClaimWorkInput["kind"]>("search");
  const [title, setTitle] = useState("");
  const [workKey, setWorkKey] = useState("");
  const [ownerSpanId, setOwnerSpanId] = useState("manual-operator");
  const [reason, setReason] = useState("Operator-created ledger claim from the Ledger UX.");
  const runId = scope.runId ?? "";
  return (
    <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
      <h3 className="text-sm font-semibold">Create / test a claim</h3>
      <p className="mt-1 text-xs text-app-text-muted">Use this to reserve or revalidate work without leaving the analysis surface. Agents use the same endpoint.</p>
      <div className="mt-3 grid gap-2 text-xs">
        <label className="grid gap-1">
          <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Kind</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as ClaimWorkInput["kind"])} className="rounded-md border border-app-border bg-app-surface-2 px-3 py-2 outline-none focus:border-app-accent/60">
            {CLAIM_KINDS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Title / task summary</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Search restaurant availability in Madrid" className="rounded-md border border-app-border bg-app-surface-2 px-3 py-2 outline-none focus:border-app-accent/60" />
        </label>
        <label className="grid gap-1">
          <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Work key</span>
          <input value={workKey} onChange={(event) => setWorkKey(event.target.value)} placeholder="search:restaurant availability madrid" className="rounded-md border border-app-border bg-app-surface-2 px-3 py-2 font-mono outline-none focus:border-app-accent/60" />
        </label>
        <label className="grid gap-1">
          <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Owner span</span>
          <input value={ownerSpanId} onChange={(event) => setOwnerSpanId(event.target.value)} className="rounded-md border border-app-border bg-app-surface-2 px-3 py-2 font-mono outline-none focus:border-app-accent/60" />
        </label>
        <label className="grid gap-1">
          <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Reason</span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} className="resize-y rounded-md border border-app-border bg-app-surface-2 px-3 py-2 outline-none focus:border-app-accent/60" />
        </label>
        <button
          type="button"
          disabled={claim.isPending || !runId || !title.trim() || !workKey.trim() || !ownerSpanId.trim()}
          onClick={() => claim.mutate({
            runId,
            threadId: scope.threadId,
            ownerSpanId,
            kind,
            workKey,
            taskSummary: title,
            title,
            requestedBy: "user-admin",
            reason,
          })}
          className="rounded-md bg-app-accent px-3 py-2 font-semibold text-app-bg disabled:opacity-50"
        >
          {claim.isPending ? "Claiming…" : "Claim work"}
        </button>
        {!runId ? <p className="text-[11px] text-app-warning">Select a run scope to create manual claims.</p> : null}
        {claim.data ? (
          <p className="rounded-md border border-app-accent/30 bg-app-accent-soft p-2 text-[11px] text-app-accent">{claim.data.decision.status}: {claim.data.decision.reason}</p>
        ) : null}
        {claim.isError ? <p className="text-[11px] text-app-danger">{claim.error.message}</p> : null}
      </div>
    </article>
  );
}

function PanelHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="flex items-baseline justify-between gap-3 border-b border-app-border px-4 py-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <span className="text-[11px] text-app-text-muted">{subtitle}</span>
    </header>
  );
}

function Metric({ label, value, tone = "muted" }: { label: string; value: string; tone?: "danger" | "warn" | "muted" }) {
  const color = tone === "danger" ? "text-app-danger" : tone === "warn" ? "text-app-warning" : "text-app-text";
  return (
    <div className="min-w-0 rounded-md border border-app-border bg-app-surface-2 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-app-text-muted">{label}</p>
      <p className={["mt-0.5 truncate text-sm font-semibold", color].join(" ")}>{value}</p>
    </div>
  );
}

function TextBlock({ label, value, danger = false }: { label: string; value?: string; danger?: boolean }) {
  if (!value) return null;
  return (
    <div className="rounded-md border border-app-border bg-app-surface-2 p-2">
      <p className="text-[10px] uppercase tracking-wider text-app-text-muted">{label}</p>
      <p className={["mt-1 whitespace-pre-wrap break-words text-[11px]", danger ? "text-app-danger" : "text-app-text-muted"].join(" ")}>{truncate(value, 700)}</p>
    </div>
  );
}

function RetrospectiveList({ title, values, tone }: { title: string; values: string[]; tone?: "danger" | "warn" }) {
  if (values.length === 0) return null;
  const color = tone === "danger" ? "text-app-danger" : tone === "warn" ? "text-app-warning" : "text-app-text-muted";
  return (
    <div className="mt-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">{title}</p>
      <ul className={["mt-1 list-disc space-y-0.5 pl-4", color].join(" ")}>
        {values.slice(0, 6).map((value, index) => <li key={index} className="break-words">{truncate(value, 220)}</li>)}
      </ul>
    </div>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-sm text-app-text-muted">{children}</p>;
}

function ErrorLine({ error }: { error: Error }) {
  return <p className="px-4 py-8 text-sm text-app-danger">{error.message}</p>;
}

function evidenceTone(status: string): "ok" | "warn" | "danger" | "muted" {
  if (status === "passed") return "ok";
  if (status === "failed" || status === "blocked") return "danger";
  if (status === "partial") return "warn";
  return "muted";
}

function scopeValueForMode(scope: LedgerScope, mode: "run" | "thread" | "workKey"): string {
  if (mode === "thread") return scope.threadId ?? "";
  if (mode === "workKey") return scope.workKey ?? "";
  return scope.runId ?? "";
}
