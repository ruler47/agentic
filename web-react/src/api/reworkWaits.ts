import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type { AgentRunRecord, ToolReworkWaitRecord, ToolReworkWaitStatus } from "@/api/types";

type RetryRunResponse = {
  wait: ToolReworkWaitRecord;
  retryRun?: AgentRunRecord;
  alreadyExists?: boolean;
};

type AutoRetryResponse = RetryRunResponse & {
  status: string;
  policy?: unknown;
  retryDepth?: number;
  reason?: string;
};

function refreshWaitCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  wait: ToolReworkWaitRecord,
  retryRun?: AgentRunRecord,
) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.toolReworkWaits });
  void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
  if (wait.runId) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.run(wait.runId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runWaits(wait.runId) });
  }
  if (retryRun) {
    queryClient.setQueryData(queryKeys.run(retryRun.id), retryRun);
  }
}

/**
 * Closes a promoted wait so the operator can retry the original task with the
 * new tool version. The button is labelled "Mark ready for retry" — the API
 * path is still /resume for backwards compatibility, but it does NOT auto-run
 * a retry. Automatic retry uses the separate retry/auto-retry endpoints.
 */
export function useResumeReworkWait() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      retryRunId,
      reason,
    }: {
      id: string;
      retryRunId?: string;
      reason?: string;
    }) =>
      apiFetch<{ wait: ToolReworkWaitRecord }>(
        `/api/tool-rework-waits/${encodeURIComponent(id)}/resume`,
        { method: "POST", body: { retryRunId, reason } },
      ),
    onSuccess: (data) => {
      refreshWaitCaches(queryClient, data.wait);
    },
  });
}

export function useCreateRetryRunForWait() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      apiFetch<RetryRunResponse>(
        `/api/tool-rework-waits/${encodeURIComponent(id)}/retry-run`,
        { method: "POST", body: { reason } },
      ),
    onSuccess: (data) => {
      refreshWaitCaches(queryClient, data.wait, data.retryRun);
    },
  });
}

export function useAutoRetryReworkWait() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      apiFetch<AutoRetryResponse>(
        `/api/tool-rework-waits/${encodeURIComponent(id)}/auto-retry`,
        { method: "POST", body: {} },
      ),
    onSuccess: (data) => {
      if (data.wait) {
        refreshWaitCaches(queryClient, data.wait, data.retryRun);
      }
    },
  });
}

export function useUpdateReworkWait() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      update,
    }: {
      id: string;
      update: {
        status?: ToolReworkWaitStatus;
        reason?: string;
        buildRequestId?: string | null;
        investigationId?: string | null;
        promotedVersion?: string | null;
        retryRunId?: string | null;
        retrySpanId?: string | null;
      };
    }) =>
      apiFetch<{ wait: ToolReworkWaitRecord }>(
        `/api/tool-rework-waits/${encodeURIComponent(id)}`,
        { method: "PATCH", body: update },
      ),
    onSuccess: (data) => {
      refreshWaitCaches(queryClient, data.wait);
    },
  });
}
