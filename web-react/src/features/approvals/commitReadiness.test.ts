import { describe, expect, it } from "vitest";
import type { ActionProposalQueueItem } from "@/api/runs";
import type { ExternalActionPreparedSession } from "@/api/types";
import { buildCommitReadiness } from "./commitReadiness";

const baseItem: ActionProposalQueueItem = {
  proposal: {
    id: "proposal-1",
    runId: "run-1",
    actionType: "reservation",
    status: "proposed",
    title: "Reserve table",
    summary: "Reservation draft",
    proposedAction: "Book a table",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: [],
    prohibitedWithoutApproval: ["submit reservation"],
    sourceUrls: [],
    artifactIds: [],
    createdAt: "2026-05-22T00:00:00.000Z",
    createdBy: "base-agent",
  },
  run: {
    id: "run-1",
    task: "reserve",
    status: "completed",
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
  },
};

describe("buildCommitReadiness", () => {
  it("requires operator approval before commit work", () => {
    const readiness = buildCommitReadiness(baseItem);

    expect(readiness.status).toBe("needs_approval");
    expect(readiness.canPrepare).toBe(true);
    expect(readiness.canCommit).toBe(false);
  });

  it("requires replay after approved profile hydration", () => {
    const readiness = buildCommitReadiness({
      ...baseItem,
      proposal: { ...baseItem.proposal, status: "approved" },
      decision: {
        status: "approved",
        decidedAt: "2026-05-22T00:00:00.000Z",
        decidedBy: "user-admin",
      },
      preparationExecution: {
        status: "completed",
        actor: "tool",
        decidedAt: "2026-05-22T00:00:00.000Z",
        preparedSession: preparedSession(),
      },
      profileHydration: {
        status: "approved",
        approvedAt: "2026-05-22T00:00:00.000Z",
        approvedBy: "user-admin",
        fields: [
          {
            field: "contact_email",
            source: "user_profile",
            valuePreview: "co***@example.com",
          },
        ],
      },
    });

    expect(readiness.status).toBe("needs_replay");
    expect(readiness.canReplay).toBe(true);
    expect(readiness.canCommit).toBe(false);
    expect(readiness.missingReplayFields).toEqual(["contact_email"]);
  });

  it("requires explicit profile approval before profile values can fill gaps", () => {
    const readiness = buildCommitReadiness({
      ...baseItem,
      proposal: { ...baseItem.proposal, status: "approved" },
      decision: {
        status: "approved",
        decidedAt: "2026-05-22T00:00:00.000Z",
        decidedBy: "user-admin",
      },
      preparationExecution: {
        status: "completed",
        actor: "tool",
        decidedAt: "2026-05-22T00:00:00.000Z",
        preparedSession: preparedSession(),
      },
    });

    expect(readiness.status).toBe("needs_profile_approval");
    expect(readiness.canApproveProfile).toBe(true);
    expect(readiness.canCommit).toBe(false);
  });

  it("allows commit after approval, replay, and executor attachment", () => {
    const readiness = buildCommitReadiness({
      ...baseItem,
      proposal: {
        ...baseItem.proposal,
        status: "approved",
        commitExecutor: {
          kind: "generated_tool",
          toolName: "external.action.reservation.fixture",
          toolVersion: "0.1.0",
          risk: "medium",
          ready: true,
          reason: "Fixture executor ready.",
        },
      },
      decision: {
        status: "approved",
        decidedAt: "2026-05-22T00:00:00.000Z",
        decidedBy: "user-admin",
      },
      preparationExecution: {
        status: "completed",
        actor: "tool",
        decidedAt: "2026-05-22T00:00:00.000Z",
        preparedSession: {
          ...preparedSession(),
          formFieldGaps: [],
          artifactIds: ["artifact-1"],
          approvedProfileFields: [
            {
              field: "contact_email",
              source: "user_profile",
              valuePreview: "co***@example.com",
              approvedAt: "2026-05-22T00:00:00.000Z",
              approvedBy: "user-admin",
            },
          ],
        },
      },
      profileHydration: {
        status: "approved",
        approvedAt: "2026-05-22T00:00:00.000Z",
        approvedBy: "user-admin",
        fields: [
          {
            field: "contact_email",
            source: "user_profile",
            valuePreview: "co***@example.com",
          },
        ],
      },
    });

    expect(readiness.status).toBe("ready_to_commit");
    expect(readiness.canCommit).toBe(true);
    expect(readiness.executorLabel).toBe("external.action.reservation.fixture@0.1.0");
  });

  it("blocks final submit when preparation only captured boundary text, not an actionable commit control", () => {
    const readiness = buildCommitReadiness({
      ...baseItem,
      proposal: {
        ...baseItem.proposal,
        status: "approved",
        commitExecutor: {
          kind: "generated_tool",
          toolName: "external.action.commit",
          toolVersion: "0.1.2",
          risk: "high",
          ready: true,
          reason: "Generic executor ready.",
        },
      },
      decision: {
        status: "approved",
        decidedAt: "2026-05-22T00:00:00.000Z",
        decidedBy: "user-admin",
      },
      preparationExecution: {
        status: "completed",
        actor: "tool",
        decidedAt: "2026-05-22T00:00:00.000Z",
        preparedSession: {
          ...preparedSession(),
          formFieldGaps: [],
          artifactIds: ["artifact-1"],
          commitCandidates: [{ reason: "submit reservation" }],
        },
      },
    });

    expect(readiness.status).toBe("blocked");
    expect(readiness.canCommit).toBe(false);
    expect(readiness.reason).toContain("No concrete external submit control");
  });

  it("blocks final submit until preparation captures proof artifacts", () => {
    const readiness = buildCommitReadiness({
      ...baseItem,
      proposal: {
        ...baseItem.proposal,
        status: "approved",
        commitExecutor: {
          kind: "generated_tool",
          toolName: "external.action.commit",
          toolVersion: "0.1.2",
          risk: "high",
          ready: true,
          reason: "Generic executor ready.",
        },
      },
      decision: {
        status: "approved",
        decidedAt: "2026-05-22T00:00:00.000Z",
        decidedBy: "user-admin",
      },
      preparationExecution: {
        status: "completed",
        actor: "tool",
        decidedAt: "2026-05-22T00:00:00.000Z",
        preparedSession: {
          ...preparedSession(),
          formFieldGaps: [],
          artifactIds: [],
        },
      },
    });

    expect(readiness.status).toBe("blocked");
    expect(readiness.canCommit).toBe(false);
    expect(readiness.reason).toContain("No proof artifact");
  });

  it("blocks final submit when the prepared action draft still needs more input", () => {
    const readiness = buildCommitReadiness({
      ...baseItem,
      proposal: {
        ...baseItem.proposal,
        status: "approved",
        commitExecutor: {
          kind: "generated_tool",
          toolName: "external.action.commit",
          toolVersion: "0.1.2",
          risk: "high",
          ready: true,
          reason: "Generic executor ready.",
        },
      },
      decision: {
        status: "approved",
        decidedAt: "2026-05-22T00:00:00.000Z",
        decidedBy: "user-admin",
      },
      preparationExecution: {
        status: "completed",
        actor: "tool",
        decidedAt: "2026-05-22T00:00:00.000Z",
        preparedSession: {
          ...preparedSession(),
          formFieldGaps: [],
          artifactIds: ["artifact-1"],
          actionDraft: {
            status: "needs_more_input",
            target: "Restaurant",
            action: "Book a table",
            pageUrl: "https://restaurant.example/book",
            dataPreview: [],
            missingBeforeCommit: ["confirmed prepared fields"],
            proofArtifactIds: ["artifact-1"],
            commitControls: [{ label: "Submit", reason: "Final submit control." }],
            operatorNextStep: "Resolve before final submit: confirmed prepared fields.",
            postCommitReportRequirements: [],
          },
        },
      },
    });

    expect(readiness.status).toBe("blocked");
    expect(readiness.canCommit).toBe(false);
    expect(readiness.reason).toContain("confirmed prepared fields");
  });

  it("surfaces server block reasons instead of generic readiness text", () => {
    const readiness = buildCommitReadiness({
      ...baseItem,
      proposal: { ...baseItem.proposal, status: "approved" },
      execution: {
        status: "blocked",
        actor: "system",
        decidedAt: "2026-05-22T00:00:00.000Z",
        reason: "Approved profile fields must be replay-prepared before commit: contact_email.",
      },
    });

    expect(readiness.status).toBe("blocked");
    expect(readiness.reason).toContain("replay-prepared");
  });
});

function preparedSession(): ExternalActionPreparedSession {
  return {
    preparedAt: "2026-05-22T00:00:00.000Z",
    toolName: "browser.operate",
    currentUrl: "http://127.0.0.1:3000/api/fixtures/external-action/reservation",
    links: [],
    formFields: [{ label: "Email", required: true }],
    formFieldGaps: [
      {
        field: "contact_email",
        label: "Email",
        required: true,
        reason: "Required email missing.",
        profileAvailable: true,
        profileSource: "user_profile",
        valuePreview: "co***@example.com",
      },
    ],
    availableProfileFields: [
      {
        field: "contact_email",
        source: "user_profile",
        valuePreview: "co***@example.com",
        reason: "Matches required email input.",
      },
    ],
    filledFields: [],
    replaySteps: [],
    commitCandidates: [{ label: "Submit", reason: "Would submit reservation." }],
    artifactIds: ["artifact-1"],
    warnings: [],
  };
}
