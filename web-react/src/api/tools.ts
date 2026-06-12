import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type {
  ToolContextKind,
  ToolContextRecord,
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
  runtimeReadiness?: ToolModuleMetadata["runtimeReadiness"];
};

export type ToolCreatePackageInput = {
  name: string;
  displayName?: string;
  version?: string;
  description?: string;
  request?: string;
  kind?: "echo" | "http-json" | "npm-default-function" | "browser-screenshot" | "browser-operate" | "web-search" | "web-read" | "service-adapter" | "external-action-prepare" | "external-action-commit";
  discoveryMode?: "disabled" | "npm" | "auto";
  discoveryQuery?: string;
  authoringMode?: "auto" | "llm" | "scaffold";
  activationPolicy?: "manual" | "available_on_success";
  capabilities?: string[];
  dependencies?: Record<string, string>;
  credentials?: Record<string, string>;
  docsUrl?: string;
  docsUrls?: string[];
  documentation?: string | string[] | ToolContextInput[];
  apiDocs?: string | string[];
  openApiSpec?: string;
  contextItems?: ToolContextInput[];
  adapterContract?: {
    packageName: string;
    importStyle: "default" | "named" | "namespace";
    exportName?: string;
    memberName?: string;
    inputMode: "text-options" | "object";
    inputSchema?: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
    inputExample?: Record<string, unknown>;
    evidence: string;
  };
  behaviorExamples?: Array<{
    title?: string;
    input: Record<string, unknown>;
    expectedOk?: boolean;
    expectedContent?: string;
    expectedContentIncludes?: string;
  }>;
};

export type ToolBuilderStrategyDecision = {
  kind:
    | "template"
    | "npm-package"
    | "external-api"
    | "web-search"
    | "web-read"
    | "cli"
    | "browser-automation"
    | "custom-typescript"
    | "container-service"
    | "imported-source-bundle";
  reason: string;
  confidence: "low" | "medium" | "high";
  candidates: Array<{
    kind: ToolBuilderStrategyDecision["kind"];
    name: string;
    reason: string;
    packageName?: string;
    versionRange?: string;
    inspectionSummary?: string;
    adapterContract?: ToolCreatePackageInput["adapterContract"];
  }>;
  rejectedCandidates: Array<{
    kind: ToolBuilderStrategyDecision["kind"];
    name: string;
    reason: string;
    packageName?: string;
    versionRange?: string;
    inspectionSummary?: string;
    adapterContract?: ToolCreatePackageInput["adapterContract"];
  }>;
  selectedDependencies: Array<{ name: string; versionRange: string }>;
  discoveryEvidence?: Array<{
    provider: "npm-registry" | "npm-package-metadata" | "operator" | "operator-docs" | "openapi" | "curl" | "html-docs" | "none";
    query?: string;
    summary: string;
    packageName?: string;
    packageVersion?: string;
    url?: string;
  }>;
  adapterContract?: ToolCreatePackageInput["adapterContract"];
  behaviorExamples?: ToolCreatePackageInput["behaviorExamples"];
  implementationNotes: string[];
};

export type ToolCreationRecord = {
  id: string;
  status: "requested" | "building" | "qa_failed" | "registered" | "failed";
  source: "operator" | "import" | "agent";
  toolName: string;
  toolVersion: string;
  kind: string;
  request?: string;
  description?: string;
  capabilities: string[];
  dependencies: Array<{ name: string; versionRange: string }>;
  strategy?: ToolBuilderStrategyDecision;
  packageRef?: string;
  manifestPath?: string;
  files: string[];
  qa?: {
    ok: boolean;
    summary: string;
    checks: string[];
    warnings?: string[];
    requiresManualLiveVerification?: boolean;
    issues?: Array<{
      phase: "behavior";
      kind: "transient_network" | "provider_blocked" | "auth_missing" | "semantic_mismatch" | "tool_bug";
      severity: "warning" | "error";
      label: string;
      detail: string;
      attempts: number;
      live: boolean;
    }>;
  };
  error?: string;
  runId?: string;
  createdAt: string;
  updatedAt: string;
  registeredAt?: string;
};

