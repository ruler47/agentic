import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { AuditEventRecord } from "../../../audit/types.js";
import type { RunStore } from "../../../runs/types.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import type { Tool } from "../../../tools/tool.js";
import type {
  ToolMetadataStore,
  ToolModuleMetadata,
  ToolModuleVersionSummary,
} from "../../../tools/toolMetadataStore.js";
import {
  MissingToolRuntimeRequirementsError,
  type ToolPackageRunner,
} from "../../../tools/toolPackageRunner.js";
import type { ToolCreationRecord, ToolCreationStore } from "../../../tools/toolCreationStore.js";
import type { AgentEvent } from "../../../types.js";
import { isRecord } from "../../common/parsers.js";
import { AuditService } from "../../common/services/audit.service.js";
import {
  RUN_STORE,
  TOOL_CREATION_STORE,
  TOOL_METADATA_STORE,
  TOOL_PACKAGE_RUNNERS,
  TOOL_REGISTRY,
} from "../../persistence/tokens.js";

type ManualToolRunDiagnostic = {
  type: "missing_runtime_requirements";
  missingConfigurationKeys: string[];
  missingSecretHandles: string[];
  message: string;
  actions: Array<{
    kind: "set_runtime_setting" | "create_secret_handle";
    key?: string;
    handle?: string;
    label: string;
  }>;
};

@Injectable()
export class ToolManualRunService {
  constructor(
    @Inject(TOOL_REGISTRY) private readonly registry: ToolRegistry | undefined,
    @Inject(TOOL_METADATA_STORE) private readonly metadata: ToolMetadataStore | undefined,
    @Inject(TOOL_PACKAGE_RUNNERS) private readonly packageRunners: ToolPackageRunner[] | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(TOOL_CREATION_STORE) private readonly creationStore?: ToolCreationStore,
    @Optional() @Inject(RUN_STORE) private readonly runs?: RunStore,
  ) {}

