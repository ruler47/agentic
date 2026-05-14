import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  ModelProviderRecord,
  ModelProviderStore,
} from "../../../settings/modelProviderStore.js";
import type { ModelTierSettingsStore } from "../../../settings/modelTierSettings.js";
import type { ModelTierSettings } from "../../../types.js";
import { AuditService } from "../../common/services/audit.service.js";
import { MODEL_PROVIDER_STORE, MODEL_TIER_SETTINGS } from "../../persistence/tokens.js";
import type {
  CreateModelProviderDto,
  UpdateModelProviderDto,
} from "./dto/model-provider.dto.js";
import type { UpdateTiersDto } from "./dto/update-tiers.dto.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_MODEL = "google/gemma-4-26b-a4b";

@Injectable()
export class ModelsService {
  constructor(
    @Inject(MODEL_TIER_SETTINGS) private readonly tiers: ModelTierSettingsStore | undefined,
    @Inject(MODEL_PROVIDER_STORE) private readonly providers: ModelProviderStore | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async listTiers(): Promise<ModelTierSettings[]> {
    return this.tiers ? this.tiers.list() : [];
  }

  async updateTiers(dto: UpdateTiersDto): Promise<ModelTierSettings[]> {
    if (!this.tiers) {
      throw new ServiceUnavailableException("Model tier settings are not configured");
    }
    return this.tiers.replace(dto.tiers);
  }

  async listProviders(): Promise<ModelProviderRecord[]> {
    return this.providers ? this.providers.list() : [];
  }

  async createProvider(dto: CreateModelProviderDto): Promise<ModelProviderRecord> {
    if (!this.providers) {
      throw new ServiceUnavailableException("Model provider store is not configured");
    }
    let provider: ModelProviderRecord;
    try {
      provider = await this.providers.create({
        id: dto.id,
        label: dto.label,
        kind: dto.kind,
        providerType: dto.providerType,
        baseUrl: dto.baseUrl,
        modelIds: dto.modelIds ?? [],
        defaultModel: dto.defaultModel,
        apiKeySecretHandle: dto.apiKeySecretHandle,
        dimensions: dto.dimensions,
        status: dto.status,
        healthStatus: dto.healthStatus,
        healthDetail: dto.healthDetail,
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid model provider",
      );
    }
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "model_provider.created",
      targetType: "model_provider",
      targetId: provider.id,
      status: "success",
      summary: `Model provider created: ${provider.label}`,
      metadata: {
        kind: provider.kind,
        providerType: provider.providerType,
        modelIds: provider.modelIds,
        apiKeySecretHandle: provider.apiKeySecretHandle,
      },
    });
    return provider;
  }

