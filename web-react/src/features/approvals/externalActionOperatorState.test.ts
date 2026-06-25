import { describe, expect, it } from "vitest";
import type { ActionProposalQueueItem } from "@/api/runs";
import type { ExternalActionPreparedSession } from "@/api/types";
import {
  buildApprovalSteps,
  externalWorldLabel,
} from "./externalActionOperatorState";

describe("external action operator state", () => {
  it("shows proposed actions as plan review with no external submit", () => {
    const item = baseItem();

    expect(buildApprovalSteps(item).map((step) => step.state)).toEqual([
      "active",
      "pending",
      "pending",
      "pending",
    ]);
    expect(externalWorldLabel(item)).toBe("not submitted");
  });

  it("shows a prepared approved action as ready for final submit", () => {
    const item: ActionProposalQueueItem = {
      ...baseItem(),
      proposal: {
        ...baseItem().proposal,
        status: "approved",
        commitExecutor: {
          kind: "generated_tool",
          toolName: "external.action.commit",
          toolVersion: "1.0.0",
          ready: true,
          risk: "high",
          reason: "Ready.",
        },
      },
      preparationExecution: {
        status: "completed",
        actor: "tool",
        decidedAt: "2026-06-25T00:00:00.000Z",
        preparedSession: preparedSession(),
      },
    };

    expect(buildApprovalSteps(item).map((step) => step.state)).toEqual([
      "done",
      "done",
      "done",
      "active",
    ]);
    expect(externalWorldLabel(item)).toBe("not submitted · ready");
  });

  it("keeps external-world state explicit when preparation is blocked", () => {
    const item: ActionProposalQueueItem = {
      ...baseItem(),
      proposal: { ...baseItem().proposal, status: "approved" },
      preparationExecution: {
        status: "completed",
        actor: "tool",
        decidedAt: "2026-06-25T00:00:00.000Z",
        preparedSession: {
          ...preparedSession(),
          actionDraft: {
            ...preparedSession().actionDraft!,
            status: "needs_more_input",
            missingBeforeCommit: ["concrete submit/control candidate"],
            commitControls: [],
          },
        },
      },
    };

    expect(buildApprovalSteps(item).at(-1)?.state).toBe("blocked");
    expect(externalWorldLabel(item)).toBe("not submitted · blocked");
  });

  it("shows rejected actions as not submitted", () => {
    const item: ActionProposalQueueItem = {
      ...baseItem(),
      proposal: { ...baseItem().proposal, status: "rejected" },
    };

    expect(buildApprovalSteps(item).map((step) => step.state)).toEqual([
      "blocked",
      "pending",
      "pending",
      "pending",
    ]);
    expect(externalWorldLabel(item)).toBe("not submitted");
  });
});

function baseItem(): ActionProposalQueueItem {
  return {
    proposal: {
      id: "proposal-1",
      runId: "run-1",
      actionType: "appointment",
      status: "proposed",
      title: "Appointment proposal",
      summary: "Prepare appointment",
      proposedAction: "Schedule an appointment",
      approvalRequired: true,
      userExplicitlyForbidsAction: false,
      allowedWithoutApproval: [],
      prohibitedWithoutApproval: ["submit appointment"],
      sourceUrls: [],
      artifactIds: [],
      createdAt: "2026-06-25T00:00:00.000Z",
      createdBy: "base-agent",
      preparation: {
        stage: "prepared_for_approval",
        objective: "Schedule an appointment",
        targetUrl: "https://provider.example/book",
        collectedInputs: [{ label: "date_or_time", value: "Friday 17:30", source: "user_request" }],
        missingInputs: [],
        proofPlan: ["filled form screenshot"],
        operatorChecklist: [],
        commitBoundary: "do not click submit before approval",
      },
    },
    run: {
      id: "run-1",
      task: "book appointment",
      status: "waiting_approval",
      createdAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:00.000Z",
    },
  };
}

function preparedSession(): ExternalActionPreparedSession {
  return {
    preparedAt: "2026-06-25T00:00:00.000Z",
    toolName: "browser.operate",
    currentUrl: "https://provider.example/book",
    links: [],
    formFields: [],
    formFieldGaps: [],
    availableProfileFields: [],
    filledFields: [{ label: "Email", valuePreview: "di***@example.com" }],
    replaySteps: [],
    commitCandidates: [{ label: "Submit", reason: "Final submit control." }],
    artifactIds: ["artifact-1"],
    proofArtifactIds: ["artifact-1"],
    warnings: [],
    actionDraft: {
      status: "ready_for_operator_review",
      action: "Schedule an appointment",
      pageUrl: "https://provider.example/book",
      dataPreview: [{ label: "Email", value: "di***@example.com", source: "prepared_form" }],
      missingBeforeCommit: [],
      proofArtifactIds: ["artifact-1"],
      commitControls: [{ label: "Submit", reason: "Final submit control." }],
      operatorNextStep: "Review and submit.",
      postCommitReportRequirements: [],
    },
  };
}
