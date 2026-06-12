import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import {
  buildCommitHydratedInput,
  hydrateExternalActionCommitExecutor,
  redactExternalActionCommitInput,
} from "../src/server/modules/runs/action-proposal-commit-input.js";
import type {
  AgentEvent,
  ExternalActionPreparedSession,
  ExternalActionProposal,
} from "../src/types.js";

test("commit hydrated inputs require replay after profile approval and redact raw values", async () => {
  const runs = new InMemoryRunStore();
  const run = await runs.create("commit hydration", {
    instanceId: "instance-local",
    requesterUserId: "user-admin",
  });
  const proposal: ExternalActionProposal = {
    id: `proposal_${run.id}`,
    runId: run.id,
    actionType: "reservation",
    status: "approved",
    title: "Reservation",
    summary: "Prepare reservation",
    proposedAction: "Commit reservation after approval.",
    target: "Fixture",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: ["prepare"],
    prohibitedWithoutApproval: ["commit"],
    sourceUrls: ["https://example.test/reserve"],
    artifactIds: [],
    preparation: {
      stage: "prepared_for_approval",
      objective: "Prepare.",
      collectedInputs: [],
      missingInputs: [],
      commitBoundary: "Do not submit.",
      operatorChecklist: [],
      proofPlan: [],
    },
    commitExecutor: {
      kind: "generated_tool",
      ready: true,
      risk: "high",
      reason: "Ready.",
      toolName: "external.action.reservation.fixture.commit",
      toolVersion: "0.1.0",
      toolInput: { fixture: true },
    },
    createdAt: "2026-05-22T10:00:00.000Z",
    createdBy: "base-agent",
  };
  await runs.complete(run.id, {
    finalAnswer: "proposal",
    complexity: { mode: "direct", reason: "test", domains: [], riskLevel: "high" },
    subtasks: [],
    workerResults: [],
    reviews: [],
    actionProposals: [proposal],
  });
  await runs.appendEvent(run.id, hydrationEvent(proposal.id));
  await runs.appendEvent(run.id, preparationEvent(proposal.id, preparedSession(false)));
  const approvedButNotReplayed = await runs.get(run.id);
  assert.ok(approvedButNotReplayed);

  assert.deepEqual(
    buildCommitHydratedInput({
      run: approvedButNotReplayed,
      proposal,
      profileValues: [{
        field: "contact_email",
        source: "group_profile",
        value: "manual-hydration@example.com",
        valuePreview: "ma***@example.com",
      }],
    }),
    {
      status: "blocked",
      reason: "Approved profile fields must be replay-prepared before commit: contact_email.",
      fields: [],
    },
  );

  await runs.appendEvent(run.id, preparationEvent(proposal.id, preparedSession(true)));
  const replayed = await runs.get(run.id);
  assert.ok(replayed);
  const hydrated = hydrateExternalActionCommitExecutor({
    run: replayed,
    proposal,
    executor: proposal.commitExecutor!,
    rawBody: {},
    profileValues: [{
      field: "contact_email",
      source: "group_profile",
      value: "manual-hydration@example.com",
      valuePreview: "ma***@example.com",
    }],
  });

  assert.equal(hydrated.blockReason, undefined);
  const toolInput = hydrated.executor.toolInput as {
    hydratedInputs?: { fields: Array<{ value: string; valuePreview: string }> };
  };
  assert.equal(toolInput.hydratedInputs?.fields[0]?.value, "manual-hydration@example.com");
  assert.equal(
    JSON.stringify(redactExternalActionCommitInput(hydrated.executor)).includes(
      "manual-hydration@example.com",
    ),
    false,
  );
  assert.equal(
    JSON.stringify(redactExternalActionCommitInput(hydrated.executor)).includes(
      "ma***@example.com",
    ),
    true,
  );
});

