import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryAuditEventStore } from "../src/audit/inMemoryAuditEventStore.js";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { AuditService } from "../src/server/common/services/audit.service.js";
import { ActionProposalAuditRecorder } from "../src/server/modules/runs/action-proposal-audit-recorder.js";
import { ActionProposalPreparationRunner } from "../src/server/modules/runs/action-proposal-preparation-runner.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ExternalActionProposal } from "../src/types.js";

test("external action preparation prefers action links from proposal payload over research pages", async () => {
  const runs = new InMemoryRunStore();
  const registry = new ToolRegistry();
  const inputs: Record<string, unknown>[] = [];
  registry.register({
    name: "external.action.prepare",
    version: "0.1.0",
    description: "Browser prepare fixture.",
    capabilities: ["external-action-prepare", "browser-field-candidates"],
    inputSchema: { type: "object", properties: {}, required: [] },
    async run(input) {
      inputs.push(input);
      return {
        ok: true,
        content: "Prepared provider page.",
        data: {
          finalUrl: String(input.url),
          pageTitle: "Appointment booking",
          extractedText: "Book an appointment.",
          links: [],
          steps: [{ index: 0, action: "extractLinks", ok: true, detail: "links" }],
        },
      };
    },
  });

  const run = await runs.create("prepare appointment", {
    instanceId: "instance-local",
    requesterUserId: "user-admin",
    channel: "web",
  });
  const bookingUrl = "https://booking.example.com/memento-barbershop";
  const proposal = appointmentProposal(run.id, {
    payloadPreview: `Ссылка для записи: [Book appointment](${bookingUrl})`,
    sourceUrls: ["https://guide.example.com/barbers-marbella/"],
    targetUrl: "https://guide.example.com/barbers-marbella/",
  });

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

  assert.equal(inputs[0]?.url, bookingUrl);
  const updated = await runs.get(run.id);
  const completed = updated?.events.find(
    (event) => event.type === "external-action-preparation-completed",
  );
  const payload = completed?.payload as
    | { preparedSession?: { currentUrl?: string } }
    | undefined;
  assert.equal(payload?.preparedSession?.currentUrl, bookingUrl);
});

test("external action replay ignores stale prepared-session URL when payload has a better action link", async () => {
  const runs = new InMemoryRunStore();
  const registry = new ToolRegistry();
  const inputs: Record<string, unknown>[] = [];
  registry.register({
    name: "external.action.prepare",
    version: "0.1.0",
    description: "Browser prepare fixture.",
    capabilities: ["external-action-prepare", "browser-field-candidates"],
    inputSchema: { type: "object", properties: {}, required: [] },
    async run(input) {
      inputs.push(input);
      return {
        ok: true,
        content: "Prepared page.",
        data: {
          finalUrl: String(input.url),
          pageTitle: "Appointment booking",
          extractedText: "Book an appointment.",
          links: [],
          steps: [{ index: 0, action: "extractLinks", ok: true, detail: "links" }],
        },
      };
    },
  });

  const run = await runs.create("prepare appointment", {
    instanceId: "instance-local",
    requesterUserId: "user-admin",
    channel: "web",
  });
  const staleUrl = "https://guide.example.com/barbers-marbella/";
  const bookingUrl = "https://booking.example.com/memento-barbershop";
  const proposal = appointmentProposal(run.id, {
    status: "approved",
    payloadPreview: `Ссылка для записи: [Book appointment](${bookingUrl})`,
    sourceUrls: [staleUrl],
    targetUrl: staleUrl,
  });
  // The runner reads the previous prepared session from the RUN's
  // `external-action-preparation-completed` events (see
  // latestPreparedSession), not from the proposal — record the stale
  // session the way the runtime does so the replay-vs-fresh-URL logic is
  // actually exercised.
  await runs.appendEvent(run.id, {
    id: "event-stale-preparation",
    spanId: "span-stale-preparation",
    type: "external-action-preparation-completed",
    actor: "external.action.prepare",
    activity: "tool",
    status: "completed",
    title: "External action preparation completed",
    timestamp: new Date().toISOString(),
    payload: {
      proposalId: proposal.id,
      preparedSession: {
        preparedAt: new Date().toISOString(),
        toolName: "external.action.prepare",
        toolVersion: "0.1.0",
        currentUrl: staleUrl,
        links: [],
        replaySteps: [
          { action: "fill", selector: "#comment", value: "wrong stale page command" },
        ],
      },
    },
  });
  const runWithStaleSession = await runs.get(run.id);
  assert.ok(runWithStaleSession);
  const recorder = new ActionProposalAuditRecorder(
    runs,
    new AuditService(new InMemoryAuditEventStore()),
  );

  await new ActionProposalPreparationRunner({
    runs,
    artifacts: undefined,
    toolRegistry: registry,
    recorder,
    approvedProfileFields: ["contact_name"],
    profileValues: [
      {
        field: "contact_name",
        source: "user_profile",
        value: "Local Admin",
        valuePreview: "Local Admin",
      },
    ],
  }).prepare({ run: runWithStaleSession, proposal, rawBody: { mode: "replay" } });

  assert.equal(inputs[0]?.url, bookingUrl);
  const commands = inputs[0]?.commands as Record<string, unknown>[];
  assert.equal(commands.some((command) => command.selector === "#comment"), false);
  assert.equal(commands.some((command) => command.source === "approved_profile"), false);
});

function appointmentProposal(
  runId: string,
  overrides: Partial<ExternalActionProposal> & {
    sourceUrls: string[];
    targetUrl: string;
  },
): ExternalActionProposal {
  return {
    id: `action_${runId}_payload_link`,
    runId,
    actionType: "appointment",
    status: "proposed",
    title: "Appointment proposal: Memento Barbershop",
    summary: "prepare appointment",
    proposedAction: "Prepare appointment after approval.",
    target: "Memento Barbershop",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: ["research", "prepare"],
    prohibitedWithoutApproval: ["submit final appointment"],
    artifactIds: [],
    preparation: {
      stage: "prepared_for_approval",
      target: "Memento Barbershop",
      targetUrl: overrides.targetUrl,
      objective: "Prepare appointment.",
      collectedInputs: [{ label: "service", value: "Haircut", source: "user_request" }],
      missingInputs: [],
      commitBoundary: "Do not submit final appointment.",
      operatorChecklist: ["Review"],
      proofPlan: ["screenshot"],
    },
    createdAt: new Date().toISOString(),
    createdBy: "base-agent",
    ...overrides,
  };
}
