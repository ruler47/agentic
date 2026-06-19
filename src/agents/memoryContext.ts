import type { AgentArtifact, MemoryScope, SkillMemoryEntry } from "../types.js";
import { evaluateMemoryPolicy } from "../memory/memoryPolicy.js";
import type { MemoryScopeFilter } from "../memory/skillMemory.js";
import { normalizeMemoryConfidence, normalizeMemoryScope, normalizeMemorySensitivity } from "../memory/skillMemory.js";
import { formatPriorWorkContextForPrompt, type PriorWorkContext } from "../work-ledger/priorWorkResolver.js";
import { limitText } from "./baseAgentToolMessages.js";
import type { BaseAgentRunContext } from "./baseAgentTypes.js";

type RuntimeArtifactRef = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  description?: string;
  contentPreview?: string;
  qualityStatus?: NonNullable<AgentArtifact["quality"]>["status"];
  qualitySignals?: string[];
};

export type MemoryContextEntry = {
  id: string;
  title: string;
  scope: MemoryScope;
  scopeId?: string;
  summary: string;
  reusableProcedure?: string;
  tags: string[];
  confidence: number;
  sensitivity: "normal" | "sensitive" | "private";
  sourceRunId?: string;
  sourceThreadId?: string;
  evidence: string[];
  match?: SkillMemoryEntry["match"];
  policyReasons: string[];
};

export type MemoryContextView = {
  run: {
    runId?: string;
    parentRunId?: string;
    inputArtifacts: RuntimeArtifactRef[];
  };
  thread?: {
    threadId?: string;
    summary?: string;
    acceptedFacts: string[];
    rejectedAttempts: string[];
    openQuestions: string[];
    relevantArtifactIds: string[];
    relevantArtifacts: RuntimeArtifactRef[];
  };
  user?: {
    id?: string;
    displayName?: string;
    role?: string;
    roles: string[];
  };
  group?: {
    id?: string;
    name?: string;
    description?: string;
    preferenceKeys: string[];
  };
  acceptedLearning: MemoryContextEntry[];
  priorWork?: PriorWorkContext;
  visibleScopes: MemoryScopeFilter[];
  generatedAt: string;
};

export function buildMemoryContextView(
  context: BaseAgentRunContext,
  now = new Date(),
): MemoryContextView {
  const visibleScopes = visibleMemoryScopesForRunContext(context);
  const requesterUserId = context.requesterUserId ?? context.requester?.id;
  const acceptedLearning = (context.acceptedMemories ?? [])
    .map((entry) => {
      const decision = evaluateMemoryPolicy(entry, { visibleScopes, requesterUserId });
      return { entry, decision };
    })
    .filter(({ decision }) => decision.status === "allowed")
    .slice(0, 8)
    .map(({ entry, decision }) => toMemoryContextEntry(entry, decision.reasons));

  return {
    run: {
      runId: context.runId,
      parentRunId: context.parentRunId,
      inputArtifacts: (context.inputArtifacts ?? []).map((artifact) => ({
        id: artifact.id,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        description: artifact.description,
      })),
    },
    thread: context.thread || context.threadId
      ? {
          threadId: context.threadId,
          summary: context.thread?.summary,
          acceptedFacts: [...(context.thread?.acceptedFacts ?? [])],
          rejectedAttempts: [...(context.thread?.rejectedAttempts ?? [])],
          openQuestions: [...(context.thread?.openQuestions ?? [])],
          relevantArtifactIds: [...(context.thread?.relevantArtifactIds ?? [])],
          relevantArtifacts: [...(context.thread?.relevantArtifacts ?? [])],
        }
      : undefined,
    user: requesterUserId || context.requester
      ? {
          id: requesterUserId,
          displayName: context.requester?.displayName,
          role: context.requester?.role,
          roles: [...(context.requester?.roles ?? [])],
        }
      : undefined,
    group: context.groupProfile
      ? {
          id: context.groupProfile.id,
          name: context.groupProfile.name,
          description: context.groupProfile.description,
          preferenceKeys: [...(context.groupProfile.preferenceKeys ?? [])],
        }
      : undefined,
    acceptedLearning,
    priorWork: context.priorWork,
    visibleScopes,
    generatedAt: now.toISOString(),
  };
}

export function visibleMemoryScopesForRunContext(context: BaseAgentRunContext): MemoryScopeFilter[] {
  const scopes: MemoryScopeFilter[] = [{ scope: "global" }];
  if (context.groupProfile?.id) scopes.push({ scope: "group", scopeId: context.groupProfile.id });
  const requesterUserId = context.requesterUserId ?? context.requester?.id;
  if (requesterUserId) scopes.push({ scope: "user", scopeId: requesterUserId });
  if (context.threadId) scopes.push({ scope: "thread", scopeId: context.threadId });
  if (context.runId) scopes.push({ scope: "run", scopeId: context.runId });
  return scopes;
}

