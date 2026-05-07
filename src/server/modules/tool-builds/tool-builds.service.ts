import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  isRecord,
  parseOptionalReason,
  parseOptionalStringArray,
  parseOptionalText,
  parseRequiredText,
  parseRequiredStringArray,
  sanitizeAuditMetadata,
} from "../../common/parsers.js";
import { parseStartupMode } from "../../common/parsers.js";
import type {
  ToolBuildQaReport,
  ToolBuildReviewReport,
  ToolBuildRequest,
  ToolBuildRequestStore,
} from "../../../tools/toolBuildRequestStore.js";
import type { ToolBuildWorkflow } from "../../../tools/toolBuildWorkflow.js";
import { AuditService } from "../../common/services/audit.service.js";
import { ToolBuildInputFinalizerService } from "../../common/services/tool-build-input-finalizer.service.js";
import { ToolReworkCoordinatorService } from "../../common/services/tool-rework-coordinator.service.js";
import {
  RELOAD_GENERATED_TOOLS,
  TOOL_BUILD_REQUEST_STORE,
  TOOL_BUILD_WORKFLOW,
} from "../../persistence/tokens.js";

type ToolBuildRequestInput = {
  capability: string;
  displayName?: string;
  reason: string;
  sourceRunId?: string;
  sourceSpanId?: string;
  taskSummary?: string;
  desiredToolName?: string;
  requiredInputs?: string[];
  requiredOutputs?: string[];
  qaCriteria?: string[];
  credentialHandles?: string[];
  credentialNotes?: string;
  reworkOf?: string;
  feedback?: string;
  replacesToolName?: string;
  replacesVersion?: string;
  startupMode?: ReturnType<typeof parseStartupMode>;
};

@Injectable()
export class ToolBuildsService {
  constructor(
    @Inject(TOOL_BUILD_REQUEST_STORE) private readonly store: ToolBuildRequestStore | undefined,
    @Inject(TOOL_BUILD_WORKFLOW) private readonly workflow: ToolBuildWorkflow | undefined,
    @Inject(RELOAD_GENERATED_TOOLS) private readonly reload: (() => Promise<void>) | undefined,
    private readonly audit: AuditService,
    private readonly finalizer: ToolBuildInputFinalizerService,
    private readonly reworkCoordinator: ToolReworkCoordinatorService,
  ) {}

  async list(): Promise<ToolBuildRequest[]> {
    return this.store ? this.store.list() : [];
  }

  async get(id: string): Promise<ToolBuildRequest> {
    if (!this.store) {
      throw new ServiceUnavailableException("Tool build request store is not configured");
    }
    const buildRequest = await this.store.get(id);
    if (!buildRequest) throw new NotFoundException("Tool build request not found");
    return buildRequest;
  }

