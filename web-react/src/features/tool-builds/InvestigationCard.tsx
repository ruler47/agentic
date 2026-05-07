import { useState } from "react";
import { Link } from "react-router-dom";

import {
  InvestigationPromotionAmbiguousError,
  usePromoteInvestigation,
  useUpdateInvestigation,
} from "@/api/investigations";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";
import type { ToolInvestigationRecord, ToolReworkWaitRecord } from "@/api/types";

type InvestigationCardProps = {
  investigation: ToolInvestigationRecord;
  linkedWaits: ToolReworkWaitRecord[];
  installedToolNames: Set<string>;
};

export function InvestigationCard({
  investigation,
  linkedWaits,
  installedToolNames,
}: InvestigationCardProps) {
  const promote = usePromoteInvestigation();
  const update = useUpdateInvestigation();
  const [override, setOverride] = useState<{ capability: string; desiredToolName: string } | undefined>();
  const canPromote = investigation.status === "open" || investigation.status === "triaged";
  const toolKnown = investigation.toolName ? installedToolNames.has(investigation.toolName) : false;

  const handlePromote = (event?: React.FormEvent) => {
    event?.preventDefault();
    promote.mutate(
      {
        id: investigation.id,
        capability: override?.capability,
        desiredToolName: override?.desiredToolName,
      },
      {
        onSuccess: () => setOverride(undefined),
      },
    );
  };

  return (
    <article className="flex flex-col gap-2 rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <div className="flex items-center justify-between">
        <GenericBadge tone={statusTone(investigation.status)}>{investigation.status}</GenericBadge>
        <span className="text-[10px] text-app-text-muted">
          {formatRelative(investigation.updatedAt ?? investigation.createdAt)}
        </span>
      </div>
      <strong className="text-sm leading-tight">{investigation.title}</strong>
      <p className="text-[11px] text-app-text-muted">
        Source: <span className="font-mono">{investigation.source}</span>
      </p>
      {investigation.toolName ? (
        <p className="text-[11px] text-app-text-muted">
          Tool: <code>{investigation.toolName}</code>
          {investigation.toolVersion ? ` v${investigation.toolVersion}` : ""}
          {toolKnown ? null : <em className="ml-1 text-app-warning">(not currently registered)</em>}
        </p>
      ) : (
        <p className="text-[11px] text-app-text-muted">Tool: not matched (manual ticket)</p>
      )}
      {investigation.runId ? (
        <p className="text-[11px]">
          Run: <code>{investigation.runId}</code>{" "}
          <Link to={`/run/${investigation.runId}`} className="text-app-accent underline">
            open
          </Link>
        </p>
      ) : null}
      {investigation.linkedBuildRequestId ? (
        <p className="text-[11px]">
          Linked build: <code>{investigation.linkedBuildRequestId}</code>
        </p>
      ) : null}
      {investigation.operatorComment ? (
        <p className="whitespace-pre-wrap text-[11px] text-app-text-muted">
          {truncate(investigation.operatorComment, 360)}
        </p>
      ) : null}

      {linkedWaits.length > 0 ? (
        <div className="rounded-md border border-app-warning/40 bg-app-warning-soft p-2 text-[11px]">
          <p className="font-semibold text-app-warning">Linked rework wait{linkedWaits.length > 1 ? "s" : ""}</p>
          <ul className="mt-1 space-y-0.5">
            {linkedWaits.map((wait) => (
              <li key={wait.id} className="font-mono">
                {wait.id} <span className="text-app-text-muted">({wait.status})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Promotion error fallback (ambiguous toolName) */}
      {promote.isError && promote.error instanceof InvestigationPromotionAmbiguousError ? (
        <form
          onSubmit={handlePromote}
          className="rounded-md border border-app-danger/30 bg-app-danger-soft p-2 text-[11px]"
        >
          <p className="text-app-danger">{promote.error.message}</p>
          <label className="mt-1.5 flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wider text-app-text-muted">capability</span>
            <input
              required
              value={override?.capability ?? ""}
              onChange={(event) =>
                setOverride((prev) => ({
                  capability: event.target.value,
                  desiredToolName: prev?.desiredToolName ?? "",
                }))
              }
              placeholder="e.g. api.unknown.score"
              className="rounded border border-app-border bg-app-surface px-2 py-1 font-mono"
            />
          </label>
          <label className="mt-1 flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wider text-app-text-muted">desiredToolName</span>
            <input
              required
              value={override?.desiredToolName ?? ""}
              onChange={(event) =>
                setOverride((prev) => ({
                  capability: prev?.capability ?? "",
                  desiredToolName: event.target.value,
                }))
              }
              placeholder="e.g. generated.api.unknown"
              className="rounded border border-app-border bg-app-surface px-2 py-1 font-mono"
            />
          </label>
          <div className="mt-1.5 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                setOverride(undefined);
                promote.reset();
              }}
              className="rounded border border-app-border bg-app-surface px-2 py-0.5"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={promote.isPending || !override?.capability || !override?.desiredToolName}
              className="rounded bg-app-accent px-2 py-0.5 font-semibold text-app-bg disabled:opacity-50"
            >
              {promote.isPending ? "Promoting…" : "Promote with override"}
            </button>
          </div>
        </form>
      ) : promote.isError ? (
        <p className="text-[11px] text-app-danger">{promote.error.message}</p>
      ) : null}

      <div className="mt-1 flex flex-wrap gap-2">
        {canPromote && !promote.isError ? (
          <button
            type="button"
            onClick={() => handlePromote()}
            disabled={promote.isPending}
            className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px] disabled:opacity-50 hover:border-app-accent/40"
          >
            {promote.isPending ? "Promoting…" : "Promote to Tool Build request"}
          </button>
        ) : null}
        {investigation.status === "open" ? (
          <button
            type="button"
            onClick={() => update.mutate({ id: investigation.id, update: { status: "triaged" } })}
            disabled={update.isPending}
            className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px]"
          >
            Mark triaged
          </button>
        ) : null}
        {investigation.status !== "closed" ? (
          <button
            type="button"
            onClick={() => update.mutate({ id: investigation.id, update: { status: "closed" } })}
            disabled={update.isPending}
            className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px]"
          >
            Close
          </button>
        ) : null}
        {investigation.runId ? (
          <Link
            to={`/trace/${investigation.runId}`}
            className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px] hover:border-app-accent/40"
          >
            Open in Trace Lab
          </Link>
        ) : null}
      </div>
    </article>
  );
}

function statusTone(status: ToolInvestigationRecord["status"]): "ok" | "warn" | "muted" | "running" {
  switch (status) {
    case "open":
      return "warn";
    case "triaged":
      return "running";
    case "linked_to_build":
      return "ok";
    case "closed":
      return "muted";
    default:
      return "muted";
  }
}
