/**
 * Read-only React Query hooks for the rest of the app surface.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type {
  AuditEventRecord,
  ConversationThreadRecord,
  GroupProfileUpdateInput,
} from "@/api/types";

export type GroupProfile = {
  id: string;
  instanceId: string;
  name: string;
  description: string;
  preferences: Record<string, unknown>;
};

export type InstanceInfo = {
  id: string;
  name: string;
  defaultLanguage: string;
  timeZone: string;
  locale: string;
};

export function useInstance() {
  return useQuery({
    queryKey: queryKeys.instance,
    queryFn: () => apiFetch<{ instance: InstanceInfo }>("/api/instance").then((data) => data.instance),
    staleTime: 60_000,
    refetchInterval: false,
  });
}

export function useGroupProfile() {
  return useQuery({
    queryKey: queryKeys.groupProfile,
    queryFn: () =>
      apiFetch<{ groupProfile: GroupProfile }>("/api/group-profile").then((data) => data.groupProfile),
    staleTime: 30_000,
    refetchInterval: false,
  });
}

export function useUpdateGroupProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: GroupProfileUpdateInput) =>
      apiFetch<{ groupProfile: GroupProfile }>("/api/group-profile", {
        method: "PATCH",
        body: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.groupProfile });
    },
  });
}

export function useConversations() {
  return useQuery({
    queryKey: queryKeys.conversations,
    queryFn: () =>
      apiFetch<{ threads: ConversationThreadRecord[] }>("/api/conversation-threads").then(
        (data) => data.threads ?? [],
      ),
    refetchInterval: 10_000,
  });
}

export function useAuditEvents(limit = 100) {
  return useQuery({
    queryKey: [...queryKeys.auditEvents, limit] as const,
    queryFn: () =>
      apiFetch<{ events: AuditEventRecord[] }>(`/api/audit-events?limit=${limit}`).then(
        (data) => data.events ?? [],
      ),
    refetchInterval: 10_000,
  });
}
