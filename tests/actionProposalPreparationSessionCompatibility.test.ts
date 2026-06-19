import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryAuditEventStore } from "../src/audit/inMemoryAuditEventStore.js";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { AuditService } from "../src/server/common/services/audit.service.js";
import { ActionProposalAuditRecorder } from "../src/server/modules/runs/action-proposal-audit-recorder.js";
import { ActionProposalPreparationRunner } from "../src/server/modules/runs/action-proposal-preparation-runner.js";
import { buildPreparedSession } from "../src/server/modules/runs/action-proposal-prepared-session.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ExternalActionProposal } from "../src/types.js";

test("prepared session accepts docker-style selector fills and submit text", () => {
  const proposal: ExternalActionProposal = {
    id: "action_run_1_docker_fill",
    runId: "run_1",
    actionType: "reservation",
    status: "approved",
    title: "Reservation proposal",
    summary: "prepare reservation",
    proposedAction: "Make a reservation",
    target: "Provider",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: ["research", "prepare"],
    prohibitedWithoutApproval: ["submit final reservation"],
    sourceUrls: ["https://provider.example/reserve"],
    artifactIds: [],
    preparation: {
      stage: "ready_to_commit",
      target: "Provider",
      targetUrl: "https://provider.example/reserve",
      objective: "Prepare reservation.",
      collectedInputs: [
        { label: "Name", value: "Dmitrii Test", source: "user_request" },
        { label: "Party size", value: "4", source: "user_request" },
      ],
      missingInputs: [],
      commitBoundary: "Do not submit final reservation.",
      operatorChecklist: ["Review"],
      proofPlan: ["screenshot"],
    },
    createdAt: new Date().toISOString(),
    createdBy: "base-agent",
  };

  const session = buildPreparedSession({
    proposal,
    toolName: "browser.operate",
    toolVersion: "1.0.0",
    toolInput: {
      url: "https://provider.example/reserve",
      commands: [
        { type: "navigate", url: "https://provider.example/reserve" },
        { type: "fill", field: "contact_name", selector: 'input[name="name"]', value: "Dmitrii Test" },
        { type: "fill", field: "party_size", selector: 'input[name="partySize"]', value: "4" },
        { type: "extractText" },
        { type: "screenshot" },
      ],
    },
    data: {
      finalUrl: "https://provider.example/reserve",
      title: "Restaurant reservation fixture",
      extractedText: [
        { label: "page", text: "Restaurant reservation\nName\nParty size\nConfirm reservation" },
      ],
      steps: [
        { index: 0, type: "navigate", status: "completed", summary: "Navigated." },
        { index: 1, type: "fill", status: "completed", summary: "Filled name." },
        { index: 2, type: "fill", status: "completed", summary: "Filled party size." },
      ],
    },
    artifactIds: ["artifact-1"],
    proofArtifactIds: ["artifact-1"],
  });

  assert.deepEqual(
    session.filledFields.map((field) => [field.label, field.valuePreview]),
    [
      ["contact_name", "Dmitrii Test"],
      ["party_size", "4"],
    ],
  );
  assert.deepEqual(session.commitCandidates, [
    {
      label: "Confirm reservation",
      reason: "Submit/control text was observed on the prepared browser page.",
    },
  ]);
  assert.equal(session.actionDraft?.status, "ready_for_operator_review");
});

