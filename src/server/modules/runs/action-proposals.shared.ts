import type { AgentRunRecord } from "../../../runs/types.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import type {
  ExternalActionBlocker,
  ExternalActionCommitExecutor,
  ExternalActionCommitStatus,
  ExternalActionPreparedSession,
  ExternalActionProposal,
  ExternalActionProposalStatus,
} from "../../../types.js";
import { isRecord } from "../../common/parsers.js";
import type { ExternalActionFinalReport } from "./action-proposal-final-report.js";
import type { ActionProposalProfileHydrationApproval } from "./action-proposal-hydration-approval.js";

export type ExternalActionExecutorBuildRequest = {
  toolName: string;
  toolVersion: string;
  description: string;
  request: string;
  capabilities: string[];
  risk: ExternalActionCommitExecutor["risk"];
  toolInput: Record<string, unknown>;
  expectedProof: string[];
  behaviorExamples: Array<Record<string, unknown>>;
};

export type ActionProposalQueueItem = {
  proposal: ExternalActionProposal;
  run: {
    id: string;
    task: string;
    status: AgentRunRecord["status"];
    createdAt: string;
    updatedAt: string;
    requesterUserId?: string;
    channel?: string;
    threadId?: string;
  };
  decision?: {
    status: Extract<ExternalActionProposalStatus, "approved" | "rejected">;
    reason?: string;
    decidedAt: string;
    decidedBy: string;
  };
  execution?: {
    status: Exclude<ExternalActionCommitStatus, "not_requested">;
    reason?: string;
    decidedAt: string;
    actor: string;
    toolName?: string;
    toolVersion?: string;
    contentPreview?: string;
    dataPreview?: unknown;
    blocker?: ExternalActionBlocker;
  };
  preparationExecution?: {
    status: "completed" | "failed";
    reason?: string;
    decidedAt: string;
    actor: string;
    toolName?: string;
    toolVersion?: string;
    contentPreview?: string;
    dataPreview?: unknown;
    artifactIds?: string[];
    preparedSession?: ExternalActionPreparedSession;
    blocker?: ExternalActionBlocker;
  };
  profileHydration?: ActionProposalProfileHydrationApproval;
  executorBuild?: {
    status: "needed" | "requested" | "registered" | "failed" | "attached";
    reason?: string;
    toolName: string;
    toolVersion: string;
    request: string;
    capabilities: string[];
    runId?: string;
    creationId?: string;
    packageRef?: string;
    commitExecutor?: ExternalActionCommitExecutor;
    updatedAt: string;
  };
  finalReport?: ExternalActionFinalReport;
};

export function latestActionProposalPreparationExecution(
  run: AgentRunRecord,
  proposalId: string,
): ActionProposalQueueItem["preparationExecution"] | undefined {
  for (const event of [...run.events].reverse()) {
    if (
      event.type !== "external-action-preparation-completed" &&
      event.type !== "external-action-preparation-failed"
    )
      continue;
    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : {};
    if (payload.proposalId !== proposalId) continue;
    return {
      status:
        event.type === "external-action-preparation-completed"
          ? "completed"
          : "failed",
      reason:
        typeof payload.reason === "string" ? payload.reason : event.detail,
      decidedAt: event.timestamp,
      actor: event.actor,
      toolName:
        typeof payload.toolName === "string" ? payload.toolName : undefined,
      toolVersion:
        typeof payload.toolVersion === "string"
          ? payload.toolVersion
          : undefined,
      contentPreview:
        typeof payload.contentPreview === "string"
          ? payload.contentPreview
          : undefined,
      dataPreview: payload.dataPreview,
      artifactIds: Array.isArray(payload.artifactIds)
        ? payload.artifactIds.filter((item): item is string => typeof item === "string")
        : undefined,
      preparedSession: isRecord(payload.preparedSession)
        ? (payload.preparedSession as ExternalActionPreparedSession)
        : undefined,
      blocker: parseExternalActionBlocker(payload.blocker),
    };
  }
  return undefined;
}

