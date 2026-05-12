import { useEffect, useState } from "react";

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
  // Tool evidence is only meaningful for actual tool runs. For LLM /
  // coordination events the same `content` field carries the model's
  // reply and would mis-render here — we surface it through
  // CouncilEventDetails below instead.
  const toolEvidence = node.activity === "tool" ? readToolEvidence(node.payload) : "";
  const artifacts = runId ? readArtifactRefs(node.payload, runId) : [];
  const tier = modelTierForNode(node);
  const hasNodeDetail = Boolean(node.detail && node.detail.trim());

  return (
    <aside className="flex max-h-[calc(100vh-260px)] flex-col gap-3 overflow-y-auto rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
      <header>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
          Inspector
        </span>
        <h3 className="mt-0.5 text-sm font-semibold leading-snug">{node.title}</h3>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
          <GenericBadge tone={statusTone(node.status)}>
            {node.status === "started" ? "in progress" : node.status}
          </GenericBadge>
          <span className="text-app-text-muted">{node.activity}</span>
          <span className="font-mono text-app-text-muted">{node.actor}</span>
          {tier ? <GenericBadge tone="muted">tier {tier}</GenericBadge> : null}
          <LiveDuration node={node} />
          {typeof node.durationMs === "number" && node.status !== "started" ? (
            <span className="font-mono text-app-text-muted">{formatDuration(node.durationMs)}</span>
          ) : null}
        </div>
        {node.parentTitle ? (
          <p className="mt-1 text-[11px] text-app-text-muted">
            Called by <span className="font-mono">{node.parentTitle}</span>
          </p>
        ) : null}
      </header>

      <CouncilEventDetails node={node} />

      {hasNodeDetail ? (
        <Section title="Status detail">
          <p className="whitespace-pre-wrap break-words text-[11px]">
            {truncate(node.detail ?? "", 1200)}
          </p>
        </Section>
      ) : null}

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
          <pre className="whitespace-pre-wrap break-words text-[11px] text-app-text-muted">{toolEvidence}</pre>
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

/**
 * Renders a live ticking duration for spans still in `started` status.
 * Once the span transitions to completed/failed the parent header shows
 * the final durationMs (computed on the backend); this component only
 * fires while the work is in-flight.
 */
function LiveDuration({ node }: { node: TraceNode }) {
  const isRunning = node.status === "started";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [isRunning]);
  if (!isRunning) return null;
  const startedMs = new Date(node.startedAt).getTime();
  if (!Number.isFinite(startedMs)) return null;
  const elapsed = Math.max(0, now - startedMs);
  return (
    <span className="font-mono text-app-info">{formatDuration(elapsed)} (running)</span>
  );
}

// ── Council event details ─────────────────────────────────────────────
// Every council event (brainstorm, vote, draft, review, revise, qa,
// repair) carries rich payload data — the prompt that was sent, the raw
// model response, the files emitted, the verdict, etc. Render each
// available block in a collapsible <details> block so the inspector
// stays scannable but the operator can drill into "why did this fail?".

/**
 * Inspector panel for a single trace span. Two rules drive the layout:
 *   1. Always answer "what was sent in?" (Input) and "what came back?"
 *      (Output) first — those are the operator's main questions when a
 *      span fails.
 *   2. Auto-open Input + Output for failed spans so the reason is
 *      visible without an extra click. For completed spans they stay
 *      collapsed to keep the panel scannable.
 */
