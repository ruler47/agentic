import type { AgentArtifact } from "../types.js";
import type { Tool, ToolResult } from "../tools/tool.js";
import type { RuntimeLedgerCoordinator } from "../work-ledger/runtimeLedgerCoordinator.js";
import { workKeyForToolCall } from "../work-ledger/runtimeLedgerCoordinator.js";
import type { EvidenceKind, EvidenceQaStatus, WorkLedgerItem, WorkLedgerKind } from "../work-ledger/types.js";
import { extractSourceUrls } from "./baseAgentEvidence.js";
import { limitText, sanitizeArtifactValue } from "./baseAgentToolMessages.js";

export type BaseAgentToolLedgerClaim = {
  workItemId?: string;
  startedArtifactCount: number;
};

export async function claimBaseAgentToolWork(input: {
  ledger?: RuntimeLedgerCoordinator;
  tool: Tool;
  toolInput: Record<string, unknown>;
  runId?: string;
  threadId?: string;
  instanceId?: string;
  toolSpanId: string;
  task: string;
  step: number;
  attemptedToolCalls: number;
  artifactCount: number;
}): Promise<BaseAgentToolLedgerClaim> {
  if (!input.ledger) return { startedArtifactCount: input.artifactCount };
  const kind = workKindForTool(input.tool);
  const canonicalWorkKey = workKeyForToolCall(input.tool.name, kind, input.toolInput);
  try {
    const claim = await input.ledger.claim(
      {
        kind,
        workKey: executionWorkKey(canonicalWorkKey, input.runId, input.toolSpanId),
        title: `Tool call: ${input.tool.name}`,
        ownerSpanId: input.toolSpanId,
        inputSummary: limitText(JSON.stringify(sanitizeArtifactValue(input.toolInput)), 1_000),
        reason: "BaseAgent is about to execute a registered tool call.",
        metadata: {
          toolName: input.tool.name,
          toolVersion: input.tool.version,
          capabilities: input.tool.capabilities,
          step: input.step,
          toolCallNumber: input.attemptedToolCalls,
          requestedBy: "base-agent",
          canonicalWorkKey,
          task: limitText(input.task, 500),
        },
      },
      input.toolSpanId,
    );
    return {
      workItemId: claim?.item.id,
      startedArtifactCount: input.artifactCount,
    };
  } catch {
    return { startedArtifactCount: input.artifactCount };
  }
}

export async function completeBaseAgentToolWork(input: {
  ledger?: RuntimeLedgerCoordinator;
  claim?: BaseAgentToolLedgerClaim;
  tool: Tool;
  toolInput: Record<string, unknown>;
  result: ToolResult;
  preview: string;
  artifacts: AgentArtifact[];
  toolSpanId: string;
  durationMs: number;
}): Promise<void> {
  const claim = input.claim;
  const workItemId = claim?.workItemId;
  if (!input.ledger || !workItemId) return;

  const sourceUrls = sourceUrlsForTool(input.tool, input.toolInput, input.result);
  const newArtifacts = input.artifacts.slice(claim.startedArtifactCount);
  const qaStatus = qaStatusForToolResult(input.result, newArtifacts);
  const primaryArtifact = newArtifacts[0];
  const evidenceKind = evidenceKindForTool(input.tool, primaryArtifact);
  const limitations = limitationsForToolResult(input.result, newArtifacts);

  try {
    if (input.result.ok) {
      await input.ledger.markCompleted(workItemId, {
        outputSummary: limitText(input.preview, 1_000),
        sourceUrls,
      });
    } else {
      await input.ledger.markFailed(workItemId, limitText(input.result.content || "Tool returned a failed result.", 1_000));
    }
  } catch {
    // Ledger is observability; never fail user work because the ledger write failed.
  }

  try {
    await input.ledger.recordEvidence(
      {
        workItemId,
        spanId: input.toolSpanId,
        kind: evidenceKind,
        sourceUrl: sourceUrls[0],
        provider: input.tool.name,
        toolName: input.tool.name,
        title: `Tool result: ${input.tool.name}`,
        summary: limitText(input.preview, 1_000),
        contentPreview: limitText(input.result.content || input.preview, 2_000),
        artifactId: primaryArtifact?.id,
        qaStatus,
        confidence: qaStatus === "passed" ? 0.9 : qaStatus === "failed" ? 0.2 : 0.6,
        limitations,
        metadata: {
          toolName: input.tool.name,
          toolVersion: input.tool.version,
          durationMs: input.durationMs,
          input: sanitizeArtifactValue(input.toolInput),
          output: {
            ok: input.result.ok,
            data: sanitizeArtifactValue(input.result.data),
          },
          artifactIds: newArtifacts.map((artifact) => artifact.id),
          artifactQuality: newArtifacts.map((artifact) => ({
            id: artifact.id,
            status: artifact.quality?.status,
          })),
        },
      },
      input.toolSpanId,
    );
  } catch {
    // Best-effort only.
  }
}

