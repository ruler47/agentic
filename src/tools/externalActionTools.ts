import { randomUUID } from "node:crypto";
import { Tool, ToolInput, ToolResult } from "./tool.js";

export class ExternalActionPrepareTool implements Tool {
  readonly name = "external.action.prepare";
  readonly version = "1.0.0";
  readonly description =
    "Prepares an auditable external action draft without submitting it: target, data, proof requirements, commit boundary, and approval plan.";
  readonly capabilities = ["external-action-prepare", "approval-required", "form-preparation", "commit-boundary"];
  readonly startupMode = "always-on" as const;
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      goal: { type: "string" },
      targetName: { type: "string" },
      targetUrl: { type: "string" },
      action: { type: "string" },
      data: { type: "object" },
      commitBoundary: { type: "string" },
      proofRequired: { type: "boolean", default: true },
      approvalMode: { type: "string", enum: ["manual", "automode"], default: "manual" },
    },
    required: ["goal", "action"],
  };
  readonly outputSchema = {
    type: "object" as const,
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: { type: "object" },
    },
    required: ["ok", "content"],
  };

  async healthcheck() {
    return { ok: true, detail: "external.action.prepare is available." };
  }

  async run(input: ToolInput): Promise<ToolResult> {
    const goal = stringInput(input.goal);
    const action = stringInput(input.action);
    if (!goal || !action) return { ok: false, content: "Provide goal and action." };

    const preparedActionId = `external_action_${randomUUID()}`;
    const draft = {
      preparedActionId,
      goal,
      targetName: stringInput(input.targetName) || "external provider",
      targetUrl: stringInput(input.targetUrl) || undefined,
      action,
      dataPreview: redactSensitive(input.data),
      commitBoundary:
        stringInput(input.commitBoundary) ||
        "External state changes only after explicit approval and external.action.commit.",
      proofRequired: input.proofRequired !== false,
      approvalMode: input.approvalMode === "automode" ? "automode" : "manual",
      status: "prepared",
      requiredFinalReport: [
        "whether the external action succeeded or failed",
        "exact submitted data summary with sensitive values redacted",
        "provider confirmation id/status or durable response when available",
        "post-submit proof artifact or explanation why proof could not be captured",
      ],
    };

    return {
      ok: true,
      content: [
        `Prepared external action ${preparedActionId}.`,
        `Target: ${draft.targetName}`,
        `Action: ${draft.action}`,
        `Commit boundary: ${draft.commitBoundary}`,
      ].join("\n"),
      data: draft,
    };
  }
}

export class ExternalActionCommitTool implements Tool {
  readonly name = "external.action.commit";
  readonly version = "1.0.0";
  readonly description =
    "Commits a previously prepared external action after approval. Provider executors can attach real submit implementations; fixture mode is available for tests.";
  readonly capabilities = [
    "external-action-commit",
    "external-action-commit-generic",
    "approval-consumption",
    "external-submit",
    "finalize-action",
  ];
  readonly startupMode = "always-on" as const;
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      preparedActionId: { type: "string" },
      approved: { type: "boolean" },
      provider: { type: "string" },
      commitPayload: { type: "object" },
      fixtureConfirmation: { type: "string" },
      proofArtifactIds: { type: "array", items: { type: "string" } },
    },
    required: ["preparedActionId", "approved"],
  };
  readonly outputSchema = {
    type: "object" as const,
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: { type: "object" },
    },
    required: ["ok", "content"],
  };

  async healthcheck() {
    return { ok: true, detail: "external.action.commit is available." };
  }

  async run(input: ToolInput): Promise<ToolResult> {
    const preparedActionId = stringInput(input.preparedActionId);
    if (!preparedActionId) return { ok: false, content: "Missing preparedActionId." };
    if (input.approved !== true) {
      return { ok: false, content: "External action was not committed because approved=true was not provided." };
    }

    const provider = stringInput(input.provider) || "generic";
    const fixtureConfirmation = stringInput(input.fixtureConfirmation);
    if (provider === "fixture" || fixtureConfirmation) {
      const confirmationId = fixtureConfirmation || `fixture-${preparedActionId}`;
      return {
        ok: true,
        content: `Fixture external action committed. Confirmation: ${confirmationId}`,
        data: {
          preparedActionId,
          provider: "fixture",
          confirmationId,
          submittedData: redactSensitive(input.commitPayload),
          proofArtifactIds: Array.isArray(input.proofArtifactIds) ? input.proofArtifactIds.map(String) : [],
        },
      };
    }

    return {
      ok: false,
      content:
        "No real provider executor was attached for this prepared action. Use browser.operate/browser.screenshot to prepare proof, or attach a provider-specific executor before final commit.",
      data: {
        preparedActionId,
        provider,
        submittedDataPreview: redactSensitive(input.commitPayload),
        committed: false,
      },
    };
  }
}

function stringInput(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      /token|secret|password|api[-_]?key|authorization|cookie/i.test(key) ? "[redacted]" : redactSensitive(nested),
    ]),
  );
}
