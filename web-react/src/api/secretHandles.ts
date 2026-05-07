import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type { SecretHandleInput, SecretHandleRecord } from "@/api/types";

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
    },
  });
}