  async runToolManually(
    name: string,
    body: unknown,
    actor: { actorId: string } = { actorId: "user-admin" },
  ): Promise<{
    tool: { name: string; version: string };
    result: { ok: boolean; content: string; data?: unknown };
    durationMs: number;
    diagnostic?: ManualToolRunDiagnostic;
  }> {
    if (!this.registry) throw new ServiceUnavailableException("Tool registry is not configured");
    const tool = this.registry.get(name);
    if (!tool) throw new NotFoundException(`Tool not registered: ${name}`);

    const input = manualRunInput(body);
    const startedAt = Date.now();
    let result: { ok: boolean; content: string; data?: unknown };
    let diagnostic: ManualToolRunDiagnostic | undefined;
    try {
      result = await this.registry.execute(tool, input, {
        now: new Date(),
        caller: "manual-ui",
      });
    } catch (error) {
      diagnostic = manualRunDiagnosticFromError(error);
      result = {
        ok: false,
        content: diagnostic
          ? diagnostic.message
          : `Manual tool invocation threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const durationMs = Date.now() - startedAt;

    await this.audit.record({
      instanceId: "instance-local",
      actorId: actor.actorId,
      actorType: "user",
      action: "tool.manual_run",
      targetType: "tool",
      targetId: tool.name,
      status: result.ok ? "success" : "failure",
      summary: `Manual tool run: ${tool.name} (${result.ok ? "ok" : "failed"}, ${durationMs}ms)`,
      metadata: {
        evidenceType: "manual-tool-run",
        toolVersion: tool.version ?? "unknown",
        durationMs,
        inputKeys: Object.keys(input),
        inputPreview: limitJsonForAudit(input),
        output: {
          ok: result.ok,
          contentPreview: (result.content ?? "").slice(0, 500),
          dataPreview: limitJsonForAudit(serializeBuffersForWire(result.data)),
          diagnostic: diagnostic ? limitJsonForAudit(diagnostic) : undefined,
        },
        contentPreview: (result.content ?? "").slice(0, 200),
      },
    });

    const wireResult = {
      ok: result.ok,
      content: typeof result.content === "string" ? result.content : "",
      data: serializeBuffersForWire(result.data),
    };

    return {
      tool: { name: tool.name, version: tool.version ?? "unknown" },
      result: wireResult,
      durationMs,
      diagnostic,
    };
  }

  async runToolVersionManually(
    name: string,
    version: string,
    body: unknown,
    actor: { actorId: string } = { actorId: "user-admin" },
  ): Promise<{
    tool: { name: string; version: string; active: boolean; status: string };
    result: { ok: boolean; content: string; data?: unknown };
    durationMs: number;
    loadDetail: string;
    diagnostic?: ManualToolRunDiagnostic;
  }> {
    if (!this.registry) throw new ServiceUnavailableException("Tool registry is not configured");
    if (!this.metadata) throw new ServiceUnavailableException("Tool metadata store is not configured");
    const active = (await this.metadata.list()).find((candidate) => candidate.name === name);
    if (!active) throw new NotFoundException(`Tool not registered: ${name}`);
    if (active.source !== "generated") {
      throw new BadRequestException("Pinned version manual runs are only supported for generated tools");
    }
    const versionSummary = (await this.metadata.listVersions(name)).find(
      (candidate) => candidate.version === version,
    );
    if (!versionSummary) throw new NotFoundException(`Version ${version} for ${name} was not found`);
    await this.assertVersionIsNotRejected(name, version);

    const versionMetadata = metadataFromVersionSummary(active, versionSummary);
    const runner = (this.packageRunners ?? []).find((candidate) => candidate.canLoad(versionMetadata));
    if (!runner) {
      throw new ServiceUnavailableException(
        `No generated-tool runner is available for ${versionMetadata.packageManifest?.package.type ?? "legacy-local-path"} package references`,
      );
    }

    const loaded = await runner.load(versionMetadata, process.cwd());
    if (!loaded.loaded || !loaded.tool) {
      throw new ServiceUnavailableException(loaded.detail || `Could not load ${name}@${version}`);
    }

    const input = manualRunInput(body);
    const startedAt = Date.now();
    let result: { ok: boolean; content: string; data?: unknown };
    let diagnostic: ManualToolRunDiagnostic | undefined;
    try {
      result = await this.registry.execute(
        loaded.tool,
        input,
        {
          now: new Date(),
          caller: "manual-ui-version",
        },
        { recordUsage: false },
      );
    } catch (error) {
      diagnostic = manualRunDiagnosticFromError(error);
      result = {
        ok: false,
        content: diagnostic
          ? diagnostic.message
          : `Manual tool version invocation threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const durationMs = Date.now() - startedAt;
    const wireResult = {
      ok: result.ok,
      content: typeof result.content === "string" ? result.content : "",
      data: serializeBuffersForWire(result.data),
    };

    await this.audit.record({
      instanceId: "instance-local",
      actorId: actor.actorId,
      actorType: "user",
      action: "tool.manual_run",
      targetType: "tool",
      targetId: `${name}@${version}`,
      status: wireResult.ok ? "success" : "failure",
      summary: `Manual tool version run: ${name}@${version} (${wireResult.ok ? "ok" : "failed"}, ${durationMs}ms)`,
      metadata: {
        evidenceType: "manual-tool-version-run",
        toolName: name,
        toolVersion: version,
        activeVersion: active.version,
        active: versionSummary.active,
        versionStatus: versionSummary.status,
        durationMs,
        inputKeys: Object.keys(input),
        inputPreview: limitJsonForAudit(input),
        output: {
          ok: wireResult.ok,
          contentPreview: wireResult.content.slice(0, 500),
          dataPreview: limitJsonForAudit(wireResult.data),
          diagnostic: diagnostic ? limitJsonForAudit(diagnostic) : undefined,
        },
        loadDetail: loaded.detail,
        diagnostic,
      },
    });
    await this.appendToolVersionLifecycleEvent({
      type: "tool-version-manual-run",
      name,
      version,
      status: wireResult.ok ? "completed" : "failed",
      title: "Pinned version manual run",
      detail: `Manual run for ${name}@${version} ${wireResult.ok ? "passed" : "failed"} in ${durationMs}ms.`,
      input: {
        actorId: actor.actorId,
        input,
        activeVersion: active.version,
        versionStatus: versionSummary.status,
      },
      output: {
        ok: wireResult.ok,
        content: wireResult.content.slice(0, 1_000),
        durationMs,
        loadDetail: loaded.detail,
      },
    });

    return {
      tool: {
        name,
        version,
        active: versionSummary.active,
        status: versionSummary.status,
      },
      result: wireResult,
      durationMs,
      loadDetail: loaded.detail,
      diagnostic,
    };
  }

  async loadToolVersionForAgent(name: string, version: string): Promise<{
    tool: Tool;
    metadata: ToolModuleMetadata;
    loadDetail: string;
  }> {
    if (!this.metadata) throw new ServiceUnavailableException("Tool metadata store is not configured");
    const active = (await this.metadata.list()).find((candidate) => candidate.name === name);
    if (!active) throw new NotFoundException(`Tool not registered: ${name}`);
    if (active.source !== "generated") {
      throw new BadRequestException("Pinned agent candidate runs are only supported for generated tools");
    }
    const versionSummary = (await this.metadata.listVersions(name)).find(
      (candidate) => candidate.version === version,
    );
    if (!versionSummary) throw new NotFoundException(`Version ${version} for ${name} was not found`);
    await this.assertVersionIsNotRejected(name, version);

    const versionMetadata = metadataFromVersionSummary(active, versionSummary);
    const runner = (this.packageRunners ?? []).find((candidate) => candidate.canLoad(versionMetadata));
    if (!runner) {
      throw new ServiceUnavailableException(
        `No generated-tool runner is available for ${versionMetadata.packageManifest?.package.type ?? "legacy-local-path"} package references`,
      );
    }
    const loaded = await runner.load(versionMetadata, process.cwd());
    if (!loaded.loaded || !loaded.tool) {
      throw new ServiceUnavailableException(loaded.detail || `Could not load ${name}@${version}`);
    }
    return {
      tool: loaded.tool,
      metadata: versionMetadata,
      loadDetail: loaded.detail,
    };
  }

  private async findToolCreationRecordForVersion(
    name: string,
    version: string,
  ): Promise<ToolCreationRecord | undefined> {
    const records = await this.creationStore?.list({ toolName: name, limit: 200 }) ?? [];
    return records.find((record) => record.toolVersion === version);
  }

  private async appendToolVersionLifecycleEvent(input: {
    type: "tool-version-manual-run";
    name: string;
    version: string;
    status: "completed" | "failed";
    title: string;
    detail: string;
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
        input: input.input,
        output: input.output,
      },
    }));
  }

  private async assertVersionIsNotRejected(name: string, version: string): Promise<void> {
    const auditEvents = await this.audit.list(1_000);
    if (isToolVersionRejected(name, version, auditEvents)) {
      throw new Error(`Cannot promote ${name}@${version}: candidate version was rejected.`);
    }
  }
}