export function latestActionProposalDecision(
  run: AgentRunRecord,
  proposalId: string,
): ActionProposalQueueItem["decision"] | undefined {
  for (const event of [...run.events].reverse()) {
    if (
      event.type !== "external-action-proposal-approved" &&
      event.type !== "external-action-proposal-rejected"
    )
      continue;
    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : {};
    if (payload.proposalId !== proposalId) continue;
    return {
      status:
        event.type === "external-action-proposal-approved"
          ? "approved"
          : "rejected",
      reason:
        typeof payload.reason === "string" ? payload.reason : event.detail,
      decidedAt: event.timestamp,
      decidedBy: event.actor,
    };
  }
  return undefined;
}

export function latestActionProposalExecution(
  run: AgentRunRecord,
  proposalId: string,
): ActionProposalQueueItem["execution"] | undefined {
  for (const event of [...run.events].reverse()) {
    if (
      event.type !== "external-action-commit-blocked" &&
      event.type !== "external-action-commit-failed" &&
      event.type !== "external-action-committed"
    )
      continue;
    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : {};
    if (payload.proposalId !== proposalId) continue;
    return {
      status:
        event.type === "external-action-committed"
          ? "committed"
          : event.type === "external-action-commit-failed"
            ? "failed"
            : "blocked",
      reason:
        typeof payload.reason === "string" ? payload.reason : event.detail,
      decidedAt: event.timestamp,
      actor: event.actor,
      toolName:
        typeof payload.toolName === "string" ? payload.toolName : undefined,
      toolVersion:
        typeof payload.toolVersion === "string"
          ? payload.toolVersion
          : undefined,
      contentPreview:
        typeof payload.contentPreview === "string"
          ? payload.contentPreview
          : undefined,
      dataPreview: payload.dataPreview,
      blocker: parseExternalActionBlocker(payload.blocker),
    };
  }
  return undefined;
}

export function latestExternalActionFinalReport(
  run: AgentRunRecord,
  proposalId: string,
): ExternalActionFinalReport | undefined {
  for (const event of [...run.events].reverse()) {
    if (event.type !== "external-action-final-report-created") continue;
    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : {};
    if (payload.proposalId !== proposalId || !isRecord(payload.report)) {
      continue;
    }
    return {
      status: parseFinalReportStatus(payload.report.status),
      summary:
        typeof payload.report.summary === "string"
          ? payload.report.summary
          : event.detail ?? "External action final report.",
      target:
        typeof payload.report.target === "string"
          ? payload.report.target
          : undefined,
      targetUrl:
        typeof payload.report.targetUrl === "string"
          ? payload.report.targetUrl
          : undefined,
      action:
        typeof payload.report.action === "string"
          ? payload.report.action
          : "external action",
      blocker: parseExternalActionBlocker(payload.report.blocker),
      nextAction:
        typeof payload.report.nextAction === "string"
          ? payload.report.nextAction
          : undefined,
      proofArtifactIds: stringArray(payload.report.proofArtifactIds),
      diagnosticArtifactIds: stringArray(payload.report.diagnosticArtifactIds),
      createdAt:
        typeof payload.report.createdAt === "string"
          ? payload.report.createdAt
          : event.timestamp,
    };
  }
  return undefined;
}

export function latestAttachedExternalActionExecutor(
  run: AgentRunRecord,
  proposalId: string,
): ExternalActionCommitExecutor | undefined {
  for (const event of [...run.events].reverse()) {
    if (event.type !== "external-action-executor-attached") continue;
    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : {};
    if (payload.proposalId !== proposalId) continue;
    const executor = payload.commitExecutor;
    if (isRecord(executor)) return executor as ExternalActionCommitExecutor;
  }
  return undefined;
}