test("commit hydration blocks unresolved required prepared form gaps", async () => {
  const runs = new InMemoryRunStore();
  const run = await runs.create("commit gaps", {
    instanceId: "instance-local",
    requesterUserId: "user-admin",
  });
  const proposal = baseProposal(run.id);
  await runs.complete(run.id, {
    finalAnswer: "proposal",
    complexity: { mode: "direct", reason: "test", domains: [], riskLevel: "high" },
    subtasks: [],
    workerResults: [],
    reviews: [],
    actionProposals: [proposal],
  });
  await runs.appendEvent(run.id, preparationEvent(proposal.id, preparedSession(false)));
  const prepared = await runs.get(run.id);
  assert.ok(prepared);

  const blocked = hydrateExternalActionCommitExecutor({
    run: prepared,
    proposal,
    executor: proposal.commitExecutor!,
    rawBody: { input: { fixtureConfirmation: "ok" } },
    profileValues: [],
  });
  assert.equal(
    blocked.blockReason,
    "Required form fields must be resolved before commit: Email.",
  );

  const suppliedByOperator = hydrateExternalActionCommitExecutor({
    run: prepared,
    proposal,
    executor: proposal.commitExecutor!,
    rawBody: { input: { contact_email: "operator@example.com" } },
    profileValues: [],
  });
  assert.equal(suppliedByOperator.blockReason, undefined);
});

function baseProposal(runId: string): ExternalActionProposal {
  return {
    id: `proposal_${runId}`,
    runId,
    actionType: "reservation",
    status: "approved",
    title: "Reservation",
    summary: "Prepare reservation",
    proposedAction: "Commit reservation after approval.",
    target: "Fixture",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: ["prepare"],
    prohibitedWithoutApproval: ["commit"],
    sourceUrls: ["https://example.test/reserve"],
    artifactIds: [],
    preparation: {
      stage: "prepared_for_approval",
      objective: "Prepare.",
      collectedInputs: [],
      missingInputs: [],
      commitBoundary: "Do not submit.",
      operatorChecklist: [],
      proofPlan: [],
    },
    commitExecutor: {
      kind: "generated_tool",
      ready: true,
      risk: "high",
      reason: "Ready.",
      toolName: "external.action.commit",
      toolVersion: "0.1.0",
      toolInput: { fixture: true },
    },
    createdAt: "2026-05-22T10:00:00.000Z",
    createdBy: "base-agent",
  };
}

function hydrationEvent(proposalId: string): AgentEvent {
  return {
    id: "hydration",
    spanId: "hydration",
    type: "external-action-profile-hydration-approved",
    actor: "user-admin",
    activity: "coordination",
    status: "completed",
    title: "Hydration approved",
    timestamp: "2026-05-22T10:01:00.000Z",
    payload: {
      proposalId,
      fields: [{
        field: "contact_email",
        label: "Email",
        source: "group_profile",
        valuePreview: "ma***@example.com",
      }],
    },
  };
}

function preparationEvent(
  proposalId: string,
  session: ExternalActionPreparedSession,
): AgentEvent {
  return {
    id: `prep-${session.preparedAt}`,
    spanId: `prep-${session.preparedAt}`,
    type: "external-action-preparation-completed",
    actor: "browser.operate",
    activity: "tool",
    status: "completed",
    title: "Prepared",
    timestamp: session.preparedAt,
    payload: { proposalId, preparedSession: session },
  };
}

function preparedSession(approved: boolean): ExternalActionPreparedSession {
  return {
    preparedAt: approved
      ? "2026-05-22T10:03:00.000Z"
      : "2026-05-22T10:02:00.000Z",
    toolName: "browser.operate",
    currentUrl: "https://example.test/reserve",
    links: [],
    formFields: [{ label: "Email", name: "email", type: "email", required: true }],
    formFieldGaps: approved ? [] : [{
      field: "contact_email",
      label: "Email",
      name: "email",
      type: "email",
      required: true,
      reason: "Required.",
      profileAvailable: true,
      profileSource: "group_profile",
      valuePreview: "ma***@example.com",
    }],
    approvedProfileFields: approved ? [{
      field: "contact_email",
      source: "group_profile",
      valuePreview: "ma***@example.com",
      approvedAt: "2026-05-22T10:01:00.000Z",
      approvedBy: "user-admin",
    }] : undefined,
    filledFields: approved ? [{
      label: "Email",
      selector: '[name="email"]',
      valuePreview: "ma***@example.com",
    }] : [],
    replaySteps: [],
    commitCandidates: [],
    artifactIds: [],
    warnings: [],
  };
}
