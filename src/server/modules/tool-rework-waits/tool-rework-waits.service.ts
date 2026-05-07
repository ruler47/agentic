import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  isRecord,
  parseNullableText,
  parseOptionalText,
  parseRequiredText,
} from "../../common/parsers.js";
import {
  TOOL_REWORK_WAIT_STATUSES,
  type ToolReworkWaitCreateInput,
  type ToolReworkWaitRecord,
  type ToolReworkWaitStatus,
  type ToolReworkWaitStore,
  type ToolReworkWaitUpdateInput,
} from "../../../runs/toolReworkWaitStore.js";
import { TOOL_REWORK_WAIT_STORE } from "../../persistence/tokens.js";

@Injectable()
export class ToolReworkWaitsService {
  constructor(
    @Inject(TOOL_REWORK_WAIT_STORE) private readonly store: ToolReworkWaitStore | undefined,
  ) {}

  async list(): Promise<ToolReworkWaitRecord[]> {
    if (!this.store) throw new ServiceUnavailableException("Tool rework wait store is not configured");
    return this.store.list();
  }

  async listByRun(runId: string): Promise<ToolReworkWaitRecord[]> {
    if (!this.store) throw new ServiceUnavailableException("Tool rework wait store is not configured");
    return this.store.listByRun(runId);
  }

  async get(id: string): Promise<ToolReworkWaitRecord> {
    if (!this.store) throw new ServiceUnavailableException("Tool rework wait store is not configured");
    const record = await this.store.get(id);
    if (!record) throw new NotFoundException("Tool rework wait not found");
    return record;
  }

  async create(rawBody: unknown): Promise<ToolReworkWaitRecord> {
    if (!this.store) throw new ServiceUnavailableException("Tool rework wait store is not configured");
    let input: ToolReworkWaitCreateInput;
    try {
      input = this.parseCreate(rawBody);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid tool rework wait",
      );
    }
    return this.store.create(input);
  }

  async update(id: string, rawBody: unknown): Promise<ToolReworkWaitRecord> {
    if (!this.store) throw new ServiceUnavailableException("Tool rework wait store is not configured");
    let update: ToolReworkWaitUpdateInput;
    try {
      update = this.parseUpdate(rawBody);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid tool rework wait update",
      );
    }
    try {
      return await this.store.update(id, update);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid tool rework wait update";
      throw message.includes("was not found")
        ? new NotFoundException(message)
        : new BadRequestException(message);
    }
  }

  // The following routes depend on RunStore + ToolReworkRetryCoordinator
  // (Phase 4). For Phase 2 they return 503 to keep the surface defined.
  async resume(_id: string, _body: unknown): Promise<never> {
    throw new ServiceUnavailableException("Tool rework wait resume is not configured");
  }

  async retryRun(_id: string, _body: unknown): Promise<never> {
    throw new ServiceUnavailableException("Tool rework wait retry is not configured");
  }

  async autoRetry(_id: string): Promise<never> {
    throw new ServiceUnavailableException("Tool rework wait auto-retry is not configured");
  }

  private parseCreate(value: unknown): ToolReworkWaitCreateInput {
    if (!isRecord(value)) throw new Error("tool rework wait must be an object");
    return {
      runId: parseRequiredText(value.runId, "runId"),
      reason: parseRequiredText(value.reason, "reason"),
      spanId: parseOptionalText(value.spanId),
      toolName: parseOptionalText(value.toolName),
      toolVersion: parseOptionalText(value.toolVersion),
      investigationId: parseOptionalText(value.investigationId),
      buildRequestId: parseOptionalText(value.buildRequestId),
      status: this.parseStatus(value.status),
      promotedVersion: parseOptionalText(value.promotedVersion),
      retryRunId: parseOptionalText(value.retryRunId),
      retrySpanId: parseOptionalText(value.retrySpanId),
    };
  }

  private parseUpdate(value: unknown): ToolReworkWaitUpdateInput {
    if (!isRecord(value)) throw new Error("tool rework wait update must be an object");
    const update: ToolReworkWaitUpdateInput = {};
    if (value.status !== undefined) update.status = this.parseStatus(value.status);
    if (value.reason !== undefined) update.reason = parseOptionalText(value.reason) ?? "";
    if (value.buildRequestId !== undefined) {
      update.buildRequestId = parseNullableText(value.buildRequestId, "buildRequestId");
    }
    if (value.investigationId !== undefined) {
      update.investigationId = parseNullableText(value.investigationId, "investigationId");
    }
    if (value.promotedVersion !== undefined) {
      update.promotedVersion = parseNullableText(value.promotedVersion, "promotedVersion");
    }
    if (value.retryRunId !== undefined) {
      update.retryRunId = parseNullableText(value.retryRunId, "retryRunId");
    }
    if (value.retrySpanId !== undefined) {
      update.retrySpanId = parseNullableText(value.retrySpanId, "retrySpanId");
    }
    if (value.toolName !== undefined) update.toolName = parseNullableText(value.toolName, "toolName");
    if (value.toolVersion !== undefined) update.toolVersion = parseNullableText(value.toolVersion, "toolVersion");
    return update;
  }

  private parseStatus(value: unknown): ToolReworkWaitStatus | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !TOOL_REWORK_WAIT_STATUSES.includes(value as ToolReworkWaitStatus)) {
      throw new Error(`status must be one of ${TOOL_REWORK_WAIT_STATUSES.join(", ")}`);
    }
    return value as ToolReworkWaitStatus;
  }
}
