import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryAuditEventStore } from "../src/audit/inMemoryAuditEventStore.js";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { AuditService } from "../src/server/common/services/audit.service.js";
import { ActionProposalAuditRecorder } from "../src/server/modules/runs/action-proposal-audit-recorder.js";
import { ActionProposalPreparationRunner } from "../src/server/modules/runs/action-proposal-preparation-runner.js";
import { buildPreparedSession } from "../src/server/modules/runs/action-proposal-prepared-session.js";
import { buildSafeAdvancePreparationCommands } from "../src/server/modules/runs/action-proposal-safe-advance.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ExternalActionProposal } from "../src/types.js";

test("external action preparation follows likely booking links without final commit", async () => {
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
      assert.equal(input.prepareOnly, true);
      const url = String(input.url);
      const isBooking = url.endsWith("/booking/");
      return {
        ok: true,
        content: isBooking ? "Prepared booking page." : "Prepared landing page.",
        data: {
          finalUrl: url,
          pageTitle: isBooking ? "Booking" : "Home",
          extractedText: isBooking ? "Reservation form. Contact required." : "Welcome. Reservations.",
          links: isBooking
            ? []
            : [
                { text: "Reservations", href: "https://restaurant.example/booking/" },
                { text: "TripAdvisor", href: "https://tripadvisor.com/restaurant" },
              ],
          steps: [{ index: 0, action: "extractLinks", ok: true, detail: "links" }],
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
    id: `action_${run.id}_1`,
    runId: run.id,
    actionType: "reservation",
    status: "proposed",
    title: "Reservation proposal: Skina",
    summary: "prepare reservation",
    proposedAction: "Prepare reservation after approval.",
    target: "Skina",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: ["research", "prepare"],
    prohibitedWithoutApproval: ["submit final booking"],
    sourceUrls: ["https://restaurant.example/"],
    artifactIds: [],
    preparation: {
      stage: "prepared_for_approval",
      target: "Skina",
      targetUrl: "https://restaurant.example/",
      objective: "Prepare reservation.",
      collectedInputs: [
        { label: "party_size", value: "2", source: "user_request" },
        { label: "date_or_time", value: "2026-05-23 20:00", source: "user_request" },
      ],
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
  }).prepare({ run, proposal, rawBody: {} });

  assert.equal(inputs.length, 2);
  assert.equal(inputs[0]?.url, "https://restaurant.example/");
  assert.equal(inputs[1]?.url, "https://restaurant.example/booking/");
  assert.equal(
    (inputs[1]?.commands as Record<string, unknown>[]).some(
      (command) => command.action === "click",
    ),
    false,
  );
  assert.equal(
    (inputs[0]?.commands as Record<string, unknown>[]).some(
      (command) => command.action === "fill" && command.optional === true,
    ),
    false,
  );
  assert.equal(
    (inputs[1]?.commands as Record<string, unknown>[]).some(
      (command) =>
        command.action === "fill" &&
        command.field === "party_size" &&
        command.optional === true &&
        Array.isArray(command.labels),
    ),
    true,
  );

  const updated = await runs.get(run.id);
  const completed = updated?.events.find(
    (event) => event.type === "external-action-preparation-completed",
  );
  const payload = completed?.payload as
    | {
        preparedSession?: {
          currentUrl?: string;
          warnings?: string[];
          actionDraft?: {
            status?: string;
            missingBeforeCommit?: string[];
            postCommitReportRequirements?: string[];
          };
        };
      }
    | undefined;
  assert.equal(payload?.preparedSession?.currentUrl, "https://restaurant.example/booking/");
  assert.deepEqual(payload?.preparedSession?.warnings, [
    "Missing inputs before commit: contact",
  ]);
  assert.equal(payload?.preparedSession?.actionDraft?.status, "needs_more_input");
  assert.ok(
    payload?.preparedSession?.actionDraft?.missingBeforeCommit?.includes("contact"),
  );
  assert.ok(
    payload?.preparedSession?.actionDraft?.postCommitReportRequirements?.some((item) =>
      item.includes("cancellation"),
    ),
  );
});

test("external action preparation safely advances through observed non-submit controls", async () => {
  const runs = new InMemoryRunStore();
  const registry = new ToolRegistry();
  const inputs: Record<string, unknown>[] = [];
  registry.register({
    name: "external.action.prepare",
    version: "0.1.2",
    description: "Generated external action prepare fixture.",
    capabilities: [
      "external-action-prepare",
      "browser-action-candidates",
      "browser-field-candidates",
      "browser-form-schema",
      "browser-safe-advance",
    ],
    inputSchema: { type: "object", properties: {}, required: [] },
    async run(input) {
      inputs.push(input);
      assert.equal(input.prepareOnly, true);
      const commands = input.commands as Record<string, unknown>[];
      const safeAdvance = commands.some(
        (command) => command.action === "click" && command.safeAdvance === true,
      );
      const schemaAware = commands.some(
        (command) => command.action === "fill" && command.field === "service",
      );
      return {
        ok: true,
        content: safeAdvance || schemaAware ? "Opened booking widget." : "Prepared landing page.",
          data: safeAdvance || schemaAware
          ? {
              finalUrl: String(input.url),
              pageTitle: "Booking widget",
              extractedText: "Choose a service and time.",
              forms: [
                {
                  fields: [
                    { label: "Service", name: "service", type: "text", required: true },
                  ],
                  submitCandidates: [{ text: "Confirm appointment" }],
                },
              ],
              steps: [{ index: 2, action: "click", ok: true, detail: "clicked Book now" }],
            }
          : {
              finalUrl: String(input.url),
              pageTitle: "Provider",
              extractedText: "Book an appointment online.",
              forms: [
                {
                  fields: [
                    {
                      label: "Search for service",
                      name: "service-search",
                      type: "search",
                      required: true,
                    },
                  ],
                  submitCandidates: [],
                },
              ],
              actionCandidates: [
                {
                  text: "Spa",
                  selector: "[data-testid=\"category-Spa\"]",
                  kind: "safe_advance",
                  safeAdvance: true,
                  score: 80,
                  visible: true,
                  disabled: false,
                },
                {
                  text: "Book now",
                  selector: "#book-now",
                  kind: "safe_advance",
                  safeAdvance: true,
                  score: 35,
                  visible: true,
                  disabled: false,
                },
              ],
              steps: [{ index: 1, action: "extractForms", ok: true, detail: "[]" }],
            },
      };
    },
  });

  const run = await runs.create("prepare appointment", {
    instanceId: "instance-local",
    requesterUserId: "user-admin",
    channel: "web",
  });
  const proposal: ExternalActionProposal = {
    id: `action_${run.id}_safe_advance`,
    runId: run.id,
    actionType: "appointment",
    status: "proposed",
    title: "Appointment proposal",
    summary: "prepare appointment",
    proposedAction: "Prepare appointment after approval.",
    target: "Barbershop",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: ["research", "prepare"],
    prohibitedWithoutApproval: ["submit final appointment"],
    sourceUrls: ["https://provider.example/"],
    artifactIds: [],
    preparation: {
      stage: "prepared_for_approval",
      target: "Barbershop",
      targetUrl: "https://provider.example/",
      objective: "Prepare appointment.",
      collectedInputs: [{ label: "service", value: "Haircut", source: "user_request" }],
      missingInputs: [],
      commitBoundary: "Do not submit final appointment.",
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
  }).prepare({ run, proposal, rawBody: {} });

  assert.equal(inputs.length, 3);
  const safeAdvanceCommands = inputs[1]?.commands as Record<string, unknown>[];
  assert.deepEqual(
    safeAdvanceCommands.slice(0, 2),
    [
      { action: "dismissDialogs" },
      {
        action: "click",
        safeAdvance: true,
        optional: false,
        selector: "#book-now",
        text: "Book now",
      },
    ],
  );
  assert.equal(
    safeAdvanceCommands.some(
      (command) => command.action === "fill" && command.field === "service",
    ),
    true,
  );
  const updated = await runs.get(run.id);
  const completed = updated?.events.find(
    (event) => event.type === "external-action-preparation-completed",
  );
  const payload = completed?.payload as
    | { preparedSession?: { commitCandidates?: Array<{ label?: string }> } }
    | undefined;
  assert.equal(payload?.preparedSession?.commitCandidates?.[0]?.label, "Confirm appointment");
});

test("external action preparation can safely advance through selection submit candidates", () => {
  const proposal: ExternalActionProposal = {
    id: "action_run_1_safe_submit",
    runId: "run_1",
    actionType: "appointment",
    status: "approved",
    title: "Appointment proposal",
    summary: "prepare appointment",
    proposedAction: "Schedule an appointment",
    target: "Provider",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: ["research", "prepare"],
    prohibitedWithoutApproval: ["submit final appointment"],
    sourceUrls: ["https://provider.example/book"],
    artifactIds: [],
    preparation: {
      stage: "ready_to_commit",
      target: "Provider",
      targetUrl: "https://provider.example/book",
      objective: "Prepare appointment.",
      collectedInputs: [{ label: "service", value: "Haircut", source: "user_request" }],
      missingInputs: [],
      commitBoundary: "Do not submit final appointment.",
      operatorChecklist: ["Review"],
      proofPlan: ["screenshot"],
    },
    createdAt: new Date().toISOString(),
    createdBy: "base-agent",
  };

  const commands = buildSafeAdvancePreparationCommands(
    proposal,
    {
      extractedText: "Choose a service and time for the appointment.",
      forms: [
        {
          fields: [
            {
              label: "¿Dónde?",
              name: "location-filter",
              type: "text",
            },
            {
              id: "CybotCookiebotDialogBodyLevelButtonNecessary",
              label: "Necessary",
              type: "checkbox",
            },
            {
              label: "Search for service",
              name: "service-search",
              type: "search",
              required: true,
            },
          ],
          submitCandidates: [
            {
              text: "Reservar ahora",
              selector: "#reserve-service",
              selectorOrdinal: 2,
              candidateIndex: 7,
              visible: true,
              disabled: false,
            },
          ],
        },
      ],
    },
    {
      buildDefaultCommands: () => [{ action: "extractForms" }],
    },
  );

  assert.deepEqual(commands.slice(0, 2), [
    { action: "dismissDialogs" },
      {
        action: "click",
        safeAdvance: true,
        optional: false,
        selector: "#reserve-service",
        selectorOrdinal: 2,
        candidateIndex: 7,
        text: "Reservar ahora",
      },
  ]);
  assert.deepEqual(commands[2], { action: "wait", ms: 1_200 });
  assert.deepEqual(commands[3], { action: "dismissDialogs" });
});

test("external action preparation prefers generated external-action-prepare capability", async () => {
  const runs = new InMemoryRunStore();
  const registry = new ToolRegistry();
  const called: string[] = [];
  registry.register({
    name: "browser.operate",
    version: "0.1.0",
    description: "Browser fallback fixture.",
    capabilities: ["browser-operate"],
    inputSchema: { type: "object", properties: {}, required: [] },
    async run() {
      called.push("browser.operate");
      return { ok: true, content: "fallback", data: { finalUrl: "https://example.com" } };
    },
  });
  registry.register({
    name: "external.action.prepare",
    version: "0.1.0",
    description: "Generated external action prepare fixture.",
    capabilities: ["external-action-prepare", "browser-operate", "browser-field-candidates", "browser-form-schema"],
    inputSchema: { type: "object", properties: {}, required: [] },
    async run(input) {
      called.push("external.action.prepare");
      assert.equal(input.prepareOnly, true);
      return {
        ok: true,
        content: "Prepared external action.",
        data: {
          finalUrl: String(input.url),
          forms: [],
          steps: [{ index: 0, action: "extractForms", ok: true }],
        },
      };
    },
  });
  const run = await runs.create("prepare action", {
    instanceId: "instance-local",
    requesterUserId: "user-admin",
    channel: "web",
  });
  const proposal: ExternalActionProposal = {
    id: `action_${run.id}_prepare_tool`,
    runId: run.id,
    actionType: "appointment",
    status: "proposed",
    title: "Appointment proposal",
    summary: "prepare appointment",
    proposedAction: "Prepare appointment after approval.",
    target: "Barbershop",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: ["research", "prepare"],
    prohibitedWithoutApproval: ["submit final appointment"],
    sourceUrls: ["https://example.com/book"],
    artifactIds: [],
    preparation: {
      stage: "prepared_for_approval",
      target: "Barbershop",
      targetUrl: "https://example.com/book",
      objective: "Prepare appointment.",
      collectedInputs: [],
      missingInputs: [],
      commitBoundary: "Do not submit final appointment.",
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
  }).prepare({ run, proposal, rawBody: {} });

  assert.deepEqual(called, ["external.action.prepare"]);
  const updated = await runs.get(run.id);
  const completed = updated?.events.find(
    (event) => event.type === "external-action-preparation-completed",
  );
  assert.equal(completed?.actor, "external.action.prepare");
});

test("prepared session accepts page-level action candidates outside forms", () => {
  const proposal: ExternalActionProposal = {
    id: "action_run_1_candidate",
    runId: "run_1",
    actionType: "appointment",
    status: "approved",
    title: "Appointment proposal",
    summary: "prepare appointment",
    proposedAction: "Schedule an appointment",
    target: "Provider",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: ["research", "prepare"],
    prohibitedWithoutApproval: ["submit final appointment"],
    sourceUrls: ["https://provider.example/book"],
    artifactIds: [],
    preparation: {
      stage: "ready_to_commit",
      target: "Provider",
      targetUrl: "https://provider.example/book",
      objective: "Prepare appointment.",
      collectedInputs: [{ label: "service", value: "Haircut", source: "user_request" }],
      missingInputs: [],
      commitBoundary: "Do not submit final appointment.",
      operatorChecklist: ["Review"],
      proofPlan: ["screenshot"],
    },
    createdAt: new Date().toISOString(),
    createdBy: "base-agent",
  };

  const session = buildPreparedSession({
    proposal,
    toolName: "external.action.prepare",
    toolVersion: "0.1.1",
    toolInput: { url: "https://provider.example/book", commands: [] },
    data: {
      finalUrl: "https://provider.example/book",
      actionCandidates: [
        { text: "Book appointment", selector: "#book", score: 25 },
      ],
    },
    artifactIds: ["artifact-1"],
  });

  assert.equal(session.actionDraft?.status, "needs_more_input");
  assert.deepEqual(session.actionDraft?.missingBeforeCommit, [
    "user-provided action data was not prepared on the provider page",
  ]);
  assert.deepEqual(session.commitCandidates, [
    {
      label: "Book appointment",
      selector: "#book",
      reason: "Action-capable control was observed in the prepared browser page.",
    },
  ]);
});

test("prepared session does not treat skipped fill commands as prepared fields", () => {
  const proposal: ExternalActionProposal = {
    id: "action_run_1_skipped_fill",
    runId: "run_1",
    actionType: "appointment",
    status: "approved",
    title: "Appointment proposal",
    summary: "prepare appointment",
    proposedAction: "Schedule an appointment",
    target: "Provider",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: ["research", "prepare"],
    prohibitedWithoutApproval: ["submit final appointment"],
    sourceUrls: ["https://provider.example/book"],
    artifactIds: [],
    preparation: {
      stage: "ready_to_commit",
      target: "Provider",
      targetUrl: "https://provider.example/book",
      objective: "Prepare appointment.",
      collectedInputs: [{ label: "service", value: "Haircut", source: "user_request" }],
      missingInputs: [],
      commitBoundary: "Do not submit final appointment.",
      operatorChecklist: ["Review"],
      proofPlan: ["screenshot"],
    },
    createdAt: new Date().toISOString(),
    createdBy: "base-agent",
  };

  const session = buildPreparedSession({
    proposal,
    toolName: "external.action.prepare",
    toolVersion: "0.1.8",
    toolInput: {
      url: "https://provider.example/book",
      commands: [
        { action: "fill", field: "service", value: "Haircut", optional: true },
      ],
    },
    data: {
      finalUrl: "https://provider.example/book",
      steps: [
        { index: 1, action: "fill", ok: true, detail: "optional skipped: fill target not found" },
      ],
      actionCandidates: [
        { text: "Book appointment", selector: "#book", score: 25 },
      ],
    },
    artifactIds: ["artifact-1"],
  });

  assert.deepEqual(session.filledFields, []);
  assert.equal(session.actionDraft?.status, "needs_more_input");
  assert.deepEqual(session.actionDraft?.missingBeforeCommit, [
    "provider selection did not advance to a fillable ready-to-submit form",
    "user-provided action data was not prepared on the provider page",
  ]);
});

test("external action preparation replays approved profile hydration without leaking raw values to trace", async () => {
  const runs = new InMemoryRunStore();
  const registry = new ToolRegistry();
  const inputs: Record<string, unknown>[] = [];
  registry.register({
    name: "browser.operate",
    version: "0.1.0",
    description: "Browser prepare fixture.",
    capabilities: ["browser-operate"],
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
