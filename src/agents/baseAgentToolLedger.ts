import type { AgentArtifact } from "../types.js";
import type { Tool, ToolResult } from "../tools/tool.js";
import type { RuntimeLedgerCoordinator } from "../work-ledger/runtimeLedgerCoordinator.js";
import { workKeyForToolCall } from "../work-ledger/runtimeLedgerCoordinator.js";
import type { EvidenceKind, EvidenceQaStatus, EvidenceRecord, WorkLedgerItem, WorkLedgerKind } from "../work-ledger/types.js";
import { extractSourceUrls } from "./baseAgentEvidence.js";
import { limitText, sanitizeArtifactValue } from "./baseAgentToolMessages.js";

const HTTP_REUSE_MAX_AGE_MS = 10 * 60 * 1000;

export type BaseAgentToolLedgerClaim = {
  workItemId?: string;
  startedArtifactCount: number;
  canonicalWorkKey?: string;
  kind?: WorkLedgerKind;
};

export type BaseAgentToolLedgerReuse = {
  reusedFromWorkItemId: string;
  evidenceIds: string[];
  artifactIds: string[];
  sourceUrls: string[];
  result: ToolResult;
  preview: string;
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
      canonicalWorkKey,
      kind,
    };
  } catch {
    return { startedArtifactCount: input.artifactCount };
  }
}

export async function findReusableBaseAgentToolWork(input: {
  ledger?: RuntimeLedgerCoordinator;
  tool: Tool;
  toolInput: Record<string, unknown>;
  task: string;
  toolSpanId: string;
}): Promise<BaseAgentToolLedgerReuse | undefined> {
  if (!input.ledger || !canPublishReusableToolWork(input.tool, input.toolInput)) {
    return undefined;
  }
  const kind = workKindForTool(input.tool);
  const canonicalWorkKey = workKeyForToolCall(input.tool.name, kind, input.toolInput);
  const currentSignal = shouldBypassReusableForFreshness(input.tool) ? currentDataSignalForTask(input.task) : undefined;
  if (currentSignal) {
    await input.ledger.recordReuseSkipped(
      {
        kind,
        workKey: canonicalWorkKey,
        toolName: input.tool.name,
        reason: `Task asks for current/fresh data (${currentSignal}); previous evidence must not be reused.`,
      },
      input.toolSpanId,
    );
    return undefined;
  }
  const reusable = await input.ledger.findReusableCompletedWork(
    {
      kind,
      workKey: canonicalWorkKey,
      allowedQaStatuses: ["passed"],
      minimumConfidence: 0.6,
      maxAgeMs: maxReuseAgeMs(input.tool),
    },
    input.toolSpanId,
  );
  if (!reusable) return undefined;
  const evidence = reusable.evidence[0];
  const sourceUrls = uniqueUrls([
    ...reusable.item.sourceUrls,
    ...reusable.evidence.map((record) => record.sourceUrl).filter((url): url is string => Boolean(url)),
  ]);
  const artifactIds = uniqueUrls([
    ...reusable.item.artifactIds,
    ...reusable.evidence.map((record) => record.artifactId).filter((id): id is string => Boolean(id)),
  ]);
  const result = toolResultFromReusableEvidence(input.tool, reusable.item, evidence, sourceUrls, artifactIds);
  return {
    reusedFromWorkItemId: reusable.item.id,
    evidenceIds: reusable.evidence.map((record) => record.id),
    artifactIds,
    sourceUrls,
    result,
    preview: limitText(evidence.contentPreview || evidence.summary || reusable.item.outputSummary || result.content, 2_000),
  };
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
    const evidence = await input.ledger.recordEvidence(
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
    if (evidence && input.result.ok) {
      await publishReusableToolWorkIndex({
        ledger: input.ledger,
        claim,
        tool: input.tool,
        toolInput: input.toolInput,
        preview: input.preview,
        result: input.result,
        sourceUrls,
        artifacts: newArtifacts,
        evidence,
        toolSpanId: input.toolSpanId,
      });
    }
  } catch {
    // Best-effort only.
  }
}

