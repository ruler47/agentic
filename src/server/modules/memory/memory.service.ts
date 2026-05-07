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
    let memory: SkillMemoryEntry;
    try {
      memory = await this.memory.add({
        title: dto.title,
        summary: dto.summary,
        reusableProcedure: dto.reusableProcedure,
        tags: dto.tags ?? [],
        scope: dto.scope ?? "global",
        scopeId: dto.scopeId,
        status: dto.status ?? "proposed",
        confidence: dto.confidence ?? 0.75,
        sensitivity: dto.sensitivity ?? "normal",
        sourceRunId: dto.sourceRunId,
        sourceThreadId: dto.sourceThreadId,
        evidence: dto.evidence ?? [],
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
    let memory: SkillMemoryEntry;
    try {
      memory = await this.memory.update(id, dto);
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
}
