import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetch";

export type HealthResponse = { ok: boolean };

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => apiFetch<HealthResponse>("/api/health"),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}
