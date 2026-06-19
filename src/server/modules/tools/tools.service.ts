import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { rm } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ToolRegistry } from "../../../tools/registry.js";
import type { Tool } from "../../../tools/tool.js";
import type { ToolCatalogEntry } from "../../../tools/toolCatalog.js";
import {
  generatedToolInputFromPackageManifest,
  toolToMetadata,
  type ToolMetadataStore,
  type ToolModuleMetadata,
} from "../../../tools/toolMetadataStore.js";
import {
  type ToolRuntimeSettingsStore,
} from "../../../settings/toolRuntimeSettings.js";
import {
  type ToolPackageRunner,
} from "../../../tools/toolPackageRunner.js";
import type { ToolServiceSupervisor } from "../../../tools/toolServiceSupervisor.js";
import type { ToolModuleVersionSummary } from "../../../tools/toolMetadataStore.js";
import {
  createToolPackageV1,
  normalizeToolCreationV1Input,
} from "../../../tools/toolCreationV1.js";
import { buildToolBuilderPlan } from "../../../tools/toolBuilderAgent.js";
import { authorToolPackageWithGuardrails } from "../../../tools/toolBuilderPackageAuthor.js";
import { discoverToolImplementation } from "../../../tools/toolImplementationDiscovery.js";
import type { LlmClient } from "../../../llm/client.js";
import type {
  ToolCreationRecord,
  ToolCreationStatus,
  ToolCreationStore,
} from "../../../tools/toolCreationStore.js";
import { ToolPackageWorkspaceStore, type ToolPackageWorkspaceFile } from "../../../tools/toolPackageWorkspaceStore.js";
import { validateAndBuildToolPackageWorkspace } from "../../../tools/toolPackageWorkspaceQa.js";
import type { ToolPackageManifest } from "../../../tools/toolPackage.js";
import type { SecretHandleStore } from "../../../secrets/secretHandleStore.js";
import type { RunStore } from "../../../runs/types.js";
import type {
  ToolContextRecord,
  ToolContextStore,
} from "../../../tools/toolContextStore.js";
import { AuditService } from "../../common/services/audit.service.js";
import {
  parseRequiredText,
  isRecord,
  parseOptionalText,
  parseOptionalStringArray,
  sanitizeAuditMetadata,
} from "../../common/parsers.js";
import {
  RELOAD_GENERATED_TOOLS,
  LLM_CLIENT,
  RUN_STORE,
  SECRET_HANDLE_STORE,
  TOOL_CONTEXT_STORE,
  TOOL_CREATION_STORE,
  TOOL_METADATA_STORE,
  TOOL_PACKAGE_RUNNERS,
  TOOL_REGISTRY,
  TOOL_RUNTIME_SETTINGS,
  TOOL_SERVICE_SUPERVISOR,
} from "../../persistence/tokens.js";
import {
  createToolCreationTrace,
  noToolCreationTrace,
  type ToolCreationTrace,
} from "./tool-creation-trace.js";
import { ToolManualRunService } from "./tool-manual-run.service.js";
import { ToolRegistryAdminService } from "./tool-registry-admin.service.js";
import {
  dependencyRecords,
  packageJsonDependencies,
  parseJsonFile,
  parseSourceBundleFiles,
  readSourceBundleDependenciesForTool,
  readSourceBundleFiles,
  sourceBundlePackageDir,
  STANDARD_SOURCE_BUNDLE_FILES,
} from "./tool-source-bundle-files.js";
import { ToolVersionLifecycleService } from "./tool-version-lifecycle.service.js";
import {
  documentationTextValues,
  extractRequestContextItems,
  formatContextForBuilder,
  formatCreationRecordForContext,
  parseOptionalKind,
  parseToolContextCreateInput,
} from "./tool-context-helpers.js";
import { ToolPackageCreationWorkflow } from "./tool-package-creation-workflow.js";
import { ToolPackageVersionWorkflow } from "./tool-package-version-workflow.js";

