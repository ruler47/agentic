import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/api/queryKeys";
import { apiFetch } from "@/lib/fetch";

export type CodingCouncilConfig = {
  instanceId: string;
  tier: "S" | "M" | "L" | "XL";
  maxRevisionAttempts: number;
  maxQaRepairAttempts: number;
  qaTimeoutMs: number;
  brainstormSystemPrompt?: string;
  updatedAt: string;
};

export function useCodingCouncil() {
  return useQuery({
    queryKey: queryKeys.codingCouncil,
    queryFn: () => apiFetch<{ config: CodingCouncilConfig }>("/api/settings/coding-council"),
    select: (response) => response.config,
  });
}

export function useUpdateCodingCouncil() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<Omit<CodingCouncilConfig, "instanceId" | "updatedAt">>) =>
      apiFetch<{ config: CodingCouncilConfig }>("/api/settings/coding-council", {
        method: "PUT",
        body: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.codingCouncil });
    },
  });
}
