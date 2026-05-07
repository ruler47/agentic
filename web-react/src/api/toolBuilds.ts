import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type {
  ToolBuildQaReport,
  ToolBuildRequest,
  ToolBuildRequestInput,
  ToolBuildRequestStatus,
} from "@/api/types";

/**
 * The server-side parser infers `capability` from displayName + reason when
 * the operator omits it, so the React shape is wider than the strict
 * `ToolBuildRequestInput` from the backend. We expose an optional `capability`
 * here on purpose.
 */
export type CreateToolBuildRequestInput = Omit<ToolBuildRequestInput, "capability"> & {
  capability?: string;
};

export function useCreateToolBuildRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateToolBuildRequestInput) =>
      apiFetch<{ request: ToolBuildRequest }>("/api/tool-build-requests", {
        method: "POST",
        body: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolBuildRequests });
    },
  });
}

export function useRunToolBuild() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{
        request: ToolBuildRequest;
        registeredToolName?: string;
        activationReport?: { ok: boolean; checks: string[] };
      }>(`/api/tool-build-requests/${encodeURIComponent(id)}/run`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolBuildRequests });
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolReworkWaits });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tools });
    },
  });
}

export function useStopToolBuild() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      apiFetch<{ request: ToolBuildRequest }>(
        `/api/tool-build-requests/${encodeURIComponent(id)}/stop`,
        { method: "POST", body: { reason } },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolBuildRequests });
    },
  });
}

export function useDeleteToolBuild() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ deleted: boolean }>(`/api/tool-build-requests/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolBuildRequests });
    },
  });
}

export function useReworkToolBuild() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, feedback }: { id: string; feedback: string }) =>
      apiFetch<{ request: ToolBuildRequest; original: ToolBuildRequest }>(
        `/api/tool-build-requests/${encodeURIComponent(id)}/rework`,
        { method: "POST", body: { feedback } },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolBuildRequests });
    },
  });
}

export const TOOL_BUILD_STATUSES: ToolBuildRequestStatus[] = [
  "requested",
  "building",
  "qa_failed",
  "qa_passed",
  "registered",
  "blocked",
];

export function describeBuildStatus(status: ToolBuildRequestStatus): string {
  switch (status) {
    case "requested":
      return "Real request waiting to be claimed by the background builder or a manual run.";
    case "building":
      return "Builder is generating or revising TypeScript source and tests.";
    case "qa_failed":
      return "Build ran, but tests or QA rejected it; feedback should drive a revision.";
    case "qa_passed":
      return "QA passed; the module is ready for registration/promotion.";
    case "registered":
      return "Tool metadata is registered and can be loaded by the runtime.";
    case "blocked":
      return "The request needs missing docs, credentials, provider support, or a human decision.";
  }
}

export function buildHasActivationFailure(qaReport?: ToolBuildQaReport): boolean {
  if (!qaReport?.checks) return false;
  return qaReport.checks.some((check) => /^activation fail:/i.test(check));
}