function serializeBuffersForWire(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return { contentBase64: value.toString("base64") };
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return undefined;
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((item) => serializeBuffersForWire(item, seen));
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === "content" && Buffer.isBuffer(nested)) {
      out.contentBase64 = (nested as Buffer).toString("base64");
      continue;
    }
    out[key] = serializeBuffersForWire(nested, seen);
  }
  return out;
}

function limitJsonForAudit(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value);
    if (text.length <= 2_000) return value;
    return {
      truncated: true,
      preview: text.slice(0, 2_000),
      originalLength: text.length,
    };
  } catch {
    return { unserializable: true };
  }
}

function manualRunInput(body: unknown): Record<string, unknown> {
  return isRecord(body) && isRecord((body as Record<string, unknown>).input)
    ? ((body as Record<string, unknown>).input as Record<string, unknown>)
    : isRecord(body)
      ? (body as Record<string, unknown>)
      : {};
}

function manualRunDiagnosticFromError(error: unknown): ManualToolRunDiagnostic | undefined {
  const missing = missingRuntimeRequirements(error);
  if (!missing) return undefined;
  const missingConfigurationKeys = [...new Set(missing.missingConfigurationKeys)];
  const missingSecretHandles = [...new Set(missing.missingSecretHandles)];
  const parts = [
    missingConfigurationKeys.length
      ? `configuration ${missingConfigurationKeys.join(", ")}`
      : undefined,
    missingSecretHandles.length
      ? `secret handles ${missingSecretHandles.join(", ")}`
      : undefined,
  ].filter(Boolean);
  return {
    type: "missing_runtime_requirements",
    missingConfigurationKeys,
    missingSecretHandles,
    message: `Missing required runtime values: ${parts.join("; ")}.`,
    actions: [
      ...missingConfigurationKeys.map((key) => ({
        kind: "set_runtime_setting" as const,
        key,
        label: `Set runtime setting ${key}`,
      })),
      ...missingSecretHandles.map((handle) => ({
        kind: "create_secret_handle" as const,
        handle,
        label: `Create secret handle ${handle}`,
      })),
    ],
  };
}

