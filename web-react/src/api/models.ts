import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type {
  ModelProviderInput,
  ModelProviderRecord,
  ModelProviderUpdateInput,
  ModelTier,
  ModelTierSettings,
} from "@/api/types";

export type ModelCatalogResponse = {
  chat?: { baseUrl?: string; models?: Array<{ id: string; ownedBy?: string }> };
  embedding?: { provider?: string; model?: string; dimensions?: number; models?: Array<{ id: string }> };
  providers?: ModelProviderRecord[];
};

export function useModelTiers() {
  return useQuery({
    queryKey: queryKeys.modelTiers,
    queryFn: () =>
      apiFetch<{ tiers: ModelTierSettings[] }>("/api/settings/model-tiers").then(
        (data) => data.tiers ?? [],
      ),
    staleTime: 30_000,
    refetchInterval: false,
  });
}

export type SaveTiersInput = {
  tiers: Array<{
    tier: ModelTier;
    models: string[];
    maxAttempts: number;
    escalateOnFailure: boolean;
  }>;
};

export function useSaveModelTiers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveTiersInput) =>
      apiFetch<{ tiers: ModelTierSettings[] }>("/api/settings/model-tiers", {
        method: "PUT",
        body: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.modelTiers });
    },
  });
}

export function useModelProviders() {
  return useQuery({
    queryKey: queryKeys.modelProviders,
    queryFn: () =>
      apiFetch<{ providers: ModelProviderRecord[] }>("/api/model-providers").then(
        (data) => data.providers ?? [],
      ),
    staleTime: 30_000,
    refetchInterval: false,
  });
}

export function useCreateModelProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ModelProviderInput) =>
      apiFetch<{ provider: ModelProviderRecord }>("/api/model-providers", {
        method: "POST",
        body: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.modelProviders });
    },
  });
}

export function useUpdateModelProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: ModelProviderUpdateInput }) =>
      apiFetch<{ provider: ModelProviderRecord }>(
        `/api/model-providers/${encodeURIComponent(id)}`,
        { method: "PATCH", body: update },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.modelProviders });
    },
  });
}

export function useDeleteModelProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ deleted: boolean }>(`/api/model-providers/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.modelProviders });
    },
  });
}

export function useModelCatalog() {
  return useQuery({
    queryKey: queryKeys.modelCatalog,
    queryFn: () => apiFetch<ModelCatalogResponse>("/api/models/catalog"),
    staleTime: 60_000,
    refetchInterval: false,
    retry: 0,
  });
}
