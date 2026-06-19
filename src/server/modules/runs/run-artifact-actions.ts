import { readFile } from "node:fs/promises";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { ArtifactStore } from "../../../artifacts/artifactStore.js";
import type { AuditService } from "../../common/services/audit.service.js";

export async function getRunArtifact(input: {
  artifacts?: ArtifactStore;
  runId: string;
  artifactId: string;
}) {
  if (!input.artifacts) {
    throw new ServiceUnavailableException("Artifact store is not configured");
  }
  const stored = await input.artifacts.read(input.runId, input.artifactId);
  if (!stored) throw new NotFoundException("Artifact not found");
  const buffer = stored.content ?? (stored.path ? await readFile(stored.path) : Buffer.alloc(0));
  return { stored, buffer };
}

export async function deleteRunArtifact(input: {
  artifacts?: ArtifactStore;
  audit: AuditService;
  runId: string;
  artifactId: string;
}): Promise<{ deleted: true; id: string; runId: string }> {
  if (!input.artifacts) {
    throw new ServiceUnavailableException("Artifact store is not configured");
  }
  const deleted = await input.artifacts.delete(input.runId, input.artifactId);
  if (!deleted) throw new NotFoundException("Artifact not found");
  await input.audit.record({
    instanceId: "instance-local",
    actorId: "user-admin",
    actorType: "user",
    action: "artifact.deleted",
    targetType: "artifact",
    targetId: input.artifactId,
    runId: input.runId,
    status: "success",
    summary: `Artifact deleted: ${input.artifactId} (run ${input.runId})`,
  });
  return { deleted: true, id: input.artifactId, runId: input.runId };
}
