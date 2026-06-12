import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { AuditEventRecord } from "../../../audit/types.js";
import type { AgentRunRecord, RunStore } from "../../../runs/types.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import type {
  ToolMetadataStore,
  ToolModuleMetadata,
  ToolModuleVersionSummary,
} from "../../../tools/toolMetadataStore.js";
import type { ToolCreationRecord, ToolCreationStore } from "../../../tools/toolCreationStore.js";
import { validateSourceBundleRuntimeContract } from "../../../tools/toolPackageWorkspaceQa.js";
import type { AgentEvent } from "../../../types.js";
import {
  isRecord,
  parseOptionalText,
  parseRequiredText,
  sanitizeAuditMetadata,
} from "../../common/parsers.js";
import { AuditService } from "../../common/services/audit.service.js";
import {
  RELOAD_GENERATED_TOOLS,
  RUN_STORE,
  TOOL_CREATION_STORE,
  TOOL_METADATA_STORE,
  TOOL_REGISTRY,
} from "../../persistence/tokens.js";
import { parseGeneratedToolReplacementInput } from "./tool-parsers.js";
import { sourceBundlePackageDir } from "./tool-source-bundle-files.js";

@Injectable()
export class ToolVersionLifecycleService {
  constructor(
    @Inject(TOOL_REGISTRY) private readonly registry: ToolRegistry | undefined,
    @Inject(TOOL_METADATA_STORE) private readonly metadata: ToolMetadataStore | undefined,
    @Inject(RELOAD_GENERATED_TOOLS) private readonly reload: (() => Promise<void>) | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(TOOL_CREATION_STORE) private readonly creationStore?: ToolCreationStore,
    @Optional() @Inject(RUN_STORE) private readonly runs?: RunStore,
  ) {}

