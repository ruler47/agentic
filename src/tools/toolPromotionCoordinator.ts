import { ToolBuildOutput } from "./toolBuildWorkflow.js";
import { ToolBuildQaReport, ToolBuildRequest } from "./toolBuildRequestStore.js";
import {
  GeneratedToolModuleInput,
  ToolMetadataStore,
  ToolModuleMetadata,
  ToolModulePromotionEvidence,
} from "./toolMetadataStore.js";
import {
  createToolMigrationChecksum,
  ToolMigrationRecord,
  ToolMigrationStore,
} from "./toolMigrationStore.js";
import { ToolPackageManifest } from "./toolPackage.js";
import { ToolPromotionRecord, ToolPromotionStore } from "./toolPromotionStore.js";

export type ToolPromotionCoordinatorResult = {
  toolName: string;
  metadata: ToolModuleMetadata;
  promotionEvidence: ToolModulePromotionEvidence;
  migrationRecords: ToolMigrationRecord[];
  promotionRecord?: ToolPromotionRecord;
};

export class ToolPromotionCoordinator {
  constructor(
    private readonly metadataStore: ToolMetadataStore,
    private readonly migrationStore?: ToolMigrationStore,
    private readonly promotionStore?: ToolPromotionStore,
  ) {}

  async promote(
    request: ToolBuildRequest,
    output: ToolBuildOutput,
    qaReport?: ToolBuildQaReport,
  ): Promise<ToolPromotionCoordinatorResult> {
    const toolName = request.contract.toolName;
    const promotionEvidence = createToolPromotionEvidence(request, output, qaReport);
    const metadataInput = createToolMetadataInput(request, output, promotionEvidence);

    const metadata = request.replacesVersion
      ? await this.metadataStore.promoteReplacement({
          ...metadataInput,
          replacesVersion: request.replacesVersion,
        })
      : await this.metadataStore.registerGenerated(metadataInput);

    const migrationRecords = await this.recordStorageMigrationManifests(request, output, qaReport);
    const promotionRecord = await this.recordPromotion(request, promotionEvidence);

    return {
      toolName,
      metadata,
      promotionEvidence,
      migrationRecords,
      promotionRecord,
    };
  }

  private async recordStorageMigrationManifests(
    request: ToolBuildRequest,
    output: ToolBuildOutput,
    qaReport?: ToolBuildQaReport,
  ): Promise<ToolMigrationRecord[]> {
    if (!this.migrationStore || !output.storage?.migrations?.length) return [];

    const records: ToolMigrationRecord[] = [];
    for (const migrationId of output.storage.migrations) {
      records.push(
        await this.migrationStore.create({
          toolName: request.contract.toolName,
          toolVersion: request.contract.version,
          migrationId,
          checksum: createToolMigrationChecksum({
            toolName: request.contract.toolName,
            toolVersion: request.contract.version,
            migrationId,
            schema: output.storage.schema,
            tables: output.storage.tables,
          }),
          status: "pending",
          qaReport: {
            ok: qaReport?.ok ?? true,
            summary: qaReport?.summary ?? "Migration manifest recorded with generated tool metadata.",
            checks: qaReport?.checks ?? ["migration manifest recorded; isolated database execution pending"],
          },
          rollbackNotes: "Pending isolated database execution and transactional promotion.",
        }),
      );
    }
    return records;
  }

  private async recordPromotion(
    request: ToolBuildRequest,
    evidence: ToolModulePromotionEvidence,
  ): Promise<ToolPromotionRecord | undefined> {
    if (!this.promotionStore) return undefined;

    return this.promotionStore.create({
      toolName: request.contract.toolName,
      toolVersion: request.contract.version,
      status: evidence.status,
      promotedAt: new Date(evidence.promotedAt),
      buildRequestId: evidence.buildRequestId,
      qaReport: evidence.qaReport,
      packageRef: evidence.packageRef,
      migrationIds: evidence.migrationIds,
      summary: evidence.summary,
    });
  }
}

export function createToolPromotionEvidence(
  request: ToolBuildRequest,
  output: ToolBuildOutput,
  qaReport?: ToolBuildQaReport,
): ToolModulePromotionEvidence {
  return {
    status: "promoted",
    promotedAt: new Date().toISOString(),
    summary: qaReport?.summary ?? output.summary,
    buildRequestId: request.id,
    qaReport: qaReport
      ? {
          ok: qaReport.ok,
          summary: qaReport.summary,
          checks: qaReport.checks,
          artifacts: qaReport.artifacts,
          reviews: qaReport.reviews,
        }
      : undefined,
    packageRef: output.packageWorkspace?.packageRef ?? output.packageManifest?.package.ref,
    migrationIds: output.storage?.migrations,
  };
}

export function createToolMetadataInput(
  request: ToolBuildRequest,
  output: ToolBuildOutput,
  promotionEvidence: ToolModulePromotionEvidence,
): GeneratedToolModuleInput {
  return {
    name: request.contract.toolName,
    displayName: output.displayName ?? request.displayName ?? request.contract.displayName,
    version: request.contract.version,
    description: request.contract.description,
    capabilities: output.capabilities ?? [request.capability],
    startupMode: request.contract.startupMode,
    inputSchema: output.inputSchema ?? request.contract.inputSchema,
    outputSchema: output.outputSchema ?? request.contract.outputSchema,
    modulePath: output.modulePath,
    testPath: output.testPath,
    requiredConfigurationKeys: output.requiredConfigurationKeys,
    requiredSecretHandles: output.requiredSecretHandles ?? request.credentialHandles,
    settingsSchema: output.settingsSchema,
    storage: output.storage,
    docsMarkdown: output.docsMarkdown,
    examples: output.examples,
    packageManifest: output.packageWorkspace
      ? packageWorkspaceManifest(request, output, output.packageWorkspace.packageRef)
      : output.packageManifest,
    changeSummary: output.changeSummary ?? formatToolVersionChangeSummary(request, output),
    promotionEvidence,
  };
}

function packageWorkspaceManifest(
  request: ToolBuildRequest,
  output: ToolBuildOutput,
  packageRef: string,
): ToolPackageManifest {
  return {
    schemaVersion: "agentic.tool-package.v1",
    name: request.contract.toolName,
    displayName: output.displayName ?? request.displayName ?? request.contract.displayName,
    version: request.contract.version,
    description: request.contract.description,
    capabilities: output.capabilities ?? [request.capability],
    startupMode: request.contract.startupMode,
    package: {
      type: "source-bundle",
      ref: packageRef,
    },
    inputSchema: output.inputSchema ?? request.contract.inputSchema,
    outputSchema: output.outputSchema ?? request.contract.outputSchema,
    requiredConfigurationKeys: output.requiredConfigurationKeys,
    requiredSecretHandles: output.requiredSecretHandles ?? request.credentialHandles,
    settingsSchema: output.settingsSchema,
    storage: output.storage,
    docsMarkdown: output.docsMarkdown,
    examples: output.examples,
  };
}

function formatToolVersionChangeSummary(request: ToolBuildRequest, output: ToolBuildOutput): string {
  const header = request.replacesVersion
    ? `Version ${request.contract.version} replaces ${request.replacesVersion}.`
    : `Initial generated version ${request.contract.version}.`;
  const feedback = request.feedback?.trim()
    ? `\n\nOperator feedback:\n${request.feedback.trim()}`
    : "";
  return [
    header,
    `Build request: ${request.id}.`,
    output.summary,
    request.reason.trim() ? `Request context:\n${request.reason.trim()}` : undefined,
    feedback || undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
}
