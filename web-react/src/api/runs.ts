import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type {
  AgentRunRecord,
  RunCreateContext,
  RunCreateResponse,
  RunDetailResponse,
  RunListResponse,
  ToolReworkWaitRecord,
} from "@/api/types";

export function useRuns() {
  return useQuery({
    queryKey: queryKeys.runs,
    queryFn: () => apiFetch<RunListResponse>("/api/runs").then((data) => data.runs ?? []),
    refetchInterval: 5_000,
  });
}

export function useRun(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.run(id) : queryKeys.run("__none__"),
    enabled: Boolean(id),
    queryFn: () =>
      apiFetch<RunDetailResponse>(`/api/runs/${encodeURIComponent(id!)}`).then((data) => data.run),
    // Refetch interval is short while we're waiting for SSE wiring; once we
    // hook EventSource the interval can drop to 0 (refetchInterval: false).
    refetchInterval: 5_000,
  });
}

export function useRunWaits(runId: string | undefined) {
  return useQuery({
    queryKey: runId ? queryKeys.runWaits(runId) : queryKeys.runWaits("__none__"),
    enabled: Boolean(runId),
    queryFn: () =>
      apiFetch<{ waits: ToolReworkWaitRecord[] }>(
        `/api/runs/${encodeURIComponent(runId!)}/tool-rework-waits`,
      ).then((data) => data.waits ?? []),
    refetchInterval: 10_000,
  });
}

export type CreateRunInput = {
  task: string;
} & Partial<RunCreateContext>;

export function useCreateRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRunInput) =>
      apiFetch<RunCreateResponse>("/api/runs", { method: "POST", body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
    },
  });
}

/**
 * Phase 13 follow-up: delete a single artifact (metadata + object).
 * Invalidates the runs query so the Artifacts page re-fetches and the
 * card disappears.
 */
export function useDeleteArtifact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, artifactId }: { runId: string; artifactId: string }) =>
      apiFetch<{ deleted: boolean; id: string; runId: string }>(
        `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
    },
  });
}

export function useCancelRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      apiFetch<RunDetailResponse>(`/api/runs/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        body: { reason: reason ?? "Operator cancelled the run." },
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.run(data.run.id), data.run);
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
    },
  });
}

export type RestartRunResponse = {
  source: AgentRunRecord;
  restart: AgentRunRecord;
};

/**
 * Phase 12 follow-up: restart an interrupted / failed / cancelled / stuck
 * run. The server creates a fresh run with the same task (and parentRunId
 * pointing at the source). Stuck `running` / `queued` runs older than the
 * stale threshold are recovered first; truly active runs are rejected with
 * 409 so operators must cancel them explicitly.
 */
export function useRestartRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<RestartRunResponse>(`/api/runs/${encodeURIComponent(id)}/restart`, {
        method: "POST",
        body: {},
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.run(data.source.id), data.source);
      queryClient.setQueryData(queryKeys.run(data.restart.id), data.restart);
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
    },
  });
}

export type ResumeRunResponse = {
  source: AgentRunRecord;
  resume: AgentRunRecord;
  fallback: "resume" | "restart";
  progress: {
    hasComplexity: boolean;
    subtaskCount: number;
    passedSubtaskCount: number;
    lastEventType?: string;
  };
};

/**
 * Phase 12 follow-up: resume an interrupted run from the point of failure
 * instead of redoing every phase. The server replays events to recover
 * classification / plan / completed subtasks, then runs only what's
 * missing. Falls back to a regular restart when the source has no
 * meaningful progress (e.g., the classifier never finished).
 */
export function useResumeRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<ResumeRunResponse>(`/api/runs/${encodeURIComponent(id)}/resume`, {
        method: "POST",
        body: {},
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.run(data.source.id), data.source);
      queryClient.setQueryData(queryKeys.run(data.resume.id), data.resume);
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
    },
  });
}

// Convenience selectors used by Dashboard / Runs / Run Workspace --------

export function selectActiveRuns(runs: AgentRunRecord[] | undefined): AgentRunRecord[] {
  if (!runs) return [];
  return runs.filter((run) => run.status === "queued" || run.status === "running");
}

export function selectRecentRuns(runs: AgentRunRecord[] | undefined, limit = 8): AgentRunRecord[] {
  if (!runs) return [];
  return [...runs]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}
