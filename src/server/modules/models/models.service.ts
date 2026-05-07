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
    private readonly audit: AuditService,
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
      this.listOpenAiCompatibleModels(baseUrl),
      this.listOpenAiCompatibleModels(embeddingBaseUrl),
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
  ): Promise<Array<{ id: string; ownedBy?: string }>> {
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
}