export type ToolCreatePackageResponse = {
  tool: ToolModuleMetadata;
  creation?: ToolCreationRecord;
  runId?: string;
  package: {
    packageRef: string;
    manifestPath: string;
    files: string[];
  };
  qa: {
    ok: boolean;
    summary: string;
    checks: string[];
    warnings?: string[];
    requiresManualLiveVerification?: boolean;
  };
};

export type ToolSourceBundleExport = {
  manifest: unknown;
  package: {
    packageRef: string;
    manifestPath: string;
  };
  files: Array<{ path: string; content: string }>;
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

export function useToolCreations() {
  return useQuery({
    queryKey: queryKeys.toolCreations,
    queryFn: () =>
      apiFetch<{ creations: ToolCreationRecord[] }>("/api/tool-creations").then(
        (data) => data.creations ?? [],
      ),
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
}

export function useDeleteToolCreation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ deleted: true; creationId: string; toolName: string }>(
        `/api/tool-creations/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolCreations });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tools });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.secretHandles });
    },
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolCreations });
    },
  });
}

export function useImportToolSourceBundle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ToolSourceBundleExport) =>
      apiFetch<ToolCreatePackageResponse>("/api/tools/source-bundles", {
        method: "POST",
        body: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tools });
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolCreations });
    },
  });
}

export function useCreateToolPackage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ToolCreatePackageInput) =>
      apiFetch<ToolCreatePackageResponse>("/api/tools/create-package", {
        method: "POST",
        body: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tools });
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolCreations });
    },
  });
}

export type ToolContextInput = {
  kind: ToolContextKind;
  title?: string;
  content: string;
  mimeType?: string;
  source?: string;
};

export function useToolContext(name: string | undefined) {
  return useQuery({
    queryKey: name ? queryKeys.toolContext(name) : ["tools", "context", "none"],
    enabled: Boolean(name),
    queryFn: () =>
      apiFetch<{ context: ToolContextRecord[] }>(
        `/api/tools/generated-modules/${encodeURIComponent(name!)}/context`,
      ).then((data) => data.context ?? []),
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
}

export function useCreateToolContext() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, input }: { name: string; input: ToolContextInput }) =>
      apiFetch<{ context: ToolContextRecord }>(
        `/api/tools/generated-modules/${encodeURIComponent(name)}/context`,
        { method: "POST", body: input },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolContext(variables.name) });
    },
  });
}

export function useUpdateToolContext() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      name,
      id,
      input,
    }: {
      name: string;
      id: string;
      input: Partial<ToolContextInput>;
    }) =>
      apiFetch<{ context: ToolContextRecord }>(
        `/api/tools/generated-modules/${encodeURIComponent(name)}/context/${encodeURIComponent(id)}`,
        { method: "PATCH", body: input },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolContext(variables.name) });
    },
  });
}

export function useDeleteToolContext() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, id }: { name: string; id: string }) =>
      apiFetch<{ deleted: boolean; id: string }>(
        `/api/tools/generated-modules/${encodeURIComponent(name)}/context/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolContext(variables.name) });
    },
  });
}

export type ToolCreateVersionInput = {
  name: string;
  baseVersion?: string;
  version?: string;
  customLabel?: string;
  changeDescription?: string;
  request: string;
  description?: string;
  kind?: ToolCreatePackageInput["kind"];
  discoveryMode?: ToolCreatePackageInput["discoveryMode"];
  discoveryQuery?: string;
  authoringMode?: ToolCreatePackageInput["authoringMode"];
  capabilities?: string[];
  dependencies?: Record<string, string>;
  credentials?: Record<string, string>;
  docsUrl?: string;
  docsUrls?: string[];
  documentation?: ToolCreatePackageInput["documentation"];
  apiDocs?: string | string[];
  openApiSpec?: string;
  contextItems?: ToolContextInput[];
  behaviorExamples?: ToolCreatePackageInput["behaviorExamples"];
};

export function useCreateToolVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, ...input }: ToolCreateVersionInput) =>
      apiFetch<ToolCreatePackageResponse>(
        `/api/tools/generated-modules/${encodeURIComponent(name)}/versions`,
        {
          method: "POST",
          body: input,
        },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tools });
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolCreations });
      void queryClient.invalidateQueries({ queryKey: ["tool-versions", variables.name] });
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