export function latestExternalActionExecutorBuild(
  run: AgentRunRecord,
  proposalId: string,
): ActionProposalQueueItem["executorBuild"] | undefined {
  for (const event of [...run.events].reverse()) {
    if (
      event.type !== "external-action-executor-build-requested" &&
      event.type !== "external-action-executor-build-completed" &&
      event.type !== "external-action-executor-build-failed" &&
      event.type !== "external-action-executor-attached"
    )
      continue;
    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : {};
    if (payload.proposalId !== proposalId) continue;
    const buildRequest = payload.buildRequest;
    if (!isRecord(buildRequest)) continue;
    return {
      status:
        event.type === "external-action-executor-build-completed"
          ? "registered"
          : event.type === "external-action-executor-build-failed"
            ? "failed"
            : event.type === "external-action-executor-attached"
              ? "attached"
              : "requested",
      reason:
        typeof payload.reason === "string" ? payload.reason : event.detail,
      toolName:
        typeof buildRequest.toolName === "string"
          ? buildRequest.toolName
          : "external.action.commit",
      toolVersion:
        typeof buildRequest.toolVersion === "string"
          ? buildRequest.toolVersion
          : "0.1.0",
      request:
        typeof buildRequest.request === "string" ? buildRequest.request : "",
      capabilities: Array.isArray(buildRequest.capabilities)
        ? buildRequest.capabilities.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
      runId: typeof payload.runId === "string" ? payload.runId : undefined,
      creationId:
        typeof payload.creationId === "string" ? payload.creationId : undefined,
      packageRef:
        typeof payload.packageRef === "string" ? payload.packageRef : undefined,
      commitExecutor: isRecord(payload.commitExecutor)
        ? (payload.commitExecutor as ExternalActionCommitExecutor)
        : undefined,
      updatedAt: event.timestamp,
    };
  }
  return undefined;
}

export function defaultExternalActionExecutorBuild(
  run: AgentRunRecord,
  proposal: ExternalActionProposal,
): ActionProposalQueueItem["executorBuild"] | undefined {
  const executor = proposal.commitExecutor;
  if (executor?.ready && executor.kind === "generated_tool") return undefined;
  const buildRequest = buildExternalActionExecutorBuildRequest(run, proposal);
  return {
    status: "needed",
    reason: executor?.reason ?? "No generated commit executor is attached.",
    toolName: buildRequest.toolName,
    toolVersion: buildRequest.toolVersion,
    request: buildRequest.request,
    capabilities: buildRequest.capabilities,
    updatedAt: proposal.createdAt,
  };
}

