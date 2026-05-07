import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  isRecord,
  parseOptionalStringArray,
  parseOptionalText,
  parseRequiredText,
  sanitizeAuditMetadata,
  sanitizeObject,
} from "../../common/parsers.js";
import { ToolReworkCoordinatorService } from "../../common/services/tool-rework-coordinator.service.js";
import {
  TOOL_INVESTIGATION_SOURCES,
  TOOL_INVESTIGATION_STATUSES,
  type ToolInvestigationContextBundle,
  type ToolInvestigationCreateInput,
  type ToolInvestigationRecord,
  type ToolInvestigationSource,
  type ToolInvestigationStatus,
  type ToolInvestigationStore,
  type ToolInvestigationUpdateInput,
} from "../../../tools/toolInvestigationStore.js";
import { TOOL_INVESTIGATION_STORE } from "../../persistence/tokens.js";

@Injectable()
export class ToolInvestigationsService {
  constructor(
    @Inject(TOOL_INVESTIGATION_STORE) private readonly store: ToolInvestigationStore | undefined,
    private readonly rework: ToolReworkCoordinatorService,
  ) {}

  async list(): Promise<ToolInvestigationRecord[]> {
    if (!this.store) throw new ServiceUnavailableException("Tool investigation store is not configured");
    return this.store.list();
  }

  async get(id: string): Promise<ToolInvestigationRecord> {
    if (!this.store) throw new ServiceUnavailableException("Tool investigation store is not configured");
    const record = await this.store.get(id);
    if (!record) throw new NotFoundException("Tool investigation not found");
    return record;
  }

