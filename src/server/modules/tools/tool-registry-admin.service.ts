import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { AuditEventRecord } from "../../../audit/types.js";
import type { AgentRunRecord, RunStore } from "../../../runs/types.js";
import type { ToolRuntimeSettingsStore } from "../../../settings/toolRuntimeSettings.js";
import type { SecretHandleStore } from "../../../secrets/secretHandleStore.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import type {
  ToolMetadataStore,
  ToolModuleMetadata,
  ToolModuleVersionSummary,
  ToolVersionLifecycleEvent,
} from "../../../tools/toolMetadataStore.js";
import { toolToMetadata } from "../../../tools/toolMetadataStore.js";
import type { ToolCreationRecord, ToolCreationStore } from "../../../tools/toolCreationStore.js";
import type { ToolPackageRunner } from "../../../tools/toolPackageRunner.js";
import { resolveToolRuntimeReadiness } from "../../../tools/toolRuntimeReadiness.js";
import {
  isRecord,
  parseRequiredText,
  sanitizeAuditMetadata,
} from "../../common/parsers.js";
import { AuditService } from "../../common/services/audit.service.js";
import {
  RELOAD_GENERATED_TOOLS,
  RUN_STORE,
  SECRET_HANDLE_STORE,
  TOOL_CREATION_STORE,
  TOOL_METADATA_STORE,
  TOOL_PACKAGE_RUNNERS,
  TOOL_REGISTRY,
  TOOL_RUNTIME_SETTINGS,
} from "../../persistence/tokens.js";
import {
  parseGeneratedToolModuleInput,
  parseToolPackageManifestImport,
} from "./tool-parsers.js";

@Injectable()
export class ToolRegistryAdminService {
  constructor(
    @Inject(TOOL_REGISTRY) private readonly registry: ToolRegistry | undefined,
    @Inject(TOOL_METADATA_STORE) private readonly metadata: ToolMetadataStore | undefined,
    @Inject(TOOL_RUNTIME_SETTINGS) private readonly runtimeSettings: ToolRuntimeSettingsStore | undefined,
    @Inject(TOOL_PACKAGE_RUNNERS) private readonly packageRunners: ToolPackageRunner[] | undefined,
    @Inject(RELOAD_GENERATED_TOOLS) private readonly reload: (() => Promise<void>) | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(TOOL_CREATION_STORE) private readonly creationStore?: ToolCreationStore,
    @Optional() @Inject(SECRET_HANDLE_STORE) private readonly secretHandles?: SecretHandleStore,
    @Optional() @Inject(RUN_STORE) private readonly runs?: RunStore,
  ) {}

  async listTools(): Promise<ToolModuleMetadata[]> {
    const tools = this.registry?.list() ?? [];
    if (this.metadata) {
      const metadataTools = await this.metadata.list();
      const auditEvents = await this.audit.list(1_000);
      const creationRecords = await this.creationStore?.list({ limit: 1_000 }) ?? [];
      const runRecords = await this.runs?.list() ?? [];
      return Promise.all(metadataTools.map(async (tool) => ({
        ...(await this.withRuntimeReadiness(tool)),
        versions: await Promise.all((tool.versions ?? []).map(async (version) => {
          const lifecycleEvents = buildToolVersionLifecycleEvents({
            name: tool.name,
            version: version.version,
            creationRecords,
            auditEvents,
          });
          const activeMirror = version.active && tool.version === version.version ? tool : undefined;
          return {
            ...version,
            status: activeMirror?.status ?? version.status,
            lastHealthDetail: activeMirror?.lastHealthDetail ?? version.lastHealthDetail,
            successCount: activeMirror?.successCount ?? version.successCount,
            failureCount: activeMirror?.failureCount ?? version.failureCount,
            manualRunEvidence: buildManualVersionRunEvidence(tool.name, version.version, auditEvents, !version.active),
            runScopedCandidateEvidence: buildRunScopedCandidateEvidence(
              tool.name,
              version.version,
              runRecords,
              !version.active,
            ),
            reviewStatus: deriveToolVersionReviewStatus(version.active, lifecycleEvents),
            lifecycleEvents,
          };
        })),
      })));
    }
    return Promise.all(tools.map((tool) => this.withRuntimeReadiness(toolToMetadata(tool))));
  }

