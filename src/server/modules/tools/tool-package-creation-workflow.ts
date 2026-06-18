import { BadRequestException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { ToolRegistry } from "../../../tools/registry.js";
import { toolToMetadata, type ToolMetadataStore, type ToolModuleMetadata, type ToolModuleVersionSummary } from "../../../tools/toolMetadataStore.js";
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
import {
  validateAndBuildToolPackageWorkspace,
  type ToolPackageWorkspaceQaReport,
} from "../../../tools/toolPackageWorkspaceQa.js";
import type { SecretHandleStore } from "../../../secrets/secretHandleStore.js";
import type { RunStore } from "../../../runs/types.js";
import { AuditService } from "../../common/services/audit.service.js";
import { isRecord, parseOptionalStringArray, parseOptionalText, parseRequiredText, sanitizeAuditMetadata } from "../../common/parsers.js";
import { createToolCreationTrace, noToolCreationTrace, type ToolCreationTrace } from "./tool-creation-trace.js";
import { dependencyRecords } from "./tool-source-bundle-files.js";

export class ToolPackageCreationWorkflow {
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
        input: {
          request,
          requestedName,
          source,
          parentRunId,
        },
        output: {
          runId: run.id,
          rootSpanId,
        },
      },
    });
    return trace;
  }

  async createToolPackage(rawBody: unknown): Promise<{
    tool: ToolModuleMetadata;
    creation?: ToolCreationRecord;
    runId?: string;
    package: {
      packageRef: string;
      manifestPath: string;
      files: string[];
    };
    qa: ToolPackageWorkspaceQaReport;
  }> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    if (!this.reload) {
      throw new ServiceUnavailableException("Generated tool reload is not configured");
    }
    let creation: ToolCreationRecord | undefined;
    const secretPreparation = prepareToolCreationSecrets(rawBody);
    const toolRequest = secretPreparation.input;
    const trace = await this.startToolCreationTrace(toolRequest);
    const discoverySpanId = `${trace.rootSpanId}:discovery`;
    const secretsSpanId = `${trace.rootSpanId}:secrets`;
    const strategySpanId = `${trace.rootSpanId}:strategy`;
    const authoringSpanId = `${trace.rootSpanId}:authoring`;
    const packageQaSpanId = `${trace.rootSpanId}:package-qa`;
    const registrationSpanId = `${trace.rootSpanId}:registered`;
    const reloadSpanId = `${trace.rootSpanId}:reload`;
    try {
      const discovery = await discoverToolImplementation({ rawInput: toolRequest });
      await trace.event({
        type: "tool-creation-discovery-completed",
        spanId: discoverySpanId,
        parentSpanId: trace.rootSpanId,
        actor: "tool-builder",
        status: "completed",
        title: "Implementation discovery completed",
        detail: discovery.notes.join(" "),
        payload: {
          mode: discovery.mode,
          candidates: discovery.candidates,
          dependencies: discovery.dependencies,
          evidence: discovery.evidence,
          notes: discovery.notes,
          input: {
            request: toolRequest,
          },
          output: {
            mode: discovery.mode,
            candidates: discovery.candidates,
            dependencies: discovery.dependencies,
            evidence: discovery.evidence,
            notes: discovery.notes,
          },
        },
      });
      const initialPlan = buildToolBuilderPlan(toolRequest, {
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
          title: "Tool secrets registered",
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
      const plan = applyStoredSecretsToToolBuilderPlan(initialPlan, storedSecrets);
      await trace.event({
        type: "tool-creation-strategy-selected",
        spanId: strategySpanId,
        parentSpanId: storedSecrets.length > 0 ? secretsSpanId : discoverySpanId,
        actor: "tool-builder",
        status: "completed",
        title: "Tool builder strategy selected",
        detail: `${plan.strategy.kind} (${plan.strategy.confidence}): ${plan.strategy.reason}`,
        payload: {
          ...plan.strategy,
          input: {
            request: toolRequest,
            discovery,
          },
          output: {
            strategy: plan.strategy,
            normalizedInput: plan.input,
          },
        },
      });
      const normalized = normalizeToolCreationV1Input(plan.input);
      creation = await this.creationStore?.create({
        source: parseToolCreationSource(toolRequest),
        toolName: normalized.name,
        toolVersion: normalized.version,
        kind: normalized.kind,
        request: normalized.request,
        description: normalized.description,
        capabilities: normalized.capabilities,
        dependencies: dependencyRecords(normalized.dependencies),
        strategy: plan.strategy,
        runId: trace.runId,
      });
      if (creation) {
        creation = await this.creationStore?.update(creation.id, {
          status: "building",
          strategy: plan.strategy,
        }) ?? creation;
      }
      const authoring = await authorToolPackageWithGuardrails({
        plan,
        llm: this.llm,
        mode: plan.authoringMode,
      });
      const authoredBehaviorExamples = authoring.mode === "authored"
        ? authoring.package.behaviorExamples ?? []
        : [];
      const finalInput = authoredBehaviorExamples.length > 0 && normalized.behaviorExamples.length === 0
        ? { ...normalized, behaviorExamples: authoredBehaviorExamples }
        : normalized;
      await trace.event({
        type: "tool-creation-authoring-completed",
        spanId: authoringSpanId,
        parentSpanId: strategySpanId,
        actor: "tool-builder",
        status: "completed",
        title: "Tool package authoring completed",
        detail: authoring.mode === "authored"
          ? "LLM authored package snapshot accepted by guardrails."
          : `Using scaffold writer: ${authoring.reason}`,
        payload: {
          mode: authoring.mode,
          notes: authoring.notes,
          reason: authoring.mode === "scaffold" ? authoring.reason : undefined,
          input: {
            strategy: plan.strategy,
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
      const strategyWithAuthoring = {
        ...plan.strategy,
        behaviorExamples: finalInput.behaviorExamples,
        implementationNotes: [
          ...plan.strategy.implementationNotes,
          ...authoring.notes,
          ...(authoredBehaviorExamples.length ? [`LLM authored ${authoredBehaviorExamples.length} behavior QA example(s).`] : []),
          ...(authoring.mode === "scaffold" ? [`Authoring fallback: ${authoring.reason}`] : []),
        ],
      };
      if (creation) {
        creation = await this.creationStore?.update(creation.id, {
          status: "building",
          strategy: strategyWithAuthoring,
        }) ?? creation;
      }

      const created = await createToolPackageV1({
        ...finalInput,
        source: parseToolCreationSource(toolRequest),
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
        title: "Package workspace QA completed",
        detail: created.qa.summary,
        payload: {
          packageRef: created.workspace.packageRef,
          manifestPath: created.workspace.manifestPath,
          files: created.workspace.files,
          qa: created.qa,
          input: {
            packageRef: created.workspace.packageRef,
            manifestPath: created.workspace.manifestPath,
            files: created.workspace.files,
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
      if (!created.qa.ok) {
        throw new Error(created.qa.summary);
      }
      const registered = await this.metadata.registerGenerated(created.generatedInput);
      const activationPolicy = parseActivationPolicy(toolRequest);
      await trace.event({
        type: "tool-creation-registered",
        spanId: registrationSpanId,
        parentSpanId: packageQaSpanId,
        actor: registered.name,
        status: "completed",
        title: "Tool metadata registered",
        detail: `${registered.name}@${registered.version} registered in metadata.`,
        payload: {
          tool: {
            name: registered.name,
            version: registered.version,
            status: registered.status,
            source: registered.source,
            capabilities: registered.capabilities,
          },
          packageRef: created.workspace.packageRef,
          input: {
            packageRef: created.workspace.packageRef,
            generatedInput: created.generatedInput,
          },
          output: {
            toolName: registered.name,
            toolVersion: registered.version,
            status: registered.status,
          },
        },
      });
      await this.reload();
      const activationRequiresManualLiveCheck = Boolean(created.qa.requiresManualLiveVerification);
      const shouldMarkAvailable =
        activationPolicy === "available_on_success" && !activationRequiresManualLiveCheck;
      if (shouldMarkAvailable) {
        await this.metadata.markAvailable(registered.name, registered.version);
      } else {
        await this.metadata.setStatus(registered.name, "disabled");
      }
      const tool = (await this.metadata.list()).find((candidate) => candidate.name === registered.name)
        ?? registered;
      if (shouldMarkAvailable) {
        await trace.event({
          type: "tool-version-marked-available",
          spanId: `${trace.rootSpanId}:marked-available`,
          parentSpanId: registrationSpanId,
          actor: tool.name,
          status: "completed",
          title: "Tool version marked available",
          detail: `${tool.name}@${tool.version} was marked available after successful creation QA by request policy.`,
          payload: {
            toolName: tool.name,
            toolVersion: tool.version,
            activationPolicy,
            input: {
              toolName: registered.name,
              toolVersion: registered.version,
              qa: created.qa,
            },
            output: {
              status: tool.status,
              activationPolicy,
            },
          },
        });
      } else if (activationPolicy === "available_on_success" && activationRequiresManualLiveCheck) {
        await trace.event({
          type: "tool-version-marked-available",
          spanId: `${trace.rootSpanId}:marked-available`,
          parentSpanId: registrationSpanId,
          actor: tool.name,
          status: "completed",
          title: "Tool version left disabled for live verification",
          detail: `${tool.name}@${tool.version} passed package QA but needs manual live verification before agent availability.`,
          payload: {
            toolName: tool.name,
            toolVersion: tool.version,
            activationPolicy,
            input: {
              toolName: registered.name,
              toolVersion: registered.version,
              qa: created.qa,
            },
            output: {
              status: tool.status,
              activationPolicy,
              activationRequiresManualLiveCheck,
            },
          },
        });
      }
      await trace.event({
        type: "tool-creation-reloaded",
        spanId: reloadSpanId,
        parentSpanId: registrationSpanId,
        actor: tool.name,
        status: "completed",
        title: "Tool registry reloaded",
        detail: `${tool.name}@${tool.version} loaded as ${tool.status}.`,
        payload: {
          tool: {
            name: tool.name,
            version: tool.version,
            status: tool.status,
            source: tool.source,
            capabilities: tool.capabilities,
          },
          packageRef: created.workspace.packageRef,
          input: {
            toolName: registered.name,
            toolVersion: registered.version,
          },
          output: {
            tool: {
              name: tool.name,
              version: tool.version,
              status: tool.status,
              source: tool.source,
              capabilities: tool.capabilities,
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
        action: "tool.package_imported",
        targetType: "tool",
        targetId: tool.name,
        status: "success",
        summary: `Created source-bundle tool package: ${tool.name}@${tool.version}`,
        metadata: sanitizeAuditMetadata({
          packageRef: created.workspace.packageRef,
          manifestPath: created.workspace.manifestPath,
          qa: created.qa,
          kind: created.input.kind,
          strategy: strategyWithAuthoring,
          authoringMode: authoring.mode,
          activationPolicy,
          activationRequiresManualLiveCheck,
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
        title: "Tool creation completed",
        detail: `Created ${tool.name}@${tool.version}; status ${tool.status}.`,
        payload: {
          creationId: creation?.id,
          toolName: tool.name,
          toolVersion: tool.version,
          status: tool.status,
          activationPolicy,
          activationRequiresManualLiveCheck,
          packageRef: created.workspace.packageRef,
          qa: created.qa,
          input: {
            creationId: creation?.id,
            packageRef: created.workspace.packageRef,
          },
          output: {
            toolName: tool.name,
            toolVersion: tool.version,
            status: tool.status,
            activationPolicy,
            activationRequiresManualLiveCheck,
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
        detail: "Tool creation lifecycle completed.",
        payload: {
          input: {
            request: toolRequest,
          },
          output: {
            toolName: tool.name,
            toolVersion: tool.version,
            status: tool.status,
            activationPolicy,
            qa: created.qa,
          },
        },
      });
      await trace.complete(`Created source-bundle tool ${tool.name}@${tool.version}; status ${tool.status}.`, created.qa);
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
          error: error instanceof Error ? error.message : "Invalid tool creation request",
        });
      }
      await trace.event({
        type: "tool-creation-failed",
        spanId: `${trace.rootSpanId}:failed`,
        parentSpanId: packageQaSpanId,
        actor: "tool-builder",
        status: "failed",
        title: "Tool creation failed",
        detail: error instanceof Error ? error.message : "Invalid tool creation request",
        payload: {
          creationId: creation?.id,
          toolName: creation?.toolName,
          status: creation?.status,
          input: {
            request: toolRequest,
          },
          output: {
            ok: false,
            error: error instanceof Error ? error.message : "Invalid tool creation request",
          },
        },
      });
      await trace.event({
        type: "tool-creation-started",
        spanId: trace.rootSpanId,
        actor: "tool-builder",
        status: "failed",
        title: "Tool creation started",
        detail: "Tool creation lifecycle failed.",
        payload: {
          input: {
            request: toolRequest,
          },
          output: {
            ok: false,
            error: error instanceof Error ? error.message : "Invalid tool creation request",
          },
        },
      });
      await trace.fail(error instanceof Error ? error.message : "Invalid tool creation request");
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid tool creation request",
      );
    }
  }

  private async findToolMetadata(toolName: string): Promise<ToolModuleMetadata | undefined> {
    if (this.metadata) return (await this.metadata.list()).find((tool) => tool.name === toolName);
    return (this.registry?.list() ?? []).map((tool) => toolToMetadata(tool)).find((tool) => tool.name === toolName);
  }
}

function limitTextForLabel(value: unknown, maxLength: number): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const text = (raw ?? "").trim().replace(/\s+/g, " ");
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function optionalBodyText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("Expected a string value");
  const trimmed = value.trim();
  return trimmed || undefined;
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

function bumpPatchVersion(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) return `${version}.1`;
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4] ?? ""}`;
}

function inferToolCreationKind(tool: ToolModuleMetadata): "echo" | "http-json" | "npm-default-function" | "browser-screenshot" | "browser-operate" | "web-read" | "service-adapter" | "external-action-prepare" | "external-action-commit" {
  if (tool.packageManifest?.integration?.mode === "always-on-service") return "service-adapter";
  if (tool.startupMode === "always-on") return "service-adapter";
  const text = [
    tool.name,
    tool.description,
    ...(tool.capabilities ?? []),
  ].join(" ").toLowerCase();
  if (text.includes("telegram") || text.includes("messaging") || text.includes("bot") || text.includes("always-on")) return "service-adapter";
  if (text.includes("external-action-prepare") || text.includes("prepared action draft") || text.includes("safe external action preparation")) return "external-action-prepare";
  if (text.includes("external-action-commit") || text.includes("commit executor") || text.includes("approved external action")) return "external-action-commit";
  if (text.includes("browser-operate") || text.includes("browser automation") || text.includes("dom-extraction")) return "browser-operate";
  if (text.includes("browser-screenshot") || text.includes("screenshot")) return "browser-screenshot";
  if (text.includes("web-read") || text.includes("web-extract")) return "web-read";
  if (text.includes("npm-package") || text.includes("slugify")) return "npm-default-function";
  if (text.includes("api-client") || text.includes("http") || text.includes("fetch")) return "http-json";
  return "echo";
}

function parseToolCreationSource(rawBody: unknown): "operator" | "agent" {
  return isRecord(rawBody) && rawBody.source === "agent" ? "agent" : "operator";
}

function parseActivationPolicy(rawBody: unknown): "manual" | "available_on_success" {
  if (!isRecord(rawBody)) return "manual";
  const value = rawBody.activationPolicy ?? rawBody.publishPolicy;
  if (value === undefined || value === null || value === "" || value === "manual") return "manual";
  if (value === "available_on_success") return "available_on_success";
  throw new BadRequestException("activationPolicy must be manual or available_on_success");
}
