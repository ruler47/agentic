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

test("external action preparation treats optional browser command failures as warnings", async () => {
  const runs = new InMemoryRunStore();
  const registry = new ToolRegistry();
  registry.register({
    name: "browser.operate",
    version: "0.1.0",
    description: "Browser prepare fixture.",
    capabilities: ["browser-operate"],
    inputSchema: { type: "object", properties: {}, required: [] },
    async run(input) {
      assert.equal(input.prepareOnly, true);
      const commands = input.commands as Record<string, unknown>[];
      assert.equal(commands.some((command) => command.optional === true), true);
      return {
        ok: false,
        content: "browser.operate failed at command 2 (fill): selector timed out",
        data: {
          finalUrl: input.url,
          pageTitle: "Provider",
          extractedText: "Book appointment. Choose a service.",
          links: [],
          steps: [
            { index: 0, action: "dismissDialogs", ok: true },
            { index: 1, action: "fill", ok: false, optional: true },
          ],
        },
      };
    },
  });
  const run = await runs.create("prepare optional fill", {
    instanceId: "instance-local",
    requesterUserId: "user-admin",
    channel: "web",
  });
  const proposal: ExternalActionProposal = {
    id: `action_${run.id}_optional_fill`,
    runId: run.id,
    actionType: "appointment",
    status: "approved",
    title: "Appointment proposal",
    summary: "Prepare appointment.",
    proposedAction: "Prepare appointment after approval.",
    target: "Barber",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: ["prepare"],
    prohibitedWithoutApproval: ["submit final appointment"],
    sourceUrls: ["https://barber.example/book"],
    artifactIds: [],
    preparation: {
      stage: "prepared_for_approval",
      target: "Barber",
      targetUrl: "https://barber.example/book",
      objective: "Open booking page and stop before final submit.",
      collectedInputs: [
        { label: "date_or_time", value: "after 14:00", source: "user_request" },
      ],
      missingInputs: [],
      commitBoundary: "Do not submit final appointment.",
      operatorChecklist: ["Review proof"],
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

  const updated = await runs.get(run.id);
  const failed = updated?.events.find(
    (event) => event.type === "external-action-preparation-failed",
  );
  const completed = updated?.events.find(
    (event) => event.type === "external-action-preparation-completed",
  );
  assert.equal(failed, undefined);
  assert.equal(completed?.type, "external-action-preparation-completed");
  const payload = completed?.payload as
    | { preparedSession?: { warnings?: string[] } }
    | undefined;
  assert.ok(
    payload?.preparedSession?.warnings?.some((warning) =>
      warning.includes("Optional preparation command failed"),
    ),
  );
});

test("prepared session surfaces provider phone verification as resumable blocker", () => {
  const proposal: ExternalActionProposal = {
    id: "action_run_1_sms_verification",
    runId: "run_1",
    actionType: "appointment",
    status: "approved",
    title: "Appointment proposal",
    summary: "prepare appointment",
    proposedAction: "Schedule an appointment",
    target: "Booksy provider",
    approvalRequired: true,
    userExplicitlyForbidsAction: false,
    allowedWithoutApproval: ["research", "prepare"],
    prohibitedWithoutApproval: ["submit final appointment"],
    sourceUrls: ["https://booksy.example/provider"],
    artifactIds: [],
    preparation: {
      stage: "ready_to_commit",
      target: "Booksy provider",
      targetUrl: "https://booksy.example/provider",
      objective: "Prepare appointment.",
      collectedInputs: [
        { label: "service", value: "Haircut", source: "user_request" },
        { label: "date_or_time", value: "2026-06-27 14:00", source: "user_request" },
      ],
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
    toolName: "browser.operate",
    toolVersion: "0.1.0",
    toolInput: { url: "https://booksy.example/provider", commands: [] },
    data: {
      finalUrl: "https://booksy.example/provider",
      extractedText:
        "Crea tu cuenta de Booksy. Nombre. Apellido. Número de teléfono. Enviaremos un código de confirmación a tu número de teléfono.",
      forms: [
        {
          fields: [
            { label: "Número de teléfono", type: "tel", required: true },
            { label: "Contraseña", type: "password", required: true },
          ],
          submitCandidates: [{ text: "Continuar", selector: "#continue" }],
        },
      ],
    },
    artifactIds: ["artifact-1"],
  });

  assert.equal(session.actionDraft?.status, "needs_more_input");
  assert.ok(
    session.actionDraft?.missingBeforeCommit.includes("provider phone/SMS verification"),
  );
  assert.ok(
    session.requiredOperatorInputs?.some((input) => input.kind === "sms_code"),
  );
  assert.ok(
    session.actionDraft?.requiredOperatorInputs?.some((input) => input.kind === "sms_code"),
  );
  assert.match(session.actionDraft?.operatorNextStep ?? "", /phone\/SMS verification/i);
});