export function buildExternalActionExecutorBuildRequest(
  run: AgentRunRecord,
  proposal: ExternalActionProposal,
): ExternalActionExecutorBuildRequest {
  const preparedSession = latestActionProposalPreparationExecution(
    run,
    proposal.id,
  )?.preparedSession;
  const actionSlug = proposal.actionType.replace(/_/g, "-");
  const toolName = "external.action.commit";
  const toolInput = {
    preparedActionId: proposal.id,
    approved: true,
    provider: isFixtureExternalActionTarget(proposal.target) ? "fixture" : "generic",
    proposalId: proposal.id,
    runId: run.id,
    threadId: run.threadId,
    actionType: proposal.actionType,
    target: proposal.target,
    proposedAction: proposal.proposedAction,
    commitPayload: {
      target: proposal.target,
      proposedAction: proposal.proposedAction,
      payloadPreview: proposal.payloadPreview,
      collectedInputs: proposal.preparation?.collectedInputs ?? [],
    },
    payloadPreview: proposal.payloadPreview,
    preparation: proposal.preparation,
    commitBoundary: proposal.preparation?.commitBoundary,
    preparedSession,
    replaySteps: preparedSession?.replaySteps,
    approvedProfileFields: preparedSession?.approvedProfileFields,
    sourceUrls: proposal.sourceUrls,
    artifactIds: [
      ...new Set([
        ...proposal.artifactIds,
        ...(preparedSession?.artifactIds ?? []),
      ]),
    ],
    proofArtifactIds: preparedSession?.proofArtifactIds ?? [],
  };
  const expectedProof = [
    "provider confirmation id/status or durable provider response",
    "submitted payload summary with secrets redacted",
    "proof artifact after final submit when the provider has a visible confirmation page or response",
    "clear missing_requirements output when the action cannot be safely committed without more data",
    "audit event linking proposal id, tool name, and provider response",
  ];
  const request = [
    "Build a universal generated external action commit executor.",
    `This invocation is for action type "${proposal.actionType}", but the package must stay reusable across targets and providers.`,
    "This tool is allowed to mutate an external system only when invoked by the approved proposal commit endpoint.",
    "It must be portable outside Agentic, declare generic external-action-commit capabilities, accept the typed proposal payload, use secret handles for credentials, and return a provider confirmation payload.",
    "It must use proposal/preparedSession/replaySteps/commitCandidates/operatorInput as runtime input; never hardcode a specific restaurant, barbershop, website, URL, user, or task into the package.",
    "If the prepared context or operator input is insufficient, it must return missing_requirements with the exact missing fields/questions instead of pretending to commit.",
    "When it can safely commit, it should return proof: confirmation id/status, submitted payload summary with secrets redacted, and any screenshot/artifact saved through the runtime artifact callback.",
    `Target: ${proposal.target ?? "unspecified"}.`,
    `Proposed action: ${proposal.proposedAction}`,
    proposal.preparation?.commitBoundary
      ? `Commit boundary: ${proposal.preparation.commitBoundary}`
      : undefined,
    proposal.preparation?.missingInputs.length
      ? `Missing inputs before safe commit: ${proposal.preparation.missingInputs.join(", ")}`
      : undefined,
    proposal.sourceUrls.length
      ? `Source URLs: ${proposal.sourceUrls.join(", ")}`
      : undefined,
    preparedSession
      ? [
          "Prepared browser/API session is available and must be treated as replay context, not as approval to commit.",
          `Prepared URL: ${preparedSession.currentUrl ?? "unspecified"}.`,
          `Replay steps: ${preparedSession.replaySteps.length}.`,
          preparedSession.approvedProfileFields?.length
            ? `Approved profile fields are present as masked replay context: ${preparedSession.approvedProfileFields.map((item) => `${item.field}=${item.valuePreview}`).join(", ")}. The commit endpoint resolves actual values only after operator approval.`
            : undefined,
          preparedSession.commitCandidates.length
            ? `Commit candidates/boundary: ${preparedSession.commitCandidates.map((item) => item.label ?? item.selector ?? item.reason).join("; ")}`
            : undefined,
        ].filter(Boolean).join("\n")
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    toolName,
    toolVersion: "0.1.0",
    description: `Commits approved ${proposal.actionType.replace(/_/g, " ")} proposals and returns confirmation proof.`,
    request,
    risk: externalActionRiskForBuild(proposal.actionType),
    capabilities: [
      "external-action-commit",
      "external-action-commit-generic",
    ],
    toolInput,
    expectedProof,
    behaviorExamples: [
      {
        title: "Missing provider details fail safely",
        input: {
          proposalId: proposal.id,
          runId: run.id,
          threadId: run.threadId,
          actionType: proposal.actionType,
          target: proposal.target,
          proposedAction: proposal.proposedAction,
          sourceUrls: proposal.sourceUrls,
        },
        expectedOk: false,
        expectedContentIncludes: "missing_requirements",
      },
    ],
  };
}

function isFixtureExternalActionTarget(target: string | undefined): boolean {
  return /\/api\/fixtures\/external-actions\//i.test(target ?? "");
}

export function stableToolSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, ".")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "")
    .replace(/\.+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 48);
  return normalized || undefined;
}