  async toolHealth(): Promise<Array<{ name: string; ok: boolean; detail?: string }>> {
    const tools = this.registry?.list() ?? [];
    return Promise.all(
      tools.map(async (tool) => {
        const health = tool.healthcheck
          ? await tool.healthcheck()
          : { ok: true, detail: "No healthcheck registered." };
        const readiness = await this.evaluateRuntimeReadiness(toolToMetadata(tool));
        const result = readiness.ok
          ? health
          : { ok: false, detail: readiness.message };
        await this.metadata?.updateHealth(tool.name, result);
        return { name: tool.name, ...result, runtimeReadiness: readiness };
      }),
    );
  }

  async reloadGenerated(): Promise<{ tools: ToolModuleMetadata[] }> {
    if (!this.reload) {
      throw new ServiceUnavailableException("Generated tool reload is not configured");
    }
    try {
      await this.reload();
    } catch (error) {
      throw new InternalServerErrorException(
        error instanceof Error ? error.message : "Generated tool reload failed",
      );
    }
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool.generated_reload",
      targetType: "tool_registry",
      targetId: "generated-tools",
      status: "success",
      summary: "Generated tools reloaded by operator.",
    });
    return { tools: this.metadata ? await this.metadata.list() : [] };
  }

  async setToolStatus(
    name: string,
    rawBody: unknown,
  ): Promise<{ tool: ToolModuleMetadata }> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    if (!isRecord(rawBody)) throw new BadRequestException("tool status request must be an object");
    const status = parseRequiredText(rawBody.status, "status");
    if (status !== "available" && status !== "disabled") {
      throw new BadRequestException("status must be available or disabled");
    }
    const tool = await this.metadata.setStatus(name, status);
    if (!tool) throw new NotFoundException("Tool not found");
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool.setting_updated",
      targetType: "tool",
      targetId: name,
      status: "success",
      summary: `${status === "disabled" ? "Disabled" : "Enabled"} tool: ${name}`,
      metadata: sanitizeAuditMetadata({
        status,
        previousStatus: isRecord(rawBody) ? rawBody.previousStatus : undefined,
      }),
    });
    return { tool };
  }

  async listPackageRunners() {
    return (this.packageRunners ?? []).map((runner) =>
      runner.describe
        ? runner.describe()
        : {
            name: `${runner.type} runner`,
            type: runner.type,
            status: "available",
            detail: "Runner does not expose extended diagnostics.",
            supportedPackageTypes: runner.type === "legacy-local-path" ? [] : [runner.type],
          },
    );
  }

  async registerGenerated(rawBody: unknown): Promise<ToolModuleMetadata> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    try {
      const input = parseGeneratedToolModuleInput(rawBody);
      return await this.metadata.registerGenerated(input);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid generated tool module",
      );
    }
  }

  async importPackageManifest(rawBody: unknown): Promise<ToolModuleMetadata> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    try {
      const input = parseToolPackageManifestImport(rawBody);
      const registered = await this.metadata.registerGenerated(input);
      await this.reload?.();
      const tool = (await this.metadata.list()).find((candidate) => candidate.name === registered.name) ?? registered;
      await this.audit.record({
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "tool.package_imported",
        targetType: "tool",
        targetId: tool.name,
        status: "success",
        summary: `Imported tool package manifest: ${tool.name}@${tool.version}`,
      });
      return tool;
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid tool package manifest",
      );
    }
  }

  async listVersions(name: string): Promise<ToolModuleVersionSummary[]> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    try {
      const versions = await this.metadata.listVersions(name);
      const activeTool = (await this.metadata.list()).find((candidate) => candidate.name === name);
      const auditEvents = await this.audit.list(1_000);
      const creationRecords = await this.creationStore?.list({ toolName: name, limit: 200 }) ?? [];
      const runRecords = await this.runs?.list() ?? [];
      return versions.map((version) => {
        const activeMirror = version.active && activeTool?.version === version.version ? activeTool : undefined;
        const lifecycleEvents = buildToolVersionLifecycleEvents({
          name,
          version: version.version,
          creationRecords,
          auditEvents,
        });
        return {
          ...version,
          status: activeMirror?.status ?? version.status,
          lastHealthDetail: activeMirror?.lastHealthDetail ?? version.lastHealthDetail,
          successCount: activeMirror?.successCount ?? version.successCount,
          failureCount: activeMirror?.failureCount ?? version.failureCount,
          manualRunEvidence: buildManualVersionRunEvidence(name, version.version, auditEvents, !version.active),
          runScopedCandidateEvidence: buildRunScopedCandidateEvidence(
            name,
            version.version,
            runRecords,
            !version.active,
          ),
          reviewStatus: deriveToolVersionReviewStatus(version.active, lifecycleEvents),
          lifecycleEvents,
        };
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid generated tool version request",
      );
    }
  }

  async getToolStats(name: string): Promise<{
    name: string;
    activeVersion: string;
    totalRuns: number;
    successCount: number;
    failureCount: number;
    successRate: number | null;
    lastSuccessAt?: string;
    lastFailureAt?: string;
    versions: Array<{
      version: string;
      activatedAt?: string;
      changeSummary?: string;
    }>;
  }> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    const tool = (await this.metadata.list()).find((candidate) => candidate.name === name);
    if (!tool) throw new NotFoundException("Tool not found");
    const totalRuns = tool.successCount + tool.failureCount;
    const successRate = totalRuns > 0 ? tool.successCount / totalRuns : null;
    const versions = await this.metadata.listVersions(name);
    return {
      name: tool.name,
      activeVersion: tool.version,
      totalRuns,
      successCount: tool.successCount,
      failureCount: tool.failureCount,
      successRate,
      lastSuccessAt: tool.lastSuccessAt,
      lastFailureAt: tool.lastFailureAt,
      versions: versions.map((v) => ({
        version: v.version,
        activatedAt: v.updatedAt,
        changeSummary: v.changeSummary,
      })),
    };
  }

  async exportPackageManifest(name: string): Promise<{
    manifest: unknown;
    filename: string;
  }> {
    const manifest = await this.getPackageManifest(name);
    const safeName = name.replace(/[^a-zA-Z0-9_.-]+/g, "-");
    return {
      manifest,
      filename: `${safeName}-${
        (manifest as { version?: string })?.version ?? "version"
      }.tool-package.json`,
    };
  }

  async getPackageManifest(name: string) {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    const tool = (await this.metadata.list()).find((candidate) => candidate.name === name);
    if (!tool) throw new NotFoundException("Generated tool was not found");
    if (!tool.packageManifest) {
      throw new NotFoundException("Generated tool does not have a package manifest");
    }
    return tool.packageManifest;
  }

  private async withRuntimeReadiness(tool: ToolModuleMetadata): Promise<ToolModuleMetadata> {
    return {
      ...tool,
      runtimeReadiness: await this.evaluateRuntimeReadiness(tool),
    };
  }

  private async evaluateRuntimeReadiness(tool: Pick<
    ToolModuleMetadata,
    "name" | "requiredConfigurationKeys" | "requiredSecretHandles"
  >) {
    return resolveToolRuntimeReadiness(tool, {
      runtimeSettings: this.runtimeSettings,
      secretHandles: this.secretHandles,
      environment: process.env,
    });
  }
}

