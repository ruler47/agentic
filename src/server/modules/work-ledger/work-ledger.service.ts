import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  isRecord,
  parseOptionalNumber,
  parseOptionalStringArray,
  parseOptionalText,
  parseOptionalEnum,
  parseRequiredEnum,
  parseRequiredText,
  parseUpdateNullableNumber,
  parseUpdateNullableText,
  sanitizeAuditMetadata,
} from "../../common/parsers.js";
import { sanitizeMetadata as sanitizeLedgerMetadata } from "../../../work-ledger/sanitize.js";
import {
  WORK_LEDGER_KINDS,
  WORK_LEDGER_STATUSES,
  type WorkLedgerCreateInput,
  type WorkLedgerItem,
  type WorkLedgerStore,
  type WorkLedgerUpdateInput,
} from "../../../work-ledger/types.js";
import { AuditService } from "../../common/services/audit.service.js";
import { WORK_LEDGER_STORE } from "../../persistence/tokens.js";

@Injectable()
export class WorkLedgerService {
  constructor(
    @Inject(WORK_LEDGER_STORE) private readonly store: WorkLedgerStore | undefined,
    private readonly audit: AuditService,
  ) {}

  async list(query: { threadId?: string; runId?: string; workKey?: string }): Promise<WorkLedgerItem[]> {
    if (!this.store) {
      throw new ServiceUnavailableException("Work ledger store is not configured");
    }
    const threadId = parseOptionalText(query.threadId);
    const runId = parseOptionalText(query.runId);
    const workKey = parseOptionalText(query.workKey);
    if (workKey) return this.store.listByWorkKey(workKey);
    if (runId) return this.store.listByRun(runId);
    if (threadId) return this.store.listByThread(threadId);
    throw new BadRequestException("threadId, runId, or workKey is required");
  }

  async create(rawBody: unknown): Promise<WorkLedgerItem> {
    if (!this.store) {
      throw new ServiceUnavailableException("Work ledger store is not configured");
    }
    let input: WorkLedgerCreateInput;
    try {
      input = this.parseCreate(rawBody);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid work ledger item",
      );
    }
    const item = await this.store.createItem(input);
    await this.audit.record({
      instanceId: item.instanceId ?? "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "work_ledger.created",
      targetType: "work_ledger_item",
      targetId: item.id,
      status: "success",
      runId: item.runId,
      threadId: item.threadId,
      summary: `Work ledger item created: ${item.title} (${item.kind}/${item.status})`,
      metadata: sanitizeAuditMetadata({
        workKey: item.workKey,
        kind: item.kind,
        status: item.status,
        ownerSpanId: item.ownerSpanId,
      }),
    });
    return item;
  }

  async update(id: string, rawBody: unknown): Promise<WorkLedgerItem> {
    if (!this.store) {
      throw new ServiceUnavailableException("Work ledger store is not configured");
    }
    let update: WorkLedgerUpdateInput;
    try {
      update = this.parseUpdate(rawBody);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid work ledger update",
      );
    }
    let item: WorkLedgerItem;
    try {
      item = await this.store.updateItemStatus(id, update);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid work ledger update";
      throw message.includes("was not found")
        ? new NotFoundException(message)
        : new BadRequestException(message);
    }
    await this.audit.record({
      instanceId: item.instanceId ?? "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "work_ledger.updated",
      targetType: "work_ledger_item",
      targetId: item.id,
      status: "success",
      runId: item.runId,
      threadId: item.threadId,
      summary: `Work ledger item updated: ${item.title} (${item.kind}/${item.status})`,
      metadata: sanitizeAuditMetadata({
        workKey: item.workKey,
        status: item.status,
      }),
    });
    return item;
  }

  async appendEvidence(id: string, rawBody: unknown): Promise<WorkLedgerItem> {
    if (!this.store) {
      throw new ServiceUnavailableException("Work ledger store is not configured");
    }
    let evidenceId: string;
    try {
      if (!isRecord(rawBody)) throw new Error("evidence link must be an object");
      evidenceId = parseRequiredText(rawBody.evidenceId, "evidenceId");
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid evidence link",
      );
    }
    try {
      return await this.store.appendEvidenceLink(id, evidenceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid evidence link";
      throw message.includes("was not found")
        ? new NotFoundException(message)
        : new BadRequestException(message);
    }
  }

  async appendArtifact(id: string, rawBody: unknown): Promise<WorkLedgerItem> {
    if (!this.store) {
      throw new ServiceUnavailableException("Work ledger store is not configured");
    }
    let artifactId: string;
    try {
      if (!isRecord(rawBody)) throw new Error("artifact link must be an object");
      artifactId = parseRequiredText(rawBody.artifactId, "artifactId");
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid artifact link",
      );
    }
    try {
      return await this.store.appendArtifactLink(id, artifactId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid artifact link";
      throw message.includes("was not found")
        ? new NotFoundException(message)
        : new BadRequestException(message);
    }
  }

  private parseCreate(value: unknown): WorkLedgerCreateInput {
    if (!isRecord(value)) throw new Error("work ledger item must be an object");
    return {
      kind: parseRequiredEnum(value.kind, WORK_LEDGER_KINDS, "kind"),
      workKey: parseRequiredText(value.workKey, "workKey"),
      title: parseRequiredText(value.title, "title"),
      status: parseOptionalEnum(value.status, WORK_LEDGER_STATUSES, "status"),
      instanceId: parseOptionalText(value.instanceId),
      threadId: parseOptionalText(value.threadId),
      runId: parseOptionalText(value.runId),
      ownerSpanId: parseOptionalText(value.ownerSpanId),
      parentWorkItemId: parseOptionalText(value.parentWorkItemId),
      summary: parseOptionalText(value.summary),
      inputSummary: parseOptionalText(value.inputSummary),
      outputSummary: parseOptionalText(value.outputSummary),
      sourceUrls: parseOptionalStringArray(value.sourceUrls, "sourceUrls"),
      artifactIds: parseOptionalStringArray(value.artifactIds, "artifactIds"),
      evidenceIds: parseOptionalStringArray(value.evidenceIds, "evidenceIds"),
      error: parseOptionalText(value.error),
      confidence: parseOptionalNumber(value.confidence),
      freshnessExpiresAt: parseOptionalText(value.freshnessExpiresAt),
      metadata: sanitizeLedgerMetadata(value.metadata),
    };
  }

  private parseUpdate(value: unknown): WorkLedgerUpdateInput {
    if (!isRecord(value)) throw new Error("work ledger update must be an object");
    return {
      status: parseOptionalEnum(value.status, WORK_LEDGER_STATUSES, "status"),
      ownerSpanId: parseUpdateNullableText(value, "ownerSpanId"),
      summary: parseUpdateNullableText(value, "summary"),
      inputSummary: parseUpdateNullableText(value, "inputSummary"),
      outputSummary: parseUpdateNullableText(value, "outputSummary"),
      sourceUrls: parseOptionalStringArray(value.sourceUrls, "sourceUrls"),
      error: parseUpdateNullableText(value, "error"),
      confidence: parseUpdateNullableNumber(value, "confidence"),
      freshnessExpiresAt: parseUpdateNullableText(value, "freshnessExpiresAt"),
      metadata:
        value.metadata !== undefined ? (sanitizeLedgerMetadata(value.metadata) ?? {}) : undefined,
    };
  }
}
