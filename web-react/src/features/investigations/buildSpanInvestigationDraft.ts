import { truncate } from "@/lib/format";
import type {
  AgentRunRecord,
  ToolInvestigationContextBundle,
  ToolInvestigationSource,
} from "@/api/types";
import type { TraceNode } from "@/features/trace/buildTraceNodes";

export type ToolMetaLite = {
  name: string;
  displayName?: string;
  version?: string;
  startupMode?: string;
  capabilities?: string[];
};

export type InvestigationDraft = {
  source: ToolInvestigationSource;
  title: string;
  runId: string;
  spanId: string;
  matchedToolName?: string;
  matchedToolVersion?: string;
  matchedToolDisplayName?: string;
  artifactIds: string[];
  warnings: string[];
  contextBundle: ToolInvestigationContextBundle;
};

/**
 * Build a draft from a Trace Lab span, mirroring the `buildSpanInvestigationDraft`
 * helper in legacy public/app.js. We never auto-retarget a tool from fuzzy text:
 * the draft is `manual` and warns the operator if the span actor/payload doesn't
 * match a registered tool exactly.
 */
export function buildSpanInvestigationDraft(args: {
  run: AgentRunRecord;
  node: TraceNode;
  installedTools: ToolMetaLite[];
}): InvestigationDraft {
  const { run, node, installedTools } = args;
  const matchedTool = matchToolForSpan(node, installedTools);
  const titleParts = [
    node.title,
    matchedTool ? `(${matchedTool.displayName ?? matchedTool.name})` : "",
  ].filter(Boolean);
  const title = titleParts.join(" ").trim() || `Span ${node.spanId} needs investigation`;

  const inputSummary = node.parentTitle ? `Called by ${node.parentTitle}` : "Root coordinator span.";
  const outputSummary = node.detail ? truncate(node.detail, 1600) : undefined;
  const error =
    node.status === "failed"
      ? truncate(node.detail ?? "", 1200) || node.title
      : undefined;
  const artifactRefs = readArtifactRefs(node.payload, run.id);
  const artifactQa = readArtifactQa(node.payload);

  const warnings: string[] = [];
  if (!matchedTool) {
    warnings.push(
      "Could not match this span to a registered tool by exact actor/payload. The investigation will be saved as a manual ticket. Triage and link it to the right tool/build request before rework.",
    );
  }

  const contextBundle: ToolInvestigationContextBundle = {
    taskPrompt: run.task,
    runTitle: run.task,
    actor: node.actor,
    activity: node.activity,
    status: node.status,
    caller: node.parentTitle,
    inputSummary,
    outputSummary,
    error,
    artifactQa,
    relatedArtifactRefs: artifactRefs.length > 0 ? artifactRefs : undefined,
    notes: warnings.length > 0 ? warnings : undefined,
  };

  return {
    source: "trace_span",
    title,
    runId: run.id,
    spanId: node.spanId,
    matchedToolName: matchedTool?.name,
    matchedToolVersion: matchedTool?.version,
    matchedToolDisplayName: matchedTool?.displayName,
    artifactIds: artifactRefs.map((ref) => ref.id ?? "").filter(Boolean),
    warnings,
    contextBundle,
  };
}

function matchToolForSpan(
  node: TraceNode,
  installedTools: ToolMetaLite[],
): ToolMetaLite | undefined {
  const candidates = new Set<string>();
  if (node.actor) candidates.add(node.actor);
  if (node.payload && typeof node.payload === "object") {
    const payload = node.payload as Record<string, unknown>;
    if (typeof payload.tool === "string") candidates.add(payload.tool);
    if (typeof payload.toolName === "string") candidates.add(payload.toolName);
  }
  return installedTools.find((tool) => candidates.has(tool.name));
}

function readArtifactRefs(
  payload: unknown,
  runId: string,
): Array<{ id?: string; filename?: string; mimeType?: string; url?: string }> {
  if (!payload || typeof payload !== "object") return [];
  const refs: Array<{ id?: string; filename?: string; mimeType?: string; url?: string }> = [];
  const record = payload as Record<string, unknown>;
  const single = record.artifact;
  const list = Array.isArray(record.artifacts) ? record.artifacts : [];
  const all = [single, ...list].filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && (
        typeof (entry as { url?: unknown }).url === "string" ||
        typeof (entry as { filename?: unknown }).filename === "string"
      ),
  );
  for (const artifact of all) {
    refs.push({
      id: typeof artifact.id === "string" ? artifact.id : undefined,
      filename: typeof artifact.filename === "string" ? artifact.filename : undefined,
      mimeType: typeof artifact.mimeType === "string" ? artifact.mimeType : undefined,
      url: typeof artifact.url === "string" ? artifact.url : `/api/runs/${runId}/artifacts/${artifact.id ?? ""}`,
    });
  }
  return refs;
}

function readArtifactQa(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const candidate = (payload as { artifactQa?: unknown }).artifactQa;
  if (!candidate || typeof candidate !== "object") return undefined;
  return candidate as Record<string, unknown>;
}
