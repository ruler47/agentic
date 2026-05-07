import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type {
  ToolBuildRequest,
  ToolInvestigationContextBundle,
  ToolInvestigationRecord,
  ToolInvestigationSource,
  ToolInvestigationStatus,
  ToolReworkWaitRecord,
} from "@/api/types";

export type CreateInvestigationInput = {
  source: ToolInvestigationSource;
  title: string;
  operatorComment?: string;
  runId?: string;
  spanId?: string;
  toolName?: string;
  toolVersion?: string;
  artifactIds?: string[];
  contextBundle?: ToolInvestigationContextBundle;
};

export function useCreateInvestigation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInvestigationInput) =>
      apiFetch<{ investigation: ToolInvestigationRecord }>("/api/tool-investigations", {
        method: "POST",
        body: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolInvestigations });
    },
  });
}

export type UpdateInvestigationInput = {
  status?: ToolInvestigationStatus;
  operatorComment?: string;
  linkedBuildRequestId?: string | null;
};

export function useUpdateInvestigation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: UpdateInvestigationInput }) =>
      apiFetch<{ investigation: ToolInvestigationRecord }>(
        `/api/tool-investigations/${encodeURIComponent(id)}`,
        { method: "PATCH", body: update },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolInvestigations });
    },
  });
}

export type PromoteInvestigationInput = {
  id: string;
  operatorComment?: string;
  /**
   * Operator override fields that the server requires when the investigation
   * does not point at a registered tool. Without these the server returns 400
   * with `code=investigation_promotion_ambiguous`.
   */
  capability?: string;
  desiredToolName?: string;
};

export type PromoteInvestigationResponse = {
  investigation: ToolInvestigationRecord;
  request: ToolBuildRequest;
  wait?: ToolReworkWaitRecord;
};

export class InvestigationPromotionAmbiguousError extends Error {
  readonly code = "investigation_promotion_ambiguous" as const;
}

export function usePromoteInvestigation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: PromoteInvestigationInput) => {
      try {
        return await apiFetch<PromoteInvestigationResponse>(
          `/api/tool-investigations/${encodeURIComponent(id)}/promote`,
          { method: "POST", body },
        );
      } catch (error) {
        if (error instanceof ApiError) {
          const payload = error.body as { code?: string; error?: string } | undefined;
          if (payload?.code === "investigation_promotion_ambiguous") {
            const message = typeof payload.error === "string" ? payload.error : error.message;
            const ambiguous = new InvestigationPromotionAmbiguousError(message);
            (ambiguous as Error & { status?: number }).status = error.status;
            throw ambiguous;
          }
        }
        throw error;
      }
    },
    onSuccess: (data) => {
      // Refresh every cache the promote can touch.
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolInvestigations });
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolBuildRequests });
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolReworkWaits });
      if (data.wait?.runId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.run(data.wait.runId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.runWaits(data.wait.runId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
      }
    },
  });
}