test("external action preparation replays approved profile hydration without leaking raw values to trace", async () => {
  const runs = new InMemoryRunStore();
  const registry = new ToolRegistry();
  const inputs: Record<string, unknown>[] = [];
  registry.register({
    name: "browser.operate",
    version: "0.1.0",
    description: "Browser prepare fixture.",
    capabilities: ["browser-operate", "browser-field-candidates"],
    inputSchema: { type: "object", properties: {}, required: [] },
    async run(input) {
      inputs.push(input);
      return {
        ok: true,
        content: "Prepared form.",
        data: {
          finalUrl: String(input.url),
          pageTitle: "Booking",
          extractedText: "Reservation form.",
          forms: [
            {
              fields: [
                { label: "Email", name: "email", type: "email", required: true },
              ],
            },
          ],
          steps: [{ index: 0, action: "extractForms", ok: true, detail: "forms" }],
        },
      };
    },
  });
  const run = await runs.create("prepare booking", {
    instanceId: "instance-local",
    requesterUserId: "user-admin",
    channel: "web",
  });
  const proposal: ExternalActionProposal = {
    id: `action_${run.id}_profile`,
    runId: run.id,
    actionType: "reservation",
    status: "proposed",
    title: "Reservation proposal",
    summary: "prepare reservation",
    proposedAction: "Prepare reservation after approval.",
    target: "Restaurant",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: ["research", "prepare"],
    prohibitedWithoutApproval: ["submit final booking"],
    sourceUrls: ["https://restaurant.example/booking/"],
    artifactIds: [],
    preparation: {
      stage: "prepared_for_approval",
      target: "Restaurant",
      targetUrl: "https://restaurant.example/booking/",
      objective: "Prepare reservation.",
      collectedInputs: [],
      missingInputs: ["contact"],
      commitBoundary: "Do not submit final booking.",
      operatorChecklist: ["Review"],
      proofPlan: ["screenshot"],
    },
    createdAt: new Date().toISOString(),
    createdBy: "base-agent",
  };
  const recorder = new ActionProposalAuditRecorder(
    runs,
    new AuditService(new InMemoryAuditEventStore()),
  );
  await new ActionProposalPreparationRunner({
    runs,
    artifacts: undefined,
    toolRegistry: registry,
    recorder,
    profileValues: [
      {
        field: "contact_email",
        source: "user_profile",
        value: "dmitrii@example.com",
        valuePreview: "dm***@example.com",
      },
    ],
  }).prepare({ run, proposal, rawBody: {} });

  const preparedRun = await runs.get(run.id);
  assert.ok(preparedRun);
  await new ActionProposalPreparationRunner({
    runs,
    artifacts: undefined,
    toolRegistry: registry,
    recorder,
    approvedProfileFields: ["contact_email"],
    profileValues: [
      {
        field: "contact_email",
        source: "user_profile",
        value: "dmitrii@example.com",
        valuePreview: "dm***@example.com",
      },
    ],
  }).prepare({ run: preparedRun, proposal, rawBody: { mode: "replay" } });

  assert.equal(inputs.length, 2);
  const replayCommands = inputs[1]?.commands as Record<string, unknown>[];
  assert.equal(
    replayCommands.some(
      (command) =>
        command.source === "approved_profile" &&
        command.value === "dmitrii@example.com",
    ),
    true,
  );
  const updated = await runs.get(run.id);
  const replayStarted = updated?.events
    .filter((event) => event.type === "external-action-preparation-started")
    .at(-1);
  assert.equal(JSON.stringify(replayStarted?.payload).includes("dmitrii@example.com"), false);
  assert.equal(JSON.stringify(replayStarted?.payload).includes("dm***@example.com"), true);
});

test("form-fill capability enables canonical fill commands including split contact", async () => {
  const runs = new InMemoryRunStore();
  const registry = new ToolRegistry();
  const inputs: Record<string, unknown>[] = [];
  registry.register({
    name: "external.action.prepare",
    version: "0.1.15",
    description: "Prepare fixture.",
    capabilities: ["external-action-preparation", "browser-operation", "form-fill"],
    inputSchema: { type: "object", properties: {}, required: [] },
    async run(input) {
      inputs.push(input);
      return {
        ok: true,
        content: "Prepared.",
        data: { finalUrl: String(input.url), steps: [] },
      };
    },
  });
  const run = await runs.create("подготовь запись", {
    instanceId: "instance-local",
    requesterUserId: "user-admin",
    channel: "web",
  });
  const proposal: ExternalActionProposal = {
    id: `action_${run.id}_1`,
    runId: run.id,
    actionType: "appointment",
    status: "approved",
    title: "Appointment proposal: Fixture",
    summary: "appointment",
    proposedAction: "Prepare appointment.",
    target: "Fixture salon",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: [],
    prohibitedWithoutApproval: [],
    sourceUrls: [],
    artifactIds: [],
    preparation: {
      stage: "prepared_for_approval",
      target: "Fixture salon",
      targetUrl: "http://127.0.0.1:3000/api/fixtures/external-actions/appointment",
      objective: "Prepare appointment.",
      collectedInputs: [
        { label: "service", value: "стрижка / haircut", source: "user_request" },
        { label: "date_or_time", value: "Friday 17:30", source: "user_request" },
        { label: "contact", value: "Test User, test@example.com, +34 600 000 000", source: "user_request" },
      ],
      missingInputs: [],
      commitBoundary: "no submit",
      operatorChecklist: [],
      proofPlan: [],
    },
    createdAt: new Date().toISOString(),
    createdBy: "base-agent",
  };
  const recorder = new ActionProposalAuditRecorder(
    runs,
    new AuditService(new InMemoryAuditEventStore()),
  );
  await new ActionProposalPreparationRunner({
    runs,
    artifacts: undefined,
    toolRegistry: registry,
    recorder,
  }).prepare({ run, proposal, rawBody: {} });

  const commands = (inputs[0]?.commands ?? []) as Array<Record<string, unknown>>;
  const fillFields = commands.filter((c) => c.action === "fill").map((c) => c.field);
  for (const field of ["time", "service", "name", "email", "phone"]) {
    assert.ok(fillFields.includes(field), `fill command for ${field} expected, got: ${JSON.stringify(fillFields)}`);
  }
  const email = commands.find((c) => c.field === "email") as { value?: string };
  assert.equal(email?.value, "test@example.com");
  const phone = commands.find((c) => c.field === "phone") as { value?: string };
  assert.equal(phone?.value, "+34 600 000 000");
  const name = commands.find((c) => c.field === "name") as { value?: string };
  assert.equal(name?.value, "Test User");
});
