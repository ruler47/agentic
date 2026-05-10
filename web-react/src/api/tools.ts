import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type {
  ToolModuleMetadata,
  ToolRuntimeSettingInput,
  ToolRuntimeSettingRecord,
} from "@/api/types";

export type ToolPackageRunnerInfo = {
  name: string;
  packageType: string;
  status: "available" | "disabled" | "failed";
  detail?: string;
  rootPath?: string;
};

export type ToolHealthEntry = {
  toolName: string;
  ok: boolean;
  detail?: string;
};

export function useTools() {
  return useQuery({
    queryKey: queryKeys.tools,
    queryFn: () =>
      apiFetch<{ tools: ToolModuleMetadata[] }>("/api/tools").then((data) => data.tools ?? []),
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
}

export function useToolPackageRunners() {
  return useQuery({
    queryKey: queryKeys.toolPackageRunners,
    queryFn: () =>
      apiFetch<{ runners: ToolPackageRunnerInfo[] }>("/api/tool-package-runners").then(
        (data) => data.runners ?? [],
      ),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export function useToolSettings() {
  return useQuery({
    queryKey: queryKeys.toolSettings,
    queryFn: () =>
      apiFetch<{ settings: ToolRuntimeSettingRecord[] }>("/api/tool-settings").then(
        (data) => data.settings ?? [],
      ),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

export function useSetToolSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ToolRuntimeSettingInput) =>
      apiFetch<{ setting: ToolRuntimeSettingRecord }>("/api/tool-settings", {
        method: "PUT",
        body: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolSettings });
    },
  });
}

export function useDeleteToolSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ toolName, key }: { toolName: string; key: string }) =>
      apiFetch<{ deleted: boolean }>(
        `/api/tool-settings/${encodeURIComponent(toolName)}/${encodeURIComponent(key)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolSettings });
    },
  });
}

export function useReloadGeneratedTools() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ reloaded: number }>("/api/tools/reload-generated", { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tools });
    },
  });
}

export function useRunToolHealthchecks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ tools: ToolHealthEntry[] }>("/api/tools/health", { method: "GET" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tools });
    },
  });
}

export function useDeleteGeneratedTool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ deleted: boolean }>(`/api/tools/generated-modules/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tools });
    },
  });
}

/**
 * Phase 13 follow-up: manual tool invocation. POSTs an arbitrary input
 * payload to the registered tool and resolves with the exact
 * `ToolResult` it returned, so the operator can smoke-test a build
 * (or a freshly-rebuilt docker image) without running an agent task.
 */
export type ManualToolRunResponse = {
  tool: { name: string; version: string };
  result: { ok: boolean; content: string; data?: unknown };
  durationMs: number;
};

export function useRunToolManually() {
  return useMutation({
    mutationFn: ({ name, input }: { name: string; input: Record<string, unknown> }) =>
      apiFetch<ManualToolRunResponse>(`/api/tools/${encodeURIComponent(name)}/run`, {
        method: "POST",
        // apiFetch already wraps the body with JSON.stringify and sets the
        // content-type header. Passing a string here would double-encode
        // the payload (server saw `"{\"input\":...}"` instead of an object
        // and rejected the body with "Unexpected token …").
        body: { input },
      }),
  });
}

// Convenience: reduce flat settings list into a nested per-tool map.
export function settingsByTool(records: ToolRuntimeSettingRecord[] | undefined) {
  const map = new Map<string, Record<string, string>>();
  if (!records) return map;
  for (const record of records) {
    const existing = map.get(record.toolName) ?? {};
    existing[record.key] = record.value;
    map.set(record.toolName, existing);
  }
  return map;
}
