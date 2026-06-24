import type { ArtifactStore } from "../../../artifacts/artifactStore.js";
import { inspectScreenshotArtifact } from "../../../artifacts/visualArtifactQuality.js";
import { extractArtifact } from "../../../agents/baseAgentArtifacts.js";
import type { AgentRunRecord, RunStore } from "../../../runs/types.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import type { ExternalActionProposal } from "../../../types.js";
import { isRecord } from "../../common/parsers.js";
import { selectAdaptivePreparationUrl } from "./action-proposal-adaptive-url.js";
import { ActionProposalAuditRecorder } from "./action-proposal-audit-recorder.js";
import {
  buildSchemaAwarePreparationCommands,
  type ActionPreparationProfileValue,
} from "./action-proposal-form-matching.js";
import {
  browserPreparationToolPriority,
  buildDefaultPreparationCommands,
  buildPreparationToolInput,
  currentUrlFromResult,
  hasExplicitPreparationCommands,
  isReplayPreparationRequested,
  isRunnableBrowserPreparationTool,
  linksFromResult,
  normalizePreparationCommands,
  preferredPreparationCapability,
  requiresExplicitNavigateCommand,
  runOptionalPreparationPass,
  supportsBrowserFieldCandidates,
  supportsBrowserFormSchema,
  supportsBrowserSafeAdvance,
  supportsSemanticFormFill,
  withPreparationWarning,
} from "./action-proposal-preparation-input.js";
import { buildPreparedSession, latestPreparedSession } from "./action-proposal-prepared-session.js";
import {
  mergePreparationWarnings,
  resultStillNeedsCandidateSelection,
} from "./action-proposal-preparation-warnings.js";
import { buildSafeAdvancePreparationCommands } from "./action-proposal-safe-advance.js";
import { withTimeout } from "./action-proposals.shared.js";

const EXTERNAL_ACTION_PREPARATION_TIMEOUT_MS = 60_000;

export class ActionProposalPreparationRunner {
  constructor(
    private readonly input: {
      runs: RunStore;
      artifacts: ArtifactStore | undefined;
      toolRegistry: ToolRegistry | undefined;
      recorder: ActionProposalAuditRecorder;
      profileValues?: ActionPreparationProfileValue[];
      approvedProfileFields?: string[];
    },
  ) {}