export function externalActionRiskForBuild(
  actionType: ExternalActionProposal["actionType"],
): ExternalActionCommitExecutor["risk"] {
  switch (actionType) {
    case "outbound_message":
    case "api_write":
      return "medium";
    case "reservation":
    case "appointment":
    case "purchase":
    case "generic_external_action":
      return "high";
  }
}

export function normalizeExternalActionCommitExecutor(
  executor: ExternalActionCommitExecutor | undefined,
): ExternalActionCommitExecutor {
  if (executor) return executor;
  return {
    kind: "manual_operator",
    ready: false,
    risk: "high",
    reason:
      "This proposal was created before commit executor contracts were persisted.",
    missing: [
      "generated commit tool or always-on service capability",
      "typed commit payload schema",
      "provider confirmation parser",
    ],
    expectedProof: [
      "external provider confirmation or durable provider response",
      "audit event with exact submitted payload and provider identifier",
    ],
  };
}

export function externalActionCommitBlockReason(
  executor: ExternalActionCommitExecutor,
  registry: ToolRegistry | undefined,
): string | undefined {
  if (!executor.ready) {
    return executor.reason;
  }
  if (executor.kind !== "generated_tool") {
    return "Manual operator commit executors cannot mutate external systems from the platform.";
  }
  if (!executor.toolName) {
    return "The commit executor is marked ready but does not declare a generated tool name.";
  }
  if (!isRecord(executor.toolInput)) {
    return "The generated commit executor is ready but does not declare a typed toolInput payload.";
  }
  if (!registry) {
    return "Tool registry is not configured, so generated commit tools cannot execute.";
  }
  const tool = registry.get(executor.toolName);
  if (!tool) {
    return `Generated commit tool is not registered: ${executor.toolName}.`;
  }
  if (
    executor.toolVersion &&
    tool.version &&
    executor.toolVersion !== tool.version
  ) {
    return `Generated commit tool version mismatch: proposal expects ${executor.toolVersion}, registry has ${tool.version}.`;
  }
  if (
    !tool.capabilities.some(
      (capability) =>
        capability === "external-action-commit" ||
        capability.startsWith("external-action-commit-"),
    )
  ) {
    return `Generated commit tool ${tool.name} must declare external-action-commit capability before it can mutate external systems.`;
  }
  const payloadBlockReason = externalActionCommitPayloadBlockReason(executor);
  if (payloadBlockReason) return payloadBlockReason;
  return undefined;
}

function externalActionCommitPayloadBlockReason(
  executor: ExternalActionCommitExecutor,
): string | undefined {
  if (!isRecord(executor.toolInput)) return undefined;
  const preparedSession = isRecord(executor.toolInput.preparedSession)
    ? executor.toolInput.preparedSession
    : undefined;
  if (!preparedSession) {
    return "Generated commit executor is missing a prepared external-action session; prepare the action before commit.";
  }
  const actionDraft = isRecord(preparedSession.actionDraft)
    ? preparedSession.actionDraft
    : undefined;
  const requiredOperatorInputs = Array.isArray(preparedSession.requiredOperatorInputs)
    ? preparedSession.requiredOperatorInputs.filter(isRecord)
    : [];
  if (requiredOperatorInputs.length) {
    const labels = requiredOperatorInputs
      .map((item) => typeof item.label === "string" ? item.label.trim() : "")
      .filter(Boolean)
      .join(", ");
    return `Prepared action requires operator input before external submit${
      labels ? `: ${labels}` : ""
    }.`;
  }
  const draftStatus = actionDraft && typeof actionDraft.status === "string"
    ? actionDraft.status
    : undefined;
  if (draftStatus && draftStatus !== "ready_for_operator_review") {
    const missing = Array.isArray(actionDraft?.missingBeforeCommit)
      ? actionDraft.missingBeforeCommit
          .filter((item): item is string => typeof item === "string")
          .join(", ")
      : "";
    return `Prepared action draft is not ready for external submit${
      missing ? `: ${missing}` : ""
    }.`;
  }
  const currentUrl =
    typeof preparedSession.currentUrl === "string"
      ? preparedSession.currentUrl.trim()
      : "";
  if (!currentUrl) {
    return "Prepared session does not include a current URL or typed commit target.";
  }
  const proofArtifactIds = Array.isArray(preparedSession.proofArtifactIds)
    ? preparedSession.proofArtifactIds.filter((item) => typeof item === "string" && item.trim())
    : [];
  if (!proofArtifactIds.length) {
    return "Prepared session has no passed proof artifact; refresh preparation before external commit.";
  }
  const candidates = Array.isArray(preparedSession.commitCandidates)
    ? preparedSession.commitCandidates.filter(isRecord)
    : [];
  const hasActionableCandidate = candidates.some(
    (candidate) =>
      (typeof candidate.label === "string" && candidate.label.trim()) ||
      (typeof candidate.selector === "string" && candidate.selector.trim()),
  );
  if (!hasActionableCandidate) {
    return "Prepared session did not detect a concrete external submit control; refresh preparation or provide a typed commit target before external commit.";
  }
  return undefined;
}