  async create(rawBody: unknown): Promise<ToolBuildRequest> {
    if (!this.store) {
      throw new ServiceUnavailableException("Tool build request store is not configured");
    }
    let input: ToolBuildRequestInput;
    try {
      input = this.parseInput(rawBody);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid tool build request",
      );
    }
    try {
      input = await this.finalizer.finalize(input);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid tool build request",
      );
    }
    const buildRequest = await this.store.create(input);
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool_build.requested",
      targetType: "tool_build_request",
      targetId: buildRequest.id,
      status: "pending",
      runId: buildRequest.sourceRunId,
      summary: `Tool build requested: ${buildRequest.capability}`,
      metadata: {
        capability: buildRequest.capability,
        displayName: buildRequest.displayName,
        desiredToolName: buildRequest.desiredToolName,
        credentialHandles: buildRequest.credentialHandles,
        modulePath: buildRequest.contract.modulePath,
      },
    });
    return buildRequest;
  }

  async updateStatus(id: string, rawBody: unknown): Promise<ToolBuildRequest> {
    if (!this.store) {
      throw new ServiceUnavailableException("Tool build request store is not configured");
    }
    let update: {
      status: "requested" | "building" | "qa_failed" | "qa_passed" | "registered" | "blocked";
      statusDetail?: string;
      registeredToolName?: string;
      qaReport?: ToolBuildQaReport;
    };
    try {
      update = this.parseStatusUpdate(rawBody);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid tool build request update",
      );
    }
    try {
      const buildRequest = await this.store.updateStatus(id, update);
      if (buildRequest.status === "registered") {
        await this.reworkCoordinator.notifyBuildRegistered(
          buildRequest.id,
          buildRequest.registeredToolName,
          buildRequest.contract?.version,
          { actorId: "user-admin", actorType: "user" },
        );
      }
      return buildRequest;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid tool build request update";
      throw message.includes("was not found")
        ? new NotFoundException(message)
        : new BadRequestException(message);
    }
  }

  async delete(id: string): Promise<{ deleted: true; request: ToolBuildRequest }> {
    if (!this.store) {
      throw new ServiceUnavailableException("Tool build request store is not configured");
    }
    const existing = await this.store.get(id);
    if (!existing) throw new NotFoundException("Tool build request not found");
    const deleted = await this.store.delete(id);
    if (!deleted) throw new NotFoundException("Tool build request not found");
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool_build.deleted",
      targetType: "tool_build_request",
      targetId: id,
      status: "success",
      runId: existing.sourceRunId,
      summary: `Tool build deleted: ${existing.capability}`,
      metadata: { capability: existing.capability, previousStatus: existing.status },
    });
    return { deleted: true, request: existing };
  }

  async stop(id: string, rawBody: unknown): Promise<ToolBuildRequest> {
    if (!this.store) {
      throw new ServiceUnavailableException("Tool build request store is not configured");
    }
    const stopReason = parseOptionalReason(rawBody);
    let buildRequest: ToolBuildRequest;
    try {
      buildRequest = await this.store.updateStatus(id, {
        status: "blocked",
        statusDetail: stopReason || "Stopped by operator. It can be deleted or reworked into a new request.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid tool build stop request";
      throw message.includes("was not found")
        ? new NotFoundException(message)
        : new BadRequestException(message);
    }
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool_build.stopped",
      targetType: "tool_build_request",
      targetId: buildRequest.id,
      status: "success",
      runId: buildRequest.sourceRunId,
      summary: `Tool build stopped: ${buildRequest.capability}`,
      metadata: { capability: buildRequest.capability, reason: buildRequest.statusDetail },
    });
    return buildRequest;
  }

  async rework(originalId: string, rawBody: unknown) {
    if (!this.store) {
      throw new ServiceUnavailableException("Tool build request store is not configured");
    }
    const original = await this.store.get(originalId);
    if (!original) throw new NotFoundException("Tool build request not found");
    let feedback: string;
    try {
      if (!isRecord(rawBody)) throw new Error("tool build rework request must be an object");
      if (typeof rawBody.feedback !== "string" || rawBody.feedback.trim() === "") {
        throw new Error("feedback is required");
      }
      feedback = rawBody.feedback.trim();
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid tool build rework request",
      );
    }
    let reworkRequestInput: ToolBuildRequestInput;
    try {
      reworkRequestInput = await this.finalizer.finalize({
        capability: original.capability,
        displayName: original.displayName,
        reason: this.formatReworkReason(original, feedback),
        sourceRunId: original.sourceRunId,
        sourceSpanId: original.sourceSpanId,
        taskSummary: original.taskSummary,
        desiredToolName: original.desiredToolName,
        requiredInputs: original.requiredInputs,
        requiredOutputs: original.requiredOutputs,
        qaCriteria: this.uniqueStrings([
          ...(original.qaCriteria ?? []),
          `Rework feedback must be addressed: ${feedback}`,
        ]),
        credentialHandles: original.credentialHandles,
        credentialNotes: original.credentialNotes,
        reworkOf: original.id,
        feedback,
        replacesToolName: original.replacesToolName,
        replacesVersion: original.replacesVersion,
        startupMode: original.contract.startupMode,
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid tool build rework request",
      );
    }
    const reworkRequest = await this.store.create(reworkRequestInput);
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool_build.rework_requested",
      targetType: "tool_build_request",
      targetId: reworkRequest.id,
      status: "pending",
      runId: reworkRequest.sourceRunId,
      summary: `Tool build rework requested: ${reworkRequest.capability}`,
      metadata: { originalRequestId: original.id, feedback },
    });
    return { request: reworkRequest, original };
  }

  async run(id: string) {
    if (!this.workflow) {
      throw new ServiceUnavailableException("Tool build workflow is not configured");
    }
    const result = await this.workflow.runOnce(id);
    if (result.request.status === "registered" && !result.activationReport) {
      await this.reload?.();
    }
    if (result.request.status === "registered") {
      await this.reworkCoordinator.notifyBuildRegistered(
        result.request.id,
        result.registeredToolName ?? result.request.registeredToolName,
        result.request.contract?.version,
        { actorId: "user-admin", actorType: "user" },
      );
    }
    return result;
  }

  private parseInput(value: unknown): ToolBuildRequestInput {
    if (!isRecord(value)) {
      throw new Error("tool build request must be an object");
    }
    if (typeof value.reason !== "string" || value.reason.trim() === "") {
      throw new Error("reason is required");
    }
    const reason = value.reason.trim();
    const displayName = parseOptionalText(value.displayName);
    const capability = parseOptionalText(value.capability) ?? this.inferCapability(displayName, reason);
    return {
      capability,
      displayName,
      reason,
      sourceRunId: typeof value.sourceRunId === "string" ? value.sourceRunId : undefined,
      sourceSpanId: typeof value.sourceSpanId === "string" ? value.sourceSpanId : undefined,
      taskSummary: typeof value.taskSummary === "string" ? value.taskSummary : undefined,
      desiredToolName: typeof value.desiredToolName === "string" ? value.desiredToolName : undefined,
      requiredInputs: parseOptionalStringArray(value.requiredInputs, "requiredInputs"),
      requiredOutputs: parseOptionalStringArray(value.requiredOutputs, "requiredOutputs"),
      qaCriteria: parseOptionalStringArray(value.qaCriteria, "qaCriteria"),
      credentialHandles: parseOptionalStringArray(value.credentialHandles, "credentialHandles"),
      credentialNotes: parseOptionalText(value.credentialNotes),
      reworkOf: typeof value.reworkOf === "string" ? value.reworkOf : undefined,
      feedback: typeof value.feedback === "string" ? value.feedback : undefined,
      replacesToolName: typeof value.replacesToolName === "string" ? value.replacesToolName : undefined,
      replacesVersion: typeof value.replacesVersion === "string" ? value.replacesVersion : undefined,
      startupMode: parseStartupMode(value.startupMode),
    };
  }

  private parseStatusUpdate(value: unknown) {
    if (!isRecord(value)) {
      throw new Error("tool build request update must be an object");
    }
    const status = String(value.status ?? "");
    if (!["requested", "building", "qa_failed", "qa_passed", "registered", "blocked"].includes(status)) {
      throw new Error("status is invalid");
    }
    return {
      status: status as "requested" | "building" | "qa_failed" | "qa_passed" | "registered" | "blocked",
      statusDetail: typeof value.statusDetail === "string" ? value.statusDetail.trim() : undefined,
      registeredToolName:
        typeof value.registeredToolName === "string" ? value.registeredToolName.trim() : undefined,
      qaReport: this.parseOptionalQaReport(value.qaReport),
    };
  }

  private parseOptionalQaReport(value: unknown): ToolBuildQaReport | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) {
      throw new Error("qaReport must be an object");
    }
    if (typeof value.ok !== "boolean") {
      throw new Error("qaReport.ok must be a boolean");
    }
    if (typeof value.summary !== "string" || value.summary.trim() === "") {
      throw new Error("qaReport.summary is required");
    }
    return {
      ok: value.ok,
      summary: value.summary.trim(),
      checks: parseRequiredStringArray(value.checks, "qaReport.checks"),
      artifacts: parseOptionalStringArray(value.artifacts, "qaReport.artifacts"),
      reviews: this.parseOptionalReviews(value.reviews),
    };
  }

  private parseOptionalReviews(value: unknown): ToolBuildReviewReport[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error("qaReport.reviews must be an array");
    return value.map((item, index) => {
      if (!isRecord(item)) throw new Error(`qaReport.reviews[${index}] must be an object`);
      if (item.kind !== "code" && item.kind !== "behavior") {
        throw new Error(`qaReport.reviews[${index}].kind is invalid`);
      }
      if (item.decision !== "pass" && item.decision !== "needs_revision" && item.decision !== "fail") {
        throw new Error(`qaReport.reviews[${index}].decision is invalid`);
      }
      if (typeof item.summary !== "string" || item.summary.trim() === "") {
        throw new Error(`qaReport.reviews[${index}].summary is required`);
      }
      return {
        kind: item.kind as "code" | "behavior",
        decision: item.decision as "pass" | "needs_revision" | "fail",
        summary: item.summary.trim(),
        findings: parseOptionalStringArray(item.findings, `qaReport.reviews[${index}].findings`) ?? [],
      };
    });
  }

  private inferCapability(displayName: string | undefined, reason: string): string {
    const text = `${displayName ?? ""} ${reason}`.toLowerCase();
    const slug = this.slugify(displayName ?? reason);
    if (/\b(browser|screenshot|screen capture|скрин|скриншот)\b/.test(text)) return "browser-screenshot";
    if (/\b(api|http|https|endpoint|openapi|swagger|webhook|bot|token|key|ключ)\b/.test(text)) {
      return `api.${slug}`;
    }
    return `tool.${slug}`;
  }

  private slugify(value: string): string {
    return (
      value
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/[^a-z0-9а-яё]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .split("-")
        .filter(Boolean)
        .slice(0, 8)
        .join("-")
        .replace(/[^a-z0-9-]+/g, "")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "tool"
    );
  }

  private formatReworkReason(
    original: ToolBuildRequest,
    feedback: string,
  ): string {
    const qaReport = original.qaReport;
    const reviewLines = qaReport?.reviews?.flatMap((review: ToolBuildReviewReport) => [
      `${review.kind} review: ${review.decision} - ${review.summary}`,
      ...review.findings.map((finding: string) => `  - ${finding}`),
    ]);
    const context = [
      `Original request ${original.id}`,
      `Status: ${original.status}`,
      original.statusDetail ? `Status detail: ${original.statusDetail}` : undefined,
      original.registeredToolName ? `Registered tool: ${original.registeredToolName}` : undefined,
      qaReport ? `QA summary: ${qaReport.summary}` : undefined,
      ...(qaReport?.checks?.length ? ["QA checks:", ...qaReport.checks.map((check: string) => `- ${check}`)] : []),
      ...(reviewLines?.length ? ["Reviews:", ...reviewLines] : []),
    ].filter(Boolean);
    return [
      original.reason,
      "Original build context:",
      ...context,
      `Rework feedback for ${original.id}:`,
      feedback,
    ].join("\n\n");
  }

  private uniqueStrings(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }
}