  async prepare(input: {
    run: AgentRunRecord;
    proposal: ExternalActionProposal;
    rawBody: unknown;
  }): Promise<void> {
    const { run, proposal, rawBody } = input;
    const tool = this.findBrowserPreparationTool();
    if (!tool) {
      await this.input.recorder.recordExternalActionPreparationFailed({
        run,
        proposal,
        reason:
          "No enabled external-action-prepare or browser-operate tool is registered for safe external action preparation.",
      });
      return;
    }

    const previousSession = latestPreparedSession(run, proposal.id);
    const explicitCommands = hasExplicitPreparationCommands(rawBody);
    const replayRequested = isReplayPreparationRequested(rawBody);
    let toolInput = buildPreparationToolInput(
      proposal,
      rawBody,
      previousSession,
      {
        useFieldCandidates: supportsBrowserFieldCandidates(tool),
        useSemanticFormFill: supportsSemanticFormFill(tool),
        useSelectorFallback: !supportsBrowserFieldCandidates(tool),
        includeFormSchemaExtraction: supportsBrowserFormSchema(tool),
        prependNavigateCommand: requiresExplicitNavigateCommand(tool),
        approvedProfileFields: this.input.approvedProfileFields,
        profileValues: this.input.profileValues,
      },
    );
    if (!toolInput.url) {
      await this.input.recorder.recordExternalActionPreparationFailed({
        run,
        proposal,
        reason:
          "No HTTP/HTTPS source URL or target URL is available for browser preparation.",
        toolName: tool.name,
        toolVersion: tool.version,
        toolInput,
      });
      return;
    }

    await this.input.recorder.recordExternalActionPreparationStarted({
      run,
      proposal,
      toolName: tool.name,
      toolVersion: tool.version,
      toolInput,
    });

    const startedAt = Date.now();
    let savedArtifactIds: string[] = [];
    let proofArtifactIds: string[] = [];
    let safeAdvanceAttempted = false;
    let result: { ok: boolean; content: string; data?: unknown };
    try {
      result = await withTimeout(
        this.input.toolRegistry!.execute(
          tool,
          toolInput,
          {
            runId: run.id,
            instanceId: run.instanceId,
            requesterUserId: run.requesterUserId,
            threadId: run.threadId,
            spanId: `action-${proposal.id}-prepare`,
            parentSpanId: findProposalParentSpan(run, proposal.id),
            caller: "external-action-prepare",
            capability: preferredPreparationCapability(tool),
            now: new Date(),
          },
          { recordUsage: true },
        ),
        EXTERNAL_ACTION_PREPARATION_TIMEOUT_MS,
      );
      let saved = await this.saveFirstArtifact({ run, proposal, toolName: tool.name, toolInput, result });
      savedArtifactIds.push(...saved.artifactIds); proofArtifactIds.push(...saved.proofArtifactIds);
      result = recoverOptionalCommandFailure(result, toolInput);
      if (result.ok && !explicitCommands && !replayRequested) {
        const candidateUrl = selectAdaptivePreparationUrl({
          actionType: proposal.actionType,
          currentUrl: currentUrlFromResult(result.data, toolInput),
          links: linksFromResult(result.data),
        });
        if (candidateUrl) {
          const adaptiveToolInput = {
            ...toolInput,
            url: candidateUrl,
            commands: normalizePreparationCommands(
              buildDefaultPreparationCommands(proposal, {
                includeCollectedInputs: supportsBrowserFieldCandidates(tool),
                includeFormSchemaExtraction: supportsBrowserFormSchema(tool),
                useFieldCandidates: supportsBrowserFieldCandidates(tool),
                useSemanticFormFill: supportsSemanticFormFill(tool),
              }),
              {
                url: candidateUrl,
                includeFormSchemaExtraction: supportsBrowserFormSchema(tool),
                prependNavigateCommand: requiresExplicitNavigateCommand(tool),
                supportsSemanticFill: supportsBrowserFieldCandidates(tool),
              },
            ),
          };
          const adaptiveResult = await withTimeout(
            this.input.toolRegistry!.execute(
              tool,
              adaptiveToolInput,
              {
                runId: run.id,
                instanceId: run.instanceId,
                requesterUserId: run.requesterUserId,
                threadId: run.threadId,
                spanId: `action-${proposal.id}-prepare-adaptive`,
                parentSpanId: `action-${proposal.id}-prepare`,
                caller: "external-action-prepare",
                capability: preferredPreparationCapability(tool),
                now: new Date(),
              },
              { recordUsage: true },
            ),
            EXTERNAL_ACTION_PREPARATION_TIMEOUT_MS,
          );
          if (adaptiveResult.ok) {
            saved = await this.saveFirstArtifact({ run, proposal, toolName: tool.name, toolInput: adaptiveToolInput, result: adaptiveResult });
            savedArtifactIds.push(...saved.artifactIds); proofArtifactIds.push(...saved.proofArtifactIds);
            toolInput = adaptiveToolInput;
            result = {
              ...adaptiveResult,
              content: `Adaptive preparation followed likely action URL ${candidateUrl}. ${adaptiveResult.content}`,
            };
          } else {
            result = {
              ...result,
              content: `${result.content} Adaptive preparation found ${candidateUrl}, but the follow-up prepare pass failed: ${adaptiveResult.content}`,
              data: withPreparationWarning(
                result.data,
                `Adaptive prepare URL failed: ${candidateUrl}`,
              ),
            };
          }
        }
        if (supportsBrowserSafeAdvance(tool)) {
          for (let safeAdvanceIndex = 0; safeAdvanceIndex < 3; safeAdvanceIndex += 1) {
            const safeAdvanceCommands = buildSafeAdvancePreparationCommands(
              proposal,
              result.data,
              {
                useFieldCandidates: supportsBrowserFieldCandidates(tool),
                buildDefaultCommands: buildDefaultPreparationCommands,
              },
            );
            const safeAdvanceUrl = currentUrlFromResult(result.data, toolInput);
            if (safeAdvanceCommands.length === 0 || !safeAdvanceUrl) break;
            safeAdvanceAttempted = true;
            const safeAdvanceToolInput = {
              ...toolInput,
              url: safeAdvanceUrl,
              commands: normalizePreparationCommands(safeAdvanceCommands, {
                url: safeAdvanceUrl,
                includeFormSchemaExtraction: supportsBrowserFormSchema(tool),
                prependNavigateCommand: requiresExplicitNavigateCommand(tool),
                supportsSemanticFill: supportsBrowserFieldCandidates(tool),
              }),
            };
            const safeAdvanceResult = await runOptionalPreparationPass(
              () =>
                withTimeout(
                  this.input.toolRegistry!.execute(
                    tool,
                    safeAdvanceToolInput,
                    {
                      runId: run.id,
                      instanceId: run.instanceId,
                      requesterUserId: run.requesterUserId,
                      threadId: run.threadId,
                      spanId: `action-${proposal.id}-prepare-safe-advance-${safeAdvanceIndex + 1}`,
                      parentSpanId: `action-${proposal.id}-prepare`,
                      caller: "external-action-prepare",
                      capability: preferredPreparationCapability(tool),
                      now: new Date(),
                    },
                    { recordUsage: true },
                  ),
                  EXTERNAL_ACTION_PREPARATION_TIMEOUT_MS,
                ),
            );
            if (!safeAdvanceResult.ok) {
              result = {
                ...result,
                data: withPreparationWarning(
                  result.data,
                  `Safe-advance prepare failed: ${safeAdvanceResult.content}`,
                ),
              };
              break;
            }
            saved = await this.saveFirstArtifact({ run, proposal, toolName: tool.name, toolInput: safeAdvanceToolInput, result: safeAdvanceResult });
            savedArtifactIds.push(...saved.artifactIds); proofArtifactIds.push(...saved.proofArtifactIds);
            toolInput = safeAdvanceToolInput;
            result = {
              ...safeAdvanceResult,
              content: `Safe-advance preparation opened a provider flow before final submit. ${safeAdvanceResult.content}`,
            };
          }
        }

        const schemaCommands = supportsBrowserFormSchema(tool)
          ? buildSchemaAwarePreparationCommands(
              proposal,
              isRecord(result.data) ? result.data.forms : undefined,
            )
          : [];
        const schemaUrl = currentUrlFromResult(result.data, toolInput);
        if (schemaCommands.length > 0 && schemaUrl) {
          const schemaToolInput = {
            ...toolInput,
            url: schemaUrl,
            commands: schemaCommands,
          };
          const schemaResult = await withTimeout(
            this.input.toolRegistry!.execute(
              tool,
              schemaToolInput,
              {
                runId: run.id,
                instanceId: run.instanceId,
                requesterUserId: run.requesterUserId,
                threadId: run.threadId,
                spanId: `action-${proposal.id}-prepare-schema`,
                parentSpanId: `action-${proposal.id}-prepare`,
                caller: "external-action-prepare",
                capability: preferredPreparationCapability(tool),
                now: new Date(),
              },
              { recordUsage: true },
            ),
            EXTERNAL_ACTION_PREPARATION_TIMEOUT_MS,
          );
          if (schemaResult.ok) {
            saved = await this.saveFirstArtifact({ run, proposal, toolName: tool.name, toolInput: schemaToolInput, result: schemaResult });
            savedArtifactIds.push(...saved.artifactIds); proofArtifactIds.push(...saved.proofArtifactIds);
            toolInput = schemaToolInput;
            result = {
              ...schemaResult,
              data: mergePreparationWarnings(schemaResult.data, result.data),
              content: `Schema-aware preparation matched observed form fields. ${schemaResult.content}`,
            };
          } else {
            result = {
              ...result,
              data: withPreparationWarning(
                result.data,
                `Schema-aware prepare failed: ${schemaResult.content}`,
              ),
            };
          }
        }
        if (safeAdvanceAttempted && resultStillNeedsCandidateSelection(result.data)) {
          result = {
            ...result,
            data: withPreparationWarning(
              result.data,
              "Safe-advance was attempted, but the provider page still shows only selection controls. The generated preparation tool likely needs richer repeated-control targeting before this action can be submitted.",
            ),
          };
        }
      }
    } catch (error) {
      result = {
        ok: false,
        content: `External action preparation threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const durationMs = Date.now() - startedAt;
    const preparedSession = buildPreparedSession({
      proposal,
      toolName: tool.name,
      toolVersion: tool.version,
      toolInput,
      data: result.data,
      artifactIds: savedArtifactIds,
      proofArtifactIds,
      profileValues: this.input.profileValues,
      approvedProfileFields: this.input.approvedProfileFields,
    });
    if (result.ok) {
      await this.input.recorder.recordExternalActionPreparationCompleted({
        run,
        proposal,
        toolName: tool.name,
        toolVersion: tool.version,
        toolInput,
        result,
        durationMs,
        artifactIds: savedArtifactIds,
        preparedSession,
      });
      return;
    }
    await this.input.recorder.recordExternalActionPreparationFailed({
      run,
      proposal,
      reason: result.content || "Preparation tool returned a failed result.",
      toolName: tool.name,
      toolVersion: tool.version,
      toolInput,
      result,
      durationMs,
      artifactIds: savedArtifactIds,
      preparedSession,
    });
  }

  private findBrowserPreparationTool() {
    const candidates =
      this.input.toolRegistry
        ?.list()
        .filter(isRunnableBrowserPreparationTool)
        .sort((a, b) => {
          return (
            browserPreparationToolPriority(b) -
              browserPreparationToolPriority(a) ||
            a.name.localeCompare(b.name)
          );
        }) ?? [];
    return candidates[0];
  }

  private async saveFirstArtifact(input: {
    run: AgentRunRecord;
    proposal: ExternalActionProposal;
    toolName: string;
    toolInput: Record<string, unknown>;
    result: { ok: boolean; content: string; data?: unknown };
  }): Promise<{ artifactIds: string[]; proofArtifactIds: string[] }> {
    if (!this.input.artifacts) return { artifactIds: [], proofArtifactIds: [] };
    const artifact = extractArtifact(
      input.toolName,
      input.toolInput,
      input.result,
    );
    if (!artifact) return { artifactIds: [], proofArtifactIds: [] };
    const quality = preparationArtifactQuality(artifact);
    const saved = await this.input.artifacts.saveGenerated(
      input.run.id,
      quality ? { ...artifact, quality } : artifact,
    );
    const now = new Date().toISOString();
    await this.input.runs.appendEvent(input.run.id, {
      id: `action-prep-artifact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      spanId: `action-${input.proposal.id}-prepare-artifact-${saved.id}`,
      parentSpanId: `action-${input.proposal.id}-prepare`,
      type: "artifact-created",
      actor: input.toolName,
      activity: "tool",
      status: "completed",
      title: `Preparation artifact saved: ${saved.filename}`,
      detail: saved.description,
      timestamp: now,
      startedAt: now,
      completedAt: now,
      payload: {
        proposalId: input.proposal.id,
        artifactId: saved.id,
        filename: saved.filename,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
        output: { artifactId: saved.id, filename: saved.filename },
      },
    });
    return {
      artifactIds: [saved.id],
      proofArtifactIds: saved.quality?.status === "failed" ? [] : [saved.id],
    };
  }
}

