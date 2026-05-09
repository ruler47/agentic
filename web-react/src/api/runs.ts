import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetch";
import { queryKeys } from "@/api/queryKeys";
import type {
  AgentRunRecord,
  ArtifactUploadInput,
  RunCreateContext,
  RunCreateResponse,
  RunDetailResponse,
  RunListResponse,
  ToolReworkWaitRecord,
} from "@/api/types";

export function useRuns() {
  return useQuery({
    queryKey: queryKeys.runs,
    queryFn: () => apiFetch<RunListResponse>("/api/runs").then((data) => data.runs ?? []),
    refetchInterval: 5_000,
  });
}

export function useRun(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.run(id) : queryKeys.run("__none__"),
    enabled: Boolean(id),
    queryFn: () =>
      apiFetch<RunDetailResponse>(`/api/runs/${encodeURIComponent(id!)}`).then((data) => data.run),
    // Refetch interval is short while we're waiting for SSE wiring; once we
    // hook EventSource the interval can drop to 0 (refetchInterval: false).
    refetchInterval: 5_000,
  });
}

export function useRunWaits(runId: string | undefined) {
  return useQuery({
    queryKey: runId ? queryKeys.runWaits(runId) : queryKeys.runWaits("__none__"),
    enabled: Boolean(runId),
    queryFn: () =>
      apiFetch<{ waits: ToolReworkWaitRecord[] }>(
        `/api/runs/${encodeURIComponent(runId!)}/tool-rework-waits`,
      ).then((data) => data.waits ?? []),
    refetchInterval: 10_000,
  });
}

export type CreateRunInput = {
  task: string;
  attachments?: ArtifactUploadInput[];
} & Partial<RunCreateContext>;

export async function fileToRunAttachment(file: File): Promise<ArtifactUploadInput> {
  return {
    filename: file.name || "attachment",
    mimeType: file.type || undefined,
    contentBase64: encodeArrayBufferBase64(await file.arrayBuffer()),
  };
}

export async function filesToRunAttachments(files: File[] | FileList): Promise<ArtifactUploadInput[]> {
  return Promise.all(Array.from(files).map((file) => fileToRunAttachment(file)));
}

function encodeArrayBufferBase64(buffer: ArrayBuffer): string {
  if (typeof globalThis.btoa !== "function") {
    throw new Error("Base64 encoding is unavailable in this browser");
  }

  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return globalThis.btoa(binary);
}

export function useCreateRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRunInput) =>
      apiFetch<RunCreateResponse>("/api/runs", { method: "POST", body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
    },
  });
}

export function useCancelRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      apiFetch<RunDetailResponse>(`/api/runs/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        body: { reason: reason ?? "Operator cancelled the run." },
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.run(data.run.id), data.run);
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
    },
  });
}

// Convenience selectors used by Dashboard / Runs / Run Workspace --------

export function selectActiveRuns(runs: AgentRunRecord[] | undefined): AgentRunRecord[] {
  if (!runs) return [];
  return runs.filter((run) => run.status === "queued" || run.status === "running");
}

export function selectRecentRuns(runs: AgentRunRecord[] | undefined, limit = 8): AgentRunRecord[] {
  if (!runs) return [];
  return [...runs]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}
