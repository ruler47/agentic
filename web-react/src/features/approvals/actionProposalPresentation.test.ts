import { describe, expect, it } from "vitest";
import type { ActionProposalQueueItem } from "@/api/runs";
import { profileHydrationApprovalCandidates } from "./actionProposalPresentation";

describe("profileHydrationApprovalCandidates", () => {
  it("groups duplicate visible fields while preserving all approved field ids", () => {
    const candidates = profileHydrationApprovalCandidates({
      proposal: {
        id: "proposal-1",
        runId: "run-1",
        actionType: "appointment",
        status: "approved",
        title: "Book appointment",
        summary: "Book appointment",
        proposedAction: "Book appointment",
        approvalRequired: true,
        userExplicitlyForbidsAction: false,
        allowedWithoutApproval: [],
        prohibitedWithoutApproval: ["submit appointment"],
        sourceUrls: [],
        artifactIds: [],
        createdAt: "2026-05-25T00:00:00.000Z",
        createdBy: "base-agent",
      },
      run: {
        id: "run-1",
        task: "book",
        status: "waiting_approval",
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
      },
      preparationExecution: {
        status: "completed",
        actor: "tool",
        decidedAt: "2026-05-25T00:00:00.000Z",
        preparedSession: {
          preparedAt: "2026-05-25T00:00:00.000Z",
          toolName: "browser.operate",
          links: [],
          formFieldGaps: [
            {
              field: "name",
              label: "Name *",
              reason: "Required",
              profileAvailable: true,
              profileSource: "user_profile",
              valuePreview: "Local Admin",
            },
            {
              field: "customer_name",
              label: "Name *",
              reason: "Required",
              profileAvailable: true,
              profileSource: "user_profile",
              valuePreview: "Local Admin",
            },
          ],
          filledFields: [],
          replaySteps: [],
          commitCandidates: [],
          artifactIds: [],
          warnings: [],
        },
      },
    } satisfies ActionProposalQueueItem);

    expect(candidates).toEqual([
      {
        fields: ["name", "customer_name"],
        label: "Name",
        source: "user_profile",
        valuePreview: "Local Admin",
      },
    ]);
  });
});
