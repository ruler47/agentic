import { useState } from "react";
import { Link } from "react-router-dom";

import { useToolBuildRuns, useCreateToolBuildRun } from "@/api/toolBuildRuns";
import { useCancelRun, useRestartRun, useResumeRun } from "@/api/runs";
import { useTools } from "@/api/tools";
import { RunStatusBadge } from "@/components/StatusBadge";
import { formatDuration, formatRelative, runDurationMs, truncate } from "@/lib/format";
import type { AgentRunRecord, ToolModuleMetadata } from "@/api/types";

const SAMPLE_QA_CRITERIA = [
  "returns ok=true on a valid input",
  "content matches the requested transformation",
  "rejects missing required fields with a descriptive error string",
].join("\n");

/**
 * Phase 14 / Phase E: Tool Builds page rewritten around the council
 * pipeline. The legacy queue (tool-build-requests + Build queue grid +
 * Investigations + Waits) is gone — every new tool goes through the
 * council via POST /api/tool-build-runs and is fully observable in
 * Trace Lab.
 *
 * The page now answers exactly three questions:
 *   - What does the operator need to fill in to start a new tool?
 *   - Which tools were built recently, and how did each run go?
 *   - Where do I jump in to see the brainstorm/vote/review/QA trail?
 *
 * Each council run row links straight into Trace Lab so the operator
 * never has to navigate Runs → search for the right id.
 */
export function ToolBuildsPage() {
  const runs = useToolBuildRuns();
  const tools = useTools();
  const runList = runs.data ?? [];
  const toolList = tools.data ?? [];

  const installed = new Map<string, ToolModuleMetadata>();
  for (const tool of toolList) installed.set(tool.name, tool);

  return (
    <section className="flex flex-col gap-4">
      <header className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Tool Builds</h2>
            <p className="mt-1 text-xs text-app-text-muted">
              Build a new tool with the coding council: peer LLMs brainstorm a proposal,
              vote on the best one, draft code, review and revise it, then run QA against
              acceptance criteria — all in one pipeline. Every step shows up live in Trace Lab.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] text-app-text-muted">
            <span className="rounded-full bg-app-surface-2 px-2 py-0.5">
              {runList.length} council runs
            </span>
            <span className="rounded-full bg-app-surface-2 px-2 py-0.5">
              {toolList.length} tools registered
            </span>
          </div>
        </div>
      </header>

      <NewCouncilBuild defaultQaCriteria={SAMPLE_QA_CRITERIA} />

      <RecentCouncilRuns runs={runList} installed={installed} isLoading={runs.isLoading} />
    </section>
  );
}

type PendingReference = {
  filename: string;
  mimeType: string;
  size: number;
  contentBase64: string;
};

const REFERENCE_FILE_CAP_MB = 5;

