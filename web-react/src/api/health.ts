import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/api/queryKeys";
import { apiFetch } from "@/lib/fetch";

export type PersistenceMode = "postgres" | "in-memory" | "local-json" | "local-files" | "s3";

export type HealthResponse = {
  ok: boolean;
  persistence?: {
    database: {
      mode: "postgres" | "in-memory";
      status: "ok" | "unconfigured" | "error";
      configured: boolean;
    };
    stores: Array<{
      name: string;
      mode: PersistenceMode;
      durable: boolean;
    }>;
  };
};

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: () => apiFetch<HealthResponse>("/api/health"),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}
