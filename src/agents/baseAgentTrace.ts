import type { AgentArtifact, AgentRunResult, Message } from "../types.js";
import type { ToolResult } from "../tools/tool.js";
import { limitText, safeToolName } from "./baseAgentToolMessages.js";
import type {
  BaseAgentRunContext,
  BaseAgentToolCandidateAccepted,
  ProofEvidence,
  ToolCreationOutcome,
  ToolEditOutcome,
} from "./baseAgentTypes.js";
import { formatPriorWorkContextForPrompt } from "../work-ledger/priorWorkResolver.js";
import { isToolLifecycleOnlyTask } from "./taskFrame.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function findUnusedScopedCandidate(input: {
  task: string;
  toolCreationRequests: ToolCreationOutcome[];
  toolEditRequests: ToolEditOutcome[];
  usedScopedCandidates: Map<string, BaseAgentToolCandidateAccepted>;
}): { toolName: string; toolVersion: string; source: "creation" | "edit" } | undefined {
  if (isToolLifecycleOnlyTask(input.task)) return undefined;
  for (const request of input.toolCreationRequests) {
    if (!request.ok || !request.scopedTool || !request.toolVersion) continue;
    // Host-attached initial candidates are offers, not obligations: the
    // agent may legitimately solve the task without them (observed live:
    // a stale reservation-commit candidate failed an entire booking-prepare
    // run that never needed it).
    if (request.initialAttachment) continue;
    if (!input.usedScopedCandidates.has(`${request.toolName}@${request.toolVersion}`)) {
      return { toolName: request.toolName, toolVersion: request.toolVersion, source: "creation" };
    }
  }
  for (const request of input.toolEditRequests) {
    if (!request.ok || !request.scopedTool || !request.toolVersion) continue;
    if (!input.usedScopedCandidates.has(`${request.toolName}@${request.toolVersion}`)) {
      return { toolName: request.toolName, toolVersion: request.toolVersion, source: "edit" };
    }
  }
  return undefined;
}

