import { useState } from "react";
import { Link } from "react-router-dom";

import { useToolBuildRuns, useCreateToolBuildRun } from "@/api/toolBuildRuns";
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

function NewCouncilBuild({ defaultQaCriteria }: { defaultQaCriteria: string }) {
  const create = useCreateToolBuildRun();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [qaCriteriaText, setQaCriteriaText] = useState("");
  const [secretHandle, setSecretHandle] = useState("");

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
      },
      {
        onSuccess: () => {
          setName("");
          setDescription("");
          setQaCriteriaText("");
          setSecretHandle("");
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
          Newest first. Click a row to open the full trace (brainstorm proposals, votes,
          drafted code, reviews, QA attempts).
        </p>
      </header>
      <ul className="divide-y divide-app-border">
        {runs.map((run) => {
          const toolName = extractToolName(run);
          const tool = toolName ? installed.get(toolName) : undefined;
          return (
            <li key={run.id}>
              <Link
                to={`/trace/${run.id}`}
                className="grid grid-cols-[minmax(0,1.5fr)_auto_auto_auto_auto] items-center gap-3 px-4 py-2.5 text-sm hover:bg-app-surface-2"
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
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Pull the canonical tool name out of the council run's task string.
 *  The runs.service writes the task as
 *  `Council build for <name>: <description>` so we can reliably
 *  parse the name back out for the row label.
 */
function extractToolName(run: AgentRunRecord): string | undefined {
  const match = /^Council build for ([^:]+):/.exec(run.task ?? "");
  return match ? match[1].trim() : undefined;
}
