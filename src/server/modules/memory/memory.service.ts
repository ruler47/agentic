import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { reviewMemoryProposals } from "../../../memory/memoryProposalReview.js";
import { evaluateMemoryRetrieval } from "../../../memory/retrievalEvaluation.js";
import type {
  MemoryListOptions,
  SkillMemoryStore,
} from "../../../memory/skillMemory.js";
import type { SkillMemoryEntry } from "../../../types.js";
import { AuditService } from "../../common/services/audit.service.js";
import { SKILL_MEMORY } from "../../persistence/tokens.js";
import type { CreateMemoryDto } from "./dto/create-memory.dto.js";
import type { EvaluateRetrievalDto } from "./dto/evaluate-retrieval.dto.js";
import type { UpdateMemoryDto } from "./dto/update-memory.dto.js";

const MEMORY_SCOPES = ["global", "group", "user", "thread", "run"] as const;
const MEMORY_STATUSES = ["proposed", "accepted", "rejected", "archived"] as const;
const MEMORY_SENSITIVITIES = ["normal", "sensitive", "private"] as const;

@Injectable()
export class MemoryService {
  constructor(
    @Inject(SKILL_MEMORY) private readonly memory: SkillMemoryStore | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(query: Record<string, string | undefined>): Promise<SkillMemoryEntry[]> {
    if (!this.memory) return [];
    return this.memory.list(this.parseListOptions(query));
  }

  async create(dto: CreateMemoryDto): Promise<SkillMemoryEntry> {
    if (!this.memory) {
      throw new ServiceUnavailableException("Memory store is not configured");
    }
    const input = this.validateCreateInput(dto);
    let memory: SkillMemoryEntry;
    try {
      memory = await this.memory.add({
        title: input.title,
        summary: input.summary,
        reusableProcedure: input.reusableProcedure,
        tags: input.tags ?? [],
        scope: input.scope ?? "global",
        scopeId: input.scopeId,
        status: input.status ?? "proposed",
        confidence: input.confidence ?? 0.75,
        sensitivity: input.sensitivity ?? "normal",
        sourceRunId: input.sourceRunId,
        sourceThreadId: input.sourceThreadId,
        evidence: input.evidence ?? [],
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid memory create request",
      );
    }
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "memory.created",
      targetType: "memory",
      targetId: memory.id,
      status: memory.status === "proposed" ? "pending" : "success",
      runId: memory.sourceRunId,
      threadId: memory.sourceThreadId,
      summary: `Memory created: ${memory.title}`,
      metadata: {
        scope: memory.scope,
        scopeId: memory.scopeId,
        confidence: memory.confidence,
        memoryStatus: memory.status,
      },
    });
    return memory;
  }

