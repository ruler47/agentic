import type { ReactNode } from "react";
import type { ActionProposalQueueItem } from "@/api/runs";
import { GenericBadge } from "@/components/StatusBadge";
import { truncate } from "@/lib/format";
import { buildCommitReadiness } from "./commitReadiness";

export function CommitReadinessPanel({ item }: { item: ActionProposalQueueItem }) {
  const readiness = buildCommitReadiness(item);
  return (
    <div className="mt-2 rounded-md border border-app-border bg-app-surface p-2 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-app-text-muted">
          Commit readiness
        </span>
        <GenericBadge tone={readiness.tone}>{readiness.label}</GenericBadge>
      </div>
      <p className="mt-1 text-app-text-muted">{truncate(readiness.reason, 260)}</p>
      <dl className="mt-2 grid gap-2 md:grid-cols-2">
        <ReadinessField label="Mode">
          {item.proposal.approvalRequired ? "approval required" : "automode"}
        </ReadinessField>
        <ReadinessField label="Preparation">
          {item.preparationExecution?.preparedSession ? "prepared session recorded" : "not prepared"}
        </ReadinessField>
        <ReadinessField label="Approval">{item.decision?.status ?? item.proposal.status}</ReadinessField>
        <ReadinessField label="Profile fields">
          {readiness.approvedProfileFields.length
            ? `approved: ${readiness.approvedProfileFields.join(", ")}`
            : "none approved"}
        </ReadinessField>
        <ReadinessField label="Replay">
          {readiness.replayPreparedFields.length
            ? `prepared: ${readiness.replayPreparedFields.join(", ")}`
            : "no approved fields replayed"}
        </ReadinessField>
        <ReadinessField label="Executor">{readiness.executorLabel}</ReadinessField>
        <ReadinessField label="Last commit">
          {item.execution?.status
            ? `${item.execution.status}${item.execution.toolName ? ` via ${item.execution.toolName}` : ""}`
            : "not requested"}
        </ReadinessField>
      </dl>
      {readiness.missingFields.length ? (
        <p className="mt-2 text-app-warning">
          Missing fields: {truncate(readiness.missingFields.join("; "), 220)}
        </p>
      ) : null}
      {readiness.missingReplayFields.length ? (
        <p className="mt-2 text-app-warning">
          Replay required for: {readiness.missingReplayFields.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function ReadinessField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded border border-app-border bg-app-surface-2 p-2">
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-app-text-muted">
        {label}
      </dt>
      <dd className="mt-1 break-words text-app-text">{children}</dd>
    </div>
  );
}
