import { useMemo, useState } from "react";

import {
  useToolBuildRequests,
  useToolInvestigations,
  useToolReworkWaits,
} from "@/api/queries";
import { useTools } from "@/api/tools";
import {
  TOOL_BUILD_STATUSES,
  describeBuildStatus,
  useCreateToolBuildRequest,
} from "@/api/toolBuilds";
import { BuildCard } from "@/features/tool-builds/BuildCard";
import { InvestigationCard } from "@/features/tool-builds/InvestigationCard";
import { WaitCard } from "@/features/tool-builds/WaitCard";
import type { ToolInvestigationRecord, ToolReworkWaitRecord } from "@/api/types";

const DEFAULT_QA_CRITERIA = [
  "The generated tool must be TypeScript, reusable outside this specific request, documented, and registered only after QA passes.",
  "Validate input/output schemas and reject unsafe or incomplete inputs with structured failures.",
  "Add focused automated tests for success, invalid input, and provider/tool failure paths.",
  "Run a manual smoke check that proves the tool can satisfy the requested capability.",
  "Do not leak credentials into prompts, logs, generated source, tests, traces, memory, or artifacts.",
].join("\n");

export function ToolBuildsPage() {
  const builds = useToolBuildRequests();
  const investigations = useToolInvestigations();
  const waits = useToolReworkWaits();
  const tools = useTools();

  const installedToolNames = useMemo(
    () => new Set((tools.data ?? []).map((tool) => tool.name)),
    [tools.data],
  );

  const investigationList = investigations.data ?? [];
  const buildList = builds.data ?? [];
  const waitList = waits.data ?? [];

  const openInvestigations = investigationList.filter(
    (item) => item.status === "open" || item.status === "triaged",
  );
  const linkedInvestigations = investigationList.filter(
    (item) => item.status === "linked_to_build",
  );
  const openWaits = waitList.filter(
    (wait) =>
      wait.status !== "resumed" && wait.status !== "cancelled" && wait.status !== "failed",
  );
  const closedWaits = waitList.filter(
    (wait) =>
      wait.status === "resumed" || wait.status === "cancelled" || wait.status === "failed",
  );

  const waitsByBuildId = useMemo(() => {
    const map = new Map<string, typeof waitList>();
    for (const wait of waitList) {
      if (!wait.buildRequestId) continue;
      const existing = map.get(wait.buildRequestId);
      if (existing) existing.push(wait);
      else map.set(wait.buildRequestId, [wait]);
    }
    return map;
  }, [waitList]);

  const waitsByInvestigationId = useMemo(() => {
    const map = new Map<string, typeof waitList>();
    for (const wait of waitList) {
      if (!wait.investigationId) continue;
      const existing = map.get(wait.investigationId);
      if (existing) existing.push(wait);
      else map.set(wait.investigationId, [wait]);
    }
    return map;
  }, [waitList]);

  return (
    <section className="flex flex-col gap-4">
      <header className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
        <div className="flex items-baseline justify-between">
          <div>
            <h2 className="text-base font-semibold">Tool Builds</h2>
            <p className="mt-1 text-xs text-app-text-muted">
              Investigations preserve failure context. Promote them to a build request, then
              register the new version. Waiting runs resume only after the operator marks
              them ready for retry.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] text-app-text-muted">
            <span className="rounded-full bg-app-surface-2 px-2 py-0.5">
              {investigationList.length} investigations
            </span>
            <span className="rounded-full bg-app-surface-2 px-2 py-0.5">
              {buildList.length} build requests
            </span>
            <span
              className={
                openWaits.length > 0
                  ? "rounded-full bg-app-warning-soft px-2 py-0.5 text-app-warning"
                  : "rounded-full bg-app-surface-2 px-2 py-0.5"
              }
            >
              {openWaits.length} active waits
            </span>
          </div>
        </div>
      </header>

      <NewToolBuildRequest defaultQaCriteria={DEFAULT_QA_CRITERIA} />

      <ToolInvestigationsPanel
        title="Open Tool Investigations"
        emptyText="No open investigations. Open Trace Lab and click 'Create tool request / bug' on a span to start one."
        investigations={openInvestigations}
        installedToolNames={installedToolNames}
        waitsByInvestigationId={waitsByInvestigationId}
      />

      {linkedInvestigations.length > 0 ? (
        <ToolInvestigationsPanel
          title="Linked to Tool Builds"
          emptyText=""
          investigations={linkedInvestigations}
          installedToolNames={installedToolNames}
          waitsByInvestigationId={waitsByInvestigationId}
        />
      ) : null}

      {openWaits.length > 0 ? (
        <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
          <h3 className="text-sm font-semibold">Active rework waits</h3>
          <p className="mt-1 text-xs text-app-text-muted">
            Each card represents a run paused for tool upgrade. Once promoted, click <em>Mark
            ready for retry</em> to close the wait and let the operator re-issue the task.
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {openWaits.map((wait) => (
              <WaitCard key={wait.id} wait={wait} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
        <h3 className="text-sm font-semibold">Build queue</h3>
        <p className="mt-1 text-xs text-app-text-muted">
          The background worker claims requested cards automatically. Use <em>Run builder</em> as
          a manual fallback.
        </p>
        <div className="mt-3 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {TOOL_BUILD_STATUSES.map((status) => {
            const items = buildList.filter((request) => request.status === status);
            return (
              <article
                key={status}
                className="flex min-h-[160px] flex-col gap-2 rounded-md border border-app-border bg-app-surface-2 p-3"
              >
                <header className="flex items-baseline justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wider">
                    {status.replace(/_/g, " ")}
                  </h4>
                  <span className="text-[11px] text-app-text-muted">{items.length}</span>
                </header>
                <p className="text-[11px] text-app-text-muted">
                  {describeBuildStatus(status)}
                </p>
                {items.length === 0 ? (
                  <p className="text-[11px] text-app-text-muted/70">No requests</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {items.map((request) => (
                      <BuildCard
                        key={request.id}
                        request={request}
                        linkedWaits={waitsByBuildId.get(request.id) ?? []}
                      />
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>

      {closedWaits.length > 0 ? (
        <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
          <h3 className="text-sm font-semibold">Closed waits</h3>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {closedWaits.slice(0, 12).map((wait) => (
              <WaitCard key={wait.id} wait={wait} />
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}

function ToolInvestigationsPanel({
  title,
  emptyText,
  investigations,
  installedToolNames,
  waitsByInvestigationId,
}: {
  title: string;
  emptyText: string;
  investigations: ToolInvestigationRecord[];
  installedToolNames: Set<string>;
  waitsByInvestigationId: Map<string, ToolReworkWaitRecord[]>;
}) {
  return (
    <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {investigations.length === 0 ? (
        <p className="mt-1 text-xs text-app-text-muted">{emptyText}</p>
      ) : (
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {investigations.map((investigation) => (
            <InvestigationCard
              key={investigation.id}
              investigation={investigation}
              linkedWaits={waitsByInvestigationId.get(investigation.id) ?? []}
              installedToolNames={installedToolNames}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function NewToolBuildRequest({ defaultQaCriteria }: { defaultQaCriteria: string }) {
  const create = useCreateToolBuildRequest();
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [reason, setReason] = useState("");
  const [credentialNotes, setCredentialNotes] = useState("");
  const [startupMode, setStartupMode] = useState("on-demand");
  const [qaCriteria, setQaCriteria] = useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    const trimmedQa = qaCriteria
      .split(/\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
    create.mutate(
      {
        // `capability` is intentionally omitted; the server infers it from
        // displayName + reason via `inferToolBuildCapability`.
        displayName: displayName.trim() || undefined,
        reason: reason.trim(),
        credentialNotes: credentialNotes.trim() || undefined,
        startupMode: ["on-demand", "always-on", "ephemeral"].includes(startupMode)
          ? (startupMode as "on-demand" | "always-on" | "ephemeral")
          : undefined,
        qaCriteria: trimmedQa.length > 0 ? trimmedQa : undefined,
      },
      {
        onSuccess: () => {
          setDisplayName("");
          setReason("");
          setCredentialNotes("");
          setStartupMode("on-demand");
          setQaCriteria("");
          setOpen(false);
        },
      },
    );
  };

  return (
    <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Request a Tool</h3>
          <p className="mt-1 text-xs text-app-text-muted">
            Describe what the tool should do. The builder generates the system name and
            schemas; secrets stay behind handles.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1 text-xs"
        >
          {open ? "Close form" : "Open request form"}
        </button>
      </header>
      {open ? (
        <form onSubmit={submit} className="mt-3 grid gap-3 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Tool name</span>
            <input
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Wallet Risk Lookup"
              className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-sm outline-none focus:border-app-accent/60"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-app-text-muted">
              Description, docs, expected behavior
            </span>
            <textarea
              required
              rows={4}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="What should it do, where are the docs, inputs/outputs, when should the agent use it?"
              className="resize-y rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-sm outline-none focus:border-app-accent/60"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Run mode</span>
            <select
              value={startupMode}
              onChange={(event) => setStartupMode(event.target.value)}
              className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-sm"
            >
              <option value="on-demand">On demand</option>
              <option value="always-on">Always running (service / listener)</option>
              <option value="ephemeral">Ephemeral (short-lived job)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-app-text-muted">
              Credentials (optional, will be redacted)
            </span>
            <textarea
              rows={2}
              value={credentialNotes}
              onChange={(event) => setCredentialNotes(event.target.value)}
              placeholder="API key, bot token, secret reference; the builder converts these to scoped secret handles."
              className="resize-y rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-sm outline-none focus:border-app-accent/60"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-app-text-muted">QA criteria</span>
            <textarea
              rows={5}
              value={qaCriteria}
              onChange={(event) => setQaCriteria(event.target.value)}
              placeholder={defaultQaCriteria}
              className="resize-y rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-sm outline-none focus:border-app-accent/60"
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
              disabled={create.isPending || !displayName.trim() || !reason.trim()}
              className="rounded-md bg-app-accent px-3 py-1.5 text-xs font-semibold text-app-bg disabled:opacity-50"
            >
              {create.isPending ? "Creating…" : "Create build request"}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
