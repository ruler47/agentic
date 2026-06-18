import type { AuditService } from "../../common/services/audit.service.js";
import { isRecord, sanitizeAuditMetadata } from "../../common/parsers.js";
import type { RunStore } from "../../../runs/types.js";
import type {
  AgentEvent,
  AgentRunResult,
  ExternalActionProposal,
  ExternalActionType,
} from "../../../types.js";

export async function createFixtureActionProposal(input: {
  runs: RunStore;
  audit: AuditService;
  fixtureBaseUrl: string;
  rawBody: unknown;
}): Promise<{ runId: string; proposal: ExternalActionProposal }> {
  const now = new Date().toISOString();
  const actionType = parseActionType(input.rawBody);
  const fixtureBaseUrl =
    textField(input.rawBody, "fixtureBaseUrl") ?? input.fixtureBaseUrl;
  const fixtureUrl = `${fixtureBaseUrl.replace(/\/+$/u, "")}/api/fixtures/external-actions/${actionType}`;
  const title = textField(input.rawBody, "title") ?? "Fixture reservation proposal";
  const target =
    textField(input.rawBody, "target") ??
    fixtureUrl;
  const proposedAction =
    textField(input.rawBody, "proposedAction") ??
    "Commit this fixture-only external action after operator approval.";
  const executionMode = parseExecutionMode(input.rawBody);
  const collectedInputs = [
    { label: "Name", value: "Dmitrii Test", source: "user_request" as const },
    { label: "Party size", value: "4", source: "user_request" as const },
    { label: "Date", value: "2026-06-12", source: "user_request" as const },
    { label: "Time", value: "20:30", source: "user_request" as const },
    {
      label: "Notes",
      value: "Fixture only. Stop before final confirmation.",
      source: "user_request" as const,
    },
  ];
  const run = await input.runs.create(
    textField(input.rawBody, "task") ??
      `[Fixture] External action approval and commit exam: ${actionType}`,
    {
      instanceId: "instance-local",
      requesterUserId: "user-admin",
      channel: "fixture",
    },
  );
  await input.runs.markRunning(run.id);
  const proposal: ExternalActionProposal = {
    id: `proposal_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    runId: run.id,
    actionType,
    status: "proposed",
    title,
    summary: `Fixture ${actionType.replace(/_/g, " ")} proposal for safe lifecycle testing.`,
    proposedAction,
    executionMode,
    target,
    payloadPreview: "fixture payload only; no external provider mutation",
    preparation: {
      stage: "prepared_for_approval",
      objective:
        "Open the provider page, fill the safe draft fields, capture proof, and stop before the final confirmation.",
      target,
      collectedInputs,
      missingInputs: [],
      commitBoundary:
        "Do not click Confirm reservation, Submit, Pay, Send, or any equivalent final mutation control during preparation.",
      operatorChecklist: [
        "Prepare in browser",
        "Review filled draft fields and screenshot",
        "Approve proposal",
        "Build executor",
        "Enter fixture confirmation",
        "Commit",
      ],
      proofPlan: [
        "Preparation screenshot",
        "filled draft field summary",
        "fixture confirmation id and submitted payload summary after commit",
      ],
    },
    approvalRequired: executionMode === "approval",
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: ["prepare fixture proposal", "build commit executor"],
    prohibitedWithoutApproval:
      executionMode === "approval" ? ["commit fixture confirmation"] : [],
    sourceUrls: [fixtureUrl],
    artifactIds: [],
    commitExecutor: {
      kind: "manual_operator",
      ready: false,
      risk: "high",
      reason: "No generated fixture commit executor is attached yet.",
      missing: ["generated external-action commit tool"],
      expectedProof: ["fixture confirmation id", "submitted payload summary"],
    },
    createdAt: now,
    createdBy: "base-agent",
  };
  const result = fixtureRunResult(proposal);
  if (proposal.executionMode === "approval") {
    await input.runs.waitForApproval(
      run.id,
      result,
      "External action proposal is waiting for operator approval.",
    );
  } else {
    await input.runs.complete(run.id, result);
  }
  await input.runs.appendEvent(run.id, proposalCreatedEvent(proposal, now));
  await input.audit.record({
    instanceId: "instance-local",
    actorId: "user-admin",
    actorType: "user",
    action: "external_action.proposed",
    targetType: "external_action",
    targetId: proposal.id,
    status: "success",
    runId: run.id,
    requesterUserId: "user-admin",
    channel: "fixture",
    summary: `Fixture action proposal created: ${proposal.title}`,
    metadata: sanitizeAuditMetadata({ proposal }),
  });
  return { runId: run.id, proposal };
}

function parseExecutionMode(rawBody: unknown): "auto" | "approval" {
  const value = textField(rawBody, "executionMode") ?? textField(rawBody, "mode");
  return value === "auto" ? "auto" : "approval";
}

function fixtureRunResult(proposal: ExternalActionProposal): AgentRunResult {
  return {
    finalAnswer: `Created fixture external action proposal: ${proposal.title}`,
    complexity: {
      mode: "direct",
      reason: "fixture external-action lifecycle exam",
      domains: ["external-action"],
      riskLevel: "high",
    },
    subtasks: [],
    workerResults: [],
    reviews: [],
    artifacts: [],
    actionProposals: [proposal],
  };
}

function proposalCreatedEvent(
  proposal: ExternalActionProposal,
  timestamp: string,
): AgentEvent {
  return {
    id: `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    spanId: `action-${proposal.id}-created`,
    type: "external-action-proposal-created",
    actor: "base-agent",
    activity: "agent",
    status: "completed",
    title: "External action proposal created",
    detail: `${proposal.actionType}: ${proposal.title}`,
    timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    payload: {
      input: { fixture: true, actionType: proposal.actionType },
      output: proposal,
      proposal,
      proposalId: proposal.id,
    },
  };
}

function parseActionType(rawBody: unknown): ExternalActionType {
  const value = textField(rawBody, "actionType");
  if (
    value === "reservation" ||
    value === "appointment" ||
    value === "purchase" ||
    value === "outbound_message" ||
    value === "api_write" ||
    value === "generic_external_action"
  ) {
    return value;
  }
  return "reservation";
}

function textField(rawBody: unknown, key: string): string | undefined {
  if (!isRecord(rawBody)) return undefined;
  const value = rawBody[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
