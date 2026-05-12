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

export type ToolVersionSummary = {
  version: string;
  active: boolean;
  status: "available" | "disabled" | "failed";
  changeSummary?: string;
  successCount?: number;
  failureCount?: number;
  updatedAt: string;
  lastHealthDetail?: string;
};

/**
 * Fetch the full version history for a generated tool. The metadata
 * store keeps every promoted version in Postgres so the operator can
 * roll back / inspect run stats. The InMemory store only keeps the
 * active one, but that's fine for tests.
 */
export function useToolVersions(name: string | undefined) {
  return useQuery({
    queryKey: ["tool-versions", name],
    enabled: Boolean(name),
    queryFn: () =>
      apiFetch<{ versions: ToolVersionSummary[] }>(
        `/api/tools/generated-modules/${encodeURIComponent(name!)}/versions`,
      ).then((data) => data.versions ?? []),
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
}

export function useActivateToolVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, version }: { name: string; version: string }) =>
      apiFetch<{ tool: ToolModuleMetadata }>(
        `/api/tools/generated-modules/${encodeURIComponent(name)}/activate-version`,
        { method: "POST", body: { version } },
      ),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tools });
      void queryClient.invalidateQueries({ queryKey: ["tool-versions", vars.name] });
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
 * Phase 16 Slice I: delete ONE non-active version from a generated
 * tool's history. The server refuses to delete the currently-active
 * version (HTTP 400) — operator must activate something else first.
 * Invalidates both the tools list (totals refresh) and the per-tool
 * versions panel.
 */
export function useDeleteToolVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, version }: { name: string; version: string }) =>
      apiFetch<{ deleted: boolean; name: string; version: string }>(
        `/api/tools/generated-modules/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tools });
      void queryClient.invalidateQueries({
        queryKey: ["tool-versions", variables.name],
      });
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
