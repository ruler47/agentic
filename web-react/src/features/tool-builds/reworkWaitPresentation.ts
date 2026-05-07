import type { ToolReworkWaitRecord } from "@/api/types";

export function isAutoRetryWait(wait: ToolReworkWaitRecord): boolean {
  return /Auto retry after tool rework promotion/i.test(wait.reason ?? "");
}

export function retryRunLabel(wait: ToolReworkWaitRecord): string {
  return isAutoRetryWait(wait) ? "Auto retry run" : "Retry run";
}

export function canCreateRetryRun(wait: ToolReworkWaitRecord): boolean {
  return wait.status === "promoted" && !wait.retryRunId;
}
