import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProfileHydrationCommands,
  buildFormFieldGaps,
  buildSchemaAwarePreparationCommands,
  extractFormFields,
  redactApprovedProfileCommandValues,
} from "../src/server/modules/runs/action-proposal-form-matching.js";
import type { ExternalActionProposal } from "../src/types.js";

test("schema-aware external action preparation maps observed fields generically", () => {
  const proposal: ExternalActionProposal = {
    id: "action_form_schema_1",
    runId: "run_form_schema",
    actionType: "reservation",
    status: "proposed",
    title: "Reservation proposal",
    summary: "Prepare reservation",
    proposedAction: "Prepare reservation after approval.",
    target: "Restaurant",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: ["prepare"],
    prohibitedWithoutApproval: ["submit"],
    sourceUrls: [],
    artifactIds: [],
    preparation: {
      stage: "prepared_for_approval",
      objective: "Prepare reservation.",
      collectedInputs: [
        { label: "party_size", value: "5", source: "user_request" },
        { label: "date_or_time", value: "2026-05-23 20:30", source: "user_request" },
        { label: "contact", value: "test@example.com", source: "user_request" },
      ],
      missingInputs: [],
      commitBoundary: "Do not submit.",
      operatorChecklist: [],
      proofPlan: [],
    },
    createdAt: "2026-05-22T10:00:00.000Z",
    createdBy: "base-agent",
  };

  const commands = buildSchemaAwarePreparationCommands(proposal, [
    {
      fields: [
        { label: "Guests", name: "partySize", type: "number" },
        { label: "Date", name: "reservationDate", type: "date" },
        { label: "Time", name: "reservationTime", type: "time" },
        { label: "Email", name: "email", type: "email" },
        { label: "Final submit", name: "submit", type: "button" },
      ],
    },
  ]);

  const fills = commands.filter((command) => command.action === "fill");
  assert.deepEqual(
    fills.map((command) => [command.field, command.value]),
    [
      ["party_size", "5"],
      ["date", "2026-05-23"],
      ["time", "20:30"],
      ["contact_email", "test@example.com"],
    ],
  );
  assert.equal(commands.some((command) => command.action === "click"), false);
  assert.deepEqual(fills[0]?.selectors, ['[name="partySize"]']);
});

test("required form gaps report profile availability without auto-fill", () => {
  const proposal: ExternalActionProposal = {
    id: "action_form_schema_2",
    runId: "run_form_schema",
    actionType: "appointment",
    status: "proposed",
    title: "Appointment proposal",
    summary: "Prepare appointment",
    proposedAction: "Prepare appointment after approval.",
    target: "Clinic",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: ["prepare"],
    prohibitedWithoutApproval: ["submit contact details"],
    sourceUrls: [],
    artifactIds: [],
    preparation: {
      stage: "prepared_for_approval",
      objective: "Prepare appointment.",
      collectedInputs: [
        { label: "service", value: "haircut", source: "user_request" },
      ],
      missingInputs: ["contact"],
      commitBoundary: "Do not submit.",
      operatorChecklist: [],
      proofPlan: [],
    },
    createdAt: "2026-05-22T10:00:00.000Z",
    createdBy: "base-agent",
  };
  const fields = extractFormFields([
    {
      fields: [
        { label: "Service", name: "service", required: true },
        { label: "Email", name: "email", type: "email", required: true },
      ],
    },
  ]);

  const gaps = buildFormFieldGaps({
    proposal,
    formFields: fields,
    filledFields: [{ label: "Service", valuePreview: "haircut" }],
    profileValues: [
      {
        field: "contact_email",
        source: "user_profile",
        value: "dmitrii@example.com",
        valuePreview: "dm***@example.com",
      },
    ],
  });

  assert.deepEqual(gaps, [
    {
      field: "contact_email",
      label: "Email",
      name: "email",
      type: "email",
      required: true,
      reason: "Required field can be hydrated from profile after operator confirmation.",
      profileAvailable: true,
      profileSource: "user_profile",
      valuePreview: "dm***@example.com",
    },
  ]);
});

test("form classification does not treat selector name attributes as contact names", () => {
  const proposal: ExternalActionProposal = {
    id: "action_form_schema_2b",
    runId: "run_form_schema",
    actionType: "appointment",
    status: "proposed",
    title: "Appointment proposal",
    summary: "Prepare appointment",
    proposedAction: "Prepare appointment after approval.",
    target: "Clinic",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: ["prepare"],
    prohibitedWithoutApproval: ["submit contact details"],
    sourceUrls: [],
    artifactIds: [],
    preparation: {
      stage: "prepared_for_approval",
      objective: "Prepare appointment.",
      collectedInputs: [],
      missingInputs: ["contact"],
      commitBoundary: "Do not submit.",
      operatorChecklist: [],
      proofPlan: [],
    },
    createdAt: "2026-05-22T10:00:00.000Z",
    createdBy: "base-agent",
  };
  const fields = extractFormFields([
    {
      fields: [
        {
          label: "Email",
          name: "email",
          selector: 'input[name="email"]',
          type: "email",
          required: true,
        },
      ],
    },
  ]);

  const gaps = buildFormFieldGaps({
    proposal,
    formFields: fields,
    profileValues: [
      {
        field: "contact_name",
        source: "user_profile",
        value: "Local Admin",
        valuePreview: "Local Admin",
      },
      {
        field: "contact_email",
        source: "user_profile",
        value: "dmitrii@example.com",
        valuePreview: "dm***@example.com",
      },
    ],
  });

  assert.equal(gaps?.[0]?.field, "contact_email");
  assert.equal(gaps?.[0]?.valuePreview, "dm***@example.com");
});

test("page-scoped interactive fields preserve generated selectors for replay", () => {
  const fields = extractFormFields([
    {
      scope: "page",
      fields: [
        {
          label: "Email",
          selector: "main > div:nth-of-type(2) input:nth-of-type(1)",
          type: "email",
          required: true,
        },
      ],
    },
  ]);

  assert.deepEqual(fields, [
    {
      label: "Email",
      selector: "main > div:nth-of-type(2) input:nth-of-type(1)",
      type: "email",
      required: true,
    },
  ]);
});

test("approved profile hydration commands carry raw values only at execution boundary", () => {
  const commands = buildProfileHydrationCommands({
    session: {
      preparedAt: "2026-05-22T10:00:00.000Z",
      toolName: "browser.operate",
      links: [],
      formFieldGaps: [
        {
          field: "contact_email",
          label: "Email",
          name: "email",
          required: true,
          reason: "Required",
          profileAvailable: true,
          profileSource: "user_profile",
          valuePreview: "dm***@example.com",
        },
      ],
      filledFields: [],
      replaySteps: [],
      commitCandidates: [],
      artifactIds: [],
      warnings: [],
    },
    approvedFields: ["contact_email"],
    profileValues: [
      {
        field: "contact_email",
        source: "user_profile",
        value: "dmitrii@example.com",
        valuePreview: "dm***@example.com",
      },
    ],
  });

  assert.deepEqual(commands, [
    {
      action: "fill",
      field: "contact_email",
      source: "approved_profile",
      value: "dmitrii@example.com",
      valuePreview: "dm***@example.com",
      optional: false,
      labels: ["Email"],
      selectors: ['[name="email"]'],
    },
  ]);
  assert.deepEqual(redactApprovedProfileCommandValues(commands), [
    {
      action: "fill",
      field: "contact_email",
      source: "approved_profile",
      value: "dm***@example.com",
      valuePreview: "dm***@example.com",
      optional: false,
      labels: ["Email"],
      selectors: ['[name="email"]'],
    },
  ]);
});