export async function failBaseAgentToolWork(input: {
  ledger?: RuntimeLedgerCoordinator;
  claim?: BaseAgentToolLedgerClaim;
  tool: Tool;
  toolInput: Record<string, unknown>;
  error: string;
  toolSpanId: string;
  durationMs: number;
}): Promise<void> {
  const workItemId = input.claim?.workItemId;
  if (!input.ledger || !workItemId) return;
  try {
    await input.ledger.markFailed(workItemId, limitText(input.error, 1_000));
    await input.ledger.recordEvidence(
      {
        workItemId,
        spanId: input.toolSpanId,
        kind: "limitation",
        provider: input.tool.name,
        toolName: input.tool.name,
        title: `Tool failed: ${input.tool.name}`,
        summary: limitText(input.error, 1_000),
        contentPreview: limitText(input.error, 2_000),
        qaStatus: "failed",
        confidence: 0.1,
        limitations: [limitText(input.error, 500)],
        metadata: {
          toolName: input.tool.name,
          toolVersion: input.tool.version,
          durationMs: input.durationMs,
          input: sanitizeArtifactValue(input.toolInput),
        },
      },
      input.toolSpanId,
    );
  } catch {
    // Best-effort only.
  }
}

function workKindForTool(tool: Tool): WorkLedgerKind {
  const name = tool.name.toLowerCase();
  const haystack = `${tool.name} ${tool.description} ${tool.capabilities.join(" ")}`.toLowerCase();
  if (name === "web.search" || /\bweb-search\b|\bsearch\b/.test(haystack)) return "search";
  if (name === "web.read" || /\bweb-read\b|\burl-read\b|\bpage-read\b/.test(haystack)) return "url_visit";
  if (name === "http.request" || /\bhttp-json\b|\bapi-client\b|\bexternal-api\b/.test(haystack)) return "api_call";
  if (name === "browser.screenshot" || /\bbrowser-screenshot\b|\bscreenshot\b/.test(haystack)) return "screenshot";
  if (name === "file.write") return "artifact_generation";
  if (name === "file.read" || name === "document.extract") return "data_fetch";
  if (name === "data.transform") return "analysis";
  return "tool_call";
}

function evidenceKindForTool(tool: Tool, artifact: AgentArtifact | undefined): EvidenceKind {
  const name = tool.name.toLowerCase();
  if (artifact?.mimeType.startsWith("image/") || name === "browser.screenshot") return "screenshot";
  if (name === "web.search") return "search_result";
  if (name === "web.read") return "source_url";
  if (name === "browser.operate") return "browser_snapshot";
  if (name === "http.request") return "api_response";
  if (name === "file.read" || name === "file.write") return "file";
  if (artifact) return "artifact";
  return "other";
}

function qaStatusForToolResult(result: ToolResult, artifacts: AgentArtifact[]): EvidenceQaStatus {
  if (!result.ok) return "failed";
  const statuses = artifacts
    .map((artifact) => artifact.quality?.status)
    .filter((status): status is NonNullable<AgentArtifact["quality"]>["status"] => Boolean(status));
  if (statuses.length === 0) return "passed";
  if (statuses.every((status) => status === "passed")) return "passed";
  if (statuses.every((status) => status === "failed")) return "failed";
  return "partial";
}

function limitationsForToolResult(result: ToolResult, artifacts: AgentArtifact[]): string[] {
  const limitations = new Set<string>();
  if (!result.ok && result.content) limitations.add(limitText(result.content, 500));
  for (const artifact of artifacts) {
    if (artifact.quality?.status === "passed") continue;
    const reason = artifact.quality?.checks
      ?.filter((check) => !check.ok)
      .map((check) => check.reason)
      .find(Boolean);
    if (reason) limitations.add(limitText(`${artifact.filename}: ${reason}`, 500));
  }
  return [...limitations];
}

function sourceUrlsForTool(tool: Tool, toolInput: Record<string, unknown>, result: ToolResult): string[] {
  const discovered = extractSourceUrls(toolInput, result).filter(isEvidenceSourceUrl);
  const explicit = explicitInputUrl(toolInput);
  const name = tool.name.toLowerCase();
  if (explicit && ["http.request", "web.read", "browser.screenshot", "browser.operate"].includes(name)) {
    return uniqueUrls([explicit, ...discovered.filter((url) => url !== explicit)]);
  }
  return uniqueUrls(discovered);
}

function explicitInputUrl(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["url", "sourceUrl", "href"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) return candidate;
  }
  return undefined;
}

function isEvidenceSourceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "nel.heroku.com" || hostname.endsWith(".nel.heroku.com")) return false;
    if (parsed.pathname === "/reports" && parsed.searchParams.has("sid")) return false;
  } catch {
    return false;
  }
  return true;
}

function uniqueUrls(urls: string[]): string[] {
  return [...new Set(urls)];
}

function executionWorkKey(canonicalWorkKey: string, runId: string | undefined, spanId: string): string {
  return `${canonicalWorkKey}#execution:${runId ?? "unknown-run"}:${spanId}`;
}
