import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type {
  EvidenceCreateInput,
  EvidenceRecord,
  RunRetrospectiveRecord,
  RunRetrospectiveUpdateInput,
  WorkClaim,
  WorkLedgerItem,
  WorkLedgerUpdateInput,
} from "@/api/types";

export type LedgerScope = {
  runId?: string;
  threadId?: string;
  workKey?: string;
  workItemId?: string;
  artifactId?: string;
  sourceUrl?: string;
};

export type ClaimWorkInput = Omit<WorkClaim, "kind"> & {
  kind:
    | "search"
    | "url_visit"
    | "api_call"
    | "browser_screenshot"
    | "artifact_generation"
    | "file_read"
    | "file_write"
    | "tool_call"
    | "other";
  workKeyParts?: Record<string, unknown>;
  taskSummary: string;
  requestedBy: string;
  ownerSpanId: string;
};

export type WorkClaimResponse = {
  item: WorkLedgerItem;
  decision: {
    status: string;
    reason: string;
    confidence?: number;
    storeDecision?: string;
    activeWorkItemId?: string;
  };
  reusableEvidence: EvidenceRecord[];
};

export function useWorkLedger(scope: LedgerScope) {
  const query = scopeToQuery(scope, ["runId", "threadId", "workKey"]);
  return useQuery({
    queryKey: queryKeys.workLedger(query),
    queryFn: () => apiFetch<{ items: WorkLedgerItem[] }>(`/api/work-ledger?${query}`).then((data) => data.items ?? []),
    enabled: Boolean(query),
    refetchInterval: 5_000,
  });
}

export function useEvidenceLedger(scope: LedgerScope) {
  const query = scopeToQuery(scope, ["runId", "threadId", "workItemId", "artifactId", "sourceUrl"]);
  return useQuery({
    queryKey: queryKeys.evidenceLedger(query),
    queryFn: () => apiFetch<{ records: EvidenceRecord[] }>(`/api/evidence-ledger?${query}`).then((data) => data.records ?? []),
    enabled: Boolean(query),
    refetchInterval: 5_000,
  });
}

export function useRunRetrospectives(scope: LedgerScope) {
  const query = scopeToQuery(scope, ["runId", "threadId"]);
  return useQuery({
    queryKey: queryKeys.runRetrospectives(query),
    queryFn: () => apiFetch<{ records: RunRetrospectiveRecord[] }>(`/api/run-retrospectives?${query}`).then((data) => data.records ?? []),
    enabled: Boolean(query),
    refetchInterval: 10_000,
  });
}

export function useClaimWork(scope: LedgerScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ClaimWorkInput) =>
      apiFetch<WorkClaimResponse>("/api/work-ledger/claim", {
        method: "POST",
        body: input,
      }),
    onSuccess: () => invalidateLedgerQueries(queryClient, scope),
  });
}

export function useUpdateWorkItem(scope: LedgerScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: WorkLedgerUpdateInput }) =>
      apiFetch<{ item: WorkLedgerItem }>(`/api/work-ledger/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: update,
      }).then((data) => data.item),
    onSuccess: () => invalidateLedgerQueries(queryClient, scope),
  });
}

export function useCreateEvidence(scope: LedgerScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: EvidenceCreateInput) =>
      apiFetch<{ record: EvidenceRecord }>("/api/evidence-ledger", {
        method: "POST",
        body: input,
      }).then((data) => data.record),
    onSuccess: () => invalidateLedgerQueries(queryClient, scope),
  });
}

export function useUpdateRetrospective(scope: LedgerScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: RunRetrospectiveUpdateInput }) =>
      apiFetch<{ record: RunRetrospectiveRecord }>(`/api/run-retrospectives/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: update,
      }).then((data) => data.record),
    onSuccess: () => invalidateLedgerQueries(queryClient, scope),
  });
}

function scopeToQuery(scope: LedgerScope, keys: Array<keyof LedgerScope>): string {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = scope[key];
    if (typeof value === "string" && value.trim()) {
      params.set(key, value.trim());
      break;
    }
  }
  return params.toString();
}

function invalidateLedgerQueries(queryClient: ReturnType<typeof useQueryClient>, scope: LedgerScope) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.workLedger(scopeToQuery(scope, ["runId", "threadId", "workKey"])) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.evidenceLedger(scopeToQuery(scope, ["runId", "threadId", "workItemId", "artifactId", "sourceUrl"])) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.runRetrospectives(scopeToQuery(scope, ["runId", "threadId"])) });
}
