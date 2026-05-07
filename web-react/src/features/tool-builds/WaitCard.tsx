import { Link } from "react-router-dom";

import { useResumeReworkWait, useUpdateReworkWait } from "@/api/reworkWaits";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";
import type { ToolReworkWaitRecord } from "@/api/types";

type WaitCardProps = {
  wait: ToolReworkWaitRecord;
};

export function WaitCard({ wait }: WaitCardProps) {
  const resume = useResumeReworkWait();
  const update = useUpdateReworkWait();

  const canResume = wait.status === "promoted";
  const canCancel = wait.status !== "resumed" && wait.status !== "cancelled";

  return (
    <article className="flex flex-col gap-2 rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <div className="flex items-center justify-between">
        <GenericBadge tone={statusTone(wait.status)}>{wait.status}</GenericBadge>
        <span className="text-[10px] text-app-text-muted">
          {formatRelative(wait.updatedAt ?? wait.createdAt)}
        </span>
      </div>
      <strong className="text-sm leading-tight">
        {wait.toolName ? (
          <>
            Tool: <code>{wait.toolName}</code>
          </>
        ) : (
          "Tool: not matched"
        )}
      </strong>
      {wait.toolVersion ? (
        <p className="text-[11px] text-app-text-muted">
          Version: {wait.toolVersion}
          {wait.promotedVersion ? ` → ${wait.promotedVersion}` : ""}
        </p>
      ) : null}
      <p className="text-[11px] text-app-text-muted">
        Run:{" "}
        <Link to={`/run/${wait.runId}`} className="text-app-accent underline">
          {wait.runId}
        </Link>
      </p>
      {wait.investigationId ? (
        <p className="text-[11px] text-app-text-muted">
          Investigation: <code>{wait.investigationId}</code>
        </p>
      ) : null}
      {wait.buildRequestId ? (
        <p className="text-[11px] text-app-text-muted">
          Build: <code>{wait.buildRequestId}</code>
        </p>
      ) : null}
      <p className="whitespace-pre-wrap text-[11px]">{truncate(wait.reason, 240)}</p>
      <div className="mt-1 flex flex-wrap gap-2">
        {canResume ? (
          <button
            type="button"
            onClick={() => resume.mutate({ id: wait.id })}
            disabled={resume.isPending}
            className="rounded-md bg-app-accent px-2.5 py-1 text-[11px] font-semibold text-app-bg disabled:opacity-50"
            title="Closes the wait. Run returns to failed so an operator can re-issue the task with the new tool version. Automatic retry is handled by the separate retry flow."
          >
            {resume.isPending ? "Closing…" : "Mark ready for retry"}
          </button>
        ) : null}
        {canCancel ? (
          <button
            type="button"
            onClick={() => {
              if (!window.confirm("Cancel this tool rework wait? The run remains in waiting state until manually closed.")) {
                return;
              }
              update.mutate({
                id: wait.id,
                update: { status: "cancelled", reason: "Operator cancelled the wait." },
              });
            }}
            disabled={update.isPending}
            className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px]"
          >
            Cancel wait
          </button>
        ) : null}
        <Link
          to={`/trace/${wait.runId}`}
          className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px] hover:border-app-accent/40"
        >
          Open Trace Lab
        </Link>
      </div>
      {[resume.error, update.error]
        .filter((error): error is Error => Boolean(error))
        .map((error, index) => (
          <p key={index} className="text-[11px] text-app-danger">
            {error.message}
          </p>
        ))}
    </article>
  );
}

function statusTone(status: ToolReworkWaitRecord["status"]): "ok" | "warn" | "danger" | "muted" | "running" {
  switch (status) {
    case "promoted":
      return "ok";
    case "waiting":
    case "build_running":
      return "warn";
    case "failed":
      return "danger";
    case "resumed":
    case "cancelled":
      return "muted";
    default:
      return "muted";
  }
}