  async deleteGenerated(name: string): Promise<{ deleted: true; name: string }> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    const versionsBeforeDelete = await this.metadata.listVersions(name).catch(() => []);
    let deleted: boolean;
    try {
      deleted = await this.metadata.deleteGenerated(name);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid generated tool delete request",
      );
    }
    if (!deleted) throw new NotFoundException("Generated tool was not found");
    this.registry?.unregister?.(name);
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool.deleted",
      targetType: "tool",
      targetId: name,
      status: "success",
      summary: `Generated tool deleted: ${name}`,
    });
    for (const version of versionsBeforeDelete) {
      await this.appendToolVersionLifecycleEvent({
        type: "tool-version-deleted",
        name,
        version: version.version,
        status: "completed",
        title: "Generated tool deleted",
        detail: `Generated tool ${name}@${version.version} was deleted with the tool family.`,
        input: {
          name,
          version: version.version,
          active: version.active,
          status: version.status,
        },
        output: {
          deleted: true,
          scope: "tool-family",
        },
      });
    }
    await this.deleteCreationRecordsForTool(name);
    return { deleted: true, name };
  }

  private async deleteCreationRecordsForTool(name: string): Promise<void> {
    if (!this.creationStore) return;
    const records = await this.creationStore.list({ toolName: name }).catch(() => []);
    for (const record of records) {
      if (record.packageRef) {
        const packageDir = sourceBundlePackageDir(
          process.cwd(),
          process.env.TOOL_PACKAGE_WORKSPACE_ROOT ?? "tools",
          record.packageRef,
        );
        await rm(packageDir, { recursive: true, force: true });
      }
      if (record.runId) await this.runs?.delete(record.runId);
      await this.creationStore.delete(record.id);
    }
  }

  async markVersionAvailable(
    name: string,
    version: string,
  ): Promise<{ name: string; version: string; status: "available" }> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    try {
      await this.assertVersionIsNotRejected(name, version);
      const selected = (await this.metadata.listVersions(name)).find((candidate) => candidate.version === version);
      if (!selected) throw new Error(`Version ${version} for ${name} was not found.`);
      await this.assertVersionRuntimeContract(name, version, selected);
      const evidence = await this.assertVersionHasActivationEvidence(name, version);
      await this.metadata.markAvailable(name, version);
      await this.audit.record({
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "tool.version_activated",
        targetType: "tool",
        targetId: `${name}@${version}`,
        status: "success",
        summary: `Operator marked ${name} v${version} as available (verified)`,
        metadata: sanitizeAuditMetadata({
          activationEvidenceType: evidence.evidenceType,
          activationEvidenceAuditEventId: evidence.auditEventId,
          activationEvidenceRunId: evidence.runId,
          activationEvidenceRanAt: evidence.ranAt,
        }),
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid mark-available request",
      );
    }
    await this.appendToolVersionLifecycleEvent({
      type: "tool-version-marked-available",
      name,
      version,
      status: "completed",
      title: "Version marked available",
      detail: `Operator marked ${name}@${version} available after verification evidence.`,
      input: {
        name,
        version,
        requiredEvidence: "successful-manual-run-or-run-scoped-candidate-run",
      },
      output: {
        name,
        version,
        status: "available",
      },
    });
    return { name, version, status: "available" };
  }

  async deleteVersion(
    name: string,
    version: string,
  ): Promise<{ deleted: true; name: string; version: string }> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    let deleted: boolean;
    const versionBeforeDelete = (await this.metadata.listVersions(name))
      .find((candidate) => candidate.version === version);
    try {
      deleted = await this.metadata.deleteVersion(name, version);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid version delete request",
      );
    }
    if (!deleted) {
      throw new BadRequestException(
        `Cannot delete v${version} of ${name}: it is either the currently active version (activate another version first) or it is not on record.`,
      );
    }
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool.deleted",
      targetType: "tool",
      targetId: `${name}@${version}`,
      status: "success",
      summary: `Generated tool version deleted: ${name} v${version}`,
    });
    await this.appendToolVersionLifecycleEvent({
      type: "tool-version-deleted",
      name,
      version,
      status: "completed",
      title: "Generated version deleted",
      detail: `Generated tool version ${name}@${version} was deleted.`,
      input: {
        name,
        version,
        active: versionBeforeDelete?.active,
        status: versionBeforeDelete?.status,
      },
      output: {
        deleted: true,
        scope: "version",
      },
    });
    return { deleted: true, name, version };
  }

  async rejectVersion(
    name: string,
    version: string,
    rawBody: unknown,
  ): Promise<{ rejected: true; name: string; version: string; reason: string }> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    const reason = isRecord(rawBody)
      ? parseOptionalText(rawBody.reason) ?? "Operator rejected candidate version."
      : "Operator rejected candidate version.";
    const versions = await this.metadata.listVersions(name);
    const selected = versions.find((candidate) => candidate.version === version);
    if (!selected) throw new NotFoundException(`Version ${version} for ${name} was not found.`);
    if (selected.active) {
      throw new BadRequestException(
        `Cannot reject active version ${name}@${version}: activate another version first or disable the tool.`,
      );
    }
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool.version_rejected",
      targetType: "tool",
      targetId: `${name}@${version}`,
      status: "success",
      summary: `Rejected candidate version: ${name}@${version}`,
      metadata: sanitizeAuditMetadata({
        reason,
        status: selected.status,
        active: selected.active,
        packageRef: selected.packageManifest?.package.ref,
      }),
    });
    await this.appendToolVersionLifecycleEvent({
      type: "tool-version-rejected",
      name,
      version,
      status: "completed",
      title: "Candidate version rejected",
      detail: `Operator rejected ${name}@${version}: ${reason}`,
      input: {
        name,
        version,
        status: selected.status,
        active: selected.active,
        reason,
      },
      output: {
        rejected: true,
        toolName: name,
        toolVersion: version,
      },
    });
    return { rejected: true, name, version, reason };
  }

  async promoteReplacement(name: string, rawBody: unknown): Promise<ToolModuleMetadata> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    try {
      const input = parseGeneratedToolReplacementInput(name, rawBody);
      return await this.metadata.promoteReplacement(input);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid generated tool replacement",
      );
    }
  }

  async activateVersion(name: string, rawBody: unknown): Promise<ToolModuleMetadata> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    try {
      if (!isRecord(rawBody)) throw new Error("activate version request must be an object");
      const version = parseRequiredText(rawBody.version, "version");
      const versions = await this.metadata.listVersions(name);
      const selected = versions.find((candidate) => candidate.version === version);
      if (!selected) throw new Error(`Version ${version} for ${name} was not found.`);
      if (selected.status === "failed") {
        throw new Error(`Cannot activate ${name}@${version}: version is failed.`);
      }
      await this.assertVersionIsNotRejected(name, version);
      await this.assertVersionRuntimeContract(name, version, selected);
      const evidence = selected.active
        ? undefined
        : await this.assertVersionHasActivationEvidence(name, version);
      const tool = await this.metadata.activateVersion(name, version);
      if (!selected.active) {
        await this.metadata.markAvailable(name, version);
      }
      const activated = (await this.metadata.list()).find((candidate) => candidate.name === name) ?? tool;
      await this.reload?.();
      await this.audit.record({
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "tool.version_activated",
        targetType: "tool",
        targetId: `${name}@${version}`,
        status: "success",
        summary: `Activated ${name} ${version}`,
        metadata: sanitizeAuditMetadata({
          activationEvidenceAuditEventId: evidence?.auditEventId,
          activationEvidenceType: evidence?.evidenceType,
          activationEvidenceRunId: evidence?.runId,
          activationEvidenceRanAt: evidence?.ranAt,
          previousStatus: selected.status,
          markedAvailable: !selected.active,
        }),
      });
      await this.appendToolVersionLifecycleEvent({
        type: "tool-version-activated",
        name,
        version,
        status: "completed",
        title: "Version activated",
        detail: `Operator activated ${name}@${version}.`,
        input: {
          name,
          version,
          previousStatus: selected.status,
          selectedWasActive: selected.active,
          activationEvidenceAuditEventId: evidence?.auditEventId,
          activationEvidenceType: evidence?.evidenceType,
          activationEvidenceRunId: evidence?.runId,
          activationEvidenceRanAt: evidence?.ranAt,
        },
        output: {
          toolName: activated.name,
          toolVersion: activated.version,
          status: activated.status,
          markedAvailable: !selected.active,
        },
      });
      return activated;
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid generated tool version activation",
      );
    }
  }

  async acceptAgentVerifiedVersion(input: {
    name: string;
    version: string;
    runId?: string;
    replacesVersion?: string;
  }): Promise<ToolModuleMetadata> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    try {
      const versions = await this.metadata.listVersions(input.name);
      const selected = versions.find((candidate) => candidate.version === input.version);
      if (!selected) throw new Error(`Version ${input.version} for ${input.name} was not found.`);
      if (selected.status === "failed") {
        throw new Error(`Cannot accept ${input.name}@${input.version}: version is failed.`);
      }
      await this.assertVersionIsNotRejected(input.name, input.version);
      await this.metadata.markAvailable(input.name, input.version);
      const activated = await this.metadata.activateVersion(input.name, input.version);
      await this.reload?.();
      const active = (await this.metadata.list()).find((candidate) => candidate.name === input.name) ?? activated;
      await this.audit.record({
        instanceId: "instance-local",
        actorId: "base-agent",
        actorType: "agent",
        action: "tool.version_activated",
        targetType: "tool",
        targetId: `${input.name}@${input.version}`,
        status: "success",
        runId: input.runId,
        summary: `Agent-verified version accepted: ${input.name}@${input.version}`,
        metadata: sanitizeAuditMetadata({
          evidenceType: "agent-run-scoped-candidate-success",
          runId: input.runId,
          replacesVersion: input.replacesVersion,
          previousStatus: selected.status,
          selectedWasActive: selected.active,
        }),
      });
      await this.appendToolVersionLifecycleEvent({
        type: "tool-version-agent-accepted",
        name: input.name,
        version: input.version,
        status: "completed",
        title: "Agent-verified version accepted",
        detail: `${input.name}@${input.version} completed the originating run and was activated for future agents.`,
        sourceRunId: input.runId,
        input: {
          name: input.name,
          version: input.version,
          sourceRunId: input.runId,
          replacesVersion: input.replacesVersion,
          previousStatus: selected.status,
          selectedWasActive: selected.active,
        },
        output: {
          toolName: active.name,
          toolVersion: active.version,
          status: active.status,
          accepted: true,
        },
      });
      return active;
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid agent-verified version acceptance",
      );
    }
  }

  private async appendToolVersionLifecycleEvent(input: {
    type:
      | "tool-version-manual-run"
      | "tool-version-marked-available"
      | "tool-version-activated"
      | "tool-version-agent-accepted"
      | "tool-version-rejected"
      | "tool-version-deleted";
    name: string;
    version: string;
    status: "completed" | "failed";
    title: string;
    detail: string;
    sourceRunId?: string;
    input?: unknown;
    output?: unknown;
  }): Promise<void> {
    if (!this.creationStore || !this.runs) return;
    const creation = await this.findToolCreationRecordForVersion(input.name, input.version);
    if (!creation?.runId) return;
    const safeEventName = [
      input.type.replace(/^tool-version-/, ""),
      input.version,
      Date.now().toString(36),
    ].map(safeTraceIdPart).join("-");
    await this.runs.appendEvent(creation.runId, makeToolCreationEvent({
      type: input.type,
      spanId: `${creation.runId}:tool-version:${safeEventName}`,
      parentSpanId: `${creation.runId}:tool-creation`,
      actor: input.name,
      status: input.status,
      title: input.title,
      detail: input.detail,
      payload: {
        toolName: input.name,
        toolVersion: input.version,
        creationId: creation.id,
        creationRunId: creation.runId,
        sourceRunId: input.sourceRunId,
        input: input.input,
        output: input.output,
      },
    }));
  }

  private async findToolCreationRecordForVersion(
    name: string,
    version: string,
  ): Promise<ToolCreationRecord | undefined> {
    const records = await this.creationStore?.list({ toolName: name, limit: 200 }) ?? [];
    return records.find((record) => record.toolVersion === version);
  }

  private async assertVersionHasActivationEvidence(
    name: string,
    version: string,
  ): Promise<VersionActivationEvidenceEntry> {
    const evidence = buildManualVersionRunEvidence(name, version, await this.audit.list(1_000), true);
    if (evidence.latestSuccess) {
      return {
        ...evidence.latestSuccess,
        evidenceType: "manual-tool-version-run",
      };
    }
    const runScopedEvidence = await findRunScopedCandidateActivationEvidence(this.runs, name, version);
    if (runScopedEvidence) return runScopedEvidence;
    throw new Error(
      `Cannot promote ${name}@${version}: run this exact version manually or complete a run-scoped candidate run first.`,
    );
  }

  private async assertVersionIsNotRejected(name: string, version: string): Promise<void> {
    const auditEvents = await this.audit.list(1_000);
    if (isToolVersionRejected(name, version, auditEvents)) {
      throw new Error(`Cannot promote ${name}@${version}: candidate version was rejected.`);
    }
  }

  private async assertVersionRuntimeContract(
    name: string,
    version: string,
    selected: ToolModuleVersionSummary,
  ): Promise<void> {
    const manifest = selected.packageManifest;
    if (manifest?.package.type !== "source-bundle") return;
    const runtimeContract = await validateSourceBundleRuntimeContract(
      process.cwd(),
      manifest.package.ref,
      manifest.startupMode,
    );
    if (!runtimeContract.ok) {
      throw new Error(`Cannot activate ${name}@${version}: ${runtimeContract.detail}`);
    }
  }
}