  async create(rawBody: unknown): Promise<ToolInvestigationRecord> {
    if (!this.store) throw new ServiceUnavailableException("Tool investigation store is not configured");
    let input: ToolInvestigationCreateInput;
    try {
      input = this.parseCreateInput(rawBody);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid tool investigation",
      );
    }
    return this.store.create(input);
  }

  async update(id: string, rawBody: unknown): Promise<ToolInvestigationRecord> {
    if (!this.store) throw new ServiceUnavailableException("Tool investigation store is not configured");
    let update: ToolInvestigationUpdateInput;
    try {
      update = this.parseUpdateInput(rawBody);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid tool investigation update",
      );
    }
    try {
      return await this.store.update(id, update);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid tool investigation update";
      throw message.includes("was not found")
        ? new NotFoundException(message)
        : new BadRequestException(message);
    }
  }

  async promote(id: string, rawBody: unknown) {
    if (!this.store) throw new ServiceUnavailableException("Tool investigation store is not configured");
    const investigation = await this.store.get(id);
    if (!investigation) throw new NotFoundException("Tool investigation not found");
    const override = this.parsePromoteOverride(rawBody);
    const result = await this.rework.requestImprovement({
      source: "investigation_promote",
      investigationId: id,
      operatorComment: override.operatorComment,
      override,
    });
    if (result.status === "failed_to_request") {
      throw new BadRequestException({
        error: result.error ?? "Tool investigation promotion failed",
        code: result.errorCode,
      });
    }
    if (result.status === "unavailable") {
      throw new ServiceUnavailableException(result.error ?? "Tool investigation promotion is not configured");
    }
    return {
      investigation: result.investigation,
      request: result.buildRequest,
      wait: result.wait,
    };
  }

  private parsePromoteOverride(value: unknown): {
    capability?: string;
    desiredToolName?: string;
    operatorComment?: string;
  } {
    if (value === undefined || value === null) return {};
    if (!isRecord(value)) throw new BadRequestException("tool investigation promote request must be an object");
    return {
      capability: parseOptionalText(value.capability),
      desiredToolName: parseOptionalText(value.desiredToolName),
      operatorComment: parseOptionalText(value.operatorComment),
    };
  }

  private parseCreateInput(value: unknown): ToolInvestigationCreateInput {
    if (!isRecord(value)) throw new Error("tool investigation must be an object");
    const source = value.source;
    if (typeof source !== "string" || !TOOL_INVESTIGATION_SOURCES.includes(source as ToolInvestigationSource)) {
      throw new Error(`source is required and must be one of ${TOOL_INVESTIGATION_SOURCES.join(", ")}`);
    }
    return {
      source: source as ToolInvestigationSource,
      title: parseRequiredText(value.title, "title"),
      operatorComment: parseOptionalText(value.operatorComment),
      runId: parseOptionalText(value.runId),
      spanId: parseOptionalText(value.spanId),
      toolName: parseOptionalText(value.toolName),
      toolVersion: parseOptionalText(value.toolVersion),
      artifactIds: parseOptionalStringArray(value.artifactIds, "artifactIds"),
      contextBundle: this.parseContextBundle(value.contextBundle),
    };
  }

  private parseUpdateInput(value: unknown): ToolInvestigationUpdateInput {
    if (!isRecord(value)) throw new Error("tool investigation update must be an object");
    const update: ToolInvestigationUpdateInput = {};
    if (value.status !== undefined) {
      if (
        typeof value.status !== "string" ||
        !TOOL_INVESTIGATION_STATUSES.includes(value.status as ToolInvestigationStatus)
      ) {
        throw new Error(`status must be one of ${TOOL_INVESTIGATION_STATUSES.join(", ")}`);
      }
      update.status = value.status as ToolInvestigationStatus;
    }
    if (value.operatorComment !== undefined) {
      update.operatorComment = parseOptionalText(value.operatorComment);
    }
    if (value.linkedBuildRequestId !== undefined) {
      if (value.linkedBuildRequestId === null) {
        update.linkedBuildRequestId = null;
      } else {
        const parsed = parseOptionalText(value.linkedBuildRequestId);
        update.linkedBuildRequestId = parsed === undefined ? null : parsed;
      }
    }
    if (value.artifactIds !== undefined) {
      update.artifactIds = parseOptionalStringArray(value.artifactIds, "artifactIds") ?? [];
    }
    if (value.contextBundle !== undefined) {
      update.contextBundle = this.parseContextBundle(value.contextBundle);
    }
    return update;
  }

  private parseContextBundle(value: unknown): ToolInvestigationContextBundle | undefined {
    if (value === undefined || value === null) return undefined;
    if (!isRecord(value)) throw new Error("contextBundle must be an object");
    const bundle: ToolInvestigationContextBundle = {
      taskPrompt: parseOptionalText(value.taskPrompt),
      runTitle: parseOptionalText(value.runTitle),
      actor: parseOptionalText(value.actor),
      activity: parseOptionalText(value.activity),
      status: parseOptionalText(value.status),
      caller: parseOptionalText(value.caller),
      inputSummary: parseOptionalText(value.inputSummary),
      outputSummary: parseOptionalText(value.outputSummary),
      error: parseOptionalText(value.error),
    };
    if (isRecord(value.artifactQa)) bundle.artifactQa = sanitizeObject(value.artifactQa);
    if (isRecord(value.toolSettingsSummary)) {
      bundle.toolSettingsSummary = sanitizeObject(value.toolSettingsSummary);
    }
    if (Array.isArray(value.relatedArtifactRefs)) {
      bundle.relatedArtifactRefs = value.relatedArtifactRefs
        .filter(isRecord)
        .map((ref) => ({
          id: parseOptionalText(ref.id),
          filename: parseOptionalText(ref.filename),
          mimeType: parseOptionalText(ref.mimeType),
          url: parseOptionalText(ref.url),
        }));
    }
    if (Array.isArray(value.notes)) {
      const notes = parseOptionalStringArray(value.notes, "contextBundle.notes");
      if (notes && notes.length > 0) bundle.notes = notes;
    }
    if (isRecord(value.extra)) bundle.extra = sanitizeObject(value.extra);
    return bundle;
  }
}
