import { BadRequestException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { ToolRegistry } from "../../../tools/registry.js";
import { toolToMetadata, type ToolMetadataStore, type ToolModuleMetadata } from "../../../tools/toolMetadataStore.js";
import { createToolPackageV1, normalizeToolCreationV1Input } from "../../../tools/toolCreationV1.js";
import { buildToolBuilderPlan } from "../../../tools/toolBuilderAgent.js";
import { authorToolPackageWithGuardrails } from "../../../tools/toolBuilderPackageAuthor.js";
import { discoverToolImplementation } from "../../../tools/toolImplementationDiscovery.js";
import {
  applyStoredSecretsToToolBuilderPlan,
  persistToolCreationSecrets,
  prepareToolCreationSecrets,
  publicStoredSecretSummary,
} from "../../../tools/toolCreationSecrets.js";
import type { LlmClient } from "../../../llm/client.js";
import type { ToolCreationRecord, ToolCreationStatus, ToolCreationStore } from "../../../tools/toolCreationStore.js";
import { ToolPackageWorkspaceStore } from "../../../tools/toolPackageWorkspaceStore.js";
import { validateAndBuildToolPackageWorkspace } from "../../../tools/toolPackageWorkspaceQa.js";
import type { SecretHandleStore } from "../../../secrets/secretHandleStore.js";
import type { RunStore } from "../../../runs/types.js";
import { AuditService } from "../../common/services/audit.service.js";
import { isRecord, parseOptionalStringArray, parseOptionalText, parseRequiredText, sanitizeAuditMetadata } from "../../common/parsers.js";
import { createToolCreationTrace, noToolCreationTrace, type ToolCreationTrace } from "./tool-creation-trace.js";
import { dependencyRecords, readSourceBundleDependenciesForTool } from "./tool-source-bundle-files.js";
import {
  applyToolBuilderPlanIntegrationEditConstraints,
  applyToolIntegrationEditConstraints,
} from "./tool-integration-edit-constraints.js";
import {
  bumpPatchVersion,
  formatChangeSummary,
  formatEditRequest,
  inheritedEditDocumentation,
  limitTextForLabel,
  metadataFromVersionSummary,
  optionalBodyText,
  parseOptionalBodyTextList,
  parseToolCreationSource,
  resolveEditKind,
} from "./tool-package-version-helpers.js";

export class ToolPackageVersionWorkflow {
  constructor(
    private readonly registry: ToolRegistry | undefined,
    private readonly metadata: ToolMetadataStore | undefined,
    private readonly reload: (() => Promise<void>) | undefined,
    private readonly audit: AuditService,
    private readonly creationStore?: ToolCreationStore,
    private readonly llm?: LlmClient,
    private readonly runs?: RunStore,
    private readonly secretHandles?: SecretHandleStore,
  ) {}

  async createToolVersion(name: string, rawBody: unknown): Promise<{
    tool: ToolModuleMetadata;
    creation?: ToolCreationRecord;
    runId?: string;
    package: {
      packageRef: string;
      manifestPath: string;
      files: string[];
    };
    qa: {
      ok: boolean;
      summary: string;
      checks: string[];
    };
  }> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    if (!this.reload) {
      throw new ServiceUnavailableException("Generated tool reload is not configured");
    }
    const activeTool = await this.findToolMetadata(name);
    if (!activeTool) throw new NotFoundException("Tool not found");
    if (activeTool.source !== "generated") {
      throw new BadRequestException("Only generated tools can receive generated version edits");
    }
    const secretPreparation = prepareToolCreationSecrets(rawBody);
    const editBody = secretPreparation.input;
    if (!isRecord(editBody)) throw new BadRequestException("tool version request must be an object");

    let creation: ToolCreationRecord | undefined;
    const request = parseRequiredText(
      editBody.request ?? editBody.changeRequest ?? editBody.desiredBehavior,
      "request",
    );
    const baseVersion = optionalBodyText(editBody.baseVersion) ?? activeTool.version;
    const versions = await this.metadata.listVersions(name);
    const baseSummary = versions.find((item) => item.version === baseVersion);
    if (!baseSummary) throw new BadRequestException(`Base version ${baseVersion} was not found for ${name}.`);
    const baseTool = metadataFromVersionSummary(activeTool, baseSummary);
    const version = optionalBodyText(editBody.version) ?? bumpPatchVersion(baseTool.version);
    const customLabel = optionalBodyText(editBody.customLabel);
    const changeDescription = optionalBodyText(editBody.changeDescription);
    const inferredKind = resolveEditKind(baseTool, optionalBodyText(editBody.kind));
    const existingDependencies = await readSourceBundleDependenciesForTool(baseTool);
    const documentation = inheritedEditDocumentation(baseTool, editBody);
    const constrainedIntegration = applyToolIntegrationEditConstraints(
      baseTool.packageManifest?.integration,
      [request, ...(documentation ?? [])],
    );
    const versionRequest = {
      source: parseToolCreationSource(editBody),
      sourceRunId: parseOptionalText(editBody.sourceRunId),
      parentRunId: parseOptionalText(editBody.parentRunId),
      instanceId: parseOptionalText(editBody.instanceId),
      requesterUserId: parseOptionalText(editBody.requesterUserId),
      threadId: parseOptionalText(editBody.threadId),
      name,
      baseVersion: baseTool.version,
      activeVersion: activeTool.version,
      customLabel,
      changeDescription,
      displayName: optionalBodyText(editBody.displayName) ?? baseTool.displayName,
      version,
      description: optionalBodyText(editBody.description) ?? baseTool.description,
      request: formatEditRequest({
        name,
        baseVersion: baseTool.version,
        activeVersion: activeTool.version,
        request,
        customLabel,
        changeDescription,
      }),
      kind: inferredKind,
      capabilities: parseOptionalStringArray(editBody.capabilities, "capabilities") ?? baseTool.capabilities,
      dependencies: isRecord(editBody.dependencies) ? editBody.dependencies : existingDependencies,
      behaviorExamples: Array.isArray(editBody.behaviorExamples) ? editBody.behaviorExamples : undefined,
      docsUrl: optionalBodyText(editBody.docsUrl),
      docsUrls: parseOptionalBodyTextList(editBody.docsUrls),
      documentation,
      apiDocs: editBody.apiDocs,
      openApiSpec: editBody.openApiSpec,
      discoveryMode: editBody.discoveryMode,
      discoveryQuery: editBody.discoveryQuery,
      authoringMode: editBody.authoringMode,
      startupMode: baseTool.startupMode,
      requiredSecretHandles: baseTool.requiredSecretHandles,
      requiredConfigurationKeys: baseTool.requiredConfigurationKeys,
      settingsSchema: baseTool.settingsSchema,
      integration: constrainedIntegration,
    };
    const trace = await this.startToolCreationTrace(versionRequest);
    const discoverySpanId = `${trace.rootSpanId}:discovery`;
    const secretsSpanId = `${trace.rootSpanId}:secrets`;
    const strategySpanId = `${trace.rootSpanId}:strategy`;
    const authoringSpanId = `${trace.rootSpanId}:authoring`;
    const packageQaSpanId = `${trace.rootSpanId}:package-qa`;
    const registrationSpanId = `${trace.rootSpanId}:registered`;
    const reloadSpanId = `${trace.rootSpanId}:reload`;

    try {
      const discovery = await discoverToolImplementation({ rawInput: versionRequest });
      await trace.event({
        type: "tool-creation-discovery-completed",
        spanId: discoverySpanId,
        parentSpanId: trace.rootSpanId,
        actor: "tool-builder",
        status: "completed",
        title: "Tool edit discovery completed",
        detail: discovery.notes.join(" "),
        payload: {
          mode: discovery.mode,
          candidates: discovery.candidates,
          dependencies: discovery.dependencies,
          evidence: discovery.evidence,
          notes: discovery.notes,
          replacesVersion: baseTool.version,
          input: {
            request: versionRequest,
            currentTool: {
              name: baseTool.name,
              version: baseTool.version,
              status: baseTool.status,
            },
          },
          output: {
            mode: discovery.mode,
            candidates: discovery.candidates,
            dependencies: discovery.dependencies,
            evidence: discovery.evidence,
            notes: discovery.notes,
            replacesVersion: baseTool.version,
          },
        },
      });
      const initialPlan = buildToolBuilderPlan(versionRequest, {
        discoveredCandidates: discovery.candidates,
        discoveredDependencies: discovery.dependencies,
        discoveryEvidence: discovery.evidence,
        discoveryNotes: discovery.notes,
      });
      const storedSecrets = await persistToolCreationSecrets({
        extractedSecrets: secretPreparation.extractedSecrets,
        toolName: initialPlan.input.name,
        store: this.secretHandles,
      });
      if (storedSecrets.length > 0) {
        await trace.event({
          type: "tool-creation-secrets-registered",
          spanId: secretsSpanId,
          parentSpanId: discoverySpanId,
          actor: "secret-store",
          status: "completed",
          title: "Tool edit secrets registered",
          detail: `Registered ${storedSecrets.length} tool-scoped secret handle(s).`,
          payload: {
            secrets: publicStoredSecretSummary(storedSecrets),
            input: {
              redactionNotes: secretPreparation.redactionNotes,
            },
            output: {
              handles: storedSecrets.map((secret) => secret.handle),
              toolName: initialPlan.input.name,
            },
          },
        });
      }
      const plan = applyToolBuilderPlanIntegrationEditConstraints(
        applyStoredSecretsToToolBuilderPlan(initialPlan, storedSecrets),
        [request, ...(documentation ?? [])],
      );
      const editStrategy = {
        ...plan.strategy,
        implementationNotes: [
          `Editing existing generated tool ${name}; candidate version ${version} is based on ${baseTool.version}.`,
          activeTool.version !== baseTool.version ? `Active version remains ${activeTool.version}; this edit intentionally uses inactive base ${baseTool.version}.` : `Active version remains ${activeTool.version}.`,
          customLabel ? `Operator custom label: ${customLabel}.` : undefined,
          changeDescription ? `Short edit description: ${changeDescription}.` : undefined,
          `${parseToolCreationSource(editBody) === "agent" ? "Agent" : "Operator"} change request: ${request}`,
          ...plan.strategy.implementationNotes,
        ].filter((note): note is string => Boolean(note)),
      };
      await trace.event({
        type: "tool-creation-strategy-selected",
        spanId: strategySpanId,
        parentSpanId: storedSecrets.length > 0 ? secretsSpanId : discoverySpanId,
        actor: "tool-builder",
        status: "completed",
        title: "Tool edit strategy selected",
        detail: `${plan.strategy.kind} (${plan.strategy.confidence}): ${plan.strategy.reason}`,
        payload: {
          ...editStrategy,
          input: {
            request: versionRequest,
            discovery,
            currentTool: {
              name: baseTool.name,
              version: baseTool.version,
              status: baseTool.status,
            },
          },
          output: {
            strategy: editStrategy,
            normalizedInput: plan.input,
          },
        },
      });
      const normalized = normalizeToolCreationV1Input(plan.input);
      creation = await this.creationStore?.create({
        source: parseToolCreationSource(editBody),
        toolName: normalized.name,
        toolVersion: normalized.version,
        kind: `${normalized.kind}-edit`,
        request: normalized.request,
        description: normalized.description,
        capabilities: normalized.capabilities,
        dependencies: dependencyRecords(normalized.dependencies),
        strategy: editStrategy,
        runId: trace.runId,
      });
      if (creation) {
        creation = await this.creationStore?.update(creation.id, {
          status: "building",
          strategy: editStrategy,
        }) ?? creation;
      }

      const authoring = await authorToolPackageWithGuardrails({
        plan: {
          ...plan,
          strategy: editStrategy,
        },
        llm: this.llm,
        mode: plan.authoringMode,
      });
      const authoredBehaviorExamples = authoring.mode === "authored"
        ? authoring.package.behaviorExamples ?? []
        : [];
      const finalInput = authoredBehaviorExamples.length > 0 && normalized.behaviorExamples.length === 0
        ? { ...normalized, behaviorExamples: authoredBehaviorExamples }
        : normalized;
      const strategyWithAuthoring = {
        ...editStrategy,
        behaviorExamples: finalInput.behaviorExamples,
        implementationNotes: [
          ...editStrategy.implementationNotes,
          ...authoring.notes,
          ...(authoredBehaviorExamples.length ? [`LLM authored ${authoredBehaviorExamples.length} behavior QA example(s).`] : []),
          ...(authoring.mode === "scaffold" ? [`Authoring fallback: ${authoring.reason}`] : []),
        ],
      };
      await trace.event({
        type: "tool-creation-authoring-completed",
        spanId: authoringSpanId,
        parentSpanId: strategySpanId,
        actor: "tool-builder",
        status: "completed",
        title: "Tool edit package authoring completed",
        detail: authoring.mode === "authored"
          ? "LLM authored edited package snapshot accepted by guardrails."
          : `Using scaffold writer: ${authoring.reason}`,
        payload: {
          mode: authoring.mode,
          notes: authoring.notes,
          reason: authoring.mode === "scaffold" ? authoring.reason : undefined,
          input: {
            strategy: editStrategy,
            authoringMode: plan.authoringMode,
          },
          output: {
            mode: authoring.mode,
            notes: authoring.notes,
            reason: authoring.mode === "scaffold" ? authoring.reason : undefined,
            behaviorExamples: authoredBehaviorExamples,
          },
        },
      });
      if (creation) {
        creation = await this.creationStore?.update(creation.id, {
          status: "building",
          strategy: strategyWithAuthoring,
        }) ?? creation;
      }

      const created = await createToolPackageV1({
        ...finalInput,
        source: parseToolCreationSource(editBody),
      }, {
        projectRoot: process.cwd(),
        workspaceRoot: process.env.TOOL_PACKAGE_WORKSPACE_ROOT ?? "tools",
        linkNodeModulesFrom: process.cwd(),
        authoredPackage: authoring.mode === "authored" ? authoring.package : undefined,
        qaRepairAttempts: 2,
      });
      await trace.event({
        type: "tool-creation-package-qa-completed",
        spanId: packageQaSpanId,
        parentSpanId: authoringSpanId,
        actor: normalized.name,
        status: created.qa.ok ? "completed" : "failed",
        title: "Edited package workspace QA completed",
        detail: created.qa.summary,
        payload: {
          packageRef: created.workspace.packageRef,
          manifestPath: created.workspace.manifestPath,
          files: created.workspace.files,
        qa: created.qa,
        replacesVersion: baseTool.version,
          input: {
            packageRef: created.workspace.packageRef,
            manifestPath: created.workspace.manifestPath,
            files: created.workspace.files,
            replacesVersion: baseTool.version,
          },
          output: {
            ok: created.qa.ok,
            summary: created.qa.summary,
            checks: created.qa.checks,
          },
        },
      });
      creation = await this.creationStore?.update(creation?.id ?? "", {
        status: created.qa.ok ? "building" : "qa_failed",
        packageRef: created.workspace.packageRef,
        manifestPath: created.workspace.manifestPath,
        files: created.workspace.files,
        qa: created.qa,
        strategy: strategyWithAuthoring,
        error: created.qa.ok ? undefined : created.qa.summary,
      }) ?? creation;
      if (!created.qa.ok) throw new Error(created.qa.summary);

      await this.metadata.registerGenerated({
        ...created.generatedInput,
        changeSummary: formatChangeSummary(request, customLabel, changeDescription),
      });
      const versions = await this.metadata.listVersions(normalized.name);
      const candidateVersion = versions.find((item) => item.version === normalized.version);
      if (!candidateVersion) {
        throw new Error(`Edited version ${normalized.version} was not registered.`);
      }
      const tool = metadataFromVersionSummary(activeTool, candidateVersion);
      await trace.event({
        type: "tool-creation-registered",
        spanId: registrationSpanId,
        parentSpanId: packageQaSpanId,
        actor: tool.name,
        status: "completed",
        title: "Edited tool metadata registered",
        detail: `${tool.name}@${tool.version} registered as candidate metadata.`,
        payload: {
          tool: {
            name: tool.name,
            version: tool.version,
            status: tool.status,
            source: tool.source,
            capabilities: tool.capabilities,
            active: false,
          },
          activeVersion: activeTool.version,
          replacesVersion: baseTool.version,
          packageRef: created.workspace.packageRef,
          input: {
            packageRef: created.workspace.packageRef,
            generatedInput: {
              ...created.generatedInput,
              changeSummary: formatChangeSummary(request, customLabel, changeDescription),
            },
          },
          output: {
            toolName: tool.name,
            toolVersion: tool.version,
            active: false,
            status: tool.status,
          },
        },
      });
      await this.reload();
      await trace.event({
        type: "tool-creation-reloaded",
        spanId: reloadSpanId,
        parentSpanId: registrationSpanId,
        actor: tool.name,
        status: "completed",
        title: "Edited tool registry reloaded",
        detail: `${tool.name}@${tool.version} loaded as ${tool.status}; active remains ${activeTool.version}.`,
        payload: {
          tool: {
            name: tool.name,
            version: tool.version,
            status: tool.status,
            source: tool.source,
            capabilities: tool.capabilities,
            active: false,
          },
          activeVersion: activeTool.version,
          replacesVersion: baseTool.version,
          packageRef: created.workspace.packageRef,
          input: {
            toolName: tool.name,
            toolVersion: tool.version,
            activeVersion: activeTool.version,
            baseVersion: baseTool.version,
          },
          output: {
            tool: {
              name: tool.name,
              version: tool.version,
              status: tool.status,
              source: tool.source,
              capabilities: tool.capabilities,
              active: false,
            },
          },
        },
      });
      creation = await this.creationStore?.update(creation?.id ?? "", {
        status: "registered",
        registeredAt: new Date(),
      }) ?? creation;
      await this.audit.record({
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "tool.version_created",
        targetType: "tool",
        targetId: `${tool.name}@${tool.version}`,
        status: "success",
          summary: `Created edited tool version: ${tool.name}@${tool.version}`,
        metadata: sanitizeAuditMetadata({
          baseVersion: baseTool.version,
          activeVersion: activeTool.version,
          customLabel,
          changeDescription,
          packageRef: created.workspace.packageRef,
          manifestPath: created.workspace.manifestPath,
          qa: created.qa,
          strategy: strategyWithAuthoring,
          authoringMode: authoring.mode,
          status: tool.status,
          registeredCredentialHandles: storedSecrets.map((secret) => secret.handle),
        }),
      });
      await trace.event({
        type: "tool-creation-completed",
        spanId: `${trace.rootSpanId}:completed`,
        parentSpanId: reloadSpanId,
        actor: "tool-builder",
        status: "completed",
        title: "Tool edit completed",
        detail: `Created edited candidate ${tool.name}@${tool.version}; active remains ${activeTool.version}.`,
        payload: {
          creationId: creation?.id,
          toolName: tool.name,
          toolVersion: tool.version,
          activeVersion: activeTool.version,
          replacesVersion: baseTool.version,
          customLabel,
          status: tool.status,
          packageRef: created.workspace.packageRef,
          qa: created.qa,
          input: {
            creationId: creation?.id,
            packageRef: created.workspace.packageRef,
            replacesVersion: baseTool.version,
          },
          output: {
            toolName: tool.name,
            toolVersion: tool.version,
            activeVersion: activeTool.version,
            status: tool.status,
            qa: created.qa,
          },
        },
      });
      await trace.event({
        type: "tool-creation-started",
        spanId: trace.rootSpanId,
        actor: "tool-builder",
        status: "completed",
        title: "Tool creation started",
        detail: "Tool edit lifecycle completed.",
        payload: {
          input: {
            request: versionRequest,
          },
          output: {
            toolName: tool.name,
            toolVersion: tool.version,
            activeVersion: activeTool.version,
            status: tool.status,
            qa: created.qa,
          },
        },
      });
      await trace.complete(
        `Created edited source-bundle candidate ${tool.name}@${tool.version}; active remains ${activeTool.version}.`,
        created.qa,
      );
      return {
        tool,
        creation,
        runId: trace.runId,
        package: {
          packageRef: created.workspace.packageRef,
          manifestPath: created.workspace.manifestPath,
          files: created.workspace.files,
        },
        qa: created.qa,
      };
    } catch (error) {
      if (creation) {
        await this.creationStore?.update(creation.id, {
          status: creation.status === "qa_failed" ? "qa_failed" : "failed",
          error: error instanceof Error ? error.message : "Invalid tool edit request",
        });
      }
      await trace.event({
        type: "tool-creation-failed",
        spanId: `${trace.rootSpanId}:failed`,
        parentSpanId: packageQaSpanId,
        actor: "tool-builder",
        status: "failed",
        title: "Tool edit failed",
        detail: error instanceof Error ? error.message : "Invalid tool edit request",
        payload: {
          creationId: creation?.id,
          toolName: creation?.toolName,
          status: creation?.status,
          replacesVersion: baseTool.version,
          input: {
            request: versionRequest,
          },
          output: {
            ok: false,
            error: error instanceof Error ? error.message : "Invalid tool edit request",
          },
        },
      });
      await trace.event({
        type: "tool-creation-started",
        spanId: trace.rootSpanId,
        actor: "tool-builder",
        status: "failed",
        title: "Tool creation started",
        detail: "Tool edit lifecycle failed.",
        payload: {
          input: {
            request: versionRequest,
          },
          output: {
            ok: false,
            error: error instanceof Error ? error.message : "Invalid tool edit request",
          },
        },
      });
      await trace.fail(error instanceof Error ? error.message : "Invalid tool edit request");
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid tool edit request",
      );
    }
  }

  private async startToolCreationTrace(rawBody: unknown): Promise<ToolCreationTrace> {
    if (!this.runs) return noToolCreationTrace();
    const request = isRecord(rawBody)
      ? String(rawBody.request ?? rawBody.desiredBehavior ?? rawBody.task ?? "").trim()
      : "";
    const requestedName = isRecord(rawBody) && typeof rawBody.name === "string"
      ? rawBody.name.trim()
      : undefined;
    const source = isRecord(rawBody) && rawBody.source === "agent" ? "agent" : "operator";
    const parentRunId = isRecord(rawBody) ? parseOptionalText(rawBody.parentRunId) ?? parseOptionalText(rawBody.sourceRunId) : undefined;
    const instanceId = isRecord(rawBody) ? parseOptionalText(rawBody.instanceId) ?? "instance-local" : "instance-local";
    const requesterUserId = isRecord(rawBody) ? parseOptionalText(rawBody.requesterUserId) ?? "user-admin" : "user-admin";
    const threadId = isRecord(rawBody) ? parseOptionalText(rawBody.threadId) : undefined;
    const label = requestedName || limitTextForLabel(request || rawBody, 80) || "tool package";
    const run = await this.runs.create(`Create tool package: ${label}`, {
      instanceId,
      requesterUserId,
      channel: "tool-builder",
      threadId,
      parentRunId,
    });
    await this.runs.markRunning(run.id);
    const rootSpanId = `${run.id}:tool-creation`;
    const trace = createToolCreationTrace(this.runs, run.id, rootSpanId);
    await trace.event({
      type: "tool-creation-started",
      spanId: rootSpanId,
      actor: "tool-builder",
      status: "started",
      title: "Tool creation started",
      detail: request || `Creating ${label}.`,
      payload: {
        request,
        requestedName,
        source,
        parentRunId,
        input: { request, requestedName, source, parentRunId },
        output: { runId: run.id, rootSpanId },
      },
    });
    return trace;
  }

  private async findToolMetadata(toolName: string): Promise<ToolModuleMetadata | undefined> {
    if (this.metadata) return (await this.metadata.list()).find((tool) => tool.name === toolName);
    return (this.registry?.list() ?? []).map((tool) => toolToMetadata(tool)).find((tool) => tool.name === toolName);
  }
}