type ManualVersionRunEvidenceEntry = {
  auditEventId: string;
  ranAt: string;
  durationMs?: number;
  inputPreview?: unknown;
  contentPreview?: string;
};

type VersionActivationEvidenceEntry = Omit<ManualVersionRunEvidenceEntry, "auditEventId"> & {
  evidenceType: "manual-tool-version-run" | "run-scoped-candidate-run";
  auditEventId?: string;
  runId?: string;
};

async function findRunScopedCandidateActivationEvidence(
  runs: RunStore | undefined,
  name: string,
  version: string,
): Promise<VersionActivationEvidenceEntry | undefined> {
  if (!runs) return undefined;
  const candidates = (await runs.list())
    .filter((run) => run.status === "completed")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const run of candidates) {
    const event = [...run.events]
      .reverse()
      .find((candidate) => {
        if (
          candidate.type !== "tool-candidate-manual-review-required"
          || candidate.status !== "completed"
        ) {
          return false;
        }
        const payload = parseRunScopedCandidatePayload(candidate.payload);
        return payload?.toolName === name && payload.toolVersion === version;
      });
    if (!event) continue;
    return {
      evidenceType: "run-scoped-candidate-run",
      runId: run.id,
      ranAt: event.completedAt ?? event.timestamp,
      inputPreview: parseRunScopedCandidatePayload(event.payload)?.input,
      contentPreview: candidateRunContentPreview(run),
    };
  }
  return undefined;
}

