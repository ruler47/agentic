import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type { ToolReworkWaitRecord, ToolReworkWaitStatus } from "@/api/types";

/**
 * Closes a promoted wait so the operator can retry the original task with the
 * new tool version. The button is labelled "Mark ready for retry" — the API
 * path is still /resume for backwards compatibility, but it does NOT auto-run
 * a retry. The recursive retry engine ships in Phase 2 of the orchestrator
 * roadmap.
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolReworkWaits });
      if (data.wait.runId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.run(data.wait.runId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.runWaits(data.wait.runId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolReworkWaits });
      if (data.wait.runId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.runWaits(data.wait.runId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.run(data.wait.runId) });
      }
    },
  });
}
