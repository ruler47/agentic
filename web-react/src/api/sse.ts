import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/api/queryKeys";
import type { AgentRunRecord } from "@/api/types";

/**
 * Subscribe to /api/runs/:id/events (SSE) and push the latest snapshot into the
 * React Query cache for that run. Replaces the legacy `connectRunStream` +
 * `state.runs[i] = ...` mutation pattern from public/app.js.
 *
 * Falls back to no-op when EventSource is unavailable; the polling
 * `refetchInterval` on `useRun` keeps the UI fresh either way.
 */
export function useRunStream(runId: string | undefined): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!runId) return;
    if (typeof window === "undefined" || typeof window.EventSource !== "function") return;

    const url = `/api/runs/${encodeURIComponent(runId)}/events`;
    const stream = new EventSource(url);

    const onMessage = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { run?: AgentRunRecord };
        if (!payload?.run) return;
        queryClient.setQueryData(queryKeys.run(runId), payload.run);
        // Refresh the runs list cache opportunistically: keep the matching row
        // in sync without a separate refetch.
        queryClient.setQueryData<AgentRunRecord[]>(queryKeys.runs, (previous) => {
          if (!previous) return previous;
          const next = [...previous];
          const index = next.findIndex((entry) => entry.id === payload.run!.id);
          if (index >= 0) next[index] = payload.run!;
          return next;
        });
      } catch {
        // Ignore malformed frames; the polling fallback will recover.
      }
    };

    stream.addEventListener("run", onMessage as EventListener);
    stream.addEventListener("message", onMessage as EventListener);

    return () => {
      stream.removeEventListener("run", onMessage as EventListener);
      stream.removeEventListener("message", onMessage as EventListener);
      stream.close();
    };
  }, [runId, queryClient]);
}
