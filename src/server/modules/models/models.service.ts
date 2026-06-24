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
import type {
  ModelProfileRecord,
  ModelProfileStore,
} from "../../../settings/modelProfileStore.js";
import type { ModelTierSettingsStore } from "../../../settings/modelTierSettings.js";
import type { ModelTierSettings } from "../../../types.js";
import { AuditService } from "../../common/services/audit.service.js";
import { MODEL_PROFILE_STORE, MODEL_PROVIDER_STORE, MODEL_TIER_SETTINGS } from "../../persistence/tokens.js";
import type {
  CreateModelProviderDto,
  UpdateModelProviderDto,
} from "./dto/model-provider.dto.js";
import type { UpdateTiersDto } from "./dto/update-tiers.dto.js";
import {
  decorateCatalogModel,
  parseModelCapabilityOverrides,
  type CatalogModelRecord,
} from "../../../settings/modelCatalog.js";
import type { UpsertModelProfileDto } from "./dto/model-profile.dto.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_MODEL = "google/gemma-4-26b-a4b";

@Injectable()
export class ModelsService {
  constructor(
    @Inject(MODEL_TIER_SETTINGS) private readonly tiers: ModelTierSettingsStore | undefined,
    @Inject(MODEL_PROVIDER_STORE) private readonly providers: ModelProviderStore | undefined,
    @Inject(MODEL_PROFILE_STORE) private readonly profiles: ModelProfileStore | undefined,
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

  async listProfiles(): Promise<ModelProfileRecord[]> {
    return this.profiles ? this.profiles.list() : [];
  }

  async upsertProfile(dto: UpsertModelProfileDto): Promise<ModelProfileRecord> {
    if (!this.profiles) {
      throw new ServiceUnavailableException("Model profile store is not configured");
    }
    let profile: ModelProfileRecord;
    try {
      profile = await this.profiles.upsert({
        providerId: dto.providerId,
        modelId: dto.modelId,
        displayName: dto.displayName,
        enabled: dto.enabled,
        capabilities: dto.capabilities,
        capabilitiesOverridden: dto.capabilitiesOverridden,
        preferredRoles: dto.preferredRoles,
        contextWindow: dto.contextWindow,
        maxOutputTokens: dto.maxOutputTokens,
        operatorNotes: dto.operatorNotes,
        verifiedAt: dto.verifiedAt,
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid model profile",
      );
    }
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "model_profile.upserted",
      targetType: "model_profile",
      targetId: profile.id,
      status: "success",
      summary: `Model profile saved: ${profile.modelId}`,
      metadata: {
        providerId: profile.providerId,
        enabled: profile.enabled,
        capabilities: profile.capabilities,
        capabilitiesOverridden: profile.capabilitiesOverridden,
      },
    });
    return profile;
  }

  async catalog() {
    const baseUrl = process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL;
    const embeddingBaseUrl = process.env.EMBEDDING_BASE_URL ?? baseUrl;
    const providers = this.providers ? await this.providers.list() : [];
    const profiles = this.profiles ? await this.profiles.list() : [];
    const capabilityOverrides = parseModelCapabilityOverrides(process.env.LLM_MODEL_CAPABILITIES);
    const [rawChatModels, rawEmbeddingModels] = await Promise.all([
      this.listOpenAiCompatibleModels(baseUrl),
      this.listOpenAiCompatibleModels(embeddingBaseUrl),
    ]);
    const chatInputs = mergeCatalogInputs([
      ...rawChatModels.map((model) => ({ ...model, providerId: "local-chat" })),
      ...providerCatalogModels(providers, "chat"),
      ...profiles.filter((profile) => profile.providerId && profile.modelId),
    ]);
    const embeddingInputs = mergeCatalogInputs([
      ...rawEmbeddingModels.map((model) => ({ ...model, providerId: "memory-embedding" })),
      ...providerCatalogModels(providers, "embedding"),
      ...profiles.filter((profile) => profile.providerId && profile.modelId),
    ]);
    const chatModels = chatInputs
      .map((model) => decorateCatalogModel(model, capabilityOverrides, profileForCatalog(profiles, model.providerId, model.id)))
      .filter((model) => model.capabilities.includes("chat"));
    const embeddingModels = embeddingInputs
      .map((model) => decorateCatalogModel(model, capabilityOverrides, profileForCatalog(profiles, model.providerId, model.id)))
      .filter((model) => model.capabilities.includes("embedding"));
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
      profiles,
    };
  }

  private async listOpenAiCompatibleModels(
    baseUrl: string,
  ): Promise<Array<Pick<CatalogModelRecord, "id" | "ownedBy">>> {
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

function providerCatalogModels(
  providers: ModelProviderRecord[],
  kind: "chat" | "embedding",
): Array<Pick<CatalogModelRecord, "id" | "ownedBy" | "providerId">> {
  return providers
    .filter((provider) => provider.kind === kind)
    .flatMap((provider) =>
      provider.modelIds.map((modelId) => ({
        id: modelId,
        ownedBy: provider.label,
        providerId: provider.id,
      })),
    );
}

function mergeCatalogInputs(
  inputs: Array<Pick<CatalogModelRecord, "id" | "ownedBy" | "providerId"> | ModelProfileRecord>,
): Array<Pick<CatalogModelRecord, "id" | "ownedBy" | "providerId">> {
  const byKey = new Map<string, Pick<CatalogModelRecord, "id" | "ownedBy" | "providerId">>();
  for (const input of inputs) {
    const id = "modelId" in input ? input.modelId : input.id;
    const providerId = "providerId" in input ? input.providerId : undefined;
    if (!id) continue;
    const key = `${providerId ?? ""}:${id}`;
    if (!byKey.has(key)) {
      byKey.set(key, { id, providerId, ownedBy: "ownedBy" in input ? input.ownedBy : undefined });
    }
  }
  return [...byKey.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function profileForCatalog(
  profiles: ModelProfileRecord[],
  providerId: string | undefined,
  modelId: string,
): ModelProfileRecord | undefined {
  return (
    profiles.find((profile) => profile.providerId === providerId && profile.modelId === modelId) ??
    profiles.find((profile) => profile.modelId === modelId)
  );
}
