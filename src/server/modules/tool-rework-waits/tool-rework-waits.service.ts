import {
  BadRequestException,
  ConflictException,
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
import { ToolReworkCoordinatorService } from "../../common/services/tool-rework-coordinator.service.js";
import {
  TOOL_REWORK_WAIT_STATUSES,
  type ToolReworkWaitCreateInput,
  type ToolReworkWaitRecord,
  type ToolReworkWaitStatus,
  type ToolReworkWaitStore,
  type ToolReworkWaitUpdateInput,
} from "../../../runs/toolReworkWaitStore.js";
import { TOOL_REWORK_WAIT_STORE } from "../../persistence/tokens.js";
import { RunsService } from "../runs/runs.service.js";

@Injectable()
export class ToolReworkWaitsService {
  constructor(
    @Inject(TOOL_REWORK_WAIT_STORE) private readonly store: ToolReworkWaitStore | undefined,
    private readonly rework: ToolReworkCoordinatorService,
    private readonly runs: RunsService,
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
    try {
      const wait = await this.rework
        .createImprovementCoordinator({ actorId: "user-admin", actorType: "user" })
        .openWait(input);
      if (!wait) throw new Error("Tool rework wait store is not configured");
      return wait;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid tool rework wait";
      throw message.includes("was not found") || message.includes("does not match")
        ? new BadRequestException(message)
        : new BadRequestException(message);
    }
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

  async resume(id: string, rawBody: unknown) {
    const body = isRecord(rawBody) ? rawBody : {};
    try {
      const wait = await this.rework.markReadyForRetry(
        id,
        {
          reason: parseOptionalText(body.reason),
          retryRunId: parseOptionalText(body.retryRunId),
          retrySpanId: parseOptionalText(body.retrySpanId),
        },
        { actorId: "user-admin", actorType: "user" },
      );
      return { wait };
    } catch (error) {
      this.throwCoordinatorError(error, "Invalid tool rework resume request");
    }
  }

  async retryRun(id: string, rawBody: unknown) {
    const coordinator = this.rework.createRetryCoordinator({ actorId: "user-admin", actorType: "user" });
    if (!coordinator) throw new ServiceUnavailableException("Tool rework retry coordinator is not available");
    const body = isRecord(rawBody) ? rawBody : {};
    const result = await coordinator.createRetryRun(id, { reason: parseOptionalText(body.reason) });
    if (result.status === "wait_not_found") throw new NotFoundException(result.error);
    if (result.status !== "created" && result.status !== "already_exists") {
      throw new ConflictException({ error: result.error, status: result.status });
    }
    if (result.status === "created" && result.retryRun) {
      void this.runs.executeRun(result.retryRun.id, result.retryRun.task, [], {
        threadId: result.retryRun.threadId,
      });
    }
    return result;
  }

  async autoRetry(id: string) {
    const coordinator = this.rework.createAutoRetryCoordinator({
      actorId: "auto-retry-orchestrator",
      actorType: "agent",
    });
    if (!coordinator) throw new ServiceUnavailableException("Tool rework auto-retry coordinator is not available");
    const result = await coordinator.tryAutoRetry(id);
    if (result.status === "wait_not_found") throw new NotFoundException(result.reason);
    if (result.status !== "created" && result.status !== "already_exists" && result.status !== "disabled") {
      throw new ConflictException({ error: result.reason, status: result.status, policy: result.policy });
    }
    if (result.status === "created" && result.retryRun) {
      void this.runs.executeRun(result.retryRun.id, result.retryRun.task, [], {
        threadId: result.retryRun.threadId,
      });
    }
    return result;
  }

  private throwCoordinatorError(error: unknown, fallback: string): never {
    const message = error instanceof Error ? error.message : fallback;
    if (message.includes("was not found")) throw new NotFoundException(message);
    if (message.includes("not promoted yet")) throw new ConflictException(message);
    throw new BadRequestException(message);
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
