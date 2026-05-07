import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type {
  AgentRunRecord,
  ConversationThreadRecord,
  RunCreateContext,
  RunCreateResponse,
} from "@/api/types";

export function useConversation(threadId: string | undefined) {
  return useQuery({
    queryKey: threadId ? queryKeys.conversation(threadId) : queryKeys.conversation("__none__"),
    enabled: Boolean(threadId),
    queryFn: () =>
      apiFetch<{ thread: ConversationThreadRecord }>(
        `/api/conversation-threads/${encodeURIComponent(threadId!)}`,
      ).then((data) => data.thread),
    refetchInterval: 10_000,
  });
}

export function useDeleteConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) =>
      apiFetch<{ deleted: boolean }>(
        `/api/conversation-threads/${encodeURIComponent(threadId)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
    },
  });
}

export type CreateContinuationInput = {
  threadId: string;
  task: string;
} & Partial<RunCreateContext>;

export function useCreateContinuationRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, ...body }: CreateContinuationInput) =>
      apiFetch<RunCreateResponse>(
        `/api/conversation-threads/${encodeURIComponent(threadId)}/runs`,
        { method: "POST", body },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversation(variables.threadId) });
    },
  });
}

/**
 * Artifacts don't have their own list endpoint — they are inlined inside each
 * run's `result.artifacts`. Phase 5 builds a flat browse view from the runs
 * cache by walking every run that has artifacts and tagging the source run.
 */
export function flattenArtifactsFromRuns(runs: AgentRunRecord[] | undefined) {
  if (!runs) return [];
  const all: Array<{
    artifact: NonNullable<AgentRunRecord["result"]>["artifacts"] extends (infer T)[] | undefined ? T : never;
    run: AgentRunRecord;
  }> = [];
  for (const run of runs) {
    const artifacts = run.result?.artifacts ?? [];
    for (const artifact of artifacts) {
      all.push({ artifact, run });
    }
  }
  return all.sort((a, b) => b.artifact.createdAt.localeCompare(a.artifact.createdAt));
}