  async update(id: string, dto: UpdateMemoryDto): Promise<SkillMemoryEntry> {
    if (!this.memory?.update) {
      throw new ServiceUnavailableException("Memory update is not configured");
    }
    const input = this.validateUpdateInput(dto);
    let memory: SkillMemoryEntry;
    try {
      memory = await this.memory.update(id, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid memory update request";
      throw message.includes("was not found")
        ? new NotFoundException(message)
        : new BadRequestException(message);
    }
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "memory.updated",
      targetType: "memory",
      targetId: memory.id,
      status: memory.status === "proposed" ? "pending" : "success",
      runId: memory.sourceRunId,
      threadId: memory.sourceThreadId,
      summary: `Memory updated: ${memory.title}`,
      metadata: {
        scope: memory.scope,
        scopeId: memory.scopeId,
        confidence: memory.confidence,
        memoryStatus: memory.status,
      },
    });
    return memory;
  }

  async reembed(): Promise<{ updated: number }> {
    if (!this.memory?.reembedAll) {
      throw new ServiceUnavailableException("Memory embedding rebuild is not configured");
    }
    let result: { updated: number };
    try {
      result = await this.memory.reembedAll();
    } catch (error) {
      throw new InternalServerErrorException(
        error instanceof Error ? error.message : "Memory embedding rebuild failed",
      );
    }
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "memory.embeddings_rebuilt",
      targetType: "memory",
      targetId: "all",
      status: "success",
      summary: `Memory embeddings rebuilt for ${result.updated} item(s)`,
      metadata: { updated: result.updated },
    });
    return result;
  }

  async evaluateRetrieval(dto: EvaluateRetrievalDto) {
    if (!this.memory) {
      throw new ServiceUnavailableException("Memory store is not configured");
    }
    try {
      return await evaluateMemoryRetrieval(this.memory, dto.cases);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid memory retrieval evaluation request",
      );
    }
  }

  async reviewQueue() {
    if (!this.memory) {
      throw new ServiceUnavailableException("Memory store is not configured");
    }
    const memories = await this.memory.list({ status: "proposed", includeArchived: true });
    const acceptedMemories = await this.memory.list({ status: "accepted", includeArchived: true });
    const reviews = reviewMemoryProposals(memories, [...memories, ...acceptedMemories]);
    return {
      memories,
      reviews,
      summary: {
        total: reviews.length,
        ready: reviews.filter((review) => review.status === "ready").length,
        needsReview: reviews.filter((review) => review.status === "needs_review").length,
        blocked: reviews.filter((review) => review.status === "blocked").length,
      },
    };
  }

  private parseListOptions(query: Record<string, string | undefined>): MemoryListOptions {
    const options: MemoryListOptions = {};
    if (query.scope) {
      const allowed = new Set(["global", "group", "user", "thread", "run"]);
      if (!allowed.has(query.scope)) throw new BadRequestException("Invalid memory scope");
      options.scope = query.scope as MemoryListOptions["scope"];
    }
    if (query.status) {
      const allowed = new Set(["proposed", "accepted", "rejected", "archived"]);
      if (!allowed.has(query.status)) throw new BadRequestException("Invalid memory status");
      options.status = query.status as MemoryListOptions["status"];
    }
    if (query.scopeId) options.scopeId = query.scopeId;
    if (query.includeArchived === "true") options.includeArchived = true;
    const limitRaw = query.limit;
    if (limitRaw !== undefined && limitRaw !== "") {
      const parsed = Number(limitRaw);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.limit = Math.min(Math.floor(parsed), 500);
      }
    }
    return options;
  }

  private validateCreateInput(dto: CreateMemoryDto): CreateMemoryDto {
    return {
      ...dto,
      title: this.requireNonEmptyString(dto.title, "title"),
      summary: this.requireNonEmptyString(dto.summary, "summary"),
      reusableProcedure: this.requireNonEmptyString(dto.reusableProcedure, "reusableProcedure"),
      tags: this.optionalStringArray(dto.tags, "tags"),
      scope: this.optionalEnum(dto.scope, MEMORY_SCOPES, "scope"),
      scopeId: this.optionalTrimmedString(dto.scopeId, "scopeId"),
      status: this.optionalEnum(dto.status, MEMORY_STATUSES, "status"),
      confidence: this.optionalConfidence(dto.confidence),
      sensitivity: this.optionalEnum(dto.sensitivity, MEMORY_SENSITIVITIES, "sensitivity"),
      sourceRunId: this.optionalTrimmedString(dto.sourceRunId, "sourceRunId"),
      sourceThreadId: this.optionalTrimmedString(dto.sourceThreadId, "sourceThreadId"),
      evidence: this.optionalStringArray(dto.evidence, "evidence"),
    };
  }

  private validateUpdateInput(dto: UpdateMemoryDto): UpdateMemoryDto {
    return {
      ...dto,
      title: dto.title === undefined ? undefined : this.requireNonEmptyString(dto.title, "title"),
      summary: dto.summary === undefined ? undefined : this.requireNonEmptyString(dto.summary, "summary"),
      reusableProcedure:
        dto.reusableProcedure === undefined
          ? undefined
          : this.requireNonEmptyString(dto.reusableProcedure, "reusableProcedure"),
      tags: this.optionalStringArray(dto.tags, "tags"),
      scope: this.optionalEnum(dto.scope, MEMORY_SCOPES, "scope"),
      scopeId: this.optionalTrimmedString(dto.scopeId, "scopeId"),
      status: this.optionalEnum(dto.status, MEMORY_STATUSES, "status"),
      confidence: this.optionalConfidence(dto.confidence),
      sensitivity: this.optionalEnum(dto.sensitivity, MEMORY_SENSITIVITIES, "sensitivity"),
      sourceRunId: this.optionalTrimmedString(dto.sourceRunId, "sourceRunId"),
      sourceThreadId: this.optionalTrimmedString(dto.sourceThreadId, "sourceThreadId"),
      evidence: this.optionalStringArray(dto.evidence, "evidence"),
    };
  }

  private requireNonEmptyString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) {
      throw new BadRequestException(`${field} must be a non-empty string`);
    }
    return value.trim();
  }

  private optionalTrimmedString(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new BadRequestException(`${field} must be a string`);
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  private optionalStringArray(value: unknown, field: string): string[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new BadRequestException(`${field} must be an array of strings`);
    }
    return value.map((item) => item.trim()).filter(Boolean);
  }

  private optionalConfidence(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new BadRequestException("confidence must be a number between 0 and 1");
    }
    return value;
  }

  private optionalEnum<T extends string>(
    value: unknown,
    allowed: readonly T[],
    field: string,
  ): T | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      throw new BadRequestException(`${field} must be one of ${allowed.join(", ")}`);
    }
    return value as T;
  }
}