@Injectable()
export class ToolsService {
  constructor(
    @Inject(TOOL_REGISTRY) private readonly registry: ToolRegistry | undefined,
    @Inject(TOOL_METADATA_STORE) private readonly metadata: ToolMetadataStore | undefined,
    @Inject(TOOL_RUNTIME_SETTINGS) private readonly runtimeSettings: ToolRuntimeSettingsStore | undefined,
    @Inject(TOOL_PACKAGE_RUNNERS) private readonly packageRunners: ToolPackageRunner[] | undefined,
    @Inject(RELOAD_GENERATED_TOOLS) private readonly reload: (() => Promise<void>) | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(TOOL_CREATION_STORE) private readonly creationStore?: ToolCreationStore,
    @Optional() @Inject(LLM_CLIENT) private readonly llm?: LlmClient,
    @Optional() @Inject(RUN_STORE) private readonly runs?: RunStore,
    @Optional() @Inject(SECRET_HANDLE_STORE) private readonly secretHandles?: SecretHandleStore,
    @Optional() @Inject(TOOL_CONTEXT_STORE) private readonly toolContexts?: ToolContextStore,
    @Optional() @Inject(TOOL_SERVICE_SUPERVISOR) private readonly serviceSupervisor?: ToolServiceSupervisor,
    @Optional() @Inject(ToolManualRunService) private readonly manualRuns?: ToolManualRunService,
    @Optional() @Inject(ToolRegistryAdminService) private readonly registryAdmin?: ToolRegistryAdminService,
    @Optional() @Inject(ToolVersionLifecycleService) private readonly versionLifecycle?: ToolVersionLifecycleService,
  ) {}

  async listTools(): Promise<ToolCatalogEntry[]> {
    return this.registryAdminService().listTools();
  }

  async toolHealth(): Promise<Array<{ name: string; ok: boolean; detail?: string }>> {
    return this.registryAdminService().toolHealth();
  }

  async runToolManually(
    name: string,
    body: unknown,
    actor: { actorId: string } = { actorId: "user-admin" },
  ) {
    return this.manualRunService().runToolManually(name, body, actor);
  }

  async runToolVersionManually(
    name: string,
    version: string,
    body: unknown,
    actor: { actorId: string } = { actorId: "user-admin" },
  ) {
    return this.manualRunService().runToolVersionManually(name, version, body, actor);
  }

  async loadToolVersionForAgent(name: string, version: string): Promise<{
    tool: Tool;
    metadata: ToolModuleMetadata;
    loadDetail: string;
  }> {
    return this.manualRunService().loadToolVersionForAgent(name, version);
  }

  private manualRunService(): ToolManualRunService {
    return this.manualRuns ?? new ToolManualRunService(
      this.registry,
      this.metadata,
      this.packageRunners,
      this.audit,
      this.creationStore,
      this.runs,
    );
  }

  private registryAdminService(): ToolRegistryAdminService {
    return this.registryAdmin ?? new ToolRegistryAdminService(
      this.registry,
      this.metadata,
      this.runtimeSettings,
      this.packageRunners,
      this.reload,
      this.audit,
      this.creationStore,
      this.secretHandles,
      this.runs,
    );
  }

  async reloadGenerated(): Promise<{ tools: ToolModuleMetadata[] }> {
    return this.registryAdminService().reloadGenerated();
  }

  async setToolStatus(
    name: string,
    rawBody: unknown,
  ): Promise<{ tool: ToolModuleMetadata }> {
    return this.registryAdminService().setToolStatus(name, rawBody);
  }

  async listToolCreations(options: { toolName?: string; status?: string; limit?: number } = {}): Promise<ToolCreationRecord[]> {
    if (!this.creationStore) return [];
    const status = options.status;
    if (status && !["requested", "building", "qa_failed", "registered", "failed"].includes(status)) {
      throw new BadRequestException("Invalid tool creation status");
    }
    return this.creationStore.list({
      toolName: options.toolName,
      status: status as ToolCreationStatus | undefined,
      limit: options.limit,
    });
  }

  async getToolCreation(id: string): Promise<ToolCreationRecord> {
    const record = await this.creationStore?.get(id);
    if (!record) throw new NotFoundException("Tool creation record not found");
    return record;
  }