function parseRunScopedCandidatePayload(payload: unknown): {
  toolName: string;
  toolVersion: string;
  input?: unknown;
} | undefined {
  if (!isRecord(payload)) return undefined;
  const toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
  const toolVersion = typeof payload.toolVersion === "string" ? payload.toolVersion : undefined;
  if (!toolName || !toolVersion) return undefined;
  return { toolName, toolVersion, input: payload.input };
}

function candidateRunContentPreview(run: AgentRunRecord): string | undefined {
  const finalAnswer = run.result?.finalAnswer;
  if (typeof finalAnswer !== "string" || finalAnswer.trim().length === 0) return undefined;
  return finalAnswer.trim().slice(0, 1_000);
}

function buildManualVersionRunEvidence(
  name: string,
  version: string,
  auditEvents: AuditEventRecord[],
  requiredForActivation: boolean,
): NonNullable<ToolModuleVersionSummary["manualRunEvidence"]> {
  let successCount = 0;
  let failureCount = 0;
  let latestSuccess: ManualVersionRunEvidenceEntry | undefined;
  let latestFailure: ManualVersionRunEvidenceEntry | undefined;
  for (const event of auditEvents) {
    if (
      event.action !== "tool.manual_run"
      || event.targetId !== `${name}@${version}`
      || event.metadata?.evidenceType !== "manual-tool-version-run"
    ) {
      continue;
    }
    const entry = manualEvidenceEntryFromAudit(event);
    if (event.status === "success") {
      successCount += 1;
      latestSuccess ??= entry;
    } else if (event.status === "failure") {
      failureCount += 1;
      latestFailure ??= entry;
    }
  }
  return {
    successCount,
    failureCount,
    latestSuccess,
    latestFailure,
    requiredForActivation,
  };
}

