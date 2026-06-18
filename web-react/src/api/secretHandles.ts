import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type { SecretHandleInput, SecretHandleRecord } from "@/api/types";

export type SecretHandleStatus = {
  handle: string;
  registered: boolean;
  resolvable: boolean;
  provider?: SecretHandleRecord["provider"];
  secretRef?: string;
  scopes?: string[];
  reason?: "not_registered" | "unresolved" | "resolved";
};

export function useSecretHandles() {
  return useQuery({
    queryKey: queryKeys.secretHandles,
    queryFn: () =>
      apiFetch<{ secretHandles: SecretHandleRecord[] }>("/api/secret-handles").then(
        (data) => data.secretHandles ?? [],
      ),
    refetchInterval: false,
    staleTime: 30_000,
  });
}

export function useSecretHandleStatuses(handles: string[]) {
  const uniqueHandles = [...new Set(handles.map((handle) => handle.trim()).filter(Boolean))];
  return useQuery({
    queryKey: queryKeys.secretHandleStatuses(uniqueHandles),
    enabled: uniqueHandles.length > 0,
    queryFn: () =>
      apiFetch<{ handles: SecretHandleStatus[] }>("/api/secret-handles/status", {
        method: "POST",
        body: { handles: uniqueHandles },
      }).then((data) => data.handles ?? []),
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
}

export function useCreateSecretHandle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SecretHandleInput) =>
      apiFetch<{ secretHandle: SecretHandleRecord }>("/api/secret-handles", {
        method: "POST",
        body: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.secretHandles });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tools });
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolServices });
    },
  });
}

export function useDeleteSecretHandle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (handle: string) =>
      apiFetch<{ deleted: boolean }>(`/api/secret-handles/${encodeURIComponent(handle)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.secretHandles });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tools });
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolServices });
    },
  });
}