export function containsRawToolCallSyntax(answer: string): boolean {
  const trimmed = answer.trim();
  if (!trimmed) return false;
  // LM Studio / Qwen-style XML tool-call leakage in prose output.
  if (/<tool_call>|<function=/i.test(trimmed)) return true;
  if (/\bfinish\s*\(\s*\{\s*answer\s*:/i.test(trimmed)) return true;
  if (/"tool_calls"\s*:/.test(trimmed)) return true;
  if (/"function"\s*:\s*\{[^}]*"arguments"\s*:/.test(trimmed)) return true;
  if (/^\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:/.test(trimmed)) return true;
  if (/^[a-zA-Z_][\w.]*\s*\(\s*\{[\s\S]*\}\s*\)\s*;?\s*$/.test(trimmed)) return true;
  return false;
}

export function normalizeFinalAnswer(answer: string): string {
  const finishCallPattern = /([\s\S]*?)\s*finish\s*\(\s*\{\s*answer\s*:\s*(["'`])([\s\S]*?)\2\s*\}\s*\)\s*;?\s*$/;
  const match = answer.match(finishCallPattern);
  if (!match) {
    const trailingRawFinish = answer.match(/^([\s\S]{120,}?)\n+\s*finish\s*\(\s*\{[\s\S]*$/i);
    return trailingRawFinish?.[1]?.trim() || answer;
  }
  const prefix = match[1]?.trim();
  if (prefix) return prefix;
  return match[3]?.trim() || answer;
}

export function failedResult(reason: string, artifacts: AgentArtifact[]): AgentRunResult {
  return {
    finalAnswer: reason,
    complexity: { mode: "direct", reason, domains: [], riskLevel: "medium" },
    subtasks: [],
    workerResults: [],
    reviews: [],
    artifacts,
    runStatus: "failed",
    runFailureReason: reason,
  };
}

export function normalizeRunContext(
  context: BaseAgentRunContext | undefined,
  fallbackRunId: string | undefined,
  now: Date,
): BaseAgentRunContext {
  return {
    ...context,
    runId: context?.runId ?? fallbackRunId,
    currentDateTimeIso: context?.currentDateTimeIso ?? now.toISOString(),
  };
}

export function contextSummary(context: BaseAgentRunContext, toolCount: number): string {
  const pieces = [
    `run=${context.runId ?? "unknown"}`,
    `instance=${context.instanceId ?? "unknown"}`,
    `user=${context.requester?.displayName ?? context.requesterUserId ?? "unknown"}`,
    `channel=${context.channel ?? "unknown"}`,
    `thread=${context.threadId ?? "none"}`,
    `tools=${toolCount}`,
  ];
  if (context.inputArtifacts?.length) pieces.push(`inputArtifacts=${context.inputArtifacts.length}`);
  return pieces.join(", ");
}

export function publicContextSummary(context: BaseAgentRunContext): Record<string, unknown> {
  return {
    runId: context.runId,
    instanceId: context.instanceId,
    requesterUserId: context.requesterUserId,
    requester: context.requester,
    channel: context.channel,
    threadId: context.threadId,
    parentRunId: context.parentRunId,
    source: {
      sourceUserId: context.sourceUserId,
      sourceMessageId: context.sourceMessageId,
      sourceChatId: context.sourceChatId,
      sourceThreadId: context.sourceThreadId,
    },
    currentDateTimeIso: context.currentDateTimeIso,
    timeZone: context.timeZone,
    locale: context.locale,
    groupProfile: context.groupProfile,
    thread: context.thread,
    inputArtifacts: context.inputArtifacts,
  };
}

export function createToolSpanId(runId: string | undefined, toolCallNumber: number, toolName: string): string {
  const runPart = runId ?? "run";
  const toolPart = safeToolName(toolName).slice(0, 48);
  return `${runPart}-tool-${toolCallNumber}-${toolPart}`;
}

export function createLlmSpanId(runId: string | undefined, step: number): string {
  return `${runId ?? "run"}-llm-${step}`;
}

export function createAgentSpanId(runId: string | undefined, suffix: string): string {
  return `${runId ?? "run"}-agent-${suffix}`;
}

export function publicMessageForTrace(message: Message): Record<string, unknown> {
  const record: Record<string, unknown> = {
    role: message.role,
    content: limitText(message.content ?? "", 4_000),
  };
  if (message.tool_call_id) record.toolCallId = message.tool_call_id;
  if (message.tool_calls) {
    record.toolCalls = message.tool_calls.map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: limitText(call.function.arguments, 4_000),
    }));
  }
  return record;
}

export function summarizeToolResultForTrace(result: ToolResult, preview: string): Record<string, unknown> {
  return {
    ok: result.ok,
    content: limitText(result.content, 4_000),
    preview: limitText(preview, 4_000),
    data: summarizeTraceValue(result.data, 3),
  };
}

export function publicArtifactForTrace(artifact: AgentArtifact): Record<string, unknown> {
  return {
    id: artifact.id,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    url: artifact.url,
    qualityStatus: artifact.quality?.status,
  };
}

export function publicProofEvidenceForTrace(evidence: ProofEvidence): Record<string, unknown> {
  return {
    sourceUrl: evidence.sourceUrl,
    title: evidence.title,
    focusText: evidence.focusText,
    signals: evidence.signals.slice(0, 12),
    contentPreview: evidence.contentPreview ? limitText(evidence.contentPreview, 600) : undefined,
  };
}

export function summarizeTraceValue(value: unknown, depth: number): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return limitText(value, 2_000);
  if (Buffer.isBuffer(value)) return `<Buffer ${value.byteLength} bytes>`;
  if (Array.isArray(value)) {
    const items = value.slice(0, 12).map((entry) => summarizeTraceValue(entry, depth - 1));
    if (value.length > 12) items.push(`... ${value.length - 12} more item(s)`);
    return items;
  }
  if (typeof value === "object") {
    if (depth <= 0) return "<object>";
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 24)) {
      if (/secret|token|password|api[_-]?key|authorization/i.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = summarizeTraceValue(entry, depth - 1);
      }
    }
    return out;
  }
  return String(value);
}

export function formatContextForPrompt(context: BaseAgentRunContext): string {
  const lines = [
    `- Current date/time: ${context.currentDateTimeIso ?? "unknown"}`,
    `- Time zone: ${context.timeZone ?? "unknown"}`,
    `- Locale: ${context.locale ?? "unknown"}`,
    `- Instance: ${context.instanceId ?? "unknown"}`,
    `- Requester: ${context.requester?.displayName ?? context.requesterUserId ?? "unknown"} (${context.requester?.role ?? "role unknown"})`,
    `- Channel: ${context.channel ?? "unknown"}`,
    `- Thread: ${context.threadId ?? "none"}`,
  ];
  if (context.groupProfile) {
    lines.push(
      `- Group profile: ${context.groupProfile.name}${context.groupProfile.description ? ` - ${limitText(context.groupProfile.description, 280)}` : ""}`,
    );
    if (context.groupProfile.preferenceKeys?.length) {
      lines.push(`- Group preference keys: ${context.groupProfile.preferenceKeys.join(", ")}`);
    }
  }
  // The summary appends the newest "Answered: ..." digest at the END and
  // limitText keeps the head — 500 chars cut off exactly the latest answer.
  if (context.thread?.summary) lines.push(`- Thread summary: ${limitText(context.thread.summary, 1_400)}`);
  if (context.thread?.acceptedFacts?.length) {
    lines.push(`- Accepted thread facts: ${context.thread.acceptedFacts.slice(0, 8).map((fact) => limitText(fact, 180)).join("; ")}`);
  }
  if (context.thread?.openQuestions?.length) {
    lines.push(`- Open questions: ${context.thread.openQuestions.slice(0, 6).map((question) => limitText(question, 180)).join("; ")}`);
  }
  if (context.thread?.relevantArtifactIds?.length) {
    lines.push(`- Prior artifact ids: ${context.thread.relevantArtifactIds.slice(0, 12).join(", ")}`);
  }
  if (context.thread?.relevantArtifacts?.length) {
    lines.push("- Prior artifact summaries:");
    for (const artifact of context.thread.relevantArtifacts.slice(0, 6)) {
      lines.push(
        `  - ${artifact.id} ${artifact.filename} (${artifact.mimeType}, ${artifact.sizeBytes} bytes, qa=${artifact.qualityStatus ?? "unchecked"})${artifact.description ? ` - ${limitText(artifact.description, 180)}` : ""}`,
      );
      if (artifact.qualitySignals?.length) {
        lines.push(`    signals: ${artifact.qualitySignals.slice(0, 12).map((signal) => limitText(signal, 80)).join("; ")}`);
      }
      if (artifact.contentPreview) {
        lines.push(`    preview: ${limitText(artifact.contentPreview, 1200)}`);
      }
    }
    lines.push("- Prefer answering follow-up questions from prior artifact summaries when they contain the requested value; do not repeat identical external/API tool calls unless the prior artifact is missing, stale, failed QA, or insufficient.");
  }
  if (context.priorWork) {
    lines.push("- Prior Work/Evidence Ledger context:");
    lines.push(formatPriorWorkContextForPrompt(context.priorWork));
    if (context.priorWork.decision.decision === "reuse") {
      lines.push("- If the current request is a follow-up satisfied by this prior evidence, answer from it before doing fresh tool work.");
    } else if (context.priorWork.decision.decision === "refresh") {
      lines.push("- The user asked for fresh/current data; do not reuse prior evidence as truth.");
    } else if (context.priorWork.decision.decision === "retry_excluding") {
      lines.push("- Avoid retrying the listed rejected URLs unless the user explicitly asks to inspect them.");
    }
  }
  if (context.inputArtifacts?.length) {
    lines.push(
      `- Input artifacts: ${context.inputArtifacts
        .slice(0, 12)
        .map((artifact) => `${artifact.filename} (${artifact.mimeType}, ${artifact.sizeBytes} bytes)`)
        .join("; ")}`,
    );
  }
  return lines.join("\n");
}