function isToolVersionRejected(
  name: string,
  version: string,
  auditEvents: AuditEventRecord[],
): boolean {
  const latestDecision = auditEvents
    .filter((event) => event.targetId === `${name}@${version}`)
    .filter((event) =>
      event.action === "tool.version_rejected" ||
      event.action === "tool.version_activated",
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  return latestDecision?.action === "tool.version_rejected" && latestDecision.status === "success";
}

function manualEvidenceEntryFromAudit(event: AuditEventRecord): ManualVersionRunEvidenceEntry {
  const output = isRecord(event.metadata?.output) ? event.metadata.output : undefined;
  const contentPreview = typeof output?.contentPreview === "string" ? output.contentPreview : undefined;
  const durationMs = typeof event.metadata?.durationMs === "number" ? event.metadata.durationMs : undefined;
  return {
    auditEventId: event.id,
    ranAt: event.createdAt,
    durationMs,
    inputPreview: event.metadata?.inputPreview,
    contentPreview,
  };
}

function makeToolCreationEvent(input: {
  type: AgentEvent["type"];
  spanId: string;
  parentSpanId?: string;
  actor: string;
  status: AgentEvent["status"];
  title: string;
  detail?: string;
  payload?: unknown;
}): AgentEvent {
  const now = new Date().toISOString();
  return {
    id: `event_${randomUUID()}`,
    spanId: input.spanId,
    parentSpanId: input.parentSpanId,
    type: input.type,
    actor: input.actor,
    activity: "coordination",
    status: input.status,
    title: input.title,
    detail: input.detail,
    timestamp: now,
    startedAt: input.status === "started" ? now : undefined,
    completedAt: input.status === "completed" || input.status === "failed" ? now : undefined,
    payload: input.payload,
  };
}

function safeTraceIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
}
