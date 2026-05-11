/**
 * Phase 14 / Phase E: client for the council-backed Tool Builds page.
 *
 * The legacy `tool-build-requests` endpoints still exist for the old
 * queue-based builder, but the Tool Builds page now drives the new
 * council pipeline exclusively. POST creates a run that the council
 * starts immediately; GET lists every prior run so the operator can
 * jump into Trace Lab for each one.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/fetch";
import type { AgentRunRecord } from "@/api/types";

export type ToolBuildRunInput = {
  /** Canonical tool name: `domain.thing`, lowercase. */
  name: string;
  /** Free-text description of what the tool should do. */
  description: string;
  /** Optional list of acceptance criteria (one bullet per requirement). */
  qaCriteria?: string[];
  /** Optional secret-handle the tool will read at runtime. */
  secretHandle?: string;
  /** When provided, the council reworks the existing tool instead of building fresh. */
  existingToolName?: string;
  bugContext?: string;
  /**
   * Reference docs the council should read before brainstorming
   * (OpenAPI specs, READMEs, PDFs). Each file is sent inline as
   * base64; the backend resolves text-like MIMEs in place and
   * delegates binary formats to registered reader tools.
   */
  references?: Array<{
    filename: string;
    mimeType: string;
    contentBase64: string;
  }>;
};

const TOOL_BUILD_RUNS_KEY = ["tool-build-runs"] as const;

export function useToolBuildRuns() {
  return useQuery({
    queryKey: TOOL_BUILD_RUNS_KEY,
    queryFn: () =>
      apiFetch<{ runs: AgentRunRecord[] }>("/api/tool-build-runs").then((data) => data.runs),
    // The list is small; refresh on focus so a fresh run shows up the
    // moment the operator alt-tabs back. Trace Lab still streams events
    // via SSE per-run.
    refetchOnWindowFocus: true,
    // Auto-refresh every 5 s so progress is visible without manual
    // reload — runs typically take 30-200 s and the operator wants the
    // status to update in place.
    refetchInterval: 5000,
  });
}

export function useCreateToolBuildRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ToolBuildRunInput) =>
      // apiFetch handles JSON.stringify internally — passing a string
      // here would double-encode the payload and the server would see
      // `"{\"name\":...}"` (a JSON string containing JSON) instead of
      // an object, then reject with "Unexpected token ... is not valid JSON".
      apiFetch<{ run: AgentRunRecord }>("/api/tool-build-runs", {
        method: "POST",
        body: input,
      }).then((data) => data.run),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TOOL_BUILD_RUNS_KEY });
    },
  });
}
