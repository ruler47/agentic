import { strict as assert } from "node:assert";
import test from "node:test";

import type { AgentRunRecord, RunStore } from "../src/runs/types.js";
import type { AgentEvent, ExternalActionProposal } from "../src/types.js";
import { advanceApprovedActionProposal } from "../src/server/modules/runs/action-proposal-auto-advance-events.js";
import type { ActionProposalQueueItem } from "../src/server/modules/runs/action-proposals.shared.js";

test("approval auto-advance stops cleanly when proposal is cancelled during preparation", async () => {
  const events: AgentEvent[] = [];
  let buildCalled = false;
  const run = baseRun();
  const approved = baseProposal({ status: "approved" });
  const rejected = baseProposal({ status: "rejected" });

  const result = await advanceApprovedActionProposal({
    proposalId: approved.id,
    runs: {
      appendEvent: async (_id, event) => {
        events.push(event);
      },
    } as unknown as RunStore,
    findActionProposal: async () => ({ run, proposal: approved }),
    findProposalParentSpan: () => undefined,
    actionProposalQueueItem: (targetRun, proposal) => queueItem(targetRun, proposal),
    prepareActionProposal: async () => ({
      ...queueItem(run, rejected),
      preparationExecution: { status: "completed", decidedAt: new Date().toISOString(), actor: "browser.operate" },
    }),
    buildActionProposalExecutor: async () => {
      buildCalled = true;
      return queueItem(run, rejected);
    },
    updatedActionProposalQueueItem: async (_runId, proposal) => queueItem(run, proposal),
  });

  assert.equal(result.proposal.status, "rejected");
  assert.equal(buildCalled, false);
  assert.equal(
    events.some((event) => event.type === "external-action-approval-auto-advance-failed"),
    false,
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "external-action-approval-auto-advance-completed" &&
        /status changed to rejected/i.test(event.detail),
    ),
  );
});

function queueItem(
  run: AgentRunRecord,
  proposal: ExternalActionProposal,
): ActionProposalQueueItem {
  return {
    proposal,
    run: {
      id: run.id,
      task: run.task,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
  };
}

function baseRun(): AgentRunRecord {
  const now = new Date().toISOString();
  return {
    id: "run_auto_advance",
    task: "fixture",
    status: "waiting_approval",
    createdAt: now,
    updatedAt: now,
    events: [],
  };
}

function baseProposal(input: {
  status: ExternalActionProposal["status"];
}): ExternalActionProposal {
  const now = new Date().toISOString();
  return {
    id: "proposal_auto_advance",
    runId: "run_auto_advance",
    actionType: "reservation",
    status: input.status,
    title: "Fixture proposal",
    summary: "Fixture proposal",
    proposedAction: "Commit fixture action.",
    executionMode: "approval",
    target: "fixture://reservation",
    payloadPreview: "fixture",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: [],
    prohibitedWithoutApproval: ["commit fixture"],
    sourceUrls: [],
    artifactIds: [],
    commitExecutor: {
      kind: "manual_operator",
      ready: false,
      risk: "high",
      reason: "No executor.",
      missing: ["executor"],
      expectedProof: ["confirmation"],
    },
    createdAt: now,
    createdBy: "base-agent",
  };
}
