import { type ToolCreationRecord, useDeleteToolCreation } from "@/api/tools";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative } from "@/lib/format";

import { creationStatusTone, formatAdapterContract } from "./toolsPageShared";

export function ToolCreationsPanel({
  creations,
  onSelectTool,
}: {
  creations: ToolCreationRecord[] | undefined;
  onSelectTool?: (name: string) => void;
}) {
  const recent = (creations ?? []).slice(0, 5);
  const deleteCreation = useDeleteToolCreation();
  return (
    <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">Creation history</h3>
        <span className="text-[10px] text-app-text-muted">{creations?.length ?? 0} records</span>
      </div>
      {recent.length === 0 ? (
        <p className="mt-2 text-[11px] text-app-text-muted">No package creation records yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {recent.map((record) => (
            <li key={record.id} className="rounded border border-app-border bg-app-surface-2 px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-[11px]">{record.toolName}</span>
                <GenericBadge tone={creationStatusTone(record.status)}>{record.status}</GenericBadge>
              </div>
              <p className="mt-0.5 truncate text-[10px] text-app-text-muted">
                v{record.toolVersion} · {record.kind} · {formatRelative(record.updatedAt)}
              </p>
              {record.strategy ? (
                <>
                  <p className="mt-1 truncate text-[10px] text-app-text-muted">
                    Strategy: {record.strategy.kind} · {record.strategy.confidence}
                  </p>
                  {record.strategy.discoveryEvidence?.[0] ? (
                    <p className="mt-1 truncate text-[10px] text-app-text-muted">
                      Discovery: {record.strategy.discoveryEvidence.map((item) => item.summary).join(" ")}
                    </p>
                  ) : null}
                  {record.strategy.behaviorExamples?.length ? (
                    <p className="mt-1 truncate text-[10px] text-app-text-muted">
                      Behavior QA: {record.strategy.behaviorExamples.length} example(s)
                    </p>
                  ) : null}
                  {record.strategy.adapterContract ? (
                    <p className="mt-1 truncate text-[10px] text-app-text-muted">
                      Adapter: {formatAdapterContract(record.strategy.adapterContract)}
                    </p>
                  ) : null}
                </>
              ) : null}
              {record.packageRef ? (
                <p className="mt-1 truncate font-mono text-[10px] text-app-text-muted">
                  {record.packageRef}
                </p>
              ) : null}
              {record.runId ? (
                <div className="mt-1 flex flex-wrap gap-2">
                  {onSelectTool ? (
                    <button
                      type="button"
                      onClick={() => onSelectTool(record.toolName)}
                      className="text-[10px] font-medium text-app-accent hover:underline"
                    >
                      Select tool
                    </button>
                  ) : null}
                  <a
                    href={`/run/${encodeURIComponent(record.runId)}`}
                    className="text-[10px] font-medium text-app-accent hover:underline"
                  >
                    Open creation run
                  </a>
                </div>
              ) : null}
              {record.status === "failed" || record.status === "qa_failed" ? (
                <button
                  type="button"
                  onClick={() => {
                    if (!window.confirm(`Delete failed creation ${record.toolName}@${record.toolVersion}? This removes its package workspace, creation record, linked run, and tool-scoped secrets.`)) return;
                    deleteCreation.mutate(record.id);
                  }}
                  disabled={deleteCreation.isPending}
                  className="mt-1 inline-flex rounded border border-app-danger/50 px-2 py-0.5 text-[10px] font-medium text-app-danger hover:bg-app-danger/10 disabled:opacity-60"
                >
                  {deleteCreation.isPending ? "Deleting..." : "Delete failed creation"}
                </button>
              ) : null}
              {record.qa ? (
                <>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {record.qa.requiresManualLiveVerification ? (
                      <GenericBadge tone="warn">manual live QA</GenericBadge>
                    ) : null}
                    {record.qa.issues?.[0] ? (
                      <GenericBadge tone={record.qa.issues[0].severity === "warning" ? "warn" : "danger"}>
                        {record.qa.issues[0].kind}
                      </GenericBadge>
                    ) : null}
                  </div>
                  <p className="mt-1 truncate text-[10px] text-app-text-muted">{record.qa.summary}</p>
                  {record.qa.warnings?.[0] ? (
                    <p className="mt-1 truncate text-[10px] text-app-warning">
                      {record.qa.warnings[0]}
                    </p>
                  ) : null}
                </>
              ) : record.error ? (
                <p className="mt-1 truncate text-[10px] text-app-danger">{record.error}</p>
              ) : null}
              {deleteCreation.isError ? (
                <p className="mt-1 text-[10px] text-app-danger">{deleteCreation.error.message}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