function CouncilEventDetails({ node }: { node: TraceNode }) {
  const payload = node.payload as Record<string, unknown> | null | undefined;
  if (!payload || typeof payload !== "object") return null;

  const summary = buildPayloadSummary(node, payload);
  if (!summary.hasAny) return null;

  const autoOpen = node.status === "failed";

  return (
    <Section title="Call details">
      {summary.headerLines.length > 0 ? (
        <div className="mb-2 flex flex-col gap-0.5 text-[11px]">
          {summary.headerLines.map((line, idx) => (
            <p key={idx}>
              <span className="text-app-text-muted">{line.label}:</span>{" "}
              <span className="font-mono">{line.value}</span>
              {line.note ? <span className="text-app-text-muted"> ({line.note})</span> : null}
            </p>
          ))}
        </div>
      ) : null}
      {summary.error ? (
        <Collapsible title="Error" tone="danger" defaultOpen>
          <pre className="whitespace-pre-wrap break-words text-[11px] text-app-danger">{summary.error}</pre>
        </Collapsible>
      ) : null}
      {summary.findings.length > 0 ? (
        <Collapsible title={`Findings (${summary.findings.length})`} defaultOpen>
          <ul className="space-y-1 text-[11px] text-app-text-muted">
            {summary.findings.map((finding, index) => (
              <li key={index} className="break-words">• {finding}</li>
            ))}
          </ul>
        </Collapsible>
      ) : null}
      {summary.failures.length > 0 ? (
        <Collapsible title={`Failures (${summary.failures.length})`} tone="danger" defaultOpen>
          <ul className="space-y-1 text-[11px] text-app-danger">
            {summary.failures.map((failure, index) => (
              <li key={index} className="break-words">• {failure}</li>
            ))}
          </ul>
        </Collapsible>
      ) : null}
      {summary.input ? (
        <Collapsible
          title={summary.input.label}
          defaultOpen={autoOpen}
        >
          <pre className="whitespace-pre-wrap break-words text-[11px] text-app-text-muted">
            {summary.input.text}
          </pre>
        </Collapsible>
      ) : null}
      {summary.output ? (
        <Collapsible
          title={summary.output.label}
          defaultOpen={autoOpen || !summary.input}
        >
          <pre className="whitespace-pre-wrap break-words text-[11px] text-app-text-muted">
            {summary.output.text}
          </pre>
        </Collapsible>
      ) : null}
      {summary.files.length > 0 ? (
        <Collapsible title={`Emitted files (${summary.files.length})`}>
          <div className="flex flex-col gap-1.5">
            {summary.files.map((file, index) => (
              <details key={index} className="rounded border border-app-border bg-app-surface px-2 py-1 text-[11px]">
                <summary className="cursor-pointer break-all font-mono text-app-text">{file.path}</summary>
                <pre className="mt-1 whitespace-pre-wrap break-words text-[10px] text-app-text-muted">
                  {file.content}
                </pre>
              </details>
            ))}
          </div>
        </Collapsible>
      ) : null}
      {/* Phase 2: child sub-build links — when a parent council run
          halted waiting for a reader tool, it spawned one or more
          sub-build runs. Render each as a clickable link into Trace
          Lab so the operator can drill into the sub-build's
          progress without copying run ids manually. */}
      {summary.subBuildRunIds.length > 0 ? (
        <Collapsible title={`Spawned reader sub-builds (${summary.subBuildRunIds.length})`} defaultOpen>
          {summary.missingCapabilities.length > 0 ? (
            <ul className="mb-2 space-y-1 text-[11px] text-app-text-muted">
              {summary.missingCapabilities.map((entry, i) => (
                <li key={i}>
                  needs <span className="font-mono text-app-text">{entry.capability}</span>
                  {entry.filename ? <> (for {entry.filename})</> : null}
                </li>
              ))}
            </ul>
          ) : null}
          <ul className="flex flex-col gap-1 text-[11px]">
            {summary.subBuildRunIds.map((id) => (
              <li key={id}>
                <Link
                  to={`/trace/${id}`}
                  className="block break-all rounded border border-app-border bg-app-surface px-2 py-1 font-mono text-app-accent hover:border-app-accent/40"
                >
                  {id}
                </Link>
              </li>
            ))}
          </ul>
        </Collapsible>
      ) : null}
      {summary.successorRunId ? (
        <Collapsible title="Successor run" defaultOpen>
          <p className="text-[11px] text-app-text-muted">
            All reader tools became available — this build was replayed as a fresh council
            run. Click through to see the resumed pipeline.
          </p>
          <Link
            to={`/trace/${summary.successorRunId}`}
            className="mt-2 inline-block break-all rounded border border-app-accent/40 bg-app-accent-soft/40 px-2 py-1 font-mono text-[11px] text-app-accent hover:bg-app-accent-soft"
          >
            {summary.successorRunId}
          </Link>
        </Collapsible>
      ) : null}
    </Section>
  );
}

type PayloadSummary = {
  hasAny: boolean;
  headerLines: { label: string; value: string; note?: string }[];
  input?: { label: string; text: string };
  output?: { label: string; text: string };
  error: string;
  findings: string[];
  failures: string[];
  files: { path: string; content: string }[];
  /** Sub-builds the parent council spawned (Phase 2 auto-spawn). */
  subBuildRunIds: string[];
  /** When the parent build was replayed after waiting on readers, this
   *  is the new run id that picked up the work. */
  successorRunId?: string;
  /** Reader-tool capabilities the parent build was blocked on. */
  missingCapabilities: { capability: string; filename: string; mimeType: string }[];
};

