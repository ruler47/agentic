import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type {
  ToolServiceEventRecord,
  ToolServiceRestartPolicyInput,
  ToolServiceStatus,
} from "@/api/types";

export type ServiceLifecycleAction = "start" | "stop" | "restart" | "heartbeat";

export type ServiceLogRecord = {
  id: string;
  toolName: string;
  level: "info" | "warn" | "error";
  message: string;
  status?: string;
  detail?: string;
  createdAt: string;
};

export function useToolServices() {
  return useQuery({
    queryKey: queryKeys.toolServices,
    queryFn: () =>
      apiFetch<{ services: ToolServiceStatus[] }>("/api/tool-services").then(
        (data) => data.services ?? [],
      ),
    refetchInterval: 5_000,
    staleTime: 2_000,
  });
}

export type ToolServiceEventQuery = {
  toolName?: string;
  direction?: ToolServiceEventRecord["direction"] | "all";
  limit?: number;
};

export function useToolServiceEvents(query: ToolServiceEventQuery | number = 80) {
  const normalized =
    typeof query === "number"
      ? { limit: query }
      : {
          ...query,
          limit: query.limit ?? 80,
        };
  const params = new URLSearchParams();
  if (normalized.toolName) params.set("toolName", normalized.toolName);
  if (normalized.direction && normalized.direction !== "all") params.set("direction", normalized.direction);
  params.set("limit", String(normalized.limit));
  return useQuery({
    queryKey: [...queryKeys.toolServiceEvents, normalized] as const,
    queryFn: () =>
      apiFetch<{ events: ToolServiceEventRecord[] }>(
        `/api/tool-service-events?${params}`,
      ).then((data) => data.events ?? []),
    refetchInterval: 5_000,
  });
}

export function useToolServiceLogs(query: { toolName?: string; limit?: number } | number = 80) {
  const normalized =
    typeof query === "number"
      ? { limit: query }
      : {
          ...query,
          limit: query.limit ?? 80,
        };
  const params = new URLSearchParams();
  if (normalized.toolName) params.set("toolName", normalized.toolName);
  params.set("limit", String(normalized.limit));
  return useQuery({
    queryKey: [...queryKeys.toolServiceLogs, normalized] as const,
    queryFn: () =>
      apiFetch<{ logs: ServiceLogRecord[] }>(`/api/tool-services/logs?${params}`).then(
        (data) => data.logs ?? [],
      ),
    refetchInterval: 5_000,
  });
}

export function useToolServiceAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, action }: { name: string; action: ServiceLifecycleAction }) =>
      apiFetch<{ service: ToolServiceStatus }>(
        `/api/tool-services/${encodeURIComponent(name)}/${action}`,
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolServices });
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolServiceLogs });
    },
  });
}

export function useUpdateToolServiceRestartPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, policy }: { name: string; policy: ToolServiceRestartPolicyInput }) =>
      apiFetch<{ service: ToolServiceStatus }>(
        `/api/tool-services/${encodeURIComponent(name)}/restart-policy`,
        { method: "PATCH", body: policy },
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.toolServices }),
  });
}

export function useAllowChannelEventIdentity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) =>
      apiFetch<{ identities: Array<{ id: string }> }>(
        `/api/tool-service-events/${encodeURIComponent(eventId)}/allow-identity`,
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolServiceEvents });
      void queryClient.invalidateQueries({ queryKey: queryKeys.users });
    },
  });
}
