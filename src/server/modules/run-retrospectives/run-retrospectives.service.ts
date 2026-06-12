import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  isRecord,
  parseOptionalEnum,
  parseOptionalStringArray,
  parseOptionalText,
  parseRequiredEnum,
  parseRequiredText,
  parseUpdateNullableText,
  sanitizeAuditMetadata,
} from "../../common/parsers.js";
import { sanitizeMetadata as sanitizeLedgerMetadata } from "../../../work-ledger/sanitize.js";
import {
  RUN_RETROSPECTIVE_OUTCOMES,
  RUN_RETROSPECTIVE_STATUSES,
  type RunRetrospectiveCreateInput,
  type RunRetrospectiveRecord,
  type RunRetrospectiveStore,
  type RunRetrospectiveUpdateInput,
} from "../../../work-ledger/types.js";
import { AuditService } from "../../common/services/audit.service.js";
import { RUN_RETROSPECTIVE_STORE } from "../../persistence/tokens.js";

@Injectable()
export class RunRetrospectivesService {
  constructor(
    @Inject(RUN_RETROSPECTIVE_STORE) private readonly store: RunRetrospectiveStore | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(query: { runId?: string; threadId?: string }): Promise<RunRetrospectiveRecord[]> {
    if (!this.store) {
      throw new ServiceUnavailableException("Run retrospective store is not configured");
    }
    const runId = parseOptionalText(query.runId);
    const threadId = parseOptionalText(query.threadId);
    if (!runId && !threadId) {
      throw new BadRequestException("runId or threadId is required");
    }
    return runId ? this.store.listByRun(runId) : this.store.listByThread(threadId!);
  }

  async create(rawBody: unknown): Promise<RunRetrospectiveRecord> {
    if (!this.store) {
      throw new ServiceUnavailableException("Run retrospective store is not configured");
    }
    let input: RunRetrospectiveCreateInput;
    try {
      input = this.parseCreate(rawBody);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid run retrospective",
      );
    }
    const record = await this.store.create(input);
    await this.audit.record({
      instanceId: record.instanceId ?? "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "run_retrospective.created",
      targetType: "run_retrospective",
      targetId: record.id,
      status: "success",
      runId: record.runId,
      threadId: record.threadId,
      summary: `Run retrospective created: ${record.runOutcome}`,
      metadata: sanitizeAuditMetadata({
        status: record.status,
        runOutcome: record.runOutcome,
      }),
    });
    return record;
  }

  async update(id: string, rawBody: unknown): Promise<RunRetrospectiveRecord> {
    if (!this.store) {
      throw new ServiceUnavailableException("Run retrospective store is not configured");
    }
    let update: RunRetrospectiveUpdateInput;
    try {
      update = this.parseUpdate(rawBody);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid run retrospective update",
      );
    }
    let record: RunRetrospectiveRecord;
    try {
      record = await this.store.updateStatus(id, update);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid run retrospective update";
      throw message.includes("was not found")
        ? new NotFoundException(message)
        : new BadRequestException(message);
    }
    await this.audit.record({
      instanceId: record.instanceId ?? "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "run_retrospective.updated",
      targetType: "run_retrospective",
      targetId: record.id,
      status: "success",
      runId: record.runId,
      threadId: record.threadId,
      summary: `Run retrospective updated: ${record.status}`,
      metadata: sanitizeAuditMetadata({ status: record.status }),
    });
    return record;
  }

  private parseCreate(value: unknown): RunRetrospectiveCreateInput {
    if (!isRecord(value)) throw new Error("run retrospective must be an object");
    return {
      runId: parseRequiredText(value.runId, "runId"),
      runOutcome: parseRequiredEnum(value.runOutcome, RUN_RETROSPECTIVE_OUTCOMES, "runOutcome"),
      status: parseOptionalEnum(value.status, RUN_RETROSPECTIVE_STATUSES, "status"),
      instanceId: parseOptionalText(value.instanceId),
      threadId: parseOptionalText(value.threadId),
      whatWorked: parseOptionalStringArray(value.whatWorked, "whatWorked"),
      whatFailed: parseOptionalStringArray(value.whatFailed, "whatFailed"),
      suspectedRootCauses: parseOptionalStringArray(value.suspectedRootCauses, "suspectedRootCauses"),
      duplicatedWork: parseOptionalStringArray(value.duplicatedWork, "duplicatedWork"),
      weakTools: parseOptionalStringArray(value.weakTools, "weakTools"),
      weakModels: parseOptionalStringArray(value.weakModels, "weakModels"),
      missingCapabilities: parseOptionalStringArray(value.missingCapabilities, "missingCapabilities"),
      usefulEvidenceIds: parseOptionalStringArray(value.usefulEvidenceIds, "usefulEvidenceIds"),
      proposedMemoryIds: parseOptionalStringArray(value.proposedMemoryIds, "proposedMemoryIds"),
      proposedToolFollowUpIds: parseOptionalStringArray(
        value.proposedToolFollowUpIds,
        "proposedToolFollowUpIds",
      ),
      proposedPolicyChanges: parseOptionalStringArray(value.proposedPolicyChanges, "proposedPolicyChanges"),
      proposedPromptChanges: parseOptionalStringArray(value.proposedPromptChanges, "proposedPromptChanges"),
      summary: parseOptionalText(value.summary),
      metadata: sanitizeLedgerMetadata(value.metadata),
    };
  }

  private parseUpdate(value: unknown): RunRetrospectiveUpdateInput {
    if (!isRecord(value)) throw new Error("run retrospective update must be an object");
    return {
      status: parseOptionalEnum(value.status, RUN_RETROSPECTIVE_STATUSES, "status"),
      summary: parseUpdateNullableText(value, "summary"),
      whatWorked: parseOptionalStringArray(value.whatWorked, "whatWorked"),
      whatFailed: parseOptionalStringArray(value.whatFailed, "whatFailed"),
      suspectedRootCauses: parseOptionalStringArray(value.suspectedRootCauses, "suspectedRootCauses"),
      duplicatedWork: parseOptionalStringArray(value.duplicatedWork, "duplicatedWork"),
      weakTools: parseOptionalStringArray(value.weakTools, "weakTools"),
      weakModels: parseOptionalStringArray(value.weakModels, "weakModels"),
      missingCapabilities: parseOptionalStringArray(value.missingCapabilities, "missingCapabilities"),
      usefulEvidenceIds: parseOptionalStringArray(value.usefulEvidenceIds, "usefulEvidenceIds"),
      metadata:
        value.metadata !== undefined ? (sanitizeLedgerMetadata(value.metadata) ?? {}) : undefined,
    };
  }
}
