import assert from "node:assert/strict";
import test from "node:test";

import {
  externalActionApprovalProposalIds,
  shouldPauseForExternalActionApproval,
} from "../src/server/modules/runs/run-external-action-pause.js";
import { shouldListActionProposal } from "../src/server/modules/runs/action-proposals.service.js";
import type { AgentRunRecord } from "../src/runs/types.js";
import type { AgentRunResult, ExternalActionProposal } from "../src/types.js";

test("external action approval pause waits for approval-mode proposals even when inputs need review", () => {
  const incomplete = resultWithProposal({
    preparation: {
      stage: "prepared_for_approval",
      objective: "Prepare reservation.",
      missingInputs: ["date_or_time", "party_size", "contact"],
      collectedInputs: [],
      commitBoundary: "Do not submit before approval.",
      operatorChecklist: [],
      proofPlan: [],
    },
  });

  assert.equal(shouldPauseForExternalActionApproval(incomplete), true);
  assert.deepEqual(externalActionApprovalProposalIds(incomplete), ["proposal_ready"]);

  const ready = resultWithProposal({
    preparation: {
      stage: "ready_to_commit",
      objective: "Prepared reservation.",
      missingInputs: [],
      collectedInputs: [
        { label: "date_or_time", value: "2026-06-12 20:30", source: "user_request" },
        { label: "party_size", value: "4", source: "user_request" },
        { label: "contact", value: "dmitrii@example.com", source: "user_request" },
      ],
      commitBoundary: "Do not submit before approval.",
      operatorChecklist: [],
      proofPlan: [],
    },
  });

  assert.equal(shouldPauseForExternalActionApproval(ready), true);
  assert.deepEqual(externalActionApprovalProposalIds(ready), ["proposal_ready"]);
});

test("external action proposal queue shows incomplete drafts once the run is waiting", () => {
  const proposal = resultWithProposal({
    preparation: {
      stage: "prepared_for_approval",
      objective: "Prepare reservation.",
      missingInputs: ["date_or_time", "party_size", "contact"],
      collectedInputs: [],
      commitBoundary: "Do not submit before approval.",
      operatorChecklist: [],
      proofPlan: [],
    },
  }).actionProposals![0];

  assert.equal(
    shouldListActionProposal(runWithProposal("completed", proposal), proposal),
    false,
  );
  assert.equal(
    shouldListActionProposal(runWithProposal("waiting_approval", proposal), proposal),
    true,
  );
});

function runWithProposal(
  status: AgentRunRecord["status"],
  proposal: ExternalActionProposal,
): AgentRunRecord {
  return {
    id: "run_proposal_queue",
    task: "test",
    status,
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
    events: [],
    result: resultWithProposal(proposal),
  };
}

function resultWithProposal(
  partial: Partial<ExternalActionProposal>,
): AgentRunResult {
  return {
    finalAnswer: "Prepared action.",
    complexity: { mode: "direct", reason: "test", domains: [], riskLevel: "high" },
    subtasks: [],
    workerResults: [],
    reviews: [],
    artifacts: [],
    actionProposals: [
      {
        id: "proposal_ready",
        runId: "run_ready",
        actionType: "reservation",
        status: "proposed",
        title: "Reservation proposal",
        summary: "test",
        proposedAction: "Submit reservation.",
        executionMode: "approval",
        approvalRequired: true,
        userExplicitlyForbidsAction: false,
        allowedWithoutApproval: [],
        prohibitedWithoutApproval: ["submit reservation"],
        sourceUrls: [],
        artifactIds: [],
        createdAt: "2026-05-22T00:00:00.000Z",
        createdBy: "base-agent",
        ...partial,
      },
    ],
  };
}
