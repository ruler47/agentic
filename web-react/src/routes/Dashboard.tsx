import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Gauge, ListChecks, Wrench } from "lucide-react";

import { useHealth } from "@/api/health";
import { selectActiveRuns, selectRecentRuns, useCreateRun, useRuns } from "@/api/runs";
import { useAuditEvents, useGroupProfile } from "@/api/queries";
import { useToolCreations, useTools } from "@/api/tools";
import { RunStatusBadge } from "@/components/StatusBadge";
import {
  applyExternalActionRunMode,
  type ExternalActionRunMode,
} from "@/features/runs/externalActionMode";
import { ExternalActionModeSelector } from "@/features/runs/ExternalActionModeSelector";
import { formatDuration, formatRelative, runDurationMs, truncate } from "@/lib/format";
import { useState } from "react";
import type { AgentRunRecord, ToolModuleMetadata } from "@/api/types";
import type { ToolCreationRecord } from "@/api/tools";

export function DashboardPage() {
  const health = useHealth();
  const groupProfile = useGroupProfile();
  const runs = useRuns();
  const audit = useAuditEvents(20);
  const tools = useTools();
  const toolCreations = useToolCreations();

  const active = selectActiveRuns(runs.data);
  const recent = selectRecentRuns(runs.data, 6);
  const readiness = buildReadinessSnapshot({
    runs: runs.data ?? [],
    tools: tools.data ?? [],
    creations: toolCreations.data ?? [],
  });

  return (
    <div className="flex flex-col gap-5">
      <ComposerCard />

      <div className="grid gap-4 md:grid-cols-3">
        <StatTile
          label="Active runs"
          value={active.length}
          helper={runs.isLoading ? "Loading…" : `${runs.data?.length ?? 0} total`}
        />
        <StatTile
          label="Completed runs"
          value={(runs.data ?? []).filter((run) => run.status === "completed").length}
          helper="base runtime"
        />
        <StatTile
          label="Failed runs"
          value={(runs.data ?? []).filter((run) => run.status === "failed").length}
          helper="needs review"
          tone={(runs.data ?? []).some((run) => run.status === "failed") ? "warn" : "muted"}
        />
      </div>

      <SystemReadinessPanel
        snapshot={readiness}
        loading={runs.isLoading || tools.isLoading || toolCreations.isLoading}
        error={runs.isError || tools.isError || toolCreations.isError}
      />

      <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
        <header className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Recent runs</h2>
            <p className="text-xs text-app-text-muted">
              {groupProfile.data?.name ?? "Local Group Profile"} · live polling every 5s
            </p>
          </div>
          <Link className="text-xs text-app-accent hover:underline" to="/runs">
            All runs →
          </Link>
        </header>
        {runs.isLoading ? (
          <p className="text-sm text-app-text-muted">Loading runs…</p>
        ) : runs.isError ? (
          <p className="text-sm text-app-danger">{runs.error?.message ?? "Failed to load runs"}</p>
        ) : recent.length === 0 ? (
          <p className="text-sm text-app-text-muted">No runs yet. Submit a task above.</p>
        ) : (
          <ul className="divide-y divide-app-border">
            {recent.map((run) => (
              <li key={run.id} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 py-2.5">
                <span className="flex min-w-0 items-center gap-2">
                  {isToolLifecycleRun(run) ? <ToolLifecycleIcon /> : null}
                  <Link to={`/run/${run.id}`} className="min-w-0 truncate text-sm hover:underline">
                    {run.task}
                  </Link>
                </span>
                <RunStatusBadge status={run.status} />
                <span className="font-mono text-[11px] text-app-text-muted">
                  {formatDuration(runDurationMs(run))}
                </span>
                <span className="text-[11px] text-app-text-muted">{formatRelative(run.updatedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
          <header className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">Backend health</h2>
            <span
              className={[
                "rounded-full px-2.5 py-0.5 text-[11px] font-medium",
                health.isError
                  ? "bg-app-danger-soft text-app-danger"
                  : health.data?.ok
                    ? "bg-app-accent-soft text-app-accent"
                    : "bg-app-surface-2 text-app-text-muted",
              ].join(" ")}
            >
              {health.isError ? "down" : health.data?.ok ? "ok" : "checking"}
            </span>
          </header>
          <dl className="grid grid-cols-2 gap-3 text-xs">
            <Definition label="GET /api/health">
              {health.isError ? health.error?.message ?? "error" : JSON.stringify(health.data ?? {})}
            </Definition>
            <Definition label="Last success">
              {health.dataUpdatedAt ? new Date(health.dataUpdatedAt).toLocaleTimeString() : "—"}
            </Definition>
            <Definition label="Refetch">10s</Definition>
            <Definition label="API route">Vite /api proxy</Definition>
          </dl>
        </article>

        <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
          <header className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">Recent audit events</h2>
            <Link className="text-xs text-app-accent hover:underline" to="/audit-log">
              Open audit log →
            </Link>
          </header>
          {audit.isLoading ? (
            <p className="text-sm text-app-text-muted">Loading…</p>
          ) : audit.data && audit.data.length > 0 ? (
            <ul className="space-y-1.5 text-xs">
              {audit.data.slice(0, 8).map((event) => (
                <li key={event.id} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate">
                    <code className="text-app-text-muted">{event.action}</code>
                    <span className="ml-2">{truncate(event.summary, 80)}</span>
                  </span>
                  <span className="shrink-0 text-app-text-muted">{formatRelative(event.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-app-text-muted">No audit events yet.</p>
          )}
        </article>
      </section>
    </div>
  );
}

type ReadinessStatus = "green" | "yellow" | "red";

type ReadinessStep = {
  title: string;
  status: ReadinessStatus;
  state: string;
  evidence: string;
  next: string;
};

type ReadinessSnapshot = {
  phase: string;
  phaseState: string;
  activeGeneratedTools: number;
  generatedTools: number;
  candidateVersions: number;
  failedCreations: number;
  latestExamRun?: AgentRunRecord;
  latestToolCreation?: ToolCreationRecord;
  steps: ReadinessStep[];
};

function SystemReadinessPanel({
  snapshot,
  loading,
  error,
}: {
  snapshot: ReadinessSnapshot;
  loading: boolean;
  error: boolean;
}) {
  return (
    <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Gauge size={18} className="text-app-accent" aria-hidden="true" />
            <h2 className="text-base font-semibold">System readiness</h2>
          </div>
          <p className="mt-1 text-xs text-app-text-muted">
            Roadmap position, live evidence, and the next engineering constraint.
          </p>
        </div>
        <Link className="text-xs text-app-accent hover:underline" to="/tools">
          Open Tools →
        </Link>
      </header>

      {error ? (
        <p className="text-sm text-app-danger">Failed to load readiness inputs.</p>
      ) : loading ? (
        <p className="text-sm text-app-text-muted">Loading readiness…</p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <ReadinessMetric
              icon={<ListChecks size={16} aria-hidden="true" />}
              label="Current phase"
              value={snapshot.phase}
              helper={snapshot.phaseState}
              status="green"
            />
            <ReadinessMetric
              icon={<Wrench size={16} aria-hidden="true" />}
              label="Generated tools"
              value={`${snapshot.activeGeneratedTools}/${snapshot.generatedTools}`}
              helper="active available / registered"
              status={snapshot.activeGeneratedTools > 0 ? "green" : "yellow"}
            />
            <ReadinessMetric
              icon={<CheckCircle2 size={16} aria-hidden="true" />}
              label="Latest exam"
              value={snapshot.latestExamRun ? "passed" : "missing"}
              helper={snapshot.latestExamRun ? truncate(snapshot.latestExamRun.id, 32) : "no completed proof run"}
              status={snapshot.latestExamRun ? "green" : "yellow"}
              to={snapshot.latestExamRun ? `/run/${snapshot.latestExamRun.id}` : undefined}
            />
            <ReadinessMetric
              icon={<AlertTriangle size={16} aria-hidden="true" />}
              label="Review queue"
              value={snapshot.failedCreations + snapshot.candidateVersions}
              helper={`${snapshot.failedCreations} failed builds · ${snapshot.candidateVersions} candidates`}
              status={snapshot.failedCreations > 0 || snapshot.candidateVersions > 0 ? "yellow" : "green"}
            />
          </div>

          <div className="overflow-hidden rounded-md border border-app-border">
            <div className="grid grid-cols-[9rem_1fr_1fr] border-b border-app-border bg-app-surface-2 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
              <span>Roadmap</span>
              <span>Evidence</span>
              <span>Next</span>
            </div>
            <ul className="divide-y divide-app-border">
              {snapshot.steps.map((step) => (
                <li key={step.title} className="grid grid-cols-[9rem_1fr_1fr] gap-3 px-3 py-3 text-xs">
                  <div className="min-w-0">
                    <ReadinessPill status={step.status}>{step.state}</ReadinessPill>
                    <div className="mt-1 font-medium">{step.title}</div>
                  </div>
                  <p className="min-w-0 text-app-text-muted">{step.evidence}</p>
                  <p className="min-w-0 text-app-text-muted">{step.next}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

function ReadinessMetric({
  icon,
  label,
  value,
  helper,
  status,
  to,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  helper: string;
  status: ReadinessStatus;
  to?: string;
}) {
  const body = (
    <div className="rounded-md border border-app-border bg-app-surface-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
          <span className={statusClass(status)}>{icon}</span>
          {label}
        </span>
        <ReadinessDot status={status} />
      </div>
      <div className="mt-2 text-xl font-semibold tabular-nums">{value}</div>
      <p className="mt-0.5 text-xs text-app-text-muted">{helper}</p>
    </div>
  );
  return to ? <Link to={to} className="block hover:border-app-accent/50">{body}</Link> : body;
}

function ReadinessPill({ status, children }: { status: ReadinessStatus; children: React.ReactNode }) {
  return (
    <span className={["inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider", pillClass(status)].join(" ")}>
      {children}
    </span>
  );
}

function ReadinessDot({ status }: { status: ReadinessStatus }) {
  return <span className={["size-2 rounded-full", dotClass(status)].join(" ")} />;
}

function buildReadinessSnapshot(input: {
  runs: AgentRunRecord[];
  tools: ToolModuleMetadata[];
  creations: ToolCreationRecord[];
}): ReadinessSnapshot {
  const generatedTools = input.tools.filter((tool) => tool.source === "generated");
  const activeGeneratedTools = generatedTools.filter((tool) =>
    tool.status === "available" && (tool.runtimeReadiness?.ok ?? true)
  );
  const failedCreations = input.creations.filter((creation) =>
    creation.status === "failed" || creation.status === "qa_failed"
  );
  const candidateVersions = input.tools.flatMap((tool) =>
    (tool.versions ?? []).filter((version) =>
      !version.active && version.reviewStatus === "candidate" && version.status !== "failed"
    )
  );
  const latestExamRun = selectRecentRuns(input.runs, 50).find(hasStructuredProofArtifact)
    ?? selectRecentRuns(input.runs, 50).find((run) =>
      run.status === "completed" && (run.result?.artifacts ?? []).some((artifact) => artifact.quality?.status === "passed")
    );
  const latestToolCreation = [...input.creations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const hasApiTool = generatedTools.some((tool) =>
    tool.name === "weather.open-meteo" && tool.status === "available"
  );
  const hasWebRead = generatedTools.some((tool) =>
    tool.name === "web.read" && tool.status === "available"
  );

  return {
    phase: "Phase 4/5",
    phaseState: "Tool lifecycle + API proof is usable; next is resilience and docs crawling.",
    activeGeneratedTools: activeGeneratedTools.length,
    generatedTools: generatedTools.length,
    failedCreations: failedCreations.length,
    candidateVersions: candidateVersions.length,
    latestExamRun,
    latestToolCreation,
    steps: [
      {
        title: "Base agent runtime",
        status: "green",
        state: "ready",
        evidence: "Runs execute through BaseAgent with trace, tool calls, return gate, and artifacts.",
        next: "Keep simple tasks single-agent while adding delegation only for broad tasks.",
      },
      {
        title: "Tool lifecycle",
        status: activeGeneratedTools.length > 0 ? "green" : "yellow",
        state: activeGeneratedTools.length > 0 ? "active" : "partial",
        evidence: `${activeGeneratedTools.length} generated tool(s) are active and available.`,
        next: candidateVersions.length > 0 ? "Review remaining inactive candidates." : "Continue versioned edits through the same flow.",
      },
      {
        title: "API tool proof",
        status: hasApiTool && latestExamRun ? "green" : "yellow",
        state: hasApiTool && latestExamRun ? "passed" : "partial",
        evidence: latestExamRun
          ? `Latest proof run: ${latestExamRun.id}.`
          : "No completed structured-proof run found yet.",
        next: "Make live behavior QA retryable and separate contract QA from flaky network checks.",
      },
      {
        title: "Research depth",
        status: hasWebRead ? "yellow" : "red",
        state: hasWebRead ? "partial" : "missing",
        evidence: hasWebRead
          ? "web.read is available, but broad-task delegation is not the default execution path yet."
          : "No enabled page-reading capability found.",
        next: "Use web.search → web.read systematically, then add child-agent delegation.",
      },
      {
        title: "Docs crawling",
        status: "yellow",
        state: "next",
        evidence: latestToolCreation
          ? `Last tool build: ${latestToolCreation.toolName}@${latestToolCreation.toolVersion} ${latestToolCreation.status}.`
          : "No tool creation records loaded.",
        next: "Accept docs URLs, discover OpenAPI/cURL/examples, then generate QA fixtures automatically.",
      },
      {
        title: "External actions",
        status: "red",
        state: "planned",
        evidence: "Real-world commits such as bookings, messages, form submits, and write APIs still need an approval-gated lifecycle.",
        next: "Add action contracts, prepare/commit, waiting_for_approval, policy checks, and confirmation proof.",
      },
    ],
  };
}

function hasStructuredProofArtifact(run: AgentRunRecord): boolean {
  return run.status === "completed" && (run.result?.artifacts ?? []).some((artifact) =>
    artifact.filename.includes("structured-proof")
    || artifact.quality?.checks.some((check) => check.name === "structured-data-tool-result")
  );
}

function statusClass(status: ReadinessStatus): string {
  if (status === "green") return "text-app-accent";
  if (status === "yellow") return "text-app-warning";
  return "text-app-danger";
}

function pillClass(status: ReadinessStatus): string {
  if (status === "green") return "bg-app-accent-soft text-app-accent";
  if (status === "yellow") return "bg-app-warning-soft text-app-warning";
  return "bg-app-danger-soft text-app-danger";
}

function dotClass(status: ReadinessStatus): string {
  if (status === "green") return "bg-app-accent";
  if (status === "yellow") return "bg-app-warning";
  return "bg-app-danger";
}

function StatTile({
  label,
  value,
  helper,
  tone = "muted",
}: {
  label: string;
  value: number;
  helper?: string;
  tone?: "muted" | "warn";
}) {
  return (
    <article
      className={[
        "rounded-[var(--radius-card)] border p-4",
        tone === "warn"
          ? "border-app-warning/40 bg-app-warning-soft"
          : "border-app-border bg-app-surface",
      ].join(" ")}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wider text-app-text-muted">
        {label}
      </span>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {helper ? <p className="text-xs text-app-text-muted">{helper}</p> : null}
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

function ToolLifecycleIcon() {
  return (
    <span
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-app-warning-soft text-app-warning"
      title="Tool creation or tool update run"
    >
      <Wrench size={12} strokeWidth={2.2} aria-hidden="true" />
    </span>
  );
}

function isToolLifecycleRun(run: AgentRunRecord): boolean {
  return run.channel === "tool-builder" || (run.events ?? []).some((event) =>
    typeof event.type === "string" && event.type.startsWith("tool-creation")
  );
}

function ComposerCard() {
  const [task, setTask] = useState("");
  const [externalActionMode, setExternalActionMode] =
    useState<ExternalActionRunMode>("approval");
  const createRun = useCreateRun();

  return (
    <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
      <header className="mb-3 flex items-baseline justify-between">
        <div>
          <h2 className="text-base font-semibold">Submit a task</h2>
          <p className="text-xs text-app-text-muted">
            One concrete task per run. Continuations live inside Run Workspace and Conversations.
          </p>
        </div>
        <span className="text-[11px] text-app-text-muted">POST /api/runs</span>
      </header>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!task.trim() || createRun.isPending) return;
          createRun.mutate(
            {
              task: applyExternalActionRunMode(task, externalActionMode),
              externalActionMode,
            },
            {
              onSuccess: () => {
                setTask("");
              },
            },
          );
        }}
      >
        <textarea
          className="min-h-[88px] resize-y rounded-md border border-app-border bg-app-surface-2 px-3 py-2 text-sm outline-none focus:border-app-accent/60"
          placeholder="e.g. Top 5 cities in Spain by population, sorted by distance to the sea"
          value={task}
          onChange={(event) => setTask(event.target.value)}
          disabled={createRun.isPending}
        />
        <ExternalActionModeSelector value={externalActionMode} onChange={setExternalActionMode} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-app-text-muted">
            Channel: <code>web</code> · Requester: <code>user-admin</code>
          </p>
          <button
            type="submit"
            disabled={createRun.isPending || !task.trim()}
            className="rounded-md bg-app-accent px-4 py-1.5 text-sm font-semibold text-app-bg transition-colors disabled:cursor-not-allowed disabled:opacity-50 hover:bg-app-accent/90"
          >
            {createRun.isPending ? "Creating…" : "Submit task"}
          </button>
        </div>
        {createRun.isError ? (
          <p className="text-xs text-app-danger">{createRun.error.message}</p>
        ) : null}
        {createRun.isSuccess ? (
          <p className="text-xs text-app-accent">
            Created run <code>{createRun.data.run.id}</code>{" "}
            <Link className="underline" to={`/run/${createRun.data.run.id}`}>
              open
            </Link>
          </p>
        ) : null}
      </form>
    </section>
  );
}