export function externalActionCommitNotReady(result: {
  ok: boolean;
  content: string;
  data?: unknown;
}): { reason: string; missing: string[] } | undefined {
  const content = result.content.trim();
  const data = isRecord(result.data) ? result.data : {};
  const missing = Array.isArray(data.missing)
    ? data.missing.filter((item): item is string => typeof item === "string")
    : [];
  const reason =
    content ||
    (typeof data.reason === "string" ? data.reason : undefined) ||
    "External action commit is not ready.";
  const haystack = `${content}\n${JSON.stringify(data)}`.toLowerCase();
  if (
    haystack.includes("missing_requirements") ||
    haystack.includes("missing requirements") ||
    haystack.includes("provider_specific_commit_implementation") ||
    haystack.includes("not enough information") ||
    haystack.includes("insufficient")
  ) {
    return { reason, missing };
  }
  return undefined;
}

export function externalActionCommitNextRequirement(
  executor: ExternalActionCommitExecutor,
): string {
  if (!executor.ready) {
    return "Attach a generated commit tool or service executor with schema, QA evidence, credentials, and provider confirmation parsing.";
  }
  if (executor.kind === "generated_tool") {
    return "Wire the approved proposal commit endpoint to the generated tool runner and persist the provider confirmation output.";
  }
  return "Replace the manual operator executor with a generated tool/service executor before automated commit.";
}

export function shouldListActionProposal(
  run: AgentRunRecord,
  proposal: ExternalActionProposal,
): boolean {
  if (proposal.status !== "proposed") return true;
  if (!proposal.approvalRequired) return true;
  if (run.status === "waiting_approval") return true;
  return (proposal.preparation?.missingInputs ?? []).length === 0;
}

function parseExternalActionBlocker(value: unknown): ExternalActionBlocker | undefined {
  if (
    value === "login_required" ||
    value === "verification_required" ||
    value === "captcha" ||
    value === "payment_required" ||
    value === "missing_data" ||
    value === "slot_unavailable" ||
    value === "ambiguous_target" ||
    value === "unsupported_widget" ||
    value === "provider_error" ||
    value === "policy_blocked" ||
    value === "proof_failed"
  ) {
    return value;
  }
  return undefined;
}

function parseFinalReportStatus(
  value: unknown,
): ExternalActionFinalReport["status"] {
  if (
    value === "committed" ||
    value === "rejected" ||
    value === "blocked" ||
    value === "failed"
  ) {
    return value;
  }
  return "blocked";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(`External action commit timed out after ${timeoutMs}ms`),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function limitJsonForAudit(value: unknown): unknown {
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