  async deleteFailedToolCreation(id: string): Promise<{
    deleted: true;
    creationId: string;
    toolName: string;
    toolVersion: string;
    packageDeleted: boolean;
    creationRunDeleted: boolean;
    metadataDeleted: boolean;
    secretHandlesDeleted: string[];
  }> {
    if (!this.creationStore) {
      throw new ServiceUnavailableException("Tool creation store is not configured");
    }
    const record = await this.creationStore.get(id);
    if (!record) throw new NotFoundException("Tool creation record not found");
    if (record.status === "registered") {
      const versions = await this.metadata?.listVersions(record.toolName).catch(() => []) ?? [];
      if (versions.length > 0) {
        throw new BadRequestException("Registered tool creations must be deleted through the generated tool lifecycle.");
      }
    }

    const metadataDeleted = await this.deleteMatchingUnregisteredMetadata(record);
    const packageDeleted = await this.deleteCreationPackage(record);
    const secretHandlesDeleted = await this.deleteToolScopedSecrets(record);
    const creationRunDeleted = record.runId ? await this.runs?.delete(record.runId) ?? false : false;
    await this.creationStore.delete(id);
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool.creation_deleted",
      targetType: "tool_creation",
      targetId: id,
      status: "success",
      summary: `Deleted failed tool creation: ${record.toolName}@${record.toolVersion}`,
      metadata: sanitizeAuditMetadata({
        toolName: record.toolName,
        toolVersion: record.toolVersion,
        status: record.status,
        packageRef: record.packageRef,
        packageDeleted,
        creationRunDeleted,
        metadataDeleted,
        secretHandlesDeleted,
      }),
    });

    return {
      deleted: true,
      creationId: id,
      toolName: record.toolName,
      toolVersion: record.toolVersion,
      packageDeleted,
      creationRunDeleted,
      metadataDeleted,
      secretHandlesDeleted,
    };
  }

  private packageCreationWorkflow(): ToolPackageCreationWorkflow {
    return new ToolPackageCreationWorkflow(
      this.registry,
      this.metadata,
      this.reload,
      this.audit,
      this.creationStore,
      this.llm,
      this.runs,
      this.secretHandles,
    );
  }

  async createToolPackage(rawBody: unknown) {
    const result = await this.packageCreationWorkflow().createToolPackage(rawBody);
    await this.captureRequestContext(result.tool.name, rawBody, result.creation?.id);
    return result;
  }

  async createToolVersion(name: string, rawBody: unknown) {
    const requestWithContext = await this.withStoredToolContext(name, rawBody);
    const result = await new ToolPackageVersionWorkflow(
      this.registry,
      this.metadata,
      this.reload,
      this.audit,
      this.creationStore,
      this.llm,
      this.runs,
      this.secretHandles,
    ).createToolVersion(name, requestWithContext);
    await this.captureRequestContext(name, rawBody, result.creation?.id);
    return result;
  }

  async listToolContext(toolName: string): Promise<ToolContextRecord[]> {
    if (!this.toolContexts) return [];
    await this.backfillToolContextFromCreations(toolName);
    return this.toolContexts.list({ toolName });
  }

  async createToolContext(toolName: string, rawBody: unknown): Promise<ToolContextRecord> {
    if (!this.toolContexts) throw new ServiceUnavailableException("Tool context store is not configured");
    if (!isRecord(rawBody)) throw new BadRequestException("tool context body must be an object");
    return this.toolContexts.create(parseToolContextCreateInput(toolName, rawBody));
  }

  async updateToolContext(id: string, rawBody: unknown): Promise<ToolContextRecord> {
    if (!this.toolContexts) throw new ServiceUnavailableException("Tool context store is not configured");
    if (!isRecord(rawBody)) throw new BadRequestException("tool context body must be an object");
    const updated = await this.toolContexts.update(id, {
      kind: parseOptionalKind(rawBody.kind),
      title: parseOptionalText(rawBody.title),
      content: parseOptionalText(rawBody.content),
      mimeType: parseOptionalText(rawBody.mimeType),
      source: parseOptionalText(rawBody.source),
    });
    if (!updated) throw new NotFoundException("Tool context item not found");
    return updated;
  }

  async deleteToolContext(id: string): Promise<{ deleted: boolean; id: string }> {
    if (!this.toolContexts) throw new ServiceUnavailableException("Tool context store is not configured");
    return { deleted: await this.toolContexts.delete(id), id };
  }

  async exportSourceBundle(name: string): Promise<{
    manifest: ToolPackageManifest;
    package: { packageRef: string; manifestPath: string };
    files: ToolPackageWorkspaceFile[];
  }> {
    const tool = await this.findToolMetadata(name);
    if (!tool) throw new NotFoundException("Tool not found");
    const manifest = tool.packageManifest;
    if (!manifest || manifest.package.type !== "source-bundle") {
      throw new BadRequestException("Tool does not have an exportable source-bundle package manifest");
    }
    const packageDir = sourceBundlePackageDir(process.cwd(), process.env.TOOL_PACKAGE_WORKSPACE_ROOT ?? "tools", manifest.package.ref);
    const files = await readSourceBundleFiles(packageDir);
    return {
      manifest,
      package: {
        packageRef: manifest.package.ref,
        manifestPath: relative(process.cwd(), join(packageDir, "tool.package.json")).replace(/\\/g, "/"),
      },
      files,
    };
  }

  async importSourceBundle(rawBody: unknown): Promise<{
    tool: ToolModuleMetadata;
    creation?: ToolCreationRecord;
    package: { packageRef: string; manifestPath: string; files: string[] };
    qa: { ok: boolean; summary: string; checks: string[] };
  }> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    if (!this.reload) {
      throw new ServiceUnavailableException("Generated tool reload is not configured");
    }
    if (!isRecord(rawBody) || !isRecord(rawBody.manifest) || !Array.isArray(rawBody.files)) {
      throw new BadRequestException("source bundle import requires manifest and files");
    }
    const manifest = rawBody.manifest as ToolPackageManifest;
    if (manifest.package?.type !== "source-bundle") {
      throw new BadRequestException("source bundle import requires a source-bundle manifest");
    }
    const files = parseSourceBundleFiles(rawBody.files);
    const fileMap = new Map(files.map((file) => [file.path, file.content]));
    let creation: ToolCreationRecord | undefined;

    try {
      creation = await this.creationStore?.create({
        source: "import",
        toolName: manifest.name,
        toolVersion: manifest.version,
        kind: "source-bundle-import",
        request: "Imported portable source-bundle package.",
        description: manifest.description,
        capabilities: manifest.capabilities,
        dependencies: dependencyRecords(packageJsonDependencies(fileMap.get("package.json"))),
        strategy: {
          kind: "imported-source-bundle",
          reason: "Operator imported an existing portable source-bundle package.",
          confidence: "high",
          candidates: [
            {
              kind: "imported-source-bundle",
              name: "source bundle import",
              reason: "The source bundle already contains manifest, package metadata, source, tests, and runtime files.",
            },
          ],
          rejectedCandidates: [],
          selectedDependencies: dependencyRecords(packageJsonDependencies(fileMap.get("package.json"))),
          implementationNotes: ["Imported package is re-QA'd and starts disabled until manual verification."],
        },
      });
      if (creation) {
        creation = await this.creationStore?.update(creation.id, { status: "building" }) ?? creation;
      }

      const store = new ToolPackageWorkspaceStore(process.cwd(), process.env.TOOL_PACKAGE_WORKSPACE_ROOT ?? "tools");
      const workspace = await store.writeSourceBundlePackage({
        manifest,
        readmeMarkdown: fileMap.get("README.md"),
        dockerfile: fileMap.get("Dockerfile"),
        packageJson: parseJsonFile(fileMap.get("package.json"), "package.json"),
        tsconfigJson: parseJsonFile(fileMap.get("tsconfig.json"), "tsconfig.json"),
        files: files.filter((file) => !STANDARD_SOURCE_BUNDLE_FILES.has(file.path)),
      });
      const qa = await validateAndBuildToolPackageWorkspace(
        process.cwd(),
        {
          packageRef: workspace.packageRef,
          manifestPath: workspace.manifestPath,
          files: workspace.files,
        },
        { linkNodeModulesFrom: process.cwd() },
      );
      creation = await this.creationStore?.update(creation?.id ?? "", {
        status: qa.ok ? "building" : "qa_failed",
        packageRef: workspace.packageRef,
        manifestPath: workspace.manifestPath,
        files: workspace.files,
        qa,
        error: qa.ok ? undefined : qa.summary,
      }) ?? creation;
      if (!qa.ok) throw new Error(qa.summary);

      const manifestWithQa: ToolPackageManifest = {
        ...workspace.manifest,
        qa: { summary: qa.summary, checks: qa.checks },
      };
      const registered = await this.metadata.registerGenerated(
        generatedToolInputFromPackageManifest(manifestWithQa, "Imported portable source-bundle package."),
      );
      await this.reload();
      const tool = await this.metadata.setStatus(registered.name, "disabled")
        ?? (await this.metadata.list()).find((candidate) => candidate.name === registered.name)
        ?? registered;
      creation = await this.creationStore?.update(creation?.id ?? "", {
        status: "registered",
        registeredAt: new Date(),
      }) ?? creation;
      await this.audit.record({
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "tool.package_imported",
        targetType: "tool",
        targetId: tool.name,
        status: "success",
        summary: `Imported source-bundle tool package: ${tool.name}@${tool.version}`,
        metadata: sanitizeAuditMetadata({
          packageRef: workspace.packageRef,
          manifestPath: workspace.manifestPath,
          qa,
          creationId: creation?.id,
        }),
      });
      return {
        tool,
        creation,
        package: {
          packageRef: workspace.packageRef,
          manifestPath: workspace.manifestPath,
          files: workspace.files,
        },
        qa,
      };
    } catch (error) {
      if (creation) {
        await this.creationStore?.update(creation.id, {
          status: creation.status === "qa_failed" ? "qa_failed" : "failed",
          error: error instanceof Error ? error.message : "Invalid source bundle import",
        });
      }
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid source bundle import",
      );
    }
  }

  async listPackageRunners() {
    return this.registryAdminService().listPackageRunners();
  }

  async registerGenerated(rawBody: unknown): Promise<ToolModuleMetadata> {
    return this.registryAdminService().registerGenerated(rawBody);
  }

  async importPackageManifest(rawBody: unknown): Promise<ToolModuleMetadata> {
    return this.registryAdminService().importPackageManifest(rawBody);
  }

  async listVersions(name: string): Promise<ToolModuleVersionSummary[]> {
    return this.registryAdminService().listVersions(name);
  }

  /**
   * Phase 13 — derive per-tool usage stats from the metadata store.
   * The store already accumulates successCount / failureCount /
   * lastSuccessAt / lastFailureAt; this method shapes them into a
   * single structured response with derived metrics (success rate,
   * total runs, per-version aggregates) so the UI doesn't need to
   * compute ratios on every render.
   */
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
    return this.registryAdminService().getToolStats(name);
  }

  /**
   * Phase 13 — return the package manifest as a JSON download. Used
   * by the export UI to share a tool's blueprint with another
   * agentic instance. Operators can then POST the same JSON back
   * via /api/tools/package-manifests on the target instance to
   * import the tool blueprint (the OCI image lives in the local
   * Docker daemon and is published / pulled separately).
   */
  async exportPackageManifest(name: string): Promise<{
    manifest: unknown;
    filename: string;
  }> {
    return this.registryAdminService().exportPackageManifest(name);
  }

  async getPackageManifest(name: string) {
    return this.registryAdminService().getPackageManifest(name);
  }

  async deleteGenerated(name: string): Promise<{ deleted: true; name: string }> {
    return this.versionLifecycleService().deleteGenerated(name);
  }

  async markVersionAvailable(
    name: string,
    version: string,
  ): Promise<{ name: string; version: string; status: "available" }> {
    return this.versionLifecycleService().markVersionAvailable(name, version);
  }

  async deleteVersion(
    name: string,
    version: string,
  ): Promise<{ deleted: true; name: string; version: string }> {
    return this.versionLifecycleService().deleteVersion(name, version);
  }

  async rejectVersion(
    name: string,
    version: string,
    rawBody: unknown,
  ): Promise<{ rejected: true; name: string; version: string; reason: string }> {
    return this.versionLifecycleService().rejectVersion(name, version, rawBody);
  }

  async promoteReplacement(name: string, rawBody: unknown): Promise<ToolModuleMetadata> {
    const tool = await this.versionLifecycleService().promoteReplacement(name, rawBody);
    await this.restartAlwaysOnServiceAfterVersionSwitch(tool);
    return tool;
  }

  async activateVersion(name: string, rawBody: unknown): Promise<ToolModuleMetadata> {
    const tool = await this.versionLifecycleService().activateVersion(name, rawBody);
    await this.restartAlwaysOnServiceAfterVersionSwitch(tool);
    return tool;
  }

  async acceptAgentVerifiedVersion(input: {
    name: string;
    version: string;
    runId?: string;
    replacesVersion?: string;
  }): Promise<ToolModuleMetadata> {
    const tool = await this.versionLifecycleService().acceptAgentVerifiedVersion(input);
    await this.restartAlwaysOnServiceAfterVersionSwitch(tool);
    return tool;
  }

  private async restartAlwaysOnServiceAfterVersionSwitch(tool: ToolModuleMetadata): Promise<void> {
    if (tool.startupMode !== "always-on" || !this.serviceSupervisor) return;
    const service = (await this.serviceSupervisor.list()).find((item) => item.toolName === tool.name);
    if (!service || service.desiredState !== "running") return;
    await this.serviceSupervisor.restart(tool.name);
  }

  private versionLifecycleService(): ToolVersionLifecycleService {
    return this.versionLifecycle ?? new ToolVersionLifecycleService(
      this.registry,
      this.metadata,
      this.reload,
      this.audit,
      this.creationStore,
      this.runs,
    );
  }

  private async findToolMetadata(toolName: string): Promise<ToolModuleMetadata | undefined> {
    if (this.metadata) {
      return (await this.metadata.list()).find((tool) => tool.name === toolName);
    }
    return (this.registry?.list() ?? [])
      .map((tool) => toolToMetadata(tool))
      .find((tool) => tool.name === toolName);
  }

  private async deleteCreationPackage(record: ToolCreationRecord): Promise<boolean> {
    if (!record.packageRef) return false;
    const packageDir = sourceBundlePackageDir(
      process.cwd(),
      process.env.TOOL_PACKAGE_WORKSPACE_ROOT ?? "tools",
      record.packageRef,
    );
    await rm(packageDir, { recursive: true, force: true });
    return true;
  }

  private async deleteMatchingUnregisteredMetadata(record: ToolCreationRecord): Promise<boolean> {
    if (!this.metadata) return false;
    const versions = await this.metadata.listVersions(record.toolName).catch(() => []);
    const matched = versions.filter((version) =>
      version.version === record.toolVersion
      && (!record.packageRef || version.packageManifest?.package.ref === record.packageRef)
    );
    if (matched.length === 0 || matched.length !== versions.length) return false;
    await this.metadata.deleteGenerated(record.toolName);
    this.registry?.unregister?.(record.toolName);
    return true;
  }

  private async deleteToolScopedSecrets(record: ToolCreationRecord): Promise<string[]> {
    if (!this.secretHandles) return [];
    const prefix = `secret.tool.${record.toolName}.`;
    const protectedHandles = await this.referencedSecretHandles(record.toolName);
    const handles = (await this.secretHandles.list(1_000))
      .map((record) => record.handle)
      .filter((handle) => handle.startsWith(prefix) && !protectedHandles.has(handle));
    const deleted: string[] = [];
    for (const handle of handles) {
      if (await this.secretHandles.delete(handle)) deleted.push(handle);
    }
    return deleted;
  }

  private async referencedSecretHandles(toolName: string): Promise<Set<string>> {
    if (!this.metadata) return new Set();
    const versions = await this.metadata.listVersions(toolName).catch(() => []);
    return new Set(versions.flatMap((version) => [
      ...(version.requiredSecretHandles ?? []),
      ...(version.packageManifest?.requiredSecretHandles ?? []),
      ...(version.packageManifest?.integration?.auth?.requiredSecretHandles ?? []),
      ...(version.packageManifest?.integration?.operations.flatMap((operation) => operation.requiredSecretHandles ?? []) ?? []),
    ]));
  }

  private async withStoredToolContext(toolName: string, rawBody: unknown): Promise<unknown> {
    if (!this.toolContexts || !isRecord(rawBody)) return rawBody;
    const contextItems = await this.toolContexts.list({ toolName });
    const contextDocs = contextItems.map(formatContextForBuilder);
    if (contextDocs.length === 0) return rawBody;
    const suppliedDocs = documentationTextValues([
      rawBody.documentation,
      rawBody.docs,
      rawBody.docsMarkdown,
      rawBody.apiDocs,
      rawBody.apiDocumentation,
      rawBody.openApiSpec,
    ]);
    return {
      ...rawBody,
      documentation: [...contextDocs, ...suppliedDocs],
    };
  }

  private async captureRequestContext(
    toolName: string,
    rawBody: unknown,
    creationId?: string,
  ): Promise<void> {
    if (!this.toolContexts || !isRecord(rawBody)) return;
    const items = extractRequestContextItems(toolName, rawBody, creationId);
    for (const item of items) await this.toolContexts.create(item);
  }

  private async backfillToolContextFromCreations(toolName: string): Promise<void> {
    if (!this.toolContexts || !this.creationStore) return;
    const existing = await this.toolContexts.list({ toolName, includeDeleted: true });
    const existingSources = new Set(existing.map((item) => item.source).filter(Boolean));
    const creations = await this.creationStore.list({ toolName, limit: 200 });
    for (const creation of creations) {
      const source = `tool-creation-history:${creation.id}`;
      if (existingSources.has(source)) continue;
      await this.toolContexts.create({
        toolName,
        kind: "note",
        title: `v${creation.toolVersion} ${creation.kind} ${creation.status}`,
        content: formatCreationRecordForContext(creation),
        source,
        mimeType: "text/markdown",
      });
      existingSources.add(source);
    }
  }
}
