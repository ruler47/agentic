import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "../../../artifacts/artifactStore.js";
import type { SkillMemory } from "../../../memory/skillMemory.js";
import type { RunStore } from "../../../runs/types.js";
import type { WorkLedgerStore } from "../../../work-ledger/types.js";
import type {
  ToolCallbackArtifactRequest,
  ToolCallbackArtifactResponse,
  ToolCallbackLedgerClaimRequest,
  ToolCallbackLedgerClaimResponse,
  ToolCallbackMemorySearchRequest,
  ToolCallbackMemorySearchResponse,
  ToolCallbackRunEventRequest,
  ToolCallbackRunEventResponse,
} from "../../../tools/toolServiceContract.js";
import type { ToolCallbackTokenClaims } from "../../../tools/toolCallbackToken.js";
import {
  ARTIFACT_STORE,
  RUN_STORE,
  SKILL_MEMORY,
  WORK_LEDGER_STORE,
} from "../../persistence/tokens.js";

/**
 * Phase 13 — services that the runtime exposes for tool service
 * containers to call back via the `/api/tools/callbacks/*` HTTP
 * surface. Each method receives the JWT claims (already verified by
 * the controller) so we can scope the operation to the calling run
 * and emit audit-friendly events.
 *
 * Stores are injected as optional so the in-memory CLI runtime (no
 * Postgres / S3) can wire a partial subset; missing stores produce
 * a deterministic 503-ish error rather than crashing the request
 * pipeline.
 */
@Injectable()
export class ToolCallbacksService {
  constructor(
    @Optional() @Inject(ARTIFACT_STORE) private readonly artifacts?: ArtifactStore,
    @Optional() @Inject(RUN_STORE) private readonly runs?: RunStore,
    @Optional() @Inject(SKILL_MEMORY) private readonly memory?: SkillMemory,
    @Optional() @Inject(WORK_LEDGER_STORE) private readonly workLedger?: WorkLedgerStore,
  ) {}

  async saveArtifact(
    claims: ToolCallbackTokenClaims,
    rawBody: unknown,
  ): Promise<ToolCallbackArtifactResponse> {
    if (!this.artifacts) {
      throw new BadRequestException("Artifact store is not configured on this runtime");
    }
    const body = this.requireRecord<ToolCallbackArtifactRequest>(rawBody, "artifact body");
    if (typeof body.filename !== "string" || !body.filename) {
      throw new BadRequestException("artifact.filename is required");
    }
    if (typeof body.mimeType !== "string" || !body.mimeType) {
      throw new BadRequestException("artifact.mimeType is required");
    }
    if (typeof body.contentBase64 !== "string" && typeof body.content !== "string") {
      throw new BadRequestException("artifact.content or artifact.contentBase64 is required");
    }
    const content =
      typeof body.contentBase64 === "string"
        ? Buffer.from(body.contentBase64, "base64")
        : body.content!;
    const saved = await this.artifacts.saveGenerated(claims.runId, {
      filename: body.filename,
      mimeType: body.mimeType,
      content,
      description: body.description ?? `Tool callback from ${claims.toolName}`,
    });
    return {
      artifactId: saved.id,
      url: saved.url,
      filename: saved.filename,
      mimeType: saved.mimeType,
      sizeBytes: saved.sizeBytes,
    };
  }

  async ledgerClaim(
    claims: ToolCallbackTokenClaims,
    rawBody: unknown,
  ): Promise<ToolCallbackLedgerClaimResponse> {
    if (!this.workLedger) {
      throw new BadRequestException("Work ledger is not configured on this runtime");
    }
    const body = this.requireRecord<ToolCallbackLedgerClaimRequest>(rawBody, "claim body");
    if (typeof body.kind !== "string" || !body.kind) {
      throw new BadRequestException("claim.kind is required");
    }
    if (typeof body.workKey !== "string" || !body.workKey) {
      throw new BadRequestException("claim.workKey is required");
    }
    if (typeof body.title !== "string" || !body.title) {
      throw new BadRequestException("claim.title is required");
    }
    const claimed = await this.workLedger.claimWork({
      runId: claims.runId,
      kind: body.kind as never,
      workKey: body.workKey,
      title: body.title,
      ownerSpanId: `tool-callback-${claims.toolName}`,
      inputSummary: body.inputSummary,
      metadata: body.metadata,
    });
    return {
      status: claimed.decision.status === "reuse_completed"
        ? "reuse_completed"
        : claimed.decision.status === "wait_for_inflight"
        ? "reuse_pending"
        : "claim_created",
      itemId: claimed.item.id,
      outputSummary: claimed.item.outputSummary,
    };
  }

  async memorySearch(
    claims: ToolCallbackTokenClaims,
    rawBody: unknown,
  ): Promise<ToolCallbackMemorySearchResponse> {
    if (!this.memory) {
      throw new BadRequestException("Skill memory is not configured on this runtime");
    }
    const body = this.requireRecord<ToolCallbackMemorySearchRequest>(rawBody, "memory search body");
    if (typeof body.query !== "string" || !body.query) {
      throw new BadRequestException("memorySearch.query is required");
    }
    const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 20) : 5;
    const candidates = await this.memory.search(body.query, limit);
    void claims; // scope-claim could be added later
    return {
      memories: candidates.map((m) => ({
        id: m.id,
        title: m.title,
        summary: m.summary,
        reusableProcedure: m.reusableProcedure,
      })),
    };
  }

  async emitRunEvent(
    claims: ToolCallbackTokenClaims,
    rawBody: unknown,
  ): Promise<ToolCallbackRunEventResponse> {
    if (!this.runs) {
      throw new BadRequestException("Run store is not configured on this runtime");
    }
    const body = this.requireRecord<ToolCallbackRunEventRequest>(rawBody, "run event body");
    if (typeof body.type !== "string" || !body.type) {
      throw new BadRequestException("event.type is required");
    }
    const reloaded = await this.runs.get(claims.runId);
    if (!reloaded) {
      throw new NotFoundException(`Run ${claims.runId} not found`);
    }
    const now = new Date().toISOString();
    await this.runs.appendEvent(claims.runId, {
      id: `event_${randomUUID()}`,
      spanId: `tool-callback-${claims.toolName}-${now}`,
      type: `tool-callback:${body.type}` as never,
      actor: `tool:${claims.toolName}`,
      activity: "tool" as never,
      status: (body.status ?? "completed") as never,
      title: body.title ?? `Tool callback ${body.type}`,
      detail: body.detail,
      timestamp: now,
      payload: { ...(body.payload ?? {}), toolName: claims.toolName, scope: claims.scope },
    });
    return { ok: true };
  }

  private requireRecord<T extends Record<string, unknown>>(value: unknown, label: string): T {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException(`${label} must be a JSON object`);
    }
    return value as T;
  }
}