function recoverOptionalCommandFailure(
  result: { ok: boolean; content: string; data?: unknown },
  toolInput: Record<string, unknown>,
): { ok: boolean; content: string; data?: unknown } {
  if (result.ok || !isOptionalPreparationCommandFailure(result.content, toolInput)) {
    return result;
  }
  return {
    ...result,
    ok: true,
    content: `Optional preparation command failed and was treated as a warning. ${result.content}`,
    data: withPreparationWarning(
      result.data,
      `Optional preparation command failed: ${result.content}`,
    ),
  };
}

function isOptionalPreparationCommandFailure(
  content: string,
  toolInput: Record<string, unknown>,
): boolean {
  const commands = Array.isArray(toolInput.commands)
    ? toolInput.commands.filter(isRecord)
    : [];
  if (!commands.length) return false;
  const match = /\bcommand\s+(\d+)\b/i.exec(content);
  if (!match) return false;
  const parsed = Number(match[1]);
  if (!Number.isInteger(parsed)) return false;

  // Browser tool errors have appeared with both zero-based and one-based command
  // indexes across providers. Accept either only when the referenced command is
  // explicitly optional.
  const candidates = [commands[parsed], commands[parsed - 1]].filter(Boolean);
  return candidates.some((command) => command.optional === true);
}

function preparationArtifactQuality(
  artifact: ReturnType<typeof extractArtifact>,
) {
  if (!artifact || artifact.mimeType !== "image/png") return undefined;
  const report = inspectScreenshotArtifact(artifact);
  return {
    status: report.ok ? "passed" as const : "failed" as const,
    reviewedAt: new Date().toISOString(),
    checks: [
      {
        name: "external-action-preparation-visual-qa",
        ok: report.ok,
        decision: report.ok ? "usable" : "visually_invalid",
        reason: report.reason,
      },
    ],
  };
}

function findProposalParentSpan(
  run: AgentRunRecord,
  proposalId: string,
): string | undefined {
  return run.events.find((candidate) => {
    if (candidate.type !== "external-action-proposal-created") return false;
    const payload =
      candidate.payload && typeof candidate.payload === "object"
        ? (candidate.payload as Record<string, unknown>)
        : {};
    return payload.proposalId === proposalId;
  })?.spanId;
}