export function formatMemoryContextForPrompt(view: MemoryContextView): string {
  const lines: string[] = [];
  if (view.group?.name) {
    lines.push(
      `- Group profile: ${view.group.name}${view.group.description ? ` - ${limitText(view.group.description, 280)}` : ""}`,
    );
    if (view.group.preferenceKeys.length) {
      lines.push(`- Group preference keys: ${view.group.preferenceKeys.join(", ")}`);
    }
  }
  if (view.thread?.summary) lines.push(`- Thread summary: ${limitText(view.thread.summary, 1_400)}`);
  if (view.thread?.acceptedFacts.length) {
    lines.push(`- Accepted thread facts: ${view.thread.acceptedFacts.slice(0, 8).map((fact) => limitText(fact, 180)).join("; ")}`);
  }
  if (view.thread?.openQuestions.length) {
    lines.push(`- Open questions: ${view.thread.openQuestions.slice(0, 6).map((question) => limitText(question, 180)).join("; ")}`);
  }
  if (view.thread?.relevantArtifactIds.length) {
    lines.push(`- Prior artifact ids: ${view.thread.relevantArtifactIds.slice(0, 12).join(", ")}`);
  }
  appendArtifactSummaries(lines, view.thread?.relevantArtifacts ?? []);
  appendPriorWork(lines, view.priorWork);
  if (view.run.inputArtifacts.length) {
    lines.push(
      `- Input artifacts: ${view.run.inputArtifacts
        .slice(0, 12)
        .map((artifact) => `${artifact.filename} (${artifact.mimeType}, ${artifact.sizeBytes} bytes)`)
        .join("; ")}`,
    );
  }
  if (view.acceptedLearning.length) {
    lines.push("- Accepted learning memory:");
    for (const entry of view.acceptedLearning.slice(0, 8)) {
      const scope = entry.scope === "global" ? "global" : `${entry.scope}:${entry.scopeId ?? "unknown"}`;
      lines.push(`  - ${entry.title} [${scope}, confidence=${Math.round(entry.confidence * 100)}%]: ${limitText(entry.summary, 240)}`);
      if (entry.reusableProcedure) lines.push(`    procedure: ${limitText(entry.reusableProcedure, 300)}`);
      if (entry.evidence.length) lines.push(`    evidence: ${entry.evidence.slice(0, 3).map((item) => limitText(item, 120)).join("; ")}`);
    }
  }
  if (!lines.length) lines.push("- No scoped runtime memory was available.");
  return lines.join("\n");
}

export function publicMemoryContextForTrace(view: MemoryContextView): Record<string, unknown> {
  return {
    run: view.run,
    thread: view.thread
      ? {
          ...view.thread,
          summary: view.thread.summary ? limitText(view.thread.summary, 1_400) : undefined,
          relevantArtifacts: view.thread.relevantArtifacts.map(publicArtifactRef),
        }
      : undefined,
    user: view.user,
    group: view.group,
    acceptedLearning: view.acceptedLearning.map((entry) => ({
      id: entry.id,
      title: entry.title,
      scope: entry.scope,
      scopeId: entry.scopeId,
      tags: entry.tags,
      confidence: entry.confidence,
      sensitivity: entry.sensitivity,
      sourceRunId: entry.sourceRunId,
      sourceThreadId: entry.sourceThreadId,
      summary: limitText(entry.summary, 600),
      policyReasons: entry.policyReasons,
    })),
    priorWorkDecision: view.priorWork?.decision,
    visibleScopes: view.visibleScopes,
    generatedAt: view.generatedAt,
  };
}

function toMemoryContextEntry(entry: SkillMemoryEntry, policyReasons: string[]): MemoryContextEntry {
  return {
    id: entry.id,
    title: entry.title,
    scope: normalizeMemoryScope(entry.scope),
    scopeId: entry.scopeId,
    summary: entry.summary,
    reusableProcedure: entry.reusableProcedure,
    tags: [...(entry.tags ?? [])],
    confidence: normalizeMemoryConfidence(entry.confidence),
    sensitivity: normalizeMemorySensitivity(entry.sensitivity),
    sourceRunId: entry.sourceRunId,
    sourceThreadId: entry.sourceThreadId,
    evidence: [...(entry.evidence ?? [])],
    match: entry.match,
    policyReasons,
  };
}

function appendArtifactSummaries(lines: string[], artifacts: RuntimeArtifactRef[]): void {
  if (!artifacts.length) return;
  lines.push("- Prior artifact summaries:");
  for (const artifact of artifacts.slice(0, 6)) {
    lines.push(
      `  - ${artifact.id} ${artifact.filename} (${artifact.mimeType}, ${artifact.sizeBytes} bytes, qa=${artifact.qualityStatus ?? "unchecked"})${artifact.description ? ` - ${limitText(artifact.description, 180)}` : ""}`,
    );
    if (artifact.qualitySignals?.length) {
      lines.push(`    signals: ${artifact.qualitySignals.slice(0, 12).map((signal) => limitText(signal, 80)).join("; ")}`);
    }
    if (artifact.contentPreview) lines.push(`    preview: ${limitText(artifact.contentPreview, 1_200)}`);
  }
  lines.push("- Prefer answering follow-up questions from prior artifact summaries when they contain the requested value; do not repeat identical external/API tool calls unless the prior artifact is missing, stale, failed QA, or insufficient.");
}

function appendPriorWork(lines: string[], priorWork: PriorWorkContext | undefined): void {
  if (!priorWork) return;
  lines.push("- Prior Work/Evidence Ledger context:");
  lines.push(formatPriorWorkContextForPrompt(priorWork));
  if (priorWork.decision.decision === "reuse") {
    lines.push("- If the current request is a follow-up satisfied by this prior evidence, answer from it before doing fresh tool work.");
  } else if (priorWork.decision.decision === "refresh") {
    lines.push("- The user asked for fresh/current data; do not reuse prior evidence as truth.");
  } else if (priorWork.decision.decision === "retry_excluding") {
    lines.push("- Avoid retrying the listed rejected URLs unless the user explicitly asks to inspect them.");
  }
}

function publicArtifactRef(artifact: RuntimeArtifactRef): Record<string, unknown> {
  return {
    id: artifact.id,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    description: artifact.description ? limitText(artifact.description, 300) : undefined,
    qualityStatus: artifact.qualityStatus,
    qualitySignals: artifact.qualitySignals?.slice(0, 12),
  };
}
