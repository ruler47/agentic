import { describe, expect, it } from "vitest";
import type { ActionProposalQueueItem } from "@/api/runs";
import { buildActionApprovalPhase } from "./actionApprovalPhase";

describe("buildActionApprovalPhase", () => {
  it("shows waiting approval only for proposed actions", () => {
    const phase = buildActionApprovalPhase([baseItem()], "waiting_approval");

    expect(phase.title).toContain("approved or rejected");
    expect(phase.badge).toBe("waiting approval");
  });

  it("shows profile/data approval after the proposal is already approved", () => {
    const item = {
      ...baseItem(),
      proposal: { ...baseItem().proposal, status: "approved" as const },
      preparationExecution: {
        status: "completed" as const,
        actor: "tool",
        decidedAt: "2026-05-22T00:00:00.000Z",
        preparedSession: {
          preparedAt: "2026-05-22T00:00:00.000Z",
          toolName: "external.action.prepare",
          toolVersion: "0.1.9",
          currentUrl: "https://provider.example/book",
          links: [],
          formFields: [{ label: "Email", required: true }],
          formFieldGaps: [
            {
              field: "contact_email",
              label: "Email",
              required: true,
              reason: "Email is required.",
              profileAvailable: true,
              profileSource: "user_profile",
              valuePreview: "co***@example.com",
            },
          ],
          availableProfileFields: [],
          filledFields: [],
          replaySteps: [],
          commitCandidates: [{ label: "Submit", reason: "Final submit control." }],
          artifactIds: ["artifact-1"],
          warnings: [],
        },
      },
    } satisfies ActionProposalQueueItem;

    const phase = buildActionApprovalPhase([item], "waiting_approval");

    expect(phase.title).toContain("needs data approval");
    expect(phase.badge).toBe("needs data approval");
  });

  it("shows ready-to-submit when commit readiness is satisfied", () => {
    const item = {
      ...baseItem(),
      proposal: {
        ...baseItem().proposal,
        status: "approved" as const,
        commitExecutor: {
          kind: "generated_tool" as const,
          toolName: "external.action.commit",
          toolVersion: "0.1.0",
          ready: true,
          risk: "high" as const,
          reason: "Executor ready.",
        },
      },
      preparationExecution: {
        status: "completed" as const,
        actor: "tool",
        decidedAt: "2026-05-22T00:00:00.000Z",
        preparedSession: {
          preparedAt: "2026-05-22T00:00:00.000Z",
          toolName: "external.action.prepare",
          toolVersion: "0.1.9",
          currentUrl: "https://provider.example/book",
          links: [],
          formFields: [],
          formFieldGaps: [],
          availableProfileFields: [],
          filledFields: [{ label: "Name", valuePreview: "Dmitrii" }],
          replaySteps: [],
          commitCandidates: [{ label: "Submit", reason: "Final submit control." }],
          artifactIds: ["artifact-1"],
          warnings: [],
          actionDraft: {
            status: "ready_for_operator_review",
            target: "Provider",
            action: "Submit booking",
            pageUrl: "https://provider.example/book",
            dataPreview: [{ label: "Name", value: "Dmitrii", source: "prepared_form" }],
            missingBeforeCommit: [],
            proofArtifactIds: ["artifact-1"],
            commitControls: [{ label: "Submit", reason: "Final submit control." }],
            operatorNextStep: "Ready for final submit.",
            postCommitReportRequirements: [],
          },
        },
      },
    } satisfies ActionProposalQueueItem;

    const phase = buildActionApprovalPhase([item], "waiting_approval");

    expect(phase.title).toContain("ready for final submit");
    expect(phase.badge).toBe("ready to submit");
    expect(phase.tone).toBe("ok");
  });
});

function baseItem(): ActionProposalQueueItem {
  return {
    proposal: {
      id: "proposal-1",
      runId: "run-1",
      actionType: "appointment",
      status: "proposed",
      title: "Book appointment",
      summary: "Appointment draft",
      proposedAction: "Schedule an appointment",
      approvalRequired: true,
      userExplicitlyForbidsAction: false,
      allowedWithoutApproval: [],
      prohibitedWithoutApproval: ["submit appointment"],
      sourceUrls: [],
      artifactIds: [],
      createdAt: "2026-05-22T00:00:00.000Z",
      createdBy: "base-agent",
    },
    run: {
      id: "run-1",
      task: "book appointment",
      status: "waiting_approval",
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:00.000Z",
    },
  };
}
