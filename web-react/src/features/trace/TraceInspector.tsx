import type { TraceNode } from "@/features/trace/buildTraceNodes";
import { modelTierForNode } from "@/features/trace/buildTraceNodes";
import { ArtifactGallery } from "@/components/ArtifactPreview";
import { GenericBadge } from "@/components/StatusBadge";
import { readArtifactRefs } from "@/features/investigations/buildSpanInvestigationDraft";
import { formatDuration, formatRelative, truncate } from "@/lib/format";
import type { ToolReworkWaitRecord } from "@/api/types";
import {
  useAutoRetryReworkWait,
  useCreateRetryRunForWait,
  useResumeReworkWait,
} from "@/api/reworkWaits";
import {
  canCreateRetryRun,
  retryRunLabel,
} from "@/features/tool-builds/reworkWaitPresentation";
import { Link } from "react-router-dom";

type TraceInspectorProps = {
  node: TraceNode | undefined;
  runId?: string;
  reworkWait: ToolReworkWaitRecord | undefined;
  onCreateInvestigation?: (node: TraceNode) => void;
};

export function TraceInspector({ node, runId, reworkWait, onCreateInvestigation }: TraceInspectorProps) {
  const resume = useResumeReworkWait();
  const createRetry = useCreateRetryRunForWait();
  const autoRetry = useAutoRetryReworkWait();

  if (!node) {
    return (
      <aside className="rounded-[var(--radius-card)] border border-dashed border-app-border bg-app-surface p-5 text-sm text-app-text-muted">
        Select a span on the graph or in the timeline to inspect its call frame, evidence, and any linked tool rework wait.
      </aside>
    );
  }

  const callFrame = readCallFrame(node.payload);
  const selfCheck = readSelfCheck(node.payload);
  const memoryHits = readMemoryEntries(node.payload);
  const toolEvidence = readToolEvidence(node.payload);
  const artifacts = runId ? readArtifactRefs(node.payload, runId) : [];
  const tier = modelTierForNode(node);

  return (
    <aside className="flex max-h-[calc(100vh-260px)] flex-col gap-3 overflow-y-auto rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
      <header>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
          Inspector
        </span>
        <h3 className="mt-0.5 text-sm font-semibold leading-snug">{node.title}</h3>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
          <GenericBadge tone={statusTone(node.status)}>{node.status}</GenericBadge>
          <span className="text-app-text-muted">{node.activity}</span>
          <span className="font-mono text-app-text-muted">{node.actor}</span>
          {tier ? <GenericBadge tone="muted">tier {tier}</GenericBadge> : null}
          {typeof node.durationMs === "number" ? (
            <span className="font-mono text-app-text-muted">{formatDuration(node.durationMs)}</span>
          ) : null}
        </div>
        {node.parentTitle ? (
          <p className="mt-1 text-[11px] text-app-text-muted">
            Called by <span className="font-mono">{node.parentTitle}</span>
          </p>
        ) : null}
      </header>

      <Section title="Output / detail">
        <p className="whitespace-pre-wrap break-words text-[11px]">
          {truncate(node.detail ?? "—", 1200)}
        </p>
      </Section>

      {node.dependencySpanIds.length > 0 ? (
        <Section title="Dependency spans">
          <ul className="min-w-0 text-[11px] font-mono text-app-text-muted">
            {node.dependencySpanIds.map((spanId) => (
              <li key={spanId} className="break-all">{spanId}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {callFrame ? (
        <Section title="Agent call frame">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            {callFrame.role ? <Field label="role">{callFrame.role}</Field> : null}
            {callFrame.depth !== undefined ? <Field label="depth">{String(callFrame.depth)}</Field> : null}
            {callFrame.modelTier ? <Field label="tier">{callFrame.modelTier}</Field> : null}
            {callFrame.parentSpanId ? <Field label="caller span">{callFrame.parentSpanId}</Field> : null}
          </dl>
          {callFrame.localTask ? (
            <p className="mt-2 whitespace-pre-wrap break-words text-[11px]">
              <span className="text-app-text-muted">Local task:</span> {truncate(callFrame.localTask, 360)}
            </p>
          ) : null}
          {callFrame.outputContract ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-[11px]">
              <span className="text-app-text-muted">Output contract:</span> {truncate(callFrame.outputContract, 360)}
            </p>
          ) : null}
        </Section>
      ) : null}

      {selfCheck ? (
        <Section title={`Return self-check (${selfCheck.readyToReturn ? "ready" : "blocked"})`}>
          <ul className="space-y-1 text-[11px]">
            {(selfCheck.checks ?? []).slice(0, 8).map((check, index) => (
              <li
                key={index}
                className={[
                  "flex items-baseline gap-1.5",
                  check.ok ? "text-app-text" : "text-app-danger",
                ].join(" ")}
              >
                <span className="font-mono text-[10px] uppercase">{check.ok ? "pass" : "fail"}</span>
                  <span className="min-w-0 break-words">{check.name ?? "check"}</span>
                {check.reason ? (
                  <span className="min-w-0 break-words text-app-text-muted">— {truncate(check.reason, 120)}</span>
                ) : null}
              </li>
            ))}
          </ul>
          {selfCheck.warnings && selfCheck.warnings.length > 0 ? (
            <p className="mt-2 whitespace-pre-wrap break-words text-[11px] text-app-warning">
              {selfCheck.warnings.map((warning) => truncate(warning, 200)).join("\n")}
            </p>
          ) : null}
        </Section>
      ) : null}

      {memoryHits.length > 0 ? (
        <Section title={`Memory hits (${memoryHits.length})`}>
          <ul className="space-y-1.5 text-[11px]">
            {memoryHits.slice(0, 5).map((memory, index) => (
              <li key={index}>
                <p className="font-medium">{memory.title}</p>
                {memory.summary ? (
                  <p className="break-words text-app-text-muted">{truncate(memory.summary, 160)}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {toolEvidence ? (
        <Section title="Tool evidence">
          <pre className="whitespace-pre-wrap break-all text-[11px] text-app-text-muted">{toolEvidence}</pre>
        </Section>
      ) : null}

      {artifacts.length > 0 ? (
        <Section title={`Artifacts (${artifacts.length})`}>
          <ArtifactGallery
            compact
            artifacts={artifacts.map((artifact, index) => ({
              id: artifact.id ?? `${node.spanId}-artifact-${index}`,
              filename: artifact.filename ?? artifact.id ?? `artifact-${index + 1}`,
              url: artifact.url ?? "",
              mimeType: artifact.mimeType,
              kind: "output",
            }))}
          />
        </Section>
      ) : null}

      {reworkWait ? (
        <section className="rounded-md border border-app-warning/40 bg-app-warning-soft p-3 text-[11px]">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-app-warning">
            Tool rework wait
          </p>
          <p className="mt-1 break-all font-mono">{reworkWait.id}</p>
          <p className="mt-1">
            Status: <span className="font-mono">{reworkWait.status}</span>
            {reworkWait.toolName ? (
              <>
                {" · tool "}
                <span className="font-mono">{reworkWait.toolName}</span>
                {reworkWait.toolVersion ? <> v{reworkWait.toolVersion}</> : null}
                {reworkWait.promotedVersion ? <> → v{reworkWait.promotedVersion}</> : null}
              </>
            ) : null}
          </p>
          {reworkWait.reason ? (
            <p className="mt-1 break-words text-app-text-muted">{truncate(reworkWait.reason, 220)}</p>
          ) : null}
          {reworkWait.retryRunId ? (
            <p className="mt-1 text-app-text-muted">
              {retryRunLabel(reworkWait)}:{" "}
              <Link to={`/run/${reworkWait.retryRunId}`} className="font-mono text-app-accent underline">
                {reworkWait.retryRunId}
              </Link>
            </p>
          ) : null}
          {canCreateRetryRun(reworkWait) ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => createRetry.mutate({ id: reworkWait.id })}
                disabled={createRetry.isPending}
                className="rounded-md bg-app-accent px-2.5 py-1 text-[11px] font-semibold text-app-bg disabled:opacity-50"
              >
                {createRetry.isPending ? "Creating…" : "Create retry run"}
              </button>
              <button
                type="button"
                onClick={() => autoRetry.mutate({ id: reworkWait.id })}
                disabled={autoRetry.isPending}
                className="rounded-md border border-app-warning/40 bg-app-surface px-2.5 py-1 text-[11px] text-app-text"
              >
                {autoRetry.isPending ? "Checking…" : "Force auto retry"}
              </button>
            </div>
          ) : null}
          {reworkWait.retryRunId ? (
            <Link
              to={`/run/${reworkWait.retryRunId}`}
              className="mt-2 inline-flex rounded-md border border-app-warning/40 bg-app-surface px-2.5 py-1 text-[11px] text-app-text hover:border-app-accent/40"
            >
              Open retry run
            </Link>
          ) : null}
          {reworkWait.status === "promoted" ? (
            <button
              type="button"
              onClick={() => resume.mutate({ id: reworkWait.id })}
              disabled={resume.isPending}
              className="mt-2 rounded-md bg-app-accent px-2.5 py-1 text-[11px] font-semibold text-app-bg disabled:opacity-50"
            >
              {resume.isPending ? "Closing…" : "Mark ready for retry"}
            </button>
          ) : null}
          {[createRetry.error, autoRetry.error, resume.error]
            .filter((error): error is Error => Boolean(error))
            .map((error, index) => (
              <p key={index} className="mt-1 text-[11px] text-app-danger">
                {error.message}
              </p>
            ))}
        </section>
      ) : null}

      <footer className="mt-2 flex flex-col gap-2 border-t border-app-border pt-3 text-[11px]">
        <button
          type="button"
          className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-xs font-medium text-app-text transition-colors hover:border-app-accent/40 hover:text-app-accent disabled:opacity-50"
          disabled={!onCreateInvestigation}
          onClick={() => onCreateInvestigation?.(node)}
          title={onCreateInvestigation ? "Open the Tool Investigation modal" : "Investigation creation is unavailable for this view"}
        >
          Create tool request / bug
        </button>
        <p className="text-[10px] text-app-text-muted">
          Opens a Tool Investigation Ticket modal so the failure context is preserved before any rebuild.
        </p>
        <p className="text-[10px] text-app-text-muted">
          First seen {formatRelative(node.firstTimestamp)} · last update {formatRelative(node.lastTimestamp)}
        </p>
      </footer>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-md border border-app-border bg-app-surface-2 p-3">
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">{title}</h4>
      <div className="mt-1.5 min-w-0">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-app-text-muted">{label}</dt>
      <dd className="break-words font-mono">{children}</dd>
    </div>
  );
}

type CallFrame = {
  role?: string;
  depth?: number;
  modelTier?: string;
  parentSpanId?: string;
  localTask?: string;
  outputContract?: string;
  outputSummary?: string;
};

type SelfCheck = {
  readyToReturn?: boolean;
  checks?: Array<{ name?: string; ok?: boolean; reason?: string }>;
  warnings?: string[];
  limitations?: string[];
};

function readCallFrame(payload: unknown): CallFrame | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const candidate = (payload as { callFrame?: unknown }).callFrame;
  if (!candidate || typeof candidate !== "object") return undefined;
  return candidate as CallFrame;
}

function readSelfCheck(payload: unknown): SelfCheck | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const candidate = (payload as { selfCheck?: unknown }).selfCheck;
  if (!candidate || typeof candidate !== "object") return undefined;
  const sc = candidate as SelfCheck;
  return {
    readyToReturn: sc.readyToReturn,
    checks: Array.isArray(sc.checks)
      ? sc.checks.map((entry) => ({
          name: typeof entry.name === "string" ? entry.name : undefined,
          ok: typeof entry.ok === "boolean" ? entry.ok : undefined,
          reason: typeof entry.reason === "string" ? entry.reason : undefined,
        }))
      : undefined,
    warnings: Array.isArray(sc.warnings) ? sc.warnings.filter((w): w is string => typeof w === "string") : undefined,
    limitations: Array.isArray(sc.limitations)
      ? sc.limitations.filter((w): w is string => typeof w === "string")
      : undefined,
  };
}

function readMemoryEntries(
  payload: unknown,
): Array<{ title: string; summary?: string }> {
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((entry): entry is { title: string; summary?: string } =>
      Boolean(entry) && typeof entry === "object" && typeof (entry as { title?: unknown }).title === "string",
    )
    .map((entry) => ({
      title: entry.title,
      summary: typeof (entry as { summary?: unknown }).summary === "string"
        ? (entry as { summary: string }).summary
        : undefined,
    }));
}

function readToolEvidence(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const lines: string[] = [];
  const record = payload as Record<string, unknown>;
  if (typeof record.tool === "string") lines.push(`Tool: ${record.tool}`);
  if (typeof record.query === "string") lines.push(`Query: ${record.query}`);
  if (typeof record.ok === "boolean") lines.push(`Result: ${record.ok ? "ok" : "failed"}`);
  if (Array.isArray(record.data)) lines.push(`Data items: ${record.data.length}`);
  if (record.input && typeof record.input === "object") {
    lines.push(`Input: ${truncate(JSON.stringify(record.input), 700)}`);
  }
  if (typeof record.content === "string") lines.push(truncate(record.content, 1200));
  return lines.join("\n");
}

function statusTone(status: string): "ok" | "running" | "danger" | "muted" {
  if (status === "completed") return "ok";
  if (status === "failed") return "danger";
  if (status === "started") return "running";
  return "muted";
}