type ManualVersionRunEvidenceEntry = {
  auditEventId: string;
  ranAt: string;
  durationMs?: number;
  inputPreview?: unknown;
  contentPreview?: string;
};

type RunScopedCandidateEvidenceEntry = {
  runId: string;
  ranAt: string;
  inputPreview?: unknown;
  contentPreview?: string;
};

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

function buildRunScopedCandidateEvidence(
  name: string,
  version: string,
  runs: AgentRunRecord[],
  requiredForActivation: boolean,
): NonNullable<ToolModuleVersionSummary["runScopedCandidateEvidence"]> {
  let successCount = 0;
  let failureCount = 0;
  let latestSuccess: RunScopedCandidateEvidenceEntry | undefined;
  let latestFailure: RunScopedCandidateEvidenceEntry | undefined;
  const sortedRuns = [...runs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const run of sortedRuns) {
    const event = [...run.events].reverse().find((candidate) => {
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
    const entry: RunScopedCandidateEvidenceEntry = {
      runId: run.id,
      ranAt: event.completedAt ?? event.timestamp,
      inputPreview: parseRunScopedCandidatePayload(event.payload)?.input,
      contentPreview: candidateRunContentPreview(run),
    };
    if (run.status === "completed") {
      successCount += 1;
      latestSuccess ??= entry;
    } else if (run.status === "failed") {
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

function buildToolVersionLifecycleEvents(input: {
  name: string;
  version: string;
  creationRecords: ToolCreationRecord[];
  auditEvents: AuditEventRecord[];
}): ToolVersionLifecycleEvent[] {
  const events: ToolVersionLifecycleEvent[] = [];
  const creation = input.creationRecords.find((record) => record.toolVersion === input.version);
  if (creation) {
    events.push({
      id: `${creation.id}:created`,
      type: "created",
      status: creation.status === "failed" || creation.status === "qa_failed" ? "failure" : "info",
      summary: creation.status === "registered"
        ? `Created and registered by ${creation.source}.`
        : `Creation status: ${creation.status}.`,
      actorId: creation.source,
      actorType: creation.source === "agent" ? "agent" : "user",
      traceRunId: creation.runId,
      createdAt: creation.registeredAt ?? creation.createdAt,
      metadata: {
        creationId: creation.id,
        packageRef: creation.packageRef,
        qaStatus: creation.qa?.ok,
        strategy: creation.strategy?.kind,
      },
    });
  }

  for (const event of input.auditEvents) {
    if (event.targetId !== `${input.name}@${input.version}`) continue;
    if (event.action === "tool.manual_run" && event.metadata?.evidenceType === "manual-tool-version-run") {
      events.push({
        id: event.id,
        type: "manual_run",
        status: event.status === "success" ? "success" : "failure",
        summary: event.summary,
        actorId: event.actorId,
        actorType: event.actorType,
        auditEventId: event.id,
        createdAt: event.createdAt,
        metadata: {
          durationMs: event.metadata.durationMs,
          inputPreview: event.metadata.inputPreview,
          output: event.metadata.output,
        },
      });
      continue;
    }
    if (event.action === "tool.version_activated") {
      const evidenceType = typeof event.metadata?.evidenceType === "string"
        ? event.metadata.evidenceType
        : undefined;
      const type: ToolVersionLifecycleEvent["type"] = evidenceType === "agent-run-scoped-candidate-success"
        ? "agent_accepted"
        : /marked .*available/i.test(event.summary)
          ? "marked_available"
          : "activated";
      events.push({
        id: event.id,
        type,
        status: event.status === "success" ? "success" : "failure",
        summary: event.summary,
        actorId: event.actorId,
        actorType: event.actorType,
        runId: event.runId,
        auditEventId: event.id,
        createdAt: event.createdAt,
        metadata: event.metadata,
      });
      continue;
    }
    if (event.action === "tool.version_rejected") {
      events.push({
        id: event.id,
        type: "rejected",
        status: event.status === "success" ? "success" : "failure",
        summary: event.summary,
        actorId: event.actorId,
        actorType: event.actorType,
        runId: event.runId,
        auditEventId: event.id,
        createdAt: event.createdAt,
        metadata: event.metadata,
      });
      continue;
    }
    if (event.action === "tool.deleted") {
      events.push({
        id: event.id,
        type: "deleted",
        status: event.status === "success" ? "success" : "failure",
        summary: event.summary,
        actorId: event.actorId,
        actorType: event.actorType,
        auditEventId: event.id,
        createdAt: event.createdAt,
        metadata: event.metadata,
      });
    }
  }

  return events.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function deriveToolVersionReviewStatus(
  active: boolean,
  lifecycleEvents: ToolVersionLifecycleEvent[],
): ToolModuleVersionSummary["reviewStatus"] {
  if (active) return "accepted";
  const latestDecision = [...lifecycleEvents]
    .filter((event) =>
      event.type === "rejected" ||
      event.type === "activated" ||
      event.type === "agent_accepted" ||
      event.type === "marked_available",
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (latestDecision?.type === "rejected") return "rejected";
  if (
    latestDecision?.type === "activated" ||
    latestDecision?.type === "agent_accepted" ||
    latestDecision?.type === "marked_available"
  ) {
    return "accepted";
  }
  return "candidate";
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
