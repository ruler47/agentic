import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type {
  MemoryScope,
  MemorySensitivity,
  MemoryStatus,
  SkillMemoryEntry,
} from "@/api/types";

export type MemoryReviewEntry = {
  memory?: SkillMemoryEntry;
  warnings: string[];
  status?: string;
  recommendedAction?: string;
  findings?: MemoryReviewFinding[];
  conflicts?: Array<{ id: string; reason: string }>;
};

export type MemoryReviewFinding = {
  code: string;
  severity: "info" | "warning" | "blocked";
  message: string;
};

type ServerMemoryReviewEntry = {
  memoryId: string;
  status: "ready" | "needs_review" | "blocked";
  findings: MemoryReviewFinding[];
  recommendedAction: string;
};

type MemoryReviewQueueResponse = {
  memories?: SkillMemoryEntry[];
  reviews?: ServerMemoryReviewEntry[];
};

export function useMemories() {
  return useQuery({
    queryKey: queryKeys.memories,
    queryFn: () =>
      apiFetch<{ memories: SkillMemoryEntry[] }>("/api/memories").then(
        (data) => data.memories ?? [],
      ),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

export function useMemoryReviews() {
  return useQuery({
    queryKey: queryKeys.memoryReviews,
    queryFn: () =>
      apiFetch<MemoryReviewQueueResponse>("/api/memories/review-queue").then(normalizeMemoryReviewQueue),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

export function normalizeMemoryReviewQueue(data: MemoryReviewQueueResponse): MemoryReviewEntry[] {
  const memoriesById = new Map((data.memories ?? []).map((memory) => [memory.id, memory]));
  return (data.reviews ?? []).map((review) => ({
    memory: memoriesById.get(review.memoryId),
    warnings: review.findings.map((finding) => finding.message),
    status: review.status,
    recommendedAction: review.recommendedAction,
    findings: review.findings,
  }));
}

export type UpdateMemoryInput = {
  id: string;
  update: {
    title?: string;
    summary?: string;
    reusableProcedure?: string;
    tags?: string[];
    scope?: MemoryScope;
    scopeId?: string | null;
    status?: MemoryStatus;
    confidence?: number;
    sensitivity?: MemorySensitivity;
    evidence?: string[];
  };
};

export function useUpdateMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: UpdateMemoryInput) =>
      apiFetch<{ memory: SkillMemoryEntry }>(
        `/api/memories/${encodeURIComponent(id)}`,
        { method: "PATCH", body: update },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.memories });
      void queryClient.invalidateQueries({ queryKey: queryKeys.memoryReviews });
    },
  });
}

export function useRebuildMemoryEmbeddings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ updated: number }>("/api/memories/reembed", { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.memories });
    },
  });
}

export type MemoryRetrievalEvaluationCase = {
  id: string;
  query: string;
  expectedMemoryIds: string[];
  limit?: number;
  minRecall?: number;
};

export type MemoryRetrievalEvaluationSummary = {
  passed: boolean;
  totalCases: number;
  passedCases: number;
  averageRecall: number;
  results: Array<{
    caseId: string;
    query: string;
    passed: boolean;
    recall: number;
    topHitMatched: boolean;
    expectedMemoryIds: string[];
    retrievedMemoryIds: string[];
    missingMemoryIds: string[];
    limit: number;
  }>;
};

export function useEvaluateMemoryRetrieval() {
  return useMutation({
    mutationFn: (cases: MemoryRetrievalEvaluationCase[]) =>
      apiFetch<MemoryRetrievalEvaluationSummary>("/api/memories/evaluate-retrieval", {
        method: "POST",
        body: { cases },
      }),
  });
}
