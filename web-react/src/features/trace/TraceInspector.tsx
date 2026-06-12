import { useEffect, useState } from "react";

import type { TraceNode } from "@/features/trace/buildTraceNodes";
import { modelTierForNode } from "@/features/trace/buildTraceNodes";
import { ArtifactGallery } from "@/components/ArtifactPreview";
import { GenericBadge } from "@/components/StatusBadge";
import { formatDuration, formatRelative, truncate } from "@/lib/format";
import { useCancelRun, useResumeRun } from "@/api/runs";
import { toolRequestSummary } from "@/features/trace/traceToolRequestSummary";

type TraceInspectorProps = {
  node: TraceNode | undefined;
  runId?: string;
};

export function TraceInspector({ node, runId }: TraceInspectorProps) {
  if (!node) {
    return (
      <aside className="rounded-[var(--radius-card)] border border-dashed border-app-border bg-app-surface p-5 text-sm text-app-text-muted">
        Select a span on the graph or in the timeline to inspect its call frame, evidence, and artifacts.
      </aside>
    );
  }

  const callFrame = readCallFrame(node.payload);
  const selfCheck = readSelfCheck(node.payload);
  const memoryHits = readMemoryEntries(node.payload);
  const stuckHelper = useStuckSpanHelper(runId, node);
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
          <span className="font-mono text-app-text-muted">
            {node.actor}{node.toolVersion ? `@${node.toolVersion}` : ""}
          </span>
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

      {stuckHelper.shouldShow ? (
        <div className="rounded-md border border-app-warn/40 bg-app-warn/10 p-2.5 text-[11px]">
          <p className="font-semibold">This step has been in progress for {stuckHelper.elapsedLabel}.</p>
          <p className="mt-0.5 text-app-text-muted">
            If the LLM is unresponsive you can cancel the run and resume from the last completed
            phase. Sub-research findings and other partial outputs collected inside this step
            are preserved by the parent run's resume snapshot when possible.
          </p>
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  "Cancel this run and resume? The new run will re-enter from completed phases when a resume snapshot is available.",
                )
              ) {
                stuckHelper.onResumeFromHere();
              }
            }}
            disabled={stuckHelper.isPending}
            className="mt-2 rounded-md border border-app-warn/60 bg-app-surface px-2.5 py-1 text-[11px] hover:border-app-warn disabled:opacity-50"
          >
            {stuckHelper.isPending ? "Cancelling…" : "Resume from here"}
          </button>
          {stuckHelper.error ? (
            <p className="mt-1 text-app-danger">{stuckHelper.error}</p>
          ) : null}
        </div>
      ) : null}

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
              quality: artifact.quality,
            }))}
          />
        </Section>
      ) : null}

      <footer className="mt-2 flex flex-col gap-2 border-t border-app-border pt-3 text-[11px]">
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

function readArtifactRefs(
  payload: unknown,
  runId: string,
): Array<{ id?: string; filename?: string; mimeType?: string; url?: string; quality?: import("@/api/types").ArtifactQualityMetadata }> {
  if (!payload || typeof payload !== "object") return [];
  const refs: Array<{ id?: string; filename?: string; mimeType?: string; url?: string; quality?: import("@/api/types").ArtifactQualityMetadata }> = [];
  const record = payload as Record<string, unknown>;
  const single = record.artifact;
  const list = Array.isArray(record.artifacts) ? record.artifacts : [];
  const inlineArtifact =
    typeof record.artifactId === "string" || typeof record.filename === "string"
      ? {
          id: record.artifactId,
          filename: record.filename,
          mimeType: record.mimeType,
          url: `/api/runs/${runId}/artifacts/${record.artifactId ?? ""}`,
          quality: record.quality,
        }
      : undefined;
  const all = [inlineArtifact, single, ...list].filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) &&
      typeof entry === "object" &&
      (typeof (entry as { url?: unknown }).url === "string" ||
        typeof (entry as { filename?: unknown }).filename === "string"),
  );
  for (const artifact of all) {
    refs.push({
      id: typeof artifact.id === "string" ? artifact.id : undefined,
      filename: typeof artifact.filename === "string" ? artifact.filename : undefined,
      mimeType: typeof artifact.mimeType === "string" ? artifact.mimeType : undefined,
      quality: readArtifactQuality(artifact.quality),
      url:
        typeof artifact.url === "string"
          ? artifact.url
          : `/api/runs/${runId}/artifacts/${artifact.id ?? ""}`,
    });
  }
  return refs;
}