  async updateProvider(id: string, dto: UpdateModelProviderDto): Promise<ModelProviderRecord> {
    if (!this.providers) {
      throw new ServiceUnavailableException("Model provider store is not configured");
    }
    let provider: ModelProviderRecord;
    try {
      provider = await this.providers.update(id, dto);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid model provider update",
      );
    }
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "model_provider.updated",
      targetType: "model_provider",
      targetId: provider.id,
      status: "success",
      summary: `Model provider updated: ${provider.label}`,
      metadata: {
        kind: provider.kind,
        status: provider.status,
        healthStatus: provider.healthStatus,
      },
    });
    return provider;
  }

  async deleteProvider(id: string): Promise<{ deleted: true }> {
    if (!this.providers) {
      throw new ServiceUnavailableException("Model provider store is not configured");
    }
    const deleted = await this.providers.delete(id);
    if (!deleted) throw new NotFoundException("Model provider not found");
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "model_provider.deleted",
      targetType: "model_provider",
      targetId: id,
      status: "success",
      summary: `Model provider deleted: ${id}`,
    });
    return { deleted: true };
  }

  async catalog() {
    const baseUrl = process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL;
    const embeddingBaseUrl = process.env.EMBEDDING_BASE_URL ?? baseUrl;
    const providers = this.providers ? await this.providers.list() : [];
    const [chatModels, embeddingModels] = await Promise.all([
      this.listOpenAiCompatibleModels(baseUrl, "chat"),
      this.listOpenAiCompatibleModels(embeddingBaseUrl, "embedding"),
    ]);
    return {
      chat: {
        baseUrl,
        defaultModel: process.env.LLM_MODEL ?? DEFAULT_MODEL,
        models: chatModels,
      },
      embedding: {
        provider:
          process.env.EMBEDDING_PROVIDER === "deterministic" || !process.env.EMBEDDING_MODEL
            ? "deterministic"
            : "openai-compatible",
        baseUrl: embeddingBaseUrl,
        model: process.env.EMBEDDING_MODEL,
        dimensions: Number(process.env.MEMORY_EMBEDDING_DIMENSIONS ?? "128"),
        models: embeddingModels,
      },
      providers,
    };
  }

  private async listOpenAiCompatibleModels(
    baseUrl: string,
    role: "chat" | "embedding" = "chat",
  ): Promise<Array<{ id: string; ownedBy?: string }>> {
    // Phase 28 follow-up — LM Studio's REST API at /api/v0/models
    // returns rich metadata (state: "loaded"|"not-loaded", type:
    // "llm"|"vlm"|"embeddings", arch, capabilities). The plain
    // OpenAI-compatible /v1/models endpoint lists every DOWNLOADED
    // model regardless of whether it's actually loaded into VRAM,
    // and gives the operator no signal for which ones the council
    // can actually call. We try v0 first (richer); fall back to v1
    // for non-LM-Studio backends.
    //
    // Filter rules when v0 data is available:
    //   - type === "embeddings" → drop from CHAT model list (they're
    //     embedding-only and would error on /chat/completions)
    //   - state !== "loaded" → drop (not in VRAM = unusable until
    //     the operator loads it in LM Studio)
    //
    // This also makes LM Studio's multi-host mesh transparent: when
    // the user connects another machine's LM Studio and loads
    // openai/gpt-oss-120b there, the federated /v1/models reflects
    // it as loaded — our v0 query picks it up automatically.
    const v0Models = await this.tryLmStudioV0Models(baseUrl, role);
    if (v0Models !== undefined) return v0Models;
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) return [];
      const payload = (await response.json()) as { data?: Array<{ id?: unknown; owned_by?: unknown }> };
      return (payload.data ?? [])
        .map((item) => ({
          id: typeof item.id === "string" ? item.id : "",
          ownedBy: typeof item.owned_by === "string" ? item.owned_by : undefined,
        }))
        .filter((item) => item.id);
    } catch {
      return [];
    }
  }

  /**
   * Probe LM Studio's REST API (`/api/v0/models`) for richer model
   * info — state (loaded/not-loaded), type (llm/vlm/embeddings),
   * capabilities. Returns `undefined` when the endpoint is missing
   * (404 / non-JSON / wrong server) so the caller can fall back to
   * the OpenAI-compat `/v1/models` path.
   *
   * The derivation strips a trailing `/v1` from the configured
   * baseUrl to reach the LM Studio root, then appends `/api/v0/models`.
   * Both forms `http://host:1234/v1` and `http://host:1234` work.
   */
  private async tryLmStudioV0Models(
    baseUrl: string,
    role: "chat" | "embedding" = "chat",
  ): Promise<Array<{ id: string; ownedBy?: string }> | undefined> {
    const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    const url = `${root}/api/v0/models`;
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) return undefined;
      const payload = (await response.json()) as {
        data?: Array<{
          id?: unknown;
          publisher?: unknown;
          type?: unknown;
          state?: unknown;
        }>;
      };
      if (!Array.isArray(payload.data)) return undefined;
      // If NONE of the items has a `state` field, this isn't a real
      // LM Studio v0 response — fall back to OpenAI-compat.
      const hasStateField = payload.data.some((item) => typeof item.state === "string");
      if (!hasStateField) return undefined;
      return payload.data
        .map((item) => ({
          id: typeof item.id === "string" ? item.id : "",
          ownedBy: typeof item.publisher === "string" ? item.publisher : undefined,
          state: typeof item.state === "string" ? item.state : undefined,
          type: typeof item.type === "string" ? item.type : undefined,
        }))
        .filter((item) => {
          if (!item.id) return false;
          if (item.state !== "loaded") return false;
          // For the chat catalog, drop embedding-only models (they'd
          // 4xx on /chat/completions). For the embedding catalog,
          // KEEP only embedding-type models.
          if (role === "chat") return item.type !== "embeddings";
          return item.type === "embeddings";
        })
        .map(({ id, ownedBy }) => ({ id, ownedBy }));
    } catch {
      return undefined;
    }
  }
}