function missingRuntimeRequirements(error: unknown): {
  missingConfigurationKeys: string[];
  missingSecretHandles: string[];
} | undefined {
  if (error instanceof MissingToolRuntimeRequirementsError) {
    return {
      missingConfigurationKeys: error.missingConfigurationKeys,
      missingSecretHandles: error.missingSecretHandles,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/Missing required runtime values for external tool package \(([^)]+)\)\./);
  if (!match) return undefined;
  const detail = match[1] ?? "";
  return {
    missingConfigurationKeys: csvAfterLabel(detail, "configuration"),
    missingSecretHandles: csvAfterLabel(detail, "secret handles"),
  };
}

function csvAfterLabel(detail: string, label: string): string[] {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = detail.match(new RegExp(`${escaped}:\\s*([^;]+)`));
  if (!match) return [];
  return (match[1] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function metadataFromVersionSummary(
  active: ToolModuleMetadata,
  version: ToolModuleVersionSummary,
): ToolModuleMetadata {
  return {
    ...active,
    version: version.version,
    displayName: version.displayName ?? active.displayName,
    description: version.description ?? active.description,
    capabilities: version.capabilities ?? active.capabilities,
    startupMode: version.packageManifest?.startupMode ?? active.startupMode,
    inputSchema: version.packageManifest?.inputSchema ?? active.inputSchema,
    outputSchema: version.packageManifest?.outputSchema ?? active.outputSchema,
    modulePath: version.modulePath,
    testPath: version.testPath,
    requiredSecretHandles: version.requiredSecretHandles ?? active.requiredSecretHandles,
    requiredConfigurationKeys: version.packageManifest?.requiredConfigurationKeys ?? active.requiredConfigurationKeys,
    settingsSchema: version.packageManifest?.settingsSchema ?? active.settingsSchema,
    storage: version.packageManifest?.storage ?? active.storage,
    docsMarkdown: version.packageManifest?.docsMarkdown ?? active.docsMarkdown,
    examples: (version.packageManifest?.examples as ToolModuleMetadata["examples"] | undefined) ?? active.examples,
    packageManifest: version.packageManifest ?? active.packageManifest,
    changeSummary: version.changeSummary,
    promotionEvidence: version.promotionEvidence,
    successCount: version.successCount ?? 0,
    failureCount: version.failureCount ?? 0,
    source: "generated",
    status: version.status,
    lastHealthDetail: version.lastHealthDetail,
    updatedAt: version.updatedAt,
    versions: undefined,
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

function safeTraceIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
}