/**
 * Normalises whatever the council emitted into a uniform Input/Output
 * pair plus a few headline fields. The mapping is event-type aware so
 * each kind of span gets a meaningful label:
 *
 *   brainstorm-proposal → Input: "Brainstorm prompt", Output: "Council proposal"
 *   vote-cast           → Input: "Voting prompt",     Output: "Ranking JSON"
 *   winner-selected     → headline only (Borda scores, winner)
 *   code-drafted        → Input: "Implement prompt",  Output: "Drafted code"
 *   code-review-cast    → Input: "Review prompt",     Output: "Verdict + findings"
 *   code-revised        → Input: "Revise prompt",     Output: "Revised code"
 *   qa-attempt          → Input: "QA tool input",     Output: "Tool output + oracle verdict"
 *   code-repaired       → Input: "Repair prompt",     Output: "Repaired code"
 *   tool-build-registered → headline only
 *
 * Falls back gracefully when the new payload fields (`prompt` / `output`)
 * are missing — older events stored only `content`/`raw`/`ranking`.
 */
function buildPayloadSummary(node: TraceNode, payload: Record<string, unknown>): PayloadSummary {
  const summary: PayloadSummary = {
    hasAny: false,
    headerLines: [],
    error: "",
    findings: [],
    failures: [],
    files: [],
    subBuildRunIds: [],
    missingCapabilities: [],
  };

  const promptText = stringField(payload.prompt);
  const outputText = stringField(payload.output);
  const oracleOutputText = stringField(payload.oracleOutput);
  const rawText = stringField(payload.raw);
  const contentText = stringField(payload.content);
  const errorText = stringField(payload.error);
  const verdict = stringField(payload.verdict);
  const tieBrokenBy = stringField(payload.tieBrokenBy);
  const winnerModelId = stringField(payload.winnerModelId);
  const fallbackFrom = stringField(payload.fallbackFrom);
  const ranking = readNumberList(payload.ranking);
  const scores = readNumberList(payload.scores);
  const findings = readStringList(payload.findings);
  const failures = readStringList(payload.failures);
  const files = readFiles(payload.files);
  const proposalContent = stringField(extractProposalContent(payload));
  const qaInput = payload.qaInput;
  const qaToolOutput = payload.output && typeof payload.output === "object" && "ok" in (payload.output as object)
    ? (payload.output as Record<string, unknown>)
    : undefined;
  const attempt = typeof payload.attempt === "number" ? payload.attempt : undefined;
  const skipped = payload.skipped === true;

  summary.error = errorText;
  summary.findings = findings;
  summary.failures = failures;
  summary.files = files;
  summary.subBuildRunIds = readStringList(payload.subBuildRunIds);
  if (typeof payload.successorRunId === "string" && payload.successorRunId.trim()) {
    summary.successorRunId = payload.successorRunId.trim();
  }
  if (Array.isArray(payload.missingCapabilities)) {
    summary.missingCapabilities = (payload.missingCapabilities as unknown[])
      .filter(
        (entry): entry is { capability: string; filename: string; mimeType: string } =>
          Boolean(entry) &&
          typeof entry === "object" &&
          typeof (entry as { capability?: unknown }).capability === "string",
      )
      .map((entry) => ({
        capability: entry.capability,
        filename: typeof entry.filename === "string" ? entry.filename : "",
        mimeType: typeof entry.mimeType === "string" ? entry.mimeType : "",
      }));
  }

  // Headline lines that work for any council event.
  if (verdict) summary.headerLines.push({ label: "Verdict", value: verdict, note: tieBrokenBy || undefined });
  if (winnerModelId) {
    summary.headerLines.push({
      label: "Winner",
      value: winnerModelId,
      note: fallbackFrom ? `fallback from ${fallbackFrom}` : undefined,
    });
  }
  if (ranking.length > 0) summary.headerLines.push({ label: "Ranking", value: `[${ranking.join(", ")}]` });
  if (scores.length > 0) summary.headerLines.push({ label: "Borda scores", value: `[${scores.join(", ")}]` });
  if (attempt !== undefined) {
    summary.headerLines.push({ label: "Attempt", value: String(attempt), note: skipped ? "skipped" : undefined });
  }

  // Event-type-aware Input/Output labels.
  const labels = inputOutputLabelsFor(node);

  // Input: prefer the new prompt field; fall back to qaInput JSON.
  if (promptText) {
    summary.input = { label: labels.inputLabel, text: promptText };
  } else if (qaInput && typeof qaInput === "object") {
    summary.input = { label: labels.inputLabel, text: safeJson(qaInput) };
  }

  // Output: prefer the new output field; for review/qa surface the
  // verdict + findings/failures inline; fall back to content/raw for
  // older events.
  if (qaToolOutput && node.type?.includes("qa")) {
    const oracleNote = oracleOutputText ? `\n\nOracle response:\n${oracleOutputText}` : "";
    summary.output = { label: labels.outputLabel, text: `${safeJson(qaToolOutput)}${oracleNote}` };
  } else if (outputText) {
    summary.output = { label: labels.outputLabel, text: outputText };
  } else if (rawText) {
    summary.output = { label: labels.outputLabel, text: rawText };
  } else if (proposalContent) {
    summary.output = { label: labels.outputLabel, text: proposalContent };
  } else if (contentText) {
    summary.output = { label: labels.outputLabel, text: contentText };
  } else if (ranking.length > 0 && !summary.output) {
    summary.output = { label: labels.outputLabel, text: `Ranking: [${ranking.join(", ")}]` };
  }

  summary.hasAny =
    summary.headerLines.length > 0 ||
    Boolean(summary.input) ||
    Boolean(summary.output) ||
    Boolean(summary.error) ||
    summary.findings.length > 0 ||
    summary.failures.length > 0 ||
    summary.files.length > 0 ||
    summary.subBuildRunIds.length > 0 ||
    Boolean(summary.successorRunId) ||
    summary.missingCapabilities.length > 0;

  return summary;
}

