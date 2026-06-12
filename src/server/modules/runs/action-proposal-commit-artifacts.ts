import type { ArtifactStore } from "../../../artifacts/artifactStore.js";
import {
  artifactInputFromCandidate,
  type ArtifactLike,
} from "../../../agents/baseAgentArtifacts.js";
import type { AuditService } from "../../common/services/audit.service.js";
import type { AgentRunRecord, RunStore } from "../../../runs/types.js";
import type { AgentArtifact, ArtifactCreateInput } from "../../../types.js";
import { isRecord, sanitizeAuditMetadata } from "../../common/parsers.js";

export function extractReturnedCommitArtifacts(
  toolName: string,
  result: { data?: unknown },
): ArtifactCreateInput[] {
  const data = isRecord(result.data) ? result.data : {};
  const candidates: unknown[] = [];
  if (isRecord(data.artifact)) candidates.push(data.artifact);
  if (Array.isArray(data.artifacts)) candidates.push(...data.artifacts);
  if (Array.isArray(data.screenshots)) candidates.push(...data.screenshots);
  return candidates
    .filter(isRecord)
    .map((candidate) =>
      artifactInputFromCandidate(toolName, candidate as ArtifactLike),
    )
    .filter((artifact): artifact is ArtifactCreateInput => Boolean(artifact));
}

export async function saveCommitArtifact(input: {
  artifacts: ArtifactStore | undefined;
  audit: AuditService;
  runs: RunStore;
  run: AgentRunRecord;
  proposalId: string;
  toolName: string;
  toolVersion?: string;
  spanId: string;
  artifact: ArtifactCreateInput;
}): Promise<AgentArtifact | undefined> {
  if (!input.artifacts) return undefined;
  const saved = await input.artifacts.saveGenerated(input.run.id, input.artifact);
  await input.audit.record({
    instanceId: input.run.instanceId,
    actorId: input.toolName,
    actorType: "tool",
    action: "artifact.generated",
    targetType: "artifact",
    targetId: saved.id,
    status: "success",
    runId: input.run.id,
    threadId: input.run.threadId,
    requesterUserId: input.run.requesterUserId,
    channel: input.run.channel,
    summary: `External action commit artifact generated: ${saved.filename}`,
    metadata: sanitizeAuditMetadata({
      proposalId: input.proposalId,
      toolName: input.toolName,
      toolVersion: input.toolVersion,
      filename: saved.filename,
      mimeType: saved.mimeType,
      sizeBytes: saved.sizeBytes,
    }),
  });
  const now = new Date().toISOString();
  await input.runs.appendEvent(input.run.id, {
    id: `action-artifact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    spanId: `${input.spanId}-artifact-${saved.id}`,
    parentSpanId: input.spanId,
    type: "artifact-created",
    actor: input.toolName,
    activity: "tool",
    status: "completed",
    title: `Commit proof artifact saved: ${saved.filename}`,
    detail: saved.description,
    timestamp: now,
    startedAt: now,
    completedAt: now,
    payload: {
      proposalId: input.proposalId,
      artifactId: saved.id,
      filename: saved.filename,
      mimeType: saved.mimeType,
      sizeBytes: saved.sizeBytes,
      toolName: input.toolName,
      toolVersion: input.toolVersion,
      output: {
        artifactId: saved.id,
        filename: saved.filename,
        url: saved.url,
        qualityStatus: saved.quality?.status,
      },
    },
  });
  return saved;
}
