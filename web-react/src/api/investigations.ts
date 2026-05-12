import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type {
  ToolInvestigationContextBundle,
  ToolInvestigationRecord,
  ToolInvestigationSource,
  ToolInvestigationStatus,
  ToolReworkWaitRecord,
} from "@/api/types";

/**
 * Phase G: the legacy `/api/tool-build-requests` endpoint and its
 * `ToolBuildRequest` shape are gone. The `/promote` endpoint that
 * used to return a `request: ToolBuildRequest` payload now returns
 * 503 with a TODO(Phase 20) marker — the council pipeline owns
 * tool builds end-to-end. This minimal stub lets the type-only
 * import keep compiling on the off-chance a server with the legacy
 * endpoint still responds with a shaped body (e.g. during a
 * staged rollout); the client treats it as opaque.
 */
type LegacyToolBuildRequestStub = { id: string; status?: string };

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
  request: LegacyToolBuildRequestStub;
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