function inputOutputLabelsFor(node: TraceNode): { inputLabel: string; outputLabel: string } {
  const type = node.type ?? "";
  if (type === "tool-build-brainstorm-proposal") {
    return { inputLabel: "Input — brainstorm prompt", outputLabel: "Output — council proposal" };
  }
  if (type === "tool-build-vote-cast") {
    return { inputLabel: "Input — voting prompt", outputLabel: "Output — vote response" };
  }
  if (type === "tool-build-code-drafted") {
    return { inputLabel: "Input — implement prompt", outputLabel: "Output — drafted code" };
  }
  if (type === "tool-build-code-review-cast") {
    return { inputLabel: "Input — review prompt", outputLabel: "Output — review response" };
  }
  if (type === "tool-build-code-revised") {
    return { inputLabel: "Input — revise prompt", outputLabel: "Output — revised code" };
  }
  if (type === "tool-build-qa-attempt") {
    return { inputLabel: "Input — tool call payload", outputLabel: "Output — tool result + oracle" };
  }
  if (type === "tool-build-code-repaired") {
    return { inputLabel: "Input — repair prompt", outputLabel: "Output — repaired code" };
  }
  return { inputLabel: "Input", outputLabel: "Output" };
}

function Collapsible({
  title,
  children,
  defaultOpen,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  tone?: "danger";
}) {
  return (
    <details className="mt-2 rounded border border-app-border bg-app-surface px-2 py-1" open={defaultOpen}>
      <summary
        className={[
          "cursor-pointer text-[10px] font-semibold uppercase tracking-wider",
          tone === "danger" ? "text-app-danger" : "text-app-text-muted",
        ].join(" ")}
      >
        {title}
      </summary>
      <div className="mt-1 min-w-0">{children}</div>
    </details>
  );
}

function stringField(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "";
}

function readFiles(value: unknown): Array<{ path: string; content: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is { path: string; content: string } =>
        Boolean(entry) &&
        typeof entry === "object" &&
        typeof (entry as { path?: unknown }).path === "string" &&
        typeof (entry as { content?: unknown }).content === "string",
    )
    .map((entry) => ({ path: entry.path, content: entry.content }));
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function readNumberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is number => typeof entry === "number");
}

function extractProposalContent(payload: Record<string, unknown>): string | undefined {
  const proposal = payload.proposal;
  if (!proposal || typeof proposal !== "object") return undefined;
  const content = (proposal as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
