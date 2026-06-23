import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type {
  AgentRunRecord,
  ExternalActionPreparedSession,
  ExternalActionProposal,
  ExternalActionBlocker,
  ExternalActionFinalReportStatus,
  RunCreateContext,
  RunCreateResponse,
  RunDetailResponse,
  RunListResponse,
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

export type ActionProposalQueueItem = {
  proposal: ExternalActionProposal;
  run: {
    id: string;
    task: string;
    status: AgentRunRecord["status"];
    createdAt: string;
    updatedAt: string;
    requesterUserId?: string;
    channel?: string;
    threadId?: string;
  };
  decision?: {
    status: "approved" | "rejected";
    reason?: string;
    decidedAt: string;
    decidedBy: string;
  };
  execution?: {
    status: "blocked" | "committed" | "failed";
    reason?: string;
    decidedAt: string;
    actor: string;
    toolName?: string;
    toolVersion?: string;
    contentPreview?: string;
    dataPreview?: unknown;
    blocker?: ExternalActionBlocker;
  };
  preparationExecution?: {
    status: "completed" | "failed";
    reason?: string;
    decidedAt: string;
    actor: string;
    toolName?: string;
    toolVersion?: string;
    contentPreview?: string;
    dataPreview?: unknown;
    artifactIds?: string[];
    preparedSession?: ExternalActionPreparedSession;
    blocker?: ExternalActionBlocker;
  };
  profileHydration?: {
    status: "approved";
    reason?: string;
    approvedAt: string;
    approvedBy: string;
    fields: Array<{
      field: string;
      label?: string;
      source: "user_profile" | "group_profile";
      valuePreview: string;
    }>;
  };
  executorBuild?: {
    status: "needed" | "requested" | "registered" | "failed" | "attached";
    reason?: string;
    toolName: string;
    toolVersion: string;
    request: string;
    capabilities: string[];
    runId?: string;
    creationId?: string;
    packageRef?: string;
    commitExecutor?: ExternalActionProposal["commitExecutor"];
    updatedAt: string;
  };
  finalReport?: {
    status: ExternalActionFinalReportStatus;
    summary: string;
    target?: string;
    targetUrl?: string;
    action: string;
    blocker?: ExternalActionBlocker;
    nextAction?: string;
    proofArtifactIds: string[];
    diagnosticArtifactIds: string[];
    createdAt: string;
  };
};

export function useActionProposals() {
  return useQuery({
    queryKey: queryKeys.actionProposals,
    queryFn: () =>
      apiFetch<{ proposals: ActionProposalQueueItem[] }>("/api/action-proposals").then(
        (data) => data.proposals ?? [],
      ),
    refetchInterval: 5_000,
  });
}

export function useCreateFixtureActionProposal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ proposal: ActionProposalQueueItem }>("/api/action-proposals/fixture", {
        method: "POST",
        body: {},
      }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.actionProposals });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.run(data.proposal.run.id) });
    },
  });
}

export function useActionProposalDecision() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision, reason }: { id: string; decision: "approve" | "reject"; reason?: string }) =>
      apiFetch<{ proposal: ActionProposalQueueItem }>(
        `/api/action-proposals/${encodeURIComponent(id)}/${decision}`,
        { method: "POST", body: { reason } },
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.actionProposals });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.run(data.proposal.run.id) });
    },
  });
}

export function useActionProposalCommit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason, input, toolInput }: { id: string; reason?: string; input?: Record<string, unknown>; toolInput?: Record<string, unknown> }) =>
      apiFetch<{ proposal: ActionProposalQueueItem }>(
        `/api/action-proposals/${encodeURIComponent(id)}/commit`,
        { method: "POST", body: { reason, ...(input ? { input } : {}), ...(toolInput ? { toolInput } : {}) } },
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.actionProposals });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.run(data.proposal.run.id) });
    },
  });
}

export function useActionProposalPrepare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, mode }: { id: string; mode?: "prepare" | "replay" }) =>
      apiFetch<{ proposal: ActionProposalQueueItem }>(
        `/api/action-proposals/${encodeURIComponent(id)}/prepare`,
        { method: "POST", body: mode === "replay" ? { mode: "replay" } : {} },
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.actionProposals });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.run(data.proposal.run.id) });
    },
  });
}

export function useActionProposalProfileHydrationApproval() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, fields, reason }: { id: string; fields: string[]; reason?: string }) =>
      apiFetch<{ proposal: ActionProposalQueueItem }>(
        `/api/action-proposals/${encodeURIComponent(id)}/profile-hydration/approve`,
        { method: "POST", body: { fields, reason } },
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.actionProposals });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.run(data.proposal.run.id) });
    },
  });
}

export function useActionProposalExecutorBuild() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, mode = "create", authoringMode, activateOnSuccess }: { id: string; mode?: "create" | "plan"; authoringMode?: "auto" | "llm" | "scaffold"; activateOnSuccess?: boolean }) =>
      apiFetch<{ proposal: ActionProposalQueueItem }>(
        `/api/action-proposals/${encodeURIComponent(id)}/build-executor`,
        { method: "POST", body: { mode, ...(authoringMode ? { authoringMode } : {}), ...(activateOnSuccess ? { activateOnSuccess } : {}) } },
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.actionProposals });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.run(data.proposal.run.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolCreations });
    },
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