function readArtifactQuality(value: unknown): import("@/api/types").ArtifactQualityMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const status = (value as { status?: unknown }).status;
  if (status !== "passed" && status !== "warning" && status !== "failed") return undefined;
  return value as import("@/api/types").ArtifactQualityMetadata;
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
/**
 * Phase 19 Slice B: when a span has been "started" for longer than
 * the stuck threshold, the operator sees a "Resume from here" affordance
 * in the Inspector. The button:
 *   1. Cancels the parent run (aborts in-flight LLM calls).
 *   2. Triggers a resume on the parent. Completed phases are reused
 *      via the resumeFrom snapshot when the backend can recover them.
 *
 * The TRUE "preserve in-flight sub-research findings AND re-fire just
 * this LLM call" semantic would require more granular runtime state.
 * For now the practical guarantee is "completed phases survive, the
 * stuck phase re-runs from scratch".
 */
const STUCK_THRESHOLD_MS = 3 * 60 * 1000;

function useStuckSpanHelper(
  runId: string | undefined,
  node: TraceNode,
): {
  shouldShow: boolean;
  elapsedLabel: string;
  isPending: boolean;
  error: string | undefined;
  onResumeFromHere: () => void;
} {
  const cancel = useCancelRun();
  const resume = useResumeRun();
  const [now, setNow] = useState(() => Date.now());
  const isStarted = node.status === "started";
  useEffect(() => {
    if (!isStarted) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isStarted]);
  const startedMs = new Date(node.startedAt).getTime();
  const elapsed = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : 0;
  const shouldShow = Boolean(runId) && isStarted && elapsed >= STUCK_THRESHOLD_MS;
  const onResumeFromHere = () => {
    if (!runId) return;
    cancel.mutate(
      { id: runId, reason: "Operator resumed from a stuck span" },
      {
        onSuccess: () => {
          resume.mutate(runId);
        },
      },
    );
  };
  const error = cancel.isError
    ? cancel.error.message
    : resume.isError
      ? resume.error.message
      : undefined;
  return {
    shouldShow,
    elapsedLabel: formatDuration(elapsed),
    isPending: cancel.isPending || resume.isPending,
    error,
    onResumeFromHere,
  };
}

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
  /** Linked child run ids, when a trace payload records them. */
  subBuildRunIds: string[];
  /** Linked successor run id, when a trace payload records one. */
  successorRunId?: string;
  /** Missing capabilities recorded by a trace payload. */
  missingCapabilities: { capability: string; filename: string; mimeType: string }[];
};

/** Normalises trace payloads into a uniform Input/Output pair plus headline fields. */
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
  const genericInput = payload.input;
  const genericOutput = payload.output;
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
  const toolRequest = toolRequestSummary(genericOutput);

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
  if (toolRequest.operation) summary.headerLines.push({ label: "Operation", value: toolRequest.operation });
  if (toolRequest.target) {
    summary.headerLines.push({
      label: "Target",
      value: toolRequest.target,
      note: toolRequest.targetRequested && toolRequest.targetRequested !== toolRequest.target
        ? `requested ${toolRequest.targetRequested}`
        : undefined,
    });
  }
  if (toolRequest.url) summary.headerLines.push({ label: "Request URL", value: truncate(toolRequest.url, 140) });
  if (toolRequest.status) summary.headerLines.push({ label: "HTTP", value: toolRequest.status });
  if (toolRequest.providerError) {
    summary.headerLines.push({
      label: "Provider error",
      value: truncate(toolRequest.providerError, 140),
      note: toolRequest.providerErrorCategory || undefined,
    });
  }

  // Event-type-aware Input/Output labels.
  const labels = inputOutputLabelsFor(node);

  // Input: prefer the new prompt field; fall back to qaInput JSON.
  if (promptText) {
    summary.input = { label: labels.inputLabel, text: promptText };
  } else if (qaInput && typeof qaInput === "object") {
    summary.input = { label: labels.inputLabel, text: safeJson(qaInput) };
  } else if (genericInput !== undefined) {
    summary.input = { label: labels.inputLabel, text: safeJson(genericInput) };
  }

  // Output: prefer the new output field; for review/qa surface the
  // verdict + findings/failures inline; fall back to content/raw for
  // older events.
  if (qaToolOutput && node.type?.includes("qa")) {
    const oracleNote = oracleOutputText ? `\n\nOracle response:\n${oracleOutputText}` : "";
    summary.output = { label: labels.outputLabel, text: `${safeJson(qaToolOutput)}${oracleNote}` };
  } else if (outputText) {
    summary.output = { label: labels.outputLabel, text: outputText };
  } else if (genericOutput !== undefined) {
    summary.output = { label: labels.outputLabel, text: safeJson(genericOutput) };
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
  void node;
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
