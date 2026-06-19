import { describe, expect, it } from "vitest";
import type { ActionProposalQueueItem } from "@/api/runs";
import type { ExternalActionPreparedSession } from "@/api/types";
import { buildExternalActionUxState } from "./externalActionUxState";

const baseItem: ActionProposalQueueItem = {
  proposal: {
    id: "proposal-1",
    runId: "run-1",
    actionType: "appointment",
    status: "proposed",
    title: "Book appointment",
    summary: "Appointment draft",
    proposedAction: "Book an appointment",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: [],
    prohibitedWithoutApproval: ["submit appointment"],
    sourceUrls: ["https://provider.example/book"],
    artifactIds: [],
    createdAt: "2026-05-25T00:00:00.000Z",
    createdBy: "base-agent",
    preparation: {
      stage: "prepared_for_approval",
      objective: "Book an appointment",
      targetUrl: "https://provider.example/book",
      collectedInputs: [
        { label: "date_or_time", value: "Friday 17:30", source: "user_request" },
        { label: "contact", value: "di***@example.com", source: "profile" },
      ],
      missingInputs: [],
      proofPlan: ["filled form screenshot"],
      operatorChecklist: [],
      commitBoundary: "submit appointment",
    },
  },
  run: {
    id: "run-1",
    task: "book",
    status: "waiting_approval",
    createdAt: "2026-05-25T00:00:00.000Z",
    updatedAt: "2026-05-25T00:00:00.000Z",
  },
};

describe("buildExternalActionUxState", () => {
  it("presents a proposed action as one safe approval step", () => {
    const ux = buildExternalActionUxState(baseItem);

    expect(ux.status).toBe("waiting_approval");
    expect(ux.primaryAction.kind).toBe("approve_proposal");
    expect(ux.primaryAction.label).toBe("Approve plan and prepare proof");
    expect(ux.primaryAction.effect).toMatch(/stops before submit/i);
    expect(ux.summary.data).toContain("Date / time: Friday 17:30");
    expect(ux.canReject).toBe(true);
  });

  it("blocks approval when the proposal still misses concrete inputs", () => {
    const ux = buildExternalActionUxState({
      ...baseItem,
      proposal: {
        ...baseItem.proposal,
        preparation: {
          ...baseItem.proposal.preparation!,
          missingInputs: ["phone number"],
        },
      },
    });

    expect(ux.status).toBe("blocked");
    expect(ux.primaryAction.kind).toBe("none");
    expect(ux.title).toMatch(/needs details/i);
    expect(ux.summary.missing).toEqual(["phone number"]);
  });

  it("separates profile-data approval from final external submit", () => {
    const ux = buildExternalActionUxState({
      ...baseItem,
      proposal: { ...baseItem.proposal, status: "approved" },
      decision: {
        status: "approved",
        decidedAt: "2026-05-25T00:00:00.000Z",
        decidedBy: "user-admin",
      },
      preparationExecution: {
        status: "completed",
        actor: "tool",
        decidedAt: "2026-05-25T00:00:00.000Z",
        preparedSession: preparedSession(),
      },
    });

    expect(ux.status).toBe("needs_data_approval");
    expect(ux.primaryAction.kind).toBe("approve_profile_values");
    expect(ux.primaryAction.effect).toMatch(/stops before submit/i);
    expect(ux.description).toContain("Email");
  });

  it("marks final submit as the only dangerous primary action", () => {
    const ux = buildExternalActionUxState({
      ...baseItem,
      proposal: {
        ...baseItem.proposal,
        status: "approved",
        commitExecutor: {
          kind: "generated_tool",
          toolName: "external.action.commit",
          toolVersion: "0.1.0",
          risk: "high",
          ready: true,
          reason: "Ready.",
        },
      },
      decision: {
        status: "approved",
        decidedAt: "2026-05-25T00:00:00.000Z",
        decidedBy: "user-admin",
      },
      preparationExecution: {
        status: "completed",
        actor: "tool",
        decidedAt: "2026-05-25T00:00:00.000Z",
        artifactIds: ["artifact-proof"],
        preparedSession: {
          ...preparedSession(),
          formFieldGaps: [],
          filledFields: [{ label: "Email", valuePreview: "di***@example.com" }],
          artifactIds: ["artifact-proof"],
          proofArtifactIds: ["artifact-proof"],
          approvedProfileFields: [
            {
              field: "contact_email",
              source: "user_profile",
              valuePreview: "di***@example.com",
              approvedAt: "2026-05-25T00:00:00.000Z",
              approvedBy: "user-admin",
            },
          ],
        },
      },
      profileHydration: {
        status: "approved",
        approvedAt: "2026-05-25T00:00:00.000Z",
        approvedBy: "user-admin",
        fields: [
          {
            field: "contact_email",
            source: "user_profile",
            valuePreview: "di***@example.com",
          },
        ],
      },
    });

    expect(ux.status).toBe("ready_to_submit");
    expect(ux.primaryAction.kind).toBe("submit");
    expect(ux.primaryAction.dangerous).toBe(true);
    expect(ux.summary.proofArtifactIds).toEqual(["artifact-proof"]);
  });
});

function preparedSession(): ExternalActionPreparedSession {
  return {
    preparedAt: "2026-05-25T00:00:00.000Z",
    toolName: "browser.operate",
    currentUrl: "https://provider.example/book",
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
        valuePreview: "di***@example.com",
      },
    ],
    availableProfileFields: [
      {
        field: "contact_email",
        source: "user_profile",
        valuePreview: "di***@example.com",
        reason: "Matches required email input.",
      },
    ],
    filledFields: [],
    replaySteps: [],
    commitCandidates: [{ label: "Submit", reason: "Would submit appointment." }],
    artifactIds: ["artifact-proof"],
    proofArtifactIds: ["artifact-proof"],
    warnings: [],
  };
}