function NewCouncilBuild({ defaultQaCriteria }: { defaultQaCriteria: string }) {
  const create = useCreateToolBuildRun();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [qaCriteriaText, setQaCriteriaText] = useState("");
  const [secretHandle, setSecretHandle] = useState("");
  const [references, setReferences] = useState<PendingReference[]>([]);
  const [referenceError, setReferenceError] = useState<string | undefined>();

  const onFilesPicked = async (files: FileList | null) => {
    setReferenceError(undefined);
    if (!files) return;
    const next: PendingReference[] = [];
    for (const file of Array.from(files)) {
      if (file.size > REFERENCE_FILE_CAP_MB * 1024 * 1024) {
        setReferenceError(`${file.name}: exceeds ${REFERENCE_FILE_CAP_MB} MB cap.`);
        return;
      }
      const buffer = await file.arrayBuffer();
      next.push({
        filename: file.name,
        mimeType: file.type || guessMimeFromName(file.name),
        size: file.size,
        contentBase64: arrayBufferToBase64(buffer),
      });
    }
    setReferences((prev) => [...prev, ...next]);
  };

  const removeReference = (filename: string) => {
    setReferences((prev) => prev.filter((ref) => ref.filename !== filename));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    const qaCriteria = qaCriteriaText
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    create.mutate(
      {
        name: name.trim(),
        description: description.trim(),
        qaCriteria: qaCriteria.length > 0 ? qaCriteria : undefined,
        secretHandle: secretHandle.trim() || undefined,
        references: references.length > 0
          ? references.map((ref) => ({
              filename: ref.filename,
              mimeType: ref.mimeType,
              contentBase64: ref.contentBase64,
            }))
          : undefined,
      },
      {
        onSuccess: () => {
          setName("");
          setDescription("");
          setQaCriteriaText("");
          setSecretHandle("");
          setReferences([]);
          setReferenceError(undefined);
          setOpen(false);
        },
      },
    );
  };

  return (
    <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Start a new council build</h3>
          <p className="mt-1 text-xs text-app-text-muted">
            Submitting kicks the brainstorm → vote → implement → review → revise → QA
            pipeline immediately. Watch progress in the run row below or in Trace Lab.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1 text-xs"
        >
          {open ? "Close form" : "Open form"}
        </button>
      </header>
      {open ? (
        <form onSubmit={submit} className="mt-3 grid gap-3 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-app-text-muted">
              Tool name (canonical, e.g. <code>weather.openmeteo</code>)
            </span>
            <input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="weather.openmeteo"
              className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-sm outline-none focus:border-app-accent/60 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-app-text-muted">
              Description — what should the tool do?
            </span>
            <textarea
              required
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Return the hourly weather forecast for a given city using the open-meteo public API. No auth required."
              className="resize-y rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-sm outline-none focus:border-app-accent/60"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-app-text-muted">
              QA acceptance criteria (one per line)
            </span>
            <textarea
              rows={4}
              value={qaCriteriaText}
              onChange={(event) => setQaCriteriaText(event.target.value)}
              placeholder={defaultQaCriteria}
              className="resize-y rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-sm outline-none focus:border-app-accent/60"
            />
          </label>
          <fieldset className="flex flex-col gap-2 rounded-md border border-app-border bg-app-surface-2 p-3">
            <legend className="text-[10px] uppercase tracking-wider text-app-text-muted">
              Reference docs (OpenAPI, README, PDF, YAML, …)
            </legend>
            <p className="text-[11px] text-app-text-muted">
              The council reads these before brainstorming. Text-like files (md / yaml /
              json / openapi / txt) are read in-process. Binary files (PDF, etc.) require
              a registered tool with capability <code>reads:&lt;mime&gt;</code> — if missing,
              the run halts with a clear message and you build the reader first.
              Cap: {REFERENCE_FILE_CAP_MB} MB per file.
            </p>
            <input
              type="file"
              multiple
              onChange={(event) => void onFilesPicked(event.target.files)}
              className="text-[11px] file:mr-3 file:rounded-md file:border file:border-app-border file:bg-app-surface file:px-3 file:py-1 file:text-[11px] file:text-app-text"
            />
            {references.length > 0 ? (
              <ul className="flex flex-col gap-1 text-[11px]">
                {references.map((ref) => (
                  <li
                    key={ref.filename}
                    className="flex items-center justify-between gap-2 rounded border border-app-border bg-app-surface px-2 py-1"
                  >
                    <span className="min-w-0 truncate font-mono">
                      {ref.filename}
                      <span className="ml-2 text-app-text-muted">
                        {formatFileSize(ref.size)} · {ref.mimeType || "unknown"}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => removeReference(ref.filename)}
                      className="rounded text-app-text-muted hover:text-app-danger"
                    >
                      remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {referenceError ? (
              <p className="text-[11px] text-app-danger">{referenceError}</p>
            ) : null}
          </fieldset>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-app-text-muted">
              Secret handle (optional — the tool reads this at runtime)
            </span>
            <input
              value={secretHandle}
              onChange={(event) => setSecretHandle(event.target.value)}
              placeholder="weather.openmeteo.api_key"
              className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-sm outline-none focus:border-app-accent/60 font-mono"
            />
          </label>
          {create.isError ? (
            <p className="text-[11px] text-app-danger">{create.error.message}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-xs"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={create.isPending || !name.trim() || !description.trim()}
              className="rounded-md bg-app-accent px-3 py-1.5 text-xs font-semibold text-app-bg disabled:opacity-50"
            >
              {create.isPending ? "Starting…" : "Start council build"}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function RecentCouncilRuns({
  runs,
  installed,
  isLoading,
}: {
  runs: AgentRunRecord[];
  installed: Map<string, ToolModuleMetadata>;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4 text-sm text-app-text-muted">
        Loading…
      </section>
    );
  }
  if (runs.length === 0) {
    return (
      <section className="rounded-[var(--radius-card)] border border-dashed border-app-border bg-app-surface p-6 text-sm text-app-text-muted">
        No council runs yet. Open the form above to start one.
      </section>
    );
  }

  return (
    <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface">
      <header className="border-b border-app-border px-4 py-3">
        <h3 className="text-sm font-semibold">Recent council runs</h3>
        <p className="mt-0.5 text-[11px] text-app-text-muted">
          Newest first. Click a row to open the full trace. Cancel/Resume/Restart
          buttons appear when the run state allows it.
        </p>
      </header>
      <ul className="divide-y divide-app-border">
        {runs.map((run) => (
          <CouncilRunRow key={run.id} run={run} installed={installed} />
        ))}
      </ul>
    </section>
  );
}

/**
 * Phase 19 Slice A: per-row Cancel / Restart / Resume controls.
 *
 *  - `running` / `queued`: Cancel button.
 *  - `failed` / `cancelled`: Restart (fresh run from the same input) +
 *    Resume (re-enter where the prior run left off — uses Phase 12
 *    `resumeFrom` so brainstorm + completed phases are reused, the
 *    failed step is replayed).
 *  - `completed`: no buttons; the operator can still click Request
 *    changes from the tool's Versions panel.
 *
 * Buttons are inside the row's <Link> so they need
 * `event.preventDefault()` + `stopPropagation()` to avoid hijacking
 * the trace-open navigation. The trace itself stays accessible via
 * the rest of the row.
 */
function CouncilRunRow({
  run,
  installed,
}: {
  run: AgentRunRecord;
  installed: Map<string, ToolModuleMetadata>;
}) {
  const toolName = extractToolName(run);
  const tool = toolName ? installed.get(toolName) : undefined;
  const cancel = useCancelRun();
  const restart = useRestartRun();
  const resume = useResumeRun();

  const status = run.status;
  const isLive = status === "running" || status === "queued" || status === "pending";
  const isStuckOrDone = status === "failed" || status === "cancelled";
  const anyPending = cancel.isPending || restart.isPending || resume.isPending;

  return (
    <li>
      <Link
        to={`/trace/${run.id}`}
        className="grid grid-cols-[minmax(0,1.5fr)_auto_auto_auto_auto_auto] items-center gap-3 px-4 py-2.5 text-sm hover:bg-app-surface-2"
      >
        <span className="min-w-0 truncate">
          <span className="font-mono">{toolName ?? run.id}</span>
          {tool ? (
            <span className="ml-2 text-[10px] text-app-text-muted">
              → v{tool.version} ({tool.status})
            </span>
          ) : null}
          <span className="ml-2 text-[11px] text-app-text-muted">
            {truncate(run.task, 100)}
          </span>
        </span>
        <RunStatusBadge status={run.status} />
        <span className="font-mono text-[11px] text-app-text-muted">
          {formatDuration(runDurationMs(run))}
        </span>
        <span className="text-[11px] text-app-text-muted">
          {(run.events ?? []).length} events
        </span>
        <span className="text-[11px] text-app-text-muted">
          {formatRelative(run.createdAt)}
        </span>
        <span
          className="flex flex-wrap items-center gap-1"
          // Stop the row-link from intercepting button clicks. Each
          // button calls preventDefault on its own onClick but we
          // also intercept at the wrapper for safety.
          onClick={(event) => event.preventDefault()}
        >
          {isLive ? (
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (window.confirm("Cancel this run? In-flight LLM calls will be aborted.")) {
                  cancel.mutate({ id: run.id, reason: "Operator cancelled" });
                }
              }}
              disabled={anyPending}
              className="rounded-md border border-app-danger/40 bg-app-surface px-2 py-0.5 text-[11px] text-app-danger hover:border-app-danger disabled:opacity-50"
            >
              {cancel.isPending ? "…" : "Cancel"}
            </button>
          ) : null}
          {isStuckOrDone ? (
            <>
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  resume.mutate(run.id);
                }}
                disabled={anyPending}
                title="Re-run from where the prior run left off (reuses completed phases)"
                className="rounded-md border border-app-accent/40 bg-app-surface px-2 py-0.5 text-[11px] text-app-accent hover:border-app-accent disabled:opacity-50"
              >
                {resume.isPending ? "…" : "Resume"}
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (window.confirm("Restart from scratch? This starts a fresh run with the same input.")) {
                    restart.mutate(run.id);
                  }
                }}
                disabled={anyPending}
                title="Start a fresh run from scratch with the same input"
                className="rounded-md border border-app-border bg-app-surface px-2 py-0.5 text-[11px] hover:border-app-accent/40 disabled:opacity-50"
              >
                {restart.isPending ? "…" : "Restart"}
              </button>
            </>
          ) : null}
        </span>
      </Link>
      {cancel.isError ? (
        <p className="px-4 pb-2 text-[11px] text-app-danger">{cancel.error.message}</p>
      ) : null}
      {resume.isError ? (
        <p className="px-4 pb-2 text-[11px] text-app-danger">{resume.error.message}</p>
      ) : null}
      {restart.isError ? (
        <p className="px-4 pb-2 text-[11px] text-app-danger">{restart.error.message}</p>
      ) : null}
    </li>
  );
}

/** Pull the canonical tool name out of the council run's task string.
 *  The runs.service writes the task as
 *  `Council build for <name>: <description>` so we can reliably
 *  parse the name back out for the row label.
 */
function extractToolName(run: AgentRunRecord): string | undefined {
  // Phase 19 Slice A fix: also match `Council rework for X:` so rework
  // rows show the tool name instead of falling back to the run id.
  const match = /^Council (?:build|rework) for ([^:]+):/.exec(run.task ?? "");
  return match ? match[1].trim() : undefined;
}

/** Convert ArrayBuffer to base64 without blowing the call stack on
 *  large files — `String.fromCharCode(...arr)` overflows past ~100 kB. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

/** Best-effort MIME guess from the file extension when the browser
 *  doesn't supply one (which happens for .yaml / .openapi / .md). */
function guessMimeFromName(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "yaml":
    case "yml":
      return "application/yaml";
    case "json":
      return "application/json";
    case "md":
    case "markdown":
      return "text/markdown";
    case "txt":
      return "text/plain";
    case "openapi":
      return "application/openapi+yaml";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
