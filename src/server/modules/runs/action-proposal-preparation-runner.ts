import type { ArtifactStore } from "../../../artifacts/artifactStore.js";
import { inspectScreenshotArtifact } from "../../../artifacts/visualArtifactQuality.js";
import { extractArtifact } from "../../../agents/baseAgentArtifacts.js";
import { prioritizedExternalActionSourceUrls } from "../../../agents/externalActionUrls.js";
import type { AgentRunRecord, RunStore } from "../../../runs/types.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import type {
  ExternalActionType,
  ExternalActionPreparedSession,
  ExternalActionProposal,
} from "../../../types.js";
import { isRecord, parseOptionalText } from "../../common/parsers.js";
import { selectAdaptivePreparationUrl } from "./action-proposal-adaptive-url.js";
import { ActionProposalAuditRecorder } from "./action-proposal-audit-recorder.js";
import {
  buildProfileHydrationCommands,
  buildSchemaAwarePreparationCommands,
  type ActionPreparationProfileValue,
} from "./action-proposal-form-matching.js";
import {
  buildPreparedSession,
  extractLinks,
  latestPreparedSession,
} from "./action-proposal-prepared-session.js";
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
            commands: buildDefaultPreparationCommands(proposal, {
              useFieldCandidates: supportsBrowserFieldCandidates(tool),
            }),
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
              commands: safeAdvanceCommands,
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
        .filter(
          (tool) =>
            tool.name === "browser.operate" ||
            tool.name === "external.action.prepare" ||
            tool.capabilities.includes("external-action-prepare") ||
            tool.capabilities.includes("browser-operate"),
        )
        .sort((a, b) => {
          const aPrepare = a.name === "external.action.prepare" || a.capabilities.includes("external-action-prepare") ? 1 : 0;
          const bPrepare = b.name === "external.action.prepare" || b.capabilities.includes("external-action-prepare") ? 1 : 0;
          const aExact = a.name === "browser.operate" ? 1 : 0;
          const bExact = b.name === "browser.operate" ? 1 : 0;
          return bPrepare - aPrepare || bExact - aExact || a.name.localeCompare(b.name);
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

function buildPreparationToolInput(
  proposal: ExternalActionProposal,
  rawBody: unknown,
  previousSession?: ExternalActionPreparedSession,
  options: {
    useFieldCandidates?: boolean;
    profileValues?: ActionPreparationProfileValue[];
    approvedProfileFields?: string[];
  } = {},
): Record<string, unknown> {
  const bodyInput =
    isRecord(rawBody) && isRecord(rawBody.input) ? rawBody.input : {};
  const mode = parseOptionalText(isRecord(rawBody) ? rawBody.mode : undefined);
  const replayRequested =
    mode === "replay" || mode === "replay_preparation" || mode === "replay-preparation";
  const replayCommands =
    replayRequested && previousSession?.replaySteps.length
      ? previousSession.replaySteps
      : undefined;
  const preferredActionUrl = firstHttpUrl(
    prioritizedExternalActionSourceUrls({
      actionType: proposal.actionType,
      finalAnswer: proposal.payloadPreview ?? "",
      sourceUrls: [
        proposal.preparation?.targetUrl,
        ...proposal.sourceUrls,
        proposal.target,
      ].filter((value): value is string => Boolean(value)),
    }),
  );
  const previousSessionUrl = replayRequested ? previousSession?.currentUrl : undefined;
  const url =
    parseOptionalText(bodyInput.url) ??
    preferredActionUrl ??
    previousSessionUrl ??
    firstHttpUrl([proposal.preparation?.targetUrl]) ??
    firstHttpUrl(proposal.sourceUrls) ??
    firstHttpUrl([proposal.target]);
  const canReplayPreviousSession =
    replayRequested &&
    Boolean(url) &&
    Boolean(previousSessionUrl) &&
    sameHttpUrlWithoutHash(url, previousSessionUrl);
  const commands =
    Array.isArray(bodyInput.commands) && bodyInput.commands.length
      ? bodyInput.commands.filter(isRecord)
      : canReplayPreviousSession
        ? replayCommands
        : undefined;
  const profileHydrationCommands = buildProfileHydrationCommands({
    session: canReplayPreviousSession ? previousSession : undefined,
    profileValues: options.profileValues,
    approvedFields:
      replayRequested && canReplayPreviousSession
        ? options.approvedProfileFields
        : undefined,
  });
  const replayCommandsWithHydration =
    commands && profileHydrationCommands.length
      ? mergePreparationCommands(commands, profileHydrationCommands)
      : commands;
  const useFieldCandidates =
    Boolean(options.useFieldCandidates) &&
    Boolean(url && isLikelyActionPreparationUrl(url, proposal.actionType));
  return {
    ...bodyInput,
    url,
    prepareOnly: true,
    commands:
      replayCommandsWithHydration ??
      buildDefaultPreparationCommands(proposal, { useFieldCandidates }),
  };
}

function mergePreparationCommands(
  commands: Record<string, unknown>[],
  hydrationCommands: Record<string, unknown>[],
): Record<string, unknown>[] {
  const insertionIndex = commands.findIndex(
    (command) =>
      command.action === "extractText" ||
      command.action === "extractLinks" ||
      command.action === "extractForms" ||
      command.action === "screenshot",
  );
  if (insertionIndex < 0) return [...commands, ...hydrationCommands];
  return [
    ...commands.slice(0, insertionIndex),
    ...hydrationCommands,
    ...commands.slice(insertionIndex),
  ];
}

function buildDefaultPreparationCommands(
  proposal: ExternalActionProposal,
  options: { useFieldCandidates?: boolean } = {},
): Record<string, unknown>[] {
  return [
    { action: "dismissDialogs" },
    ...buildCollectedInputCommands(proposal),
    ...(options.useFieldCandidates
      ? buildCanonicalCandidateFillCommands(proposal)
      : []),
    { action: "extractText", limit: 8000 },
    { action: "extractLinks", limit: 30 },
    { action: "extractForms", limit: 8 },
    {
      action: "screenshot",
      filename: `${proposal.id.replace(/[^a-zA-Z0-9_.-]/g, "-")}.png`,
    },
  ];
}

function buildCanonicalCandidateFillCommands(
  proposal: ExternalActionProposal,
): Record<string, unknown>[] {
  const inputs = proposal.preparation?.collectedInputs ?? [];
  const valueByLabel = new Map(
    inputs
      .map((item) => [item.label.trim().toLowerCase(), item.value.trim()] as const)
      .filter(([, value]) => value.length > 0),
  );
  const commands: Record<string, unknown>[] = [];
  const partySize = valueByLabel.get("party_size");
  if (partySize) {
    commands.push({
      action: "fill",
      field: "party_size",
      labels: [
        "Party size",
        "Guests",
        "People",
        "Number of guests",
        "Persons",
        "Comensales",
        "Personas",
        "Número de personas",
        "Numero de personas",
      ],
      placeholders: [
        "Party size",
        "Guests",
        "People",
        "Personas",
        "Comensales",
      ],
      value: partySize,
      optional: true,
    });
  }
  const dateOrTime = valueByLabel.get("date_or_time");
  const split = dateOrTime ? splitDateAndTime(dateOrTime) : {};
  if (split.date) {
    commands.push({
      action: "fill",
      field: "date",
      labels: ["Date", "Reservation date", "Booking date", "Fecha"],
      placeholders: ["Date", "Fecha", "dd/mm/yyyy", "yyyy-mm-dd"],
      value: split.date,
      optional: true,
    });
  }
  if (split.time) {
    commands.push({
      action: "fill",
      field: "time",
      labels: ["Time", "Reservation time", "Booking time", "Hora"],
      placeholders: ["Time", "Hora", "hh:mm"],
      value: split.time,
      optional: true,
    });
  }
  const service = valueByLabel.get("service") ?? valueByLabel.get("item_or_service");
  if (service) {
    commands.push({
      action: "fill",
      field: "service",
      labels: ["Service", "Treatment", "Appointment type", "Servicio"],
      placeholders: ["Service", "Treatment", "Servicio"],
      value: service,
      optional: true,
    });
  }
  const contact = valueByLabel.get("contact");
  if (contact) {
    const { name, email, phone } = splitContactValue(contact);
    if (name) {
      commands.push({
        action: "fill",
        field: "name",
        labels: ["Name", "Full name", "Имя", "Nombre", "Contact name"],
        placeholders: ["Name", "Your name", "Имя", "Nombre"],
        value: name,
        optional: true,
      });
    }
    if (email) {
      commands.push({
        action: "fill",
        field: "email",
        labels: ["Email", "E-mail", "Почта", "Correo", "Correo electrónico"],
        placeholders: ["Email", "you@example.com", "Correo"],
        value: email,
        optional: true,
      });
    }
    if (phone) {
      commands.push({
        action: "fill",
        field: "phone",
        labels: ["Phone", "Phone number", "Телефон", "Teléfono", "Móvil"],
        placeholders: ["Phone", "Телефон", "Teléfono", "+34"],
        value: phone,
        optional: true,
      });
    }
  }
  return commands;
}

/** Split a combined contact string into name / email / phone parts. */
function splitContactValue(value: string): { name?: string; email?: string; phone?: string } {
  const email = value.match(/[\w.+-]+@[\w-]+\.[\w.-]+/u)?.[0];
  const phone = value.match(/\+?\d[\d\s()-]{6,}\d/u)?.[0]?.trim();
  let name = value;
  if (email) name = name.replace(email, " ");
  if (phone) name = name.replace(phone, " ");
  name = name.replace(/[,;|]+/g, " ").replace(/\s+/g, " ").trim();
  return {
    name: name.length >= 2 ? name : undefined,
    email,
    phone,
  };
}

function buildCollectedInputCommands(
  proposal: ExternalActionProposal,
): Record<string, unknown>[] {
  return (
    proposal.preparation?.collectedInputs
      .filter((item) => item.label.trim() && item.value.trim())
      .filter((item) => !isCanonicalPreparationLabel(item.label))
      .filter((item) => !/target|url|link|source|confirmation/i.test(item.label))
      .slice(0, 20)
      .map((item) => ({
        action: "fill",
        label: item.label,
        value: item.value,
      })) ?? []
  );
}

function isCanonicalPreparationLabel(label: string): boolean {
  return /^(?:date_or_time|party_size|contact|service|item_or_service|delivery_or_pickup|payment_approval|recipient|message_body|target_system|write_payload|target|commit_instruction)$/i.test(label.trim());
}

function supportsBrowserFieldCandidates(tool: {
  capabilities?: string[];
}): boolean {
  // "form-fill" is the same contract under the name the registered
  // external.action.prepare package actually declares — label/placeholder
  // driven fill commands. Without this alias no canonical input (date,
  // time, service, contact) was ever sent to the provider form and every
  // commit was blocked with "data was not prepared on the provider page".
  return Boolean(
    tool.capabilities?.includes("browser-field-candidates") ||
      tool.capabilities?.includes("form-fill"),
  );
}

function supportsBrowserFormSchema(tool: { capabilities?: string[] }): boolean {
  return Boolean(tool.capabilities?.includes("browser-form-schema"));
}

function supportsBrowserSafeAdvance(tool: { capabilities?: string[] }): boolean {
  return Boolean(tool.capabilities?.includes("browser-safe-advance"));
}

function preferredPreparationCapability(tool: {
  capabilities?: string[];
}): "external-action-prepare" | "browser-operate" {
  return tool.capabilities?.includes("external-action-prepare")
    ? "external-action-prepare"
    : "browser-operate";
}

function isLikelyActionPreparationUrl(
  url: string,
  actionType: ExternalActionType,
): boolean {
  const lower = url.toLowerCase();
  const generic =
    /book|booking|reserve|reservation|appointment|schedule|checkout|order|cart/.test(
      lower,
    );
  if (generic) return true;
  if (actionType === "reservation") {
    return /reserv|book|mesa|table|booking/.test(lower);
  }
  if (actionType === "appointment") {
    return /appointment|booking|schedule|cita|book/.test(lower);
  }
  if (actionType === "purchase") {
    return /checkout|cart|order|buy|purchase/.test(lower);
  }
  return false;
}

function splitDateAndTime(value: string): { date?: string; time?: string } {
  const date = value.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  const time = value.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/)?.[0];
  return { date, time };
}

function hasExplicitPreparationCommands(rawBody: unknown): boolean {
  const bodyInput =
    isRecord(rawBody) && isRecord(rawBody.input) ? rawBody.input : {};
  return Array.isArray(bodyInput.commands) && bodyInput.commands.length > 0;
}

function isReplayPreparationRequested(rawBody: unknown): boolean {
  const mode = parseOptionalText(isRecord(rawBody) ? rawBody.mode : undefined);
  return mode === "replay" || mode === "replay_preparation" || mode === "replay-preparation";
}

async function runOptionalPreparationPass(
  execute: () => Promise<{ ok: boolean; content: string; data?: unknown }>,
): Promise<{ ok: boolean; content: string; data?: unknown }> {
  try {
    return await execute();
  } catch (error) {
    return {
      ok: false,
      content: error instanceof Error ? error.message : String(error),
    };
  }
}

function currentUrlFromResult(
  data: unknown,
  toolInput: Record<string, unknown>,
): string | undefined {
  const record = isRecord(data) ? data : {};
  return parseOptionalText(record.finalUrl) ?? parseOptionalText(toolInput.url);
}

function linksFromResult(data: unknown): Array<{ text?: string; href: string }> {
  return isRecord(data) ? extractLinks(data.links) : [];
}

function withPreparationWarning(
  data: unknown,
  warning: string,
): unknown {
  const record = isRecord(data) ? { ...data } : {};
  const existing = Array.isArray(record.preparationWarnings)
    ? record.preparationWarnings
    : [];
  return { ...record, preparationWarnings: [...existing, warning] };
}

function compactPreview(value: string | undefined, limit: number): string {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function firstHttpUrl(values: readonly unknown[] | undefined): string | undefined {
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const match = value.match(/https?:\/\/[^\s)]+/i);
    if (match) return match[0];
  }
  return undefined;
}

function sameHttpUrlWithoutHash(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.protocol === rightUrl.protocol &&
      leftUrl.hostname === rightUrl.hostname &&
      leftUrl.pathname.replace(/\/+$/g, "") ===
        rightUrl.pathname.replace(/\/+$/g, "") &&
      leftUrl.search === rightUrl.search
    );
  } catch {
    return false;
  }
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