export function useSetToolStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, status, previousStatus }: {
      name: string;
      status: "available" | "disabled";
      previousStatus?: string;
    }) =>
      apiFetch<{ tool: ToolModuleMetadata }>(`/api/tools/${encodeURIComponent(name)}/status`, {
        method: "PATCH",
        body: { status, previousStatus },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tools });
    },
  });
}

export type ToolVersionSummary = {
  version: string;
  active: boolean;
  // Phase 18: 4-state lifecycle. `loaded` = source-bundle imports
  // but no QA pass yet; `available` = QA blessed.
  status: "available" | "loaded" | "disabled" | "failed";
  displayName?: string;
  description?: string;
  capabilities?: string[];
  modulePath?: string;
  testPath?: string;
  requiredSecretHandles?: string[];
  changeSummary?: string;
  packageManifest?: ToolModuleMetadata["packageManifest"];
  manualRunEvidence?: {
    successCount: number;
    failureCount: number;
    latestSuccess?: {
      auditEventId: string;
      ranAt: string;
      durationMs?: number;
      inputPreview?: unknown;
      contentPreview?: string;
    };
    latestFailure?: {
      auditEventId: string;
      ranAt: string;
      durationMs?: number;
      inputPreview?: unknown;
      contentPreview?: string;
    };
    requiredForActivation: boolean;
  };
  runScopedCandidateEvidence?: {
    successCount: number;
    failureCount: number;
    latestSuccess?: {
      runId: string;
      ranAt: string;
      inputPreview?: unknown;
      contentPreview?: string;
    };
    latestFailure?: {
      runId: string;
      ranAt: string;
      inputPreview?: unknown;
      contentPreview?: string;
    };
    requiredForActivation: boolean;
  };
  lifecycleEvents?: Array<{
    id: string;
    type:
      | "created"
      | "manual_run"
      | "marked_available"
      | "activated"
      | "agent_accepted"
      | "rejected"
      | "deleted";
    status: "success" | "failure" | "info";
    summary: string;
    actorId?: string;
    actorType?: string;
    runId?: string;
    traceRunId?: string;
    auditEventId?: string;
    createdAt: string;
    metadata?: Record<string, unknown>;
  }>;
  reviewStatus?: "candidate" | "accepted" | "rejected";
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
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
 * Phase 18 Slice D: operator "Mark available" — promote a version
 * from `loaded` to `available` after manual verification, without
 * a full council QA cycle.
 */
export function useMarkToolVersionAvailable() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, version }: { name: string; version: string }) =>
      apiFetch<{ name: string; version: string; status: "available" }>(
        `/api/tools/generated-modules/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/mark-available`,
        { method: "POST" },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tools });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
      void queryClient.invalidateQueries({
        queryKey: ["tool-versions", variables.name],
      });
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
      void queryClient.invalidateQueries({
        queryKey: ["tool-versions", variables.name],
      });
    },
  });
}

export function useRejectToolVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, version, reason }: { name: string; version: string; reason: string }) =>
      apiFetch<{ rejected: true; name: string; version: string; reason: string }>(
        `/api/tools/generated-modules/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/reject`,
        { method: "POST", body: { reason } },
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
  tool: { name: string; version: string; active?: boolean; status?: string };
  result: { ok: boolean; content: string; data?: unknown };
  durationMs: number;
  loadDetail?: string;
  diagnostic?: {
    type: "missing_runtime_requirements";
    missingConfigurationKeys: string[];
    missingSecretHandles: string[];
    message: string;
    actions: Array<{
      kind: "set_runtime_setting" | "create_secret_handle";
      key?: string;
      handle?: string;
      label: string;
    }>;
  };
};

export function useRunToolManually() {
  const queryClient = useQueryClient();
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tools });
    },
  });
}

export function useRunToolVersionManually() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      name,
      version,
      input,
    }: {
      name: string;
      version: string;
      input: Record<string, unknown>;
    }) =>
      apiFetch<ManualToolRunResponse>(
        `/api/tools/generated-modules/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/run`,
        {
          method: "POST",
          body: { input },
        },
      ),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: ["tool-versions", vars.name] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tools });
    },
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
