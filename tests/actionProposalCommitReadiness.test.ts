import test from "node:test";
import assert from "node:assert/strict";
import { externalActionCommitBlockReason } from "../src/server/modules/runs/action-proposals.shared.js";
import { findExistingExternalActionCommitExecutor } from "../src/server/modules/runs/action-proposal-executor-matching.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/tool.js";
import type {
  ExternalActionCommitExecutor,
  ExternalActionRequiredOperatorInput,
} from "../src/types.js";

test("external action commit blocks prepared sessions without actionable submit controls", () => {
  const registry = new ToolRegistry();
  registry.register(commitTool());
  const reason = externalActionCommitBlockReason(
    commitExecutor({
      commitCandidates: [{ reason: "submit reservation" }],
    }),
    registry,
  );

  assert.match(reason ?? "", /concrete external submit control/i);
});

test("external action commit blocks prepared sessions whose draft is not review-ready", () => {
  const registry = new ToolRegistry();
  registry.register(commitTool());
  const reason = externalActionCommitBlockReason(
    commitExecutor({
      commitCandidates: [{ label: "Confirm", reason: "observed submit control" }],
      actionDraftStatus: "needs_more_input",
      missingBeforeCommit: ["proof artifact"],
      proofArtifactIds: [],
    }),
    registry,
  );

  assert.match(reason ?? "", /not ready.*proof artifact/i);
});

test("external action commit blocks prepared sessions with required operator inputs", () => {
  const registry = new ToolRegistry();
  registry.register(commitTool());
  const reason = externalActionCommitBlockReason(
    commitExecutor({
      commitCandidates: [{ label: "Confirm", reason: "observed submit control" }],
      requiredOperatorInputs: [
        {
          id: "verification:sms-code",
          kind: "sms_code",
          label: "SMS verification code",
          reason: "Provider requires one-time verification.",
          source: "provider_text",
          sensitivity: "secret",
          resumable: true,
        },
      ],
    }),
    registry,
  );

  assert.match(reason ?? "", /requires operator input.*SMS verification code/i);
});

test("external action commit accepts prepared sessions with proof and concrete submit controls", () => {
  const registry = new ToolRegistry();
  registry.register(commitTool());
  const reason = externalActionCommitBlockReason(
    commitExecutor({
      commitCandidates: [{ label: "Confirm", reason: "observed submit control" }],
    }),
    registry,
  );

  assert.equal(reason, undefined);
});

test("external action commit blocks generated executor without prepared session", () => {
  const registry = new ToolRegistry();
  registry.register(commitTool());
  const reason = externalActionCommitBlockReason(
    {
      kind: "generated_tool",
      risk: "high",
      ready: true,
      toolName: "external.action.commit",
      toolVersion: "0.1.2",
      reason: "tool is registered",
      toolInput: {
        proposalId: "action-1",
        commitPayload: { target: "Booksy" },
      },
    },
    registry,
  );

  assert.match(reason ?? "", /missing a prepared external-action session/i);
});

test("existing commit executor is not ready until preparation context exists", () => {
  const registry = new ToolRegistry();
  registry.register(commitTool());
  const executor = findExistingExternalActionCommitExecutor(registry, {
    toolName: "external.action.commit",
    toolVersion: "0.1.0",
    description: "Commit appointment",
    request: "Commit appointment",
    capabilities: ["external-action-commit", "external-action-commit-generic"],
    risk: "high",
    toolInput: {
      proposalId: "action-1",
      commitPayload: { target: "Booksy" },
    },
    expectedProof: ["provider confirmation"],
    behaviorExamples: [],
  });

  assert.equal(executor?.ready, false);
  assert.match(executor?.reason ?? "", /no prepared external-action session/i);
});

function commitTool(): Tool {
  return {
    name: "external.action.commit",
    version: "0.1.2",
    description: "Generic commit executor.",
    capabilities: ["external-action-commit", "external-action-commit-generic"],
    async run() {
      return { ok: true, content: "ok" };
    },
  };
}

function commitExecutor(input: {
  commitCandidates: Array<{ label?: string; selector?: string; reason: string }>;
  actionDraftStatus?: "needs_preparation" | "needs_more_input" | "ready_for_operator_review";
  missingBeforeCommit?: string[];
  proofArtifactIds?: string[];
  requiredOperatorInputs?: ExternalActionRequiredOperatorInput[];
}): ExternalActionCommitExecutor {
  const proofArtifactIds = input.proofArtifactIds ?? ["artifact-1"];
  return {
    kind: "generated_tool",
    risk: "high",
    ready: true,
    toolName: "external.action.commit",
    toolVersion: "0.1.2",
    reason: "ready",
    toolInput: {
      preparedSession: {
        preparedAt: "2026-05-24T00:00:00.000Z",
        toolName: "browser.operate",
        currentUrl: "https://example.com/reserve",
        links: [],
        formFields: [],
        formFieldGaps: [],
        filledFields: [],
        replaySteps: [],
        artifactIds: ["artifact-1"],
        proofArtifactIds,
        warnings: [],
        requiredOperatorInputs: input.requiredOperatorInputs,
        commitCandidates: input.commitCandidates,
        actionDraft: {
          status: input.actionDraftStatus ?? "ready_for_operator_review",
          action: "Schedule an appointment",
          dataPreview: [],
          missingBeforeCommit: input.missingBeforeCommit ?? [],
          requiredOperatorInputs: input.requiredOperatorInputs,
          proofArtifactIds,
          commitControls: input.commitCandidates,
          operatorNextStep: "Review and submit.",
          postCommitReportRequirements: [],
        },
      },
    },
  };
}
