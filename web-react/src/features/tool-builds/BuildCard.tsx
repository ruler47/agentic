import { useState } from "react";

import {
  buildHasActivationFailure,
  useDeleteToolBuild,
  useReworkToolBuild,
  useRunToolBuild,
  useStopToolBuild,
} from "@/api/toolBuilds";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";
import type { ToolBuildRequest, ToolBuildRequestStatus, ToolReworkWaitRecord } from "@/api/types";

type BuildCardProps = {
  request: ToolBuildRequest;
  linkedWaits: ToolReworkWaitRecord[];
};

const RUNNABLE_STATUSES: ToolBuildRequestStatus[] = ["requested", "qa_failed", "blocked"];

export function BuildCard({ request, linkedWaits }: BuildCardProps) {
  const runBuild = useRunToolBuild();
  const stopBuild = useStopToolBuild();
  const deleteBuild = useDeleteToolBuild();
  const rework = useReworkToolBuild();
  const [reworkOpen, setReworkOpen] = useState(false);
  const [feedback, setFeedback] = useState("");

  const activationFailed = buildHasActivationFailure(request.qaReport);

  return (
    <article className="flex flex-col gap-2 rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <div className="flex items-center justify-between">
        <GenericBadge tone={statusTone(request.status)}>{request.status}</GenericBadge>
        <span className="text-[10px] text-app-text-muted">
          {formatRelative(request.updatedAt ?? request.createdAt)}
        </span>
      </div>
      <strong className="text-sm leading-tight">
        {request.displayName || request.capability}
      </strong>
      <p className="text-[11px] text-app-text-muted">
        capability: <code>{request.capability}</code>
      </p>
      <p className="text-[11px] text-app-text-muted">
        run mode: {request.contract?.startupMode ?? "on-demand"}
      </p>
      <p className="whitespace-pre-wrap text-[11px]">{truncate(request.reason, 240)}</p>
      <p className="break-all font-mono text-[10px] text-app-text-muted">
        {request.contract?.toolName ?? "tool contract pending"}
      </p>
      {request.statusDetail ? (
        <p className="text-[11px] text-app-text-muted">
          Status detail: {truncate(request.statusDetail, 180)}
        </p>
      ) : null}
      {request.qaReport ? (
        <p className="text-[11px] text-app-text-muted">
          QA: {truncate(request.qaReport.summary, 180)}
        </p>
      ) : null}
      {activationFailed ? (
        <p className="rounded bg-app-danger-soft px-2 py-1 text-[11px] text-app-danger">
          Activation failed; see QA evidence.
        </p>
      ) : null}

      {linkedWaits.length > 0 ? (
        <div className="rounded-md border border-app-warning/40 bg-app-warning-soft p-2 text-[11px]">
          <p className="font-semibold text-app-warning">Linked rework wait{linkedWaits.length > 1 ? "s" : ""}</p>
          <ul className="mt-1 space-y-0.5">
            {linkedWaits.map((wait) => (
              <li key={wait.id}>
                <span className="font-mono">{wait.id}</span>
                <span className="ml-1 text-app-text-muted">
                  · run {wait.runId} · {wait.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-1 flex flex-wrap gap-2">
        {RUNNABLE_STATUSES.includes(request.status) ? (
          <button
            type="button"
            onClick={() => runBuild.mutate(request.id)}
            disabled={runBuild.isPending}
            className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px] disabled:opacity-50 hover:border-app-accent/40"
          >
            {runBuild.isPending ? "Running…" : "Run builder"}
          </button>
        ) : null}
        {request.status !== "registered" ? (
          <button
            type="button"
            onClick={() => stopBuild.mutate({ id: request.id, reason: "Stopped from Tool Builds UI." })}
            disabled={stopBuild.isPending}
            className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px]"
          >
            Stop
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            if (window.confirm("Delete this tool build request from the queue?")) {
              deleteBuild.mutate(request.id);
            }
          }}
          disabled={deleteBuild.isPending}
          className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px] text-app-danger hover:border-app-danger/40"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={() => setReworkOpen((prev) => !prev)}
          className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px]"
        >
          {reworkOpen ? "Cancel rework" : "Create revision request"}
        </button>
      </div>

      {reworkOpen ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!feedback.trim() || rework.isPending) return;
            rework.mutate(
              { id: request.id, feedback: feedback.trim() },
              {
                onSuccess: () => {
                  setFeedback("");
                  setReworkOpen(false);
                },
              },
            );
          }}
          className="rounded-md border border-app-border bg-app-surface p-2 text-[11px]"
        >
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wider text-app-text-muted">
              Operator feedback
            </span>
            <textarea
              rows={3}
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder={suggestPlaceholder(request)}
              className="resize-y rounded border border-app-border bg-app-surface-2 px-2 py-1 outline-none focus:border-app-accent/60"
              required
            />
          </label>
          <div className="mt-1.5 flex justify-end gap-1.5">
            <button
              type="submit"
              disabled={rework.isPending || !feedback.trim()}
              className="rounded bg-app-accent px-2 py-0.5 font-semibold text-app-bg disabled:opacity-50"
            >
              {rework.isPending ? "Creating…" : "Create rework request"}
            </button>
          </div>
          {rework.isError ? (
            <p className="mt-1 text-[11px] text-app-danger">{rework.error.message}</p>
          ) : null}
        </form>
      ) : null}

      {[runBuild.error, stopBuild.error, deleteBuild.error]
        .filter((error): error is Error => Boolean(error))
        .map((error, index) => (
          <p key={index} className="text-[11px] text-app-danger">
            {error.message}
          </p>
        ))}
    </article>
  );
}

function suggestPlaceholder(request: ToolBuildRequest): string {
  const activationCheck = request.qaReport?.checks?.find((check) =>
    /^activation fail:/i.test(check),
  );
  if (activationCheck) {
    return `Describe the runtime activation fix you want.\nCurrent blocker: ${
      request.statusDetail || request.qaReport?.summary || activationCheck
    }`;
  }
  if (request.statusDetail || request.qaReport?.summary) {
    return [
      "Describe what should be changed, fixed, retested, or redesigned.",
      request.statusDetail ? `Current status: ${request.statusDetail}` : undefined,
      request.qaReport?.summary ? `QA summary: ${request.qaReport.summary}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return "What should be changed, fixed, retested, or redesigned?";
}

function statusTone(status: ToolBuildRequestStatus): "ok" | "warn" | "danger" | "muted" | "running" {
  switch (status) {
    case "registered":
      return "ok";
    case "qa_passed":
      return "ok";
    case "qa_failed":
      return "danger";
    case "blocked":
      return "danger";
    case "building":
      return "running";
    case "requested":
      return "warn";
    default:
      return "muted";
  }
}
