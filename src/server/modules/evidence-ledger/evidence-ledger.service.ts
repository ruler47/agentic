import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  isRecord,
  parseOptionalEnum,
  parseOptionalNumber,
  parseOptionalStringArray,
  parseOptionalText,
  parseRequiredEnum,
  parseRequiredText,
  sanitizeAuditMetadata,
} from "../../common/parsers.js";
import { sanitizeMetadata as sanitizeLedgerMetadata } from "../../../work-ledger/sanitize.js";
import {
  EVIDENCE_KINDS,
  EVIDENCE_QA_STATUSES,
  type EvidenceCreateInput,
  type EvidenceLedgerStore,
  type EvidenceRecord,
} from "../../../work-ledger/types.js";
import { AuditService } from "../../common/services/audit.service.js";
import { EVIDENCE_LEDGER_STORE } from "../../persistence/tokens.js";

@Injectable()
export class EvidenceLedgerService {
  constructor(
    @Inject(EVIDENCE_LEDGER_STORE) private readonly store: EvidenceLedgerStore | undefined,
    private readonly audit: AuditService,
  ) {}

  async list(query: {
    threadId?: string;
    runId?: string;
    workItemId?: string;
    artifactId?: string;
    sourceUrl?: string;
  }): Promise<EvidenceRecord[]> {
    if (!this.store) {
      throw new ServiceUnavailableException("Evidence ledger store is not configured");
    }
    const threadId = parseOptionalText(query.threadId);
    const runId = parseOptionalText(query.runId);
    const workItemId = parseOptionalText(query.workItemId);
    const artifactId = parseOptionalText(query.artifactId);
    const sourceUrl = parseOptionalText(query.sourceUrl);
    if (workItemId) return this.store.listByWorkItem(workItemId);
    if (artifactId) return this.store.listByArtifact(artifactId);
    if (sourceUrl) return this.store.listBySourceUrl(sourceUrl);
    if (runId) return this.store.listByRun(runId);
    if (threadId) return this.store.listByThread(threadId);
    throw new BadRequestException(
      "threadId, runId, workItemId, artifactId, or sourceUrl is required",
    );
  }

  async create(rawBody: unknown): Promise<EvidenceRecord> {
    if (!this.store) {
      throw new ServiceUnavailableException("Evidence ledger store is not configured");
    }
    let input: EvidenceCreateInput;
    try {
      input = this.parseCreate(rawBody);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid evidence record",
      );
    }
    const record = await this.store.createEvidence(input);
    await this.audit.record({
      instanceId: record.instanceId ?? "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "evidence_ledger.created",
      targetType: "evidence_ledger_record",
      targetId: record.id,
      status: "success",
      runId: record.runId,
      threadId: record.threadId,
      summary: `Evidence ledger record created: ${record.title} (${record.kind}/${record.qaStatus})`,
      metadata: sanitizeAuditMetadata({
        kind: record.kind,
        qaStatus: record.qaStatus,
        workItemId: record.workItemId,
        artifactId: record.artifactId,
        sourceUrl: record.sourceUrl,
      }),
    });
    return record;
  }

  private parseCreate(value: unknown): EvidenceCreateInput {
    if (!isRecord(value)) throw new Error("evidence record must be an object");
    return {
      kind: parseRequiredEnum(value.kind, EVIDENCE_KINDS, "kind"),
      title: parseRequiredText(value.title, "title"),
      qaStatus: parseOptionalEnum(value.qaStatus, EVIDENCE_QA_STATUSES, "qaStatus"),
      instanceId: parseOptionalText(value.instanceId),
      threadId: parseOptionalText(value.threadId),
      runId: parseOptionalText(value.runId),
      spanId: parseOptionalText(value.spanId),
      workItemId: parseOptionalText(value.workItemId),
      sourceUrl: parseOptionalText(value.sourceUrl),
      provider: parseOptionalText(value.provider),
      toolName: parseOptionalText(value.toolName),
      summary: parseOptionalText(value.summary),
      contentPreview: parseOptionalText(value.contentPreview),
      artifactId: parseOptionalText(value.artifactId),
      confidence: parseOptionalNumber(value.confidence),
      limitations: parseOptionalStringArray(value.limitations, "limitations"),
      metadata: sanitizeLedgerMetadata(value.metadata),
    };
  }
}