export async function completeBaseAgentToolWorkFromReuse(input: {
  ledger?: RuntimeLedgerCoordinator;
  claim?: BaseAgentToolLedgerClaim;
  tool: Tool;
  toolInput: Record<string, unknown>;
  reuse: BaseAgentToolLedgerReuse;
  toolSpanId: string;
}): Promise<void> {
  const workItemId = input.claim?.workItemId;
  if (!input.ledger || !workItemId) return;
  try {
    await input.ledger.markCompleted(workItemId, {
      outputSummary: limitText(input.reuse.preview, 1_000),
      sourceUrls: input.reuse.sourceUrls,
    });
    const evidence = await input.ledger.recordEvidence(
      {
        workItemId,
        spanId: input.toolSpanId,
        kind: evidenceKindForTool(input.tool, undefined),
        sourceUrl: input.reuse.sourceUrls[0],
        provider: input.tool.name,
        toolName: input.tool.name,
        title: `Reused tool result: ${input.tool.name}`,
        summary: limitText(input.reuse.preview, 1_000),
        contentPreview: limitText(input.reuse.result.content || input.reuse.preview, 2_000),
        artifactId: input.reuse.artifactIds[0],
        qaStatus: "passed",
        confidence: 0.85,
        metadata: {
          toolName: input.tool.name,
          toolVersion: input.tool.version,
          input: sanitizeArtifactValue(input.toolInput),
          output: {
            ok: input.reuse.result.ok,
            data: sanitizeArtifactValue(input.reuse.result.data),
          },
          reusedFromWorkItemId: input.reuse.reusedFromWorkItemId,
          reusedEvidenceIds: input.reuse.evidenceIds,
          reusedArtifactIds: input.reuse.artifactIds,
        },
      },
      input.toolSpanId,
    );
    await input.ledger.recordReuseApplied(
      {
        workItemId,
        reusedFromWorkItemId: input.reuse.reusedFromWorkItemId,
        evidenceIds: evidence ? [evidence.id, ...input.reuse.evidenceIds] : input.reuse.evidenceIds,
        artifactIds: input.reuse.artifactIds,
        sourceUrls: input.reuse.sourceUrls,
        toolName: input.tool.name,
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
  if (name === "file.read" || name === "file.write" || name === "document.extract") return "file";
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
  if (explicit && ["http.request", "web.read", "document.extract", "browser.screenshot", "browser.operate"].includes(name)) {
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

async function publishReusableToolWorkIndex(input: {
  ledger: RuntimeLedgerCoordinator;
  claim: BaseAgentToolLedgerClaim;
  tool: Tool;
  toolInput: Record<string, unknown>;
  preview: string;
  result: ToolResult;
  sourceUrls: string[];
  artifacts: AgentArtifact[];
  evidence: EvidenceRecord;
  toolSpanId: string;
}): Promise<void> {
  if (!input.claim.canonicalWorkKey || !input.claim.kind) return;
  if (!canPublishReusableToolWork(input.tool, input.toolInput)) return;
  await input.ledger.upsertReusableWorkIndex(
    {
      kind: input.claim.kind,
      workKey: input.claim.canonicalWorkKey,
      title: `Reusable tool result: ${input.tool.name}`,
      ownerSpanId: `${input.toolSpanId}:reuse-index`,
      inputSummary: limitText(JSON.stringify(sanitizeArtifactValue(input.toolInput)), 1_000),
      outputSummary: limitText(input.preview, 1_000),
      sourceUrls: input.sourceUrls,
      artifactIds: input.artifacts.map((artifact) => artifact.id),
      evidenceIds: [input.evidence.id],
      freshnessExpiresAt: reusableFreshnessExpiresAt(input.tool),
      metadata: {
        toolName: input.tool.name,
        toolVersion: input.tool.version,
        sourceWorkItemId: input.claim.workItemId,
        sourceEvidenceId: input.evidence.id,
        output: {
          ok: input.result.ok,
          data: sanitizeArtifactValue(input.result.data),
        },
      },
    },
    input.toolSpanId,
  );
}

function canPublishReusableToolWork(tool: Tool, toolInput: Record<string, unknown>): boolean {
  const name = tool.name.toLowerCase();
  if (name === "data.transform") return true;
  if (name === "document.extract") return documentExtractInputIsImmutable(toolInput);
  if (name !== "http.request") return false;
  const method = String(toolInput.method ?? "GET").trim().toUpperCase();
  return method === "GET" || method === "HEAD";
}

function maxReuseAgeMs(tool: Tool): number | undefined {
  return tool.name.toLowerCase() === "http.request" ? HTTP_REUSE_MAX_AGE_MS : undefined;
}

function shouldBypassReusableForFreshness(tool: Tool): boolean {
  return tool.name.toLowerCase() === "http.request";
}

function documentExtractInputIsImmutable(input: Record<string, unknown>): boolean {
  const hasInlineText = typeof input.content === "string";
  const hasInlineBase64 = typeof input.contentBase64 === "string";
  const hasMutableReference = typeof input.url === "string" || typeof input.path === "string";
  return (hasInlineText || hasInlineBase64) && !hasMutableReference;
}

function reusableFreshnessExpiresAt(tool: Tool): string | undefined {
  const maxAgeMs = maxReuseAgeMs(tool);
  return maxAgeMs === undefined ? undefined : new Date(Date.now() + maxAgeMs).toISOString();
}

function currentDataSignalForTask(task: string): string | undefined {
  const match = task.match(/\b(now|current|latest|today|fresh|live|real[-\s]?time)\b|сейчас|текущ|актуальн|последн|сегодня|свеж|цена|курс/i);
  return match?.[0];
}

function toolResultFromReusableEvidence(
  tool: Tool,
  item: WorkLedgerItem,
  evidence: EvidenceRecord,
  sourceUrls: string[],
  artifactIds: string[],
): ToolResult {
  const outputData = outputDataFromEvidence(evidence);
  return {
    ok: true,
    content: [
      `Reused passed ledger evidence for ${tool.name}.`,
      evidence.contentPreview || evidence.summary || item.outputSummary,
    ].filter(Boolean).join("\n\n"),
    data: outputData ?? {
      reusedFromWorkItemId: item.id,
      reusedEvidenceId: evidence.id,
      sourceUrls,
      artifactIds,
    },
  };
}

function outputDataFromEvidence(evidence: EvidenceRecord): unknown {
  const metadata = evidence.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const output = (metadata as Record<string, unknown>).output;
  if (!output || typeof output !== "object") return undefined;
  return (output as Record<string, unknown>).data;
}
