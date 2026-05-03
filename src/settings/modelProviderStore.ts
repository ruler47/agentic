export type ModelProviderKind = "chat" | "embedding";

export type ModelProviderType =
  | "local"
  | "remote"
  | "openai-compatible"
  | "deterministic";

export type ModelProviderStatus = "available" | "disabled" | "failed";

export type ModelProviderHealthStatus = "unknown" | "ok" | "failed";

export type ModelProviderRecord = {
  id: string;
  label: string;
  kind: ModelProviderKind;
  providerType: ModelProviderType;
  baseUrl?: string;
  modelIds: string[];
  defaultModel?: string;
  apiKeySecretHandle?: string;
  dimensions?: number;
  status: ModelProviderStatus;
  healthStatus: ModelProviderHealthStatus;
  healthDetail?: string;
  createdAt: string;
  updatedAt: string;
};

export type ModelProviderInput = {
  id?: string;
  label: string;
  kind: ModelProviderKind;
  providerType: ModelProviderType;
  baseUrl?: string;
  modelIds?: string[];
  defaultModel?: string;
  apiKeySecretHandle?: string;
  dimensions?: number;
  status?: ModelProviderStatus;
  healthStatus?: ModelProviderHealthStatus;
  healthDetail?: string;
};

export type ModelProviderUpdateInput = Partial<Omit<ModelProviderInput, "id">>;

export type ModelProviderStore = {
  list(): Promise<ModelProviderRecord[]>;
  create(input: ModelProviderInput): Promise<ModelProviderRecord>;
  update(id: string, input: ModelProviderUpdateInput): Promise<ModelProviderRecord>;
  delete(id: string): Promise<boolean>;
};

const validKinds: ModelProviderKind[] = ["chat", "embedding"];
const validProviderTypes: ModelProviderType[] = [
  "local",
  "remote",
  "openai-compatible",
  "deterministic",
];
const validStatuses: ModelProviderStatus[] = ["available", "disabled", "failed"];
const validHealthStatuses: ModelProviderHealthStatus[] = ["unknown", "ok", "failed"];

export class InMemoryModelProviderStore implements ModelProviderStore {
  private providers = new Map<string, ModelProviderRecord>();

  constructor(initialProviders: ModelProviderInput[] = defaultModelProvidersFromEnv()) {
    const now = new Date().toISOString();
    for (const input of initialProviders) {
      const provider = normalizeProviderInput(input, now, now);
      this.providers.set(provider.id, provider);
    }
  }

  async list(): Promise<ModelProviderRecord[]> {
    return sortProviders([...this.providers.values()]);
  }

  async create(input: ModelProviderInput): Promise<ModelProviderRecord> {
    const now = new Date().toISOString();
    const provider = normalizeProviderInput(input, now, now);
    if (this.providers.has(provider.id)) {
      throw new Error(`Model provider already exists: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
    return { ...provider };
  }

  async update(id: string, input: ModelProviderUpdateInput): Promise<ModelProviderRecord> {
    const existing = this.providers.get(id);
    if (!existing) {
      throw new Error(`Model provider not found: ${id}`);
    }

    const updated = normalizeProviderInput(
      {
        id: existing.id,
        label: input.label ?? existing.label,
        kind: input.kind ?? existing.kind,
        providerType: input.providerType ?? existing.providerType,
        baseUrl: input.baseUrl ?? existing.baseUrl,
        modelIds: input.modelIds ?? existing.modelIds,
        defaultModel: input.defaultModel ?? existing.defaultModel,
        apiKeySecretHandle: input.apiKeySecretHandle ?? existing.apiKeySecretHandle,
        dimensions: input.dimensions ?? existing.dimensions,
        status: input.status ?? existing.status,
        healthStatus: input.healthStatus ?? existing.healthStatus,
        healthDetail: input.healthDetail ?? existing.healthDetail,
      },
      existing.createdAt,
      new Date().toISOString(),
    );
    this.providers.set(id, updated);
    return { ...updated };
  }

  async delete(id: string): Promise<boolean> {
    return this.providers.delete(id);
  }
}

export function defaultModelProvidersFromEnv(env: NodeJS.ProcessEnv = process.env): ModelProviderInput[] {
  const chatModels = uniqueStrings([
    env.LLM_MODEL,
    env.LLM_MODEL_TIER_S,
    env.LLM_MODEL_TIER_M,
    env.LLM_MODEL_TIER_L,
    env.LLM_MODEL_TIER_XL,
  ].flatMap((value) => (value ? value.split(",") : [])));
  const defaultChatModel = env.LLM_MODEL ?? chatModels[0] ?? "google/gemma-4-26b-a4b";
  const embeddingModel = env.EMBEDDING_MODEL;
  const embeddingProviderIsDeterministic = env.EMBEDDING_PROVIDER === "deterministic" || !embeddingModel;

  return [
    {
      id: "local-chat",
      label: "Local chat endpoint",
      kind: "chat",
      providerType: "openai-compatible",
      baseUrl: env.LLM_BASE_URL ?? "http://127.0.0.1:1234/v1",
      modelIds: uniqueStrings([defaultChatModel, ...chatModels]),
      defaultModel: defaultChatModel,
      status: "available",
      healthStatus: "unknown",
    },
    {
      id: "memory-embedding",
      label: embeddingProviderIsDeterministic ? "Deterministic memory embeddings" : "Memory embedding endpoint",
      kind: "embedding",
      providerType: embeddingProviderIsDeterministic ? "deterministic" : "openai-compatible",
      baseUrl: embeddingProviderIsDeterministic
        ? undefined
        : env.EMBEDDING_BASE_URL ?? env.LLM_BASE_URL ?? "http://127.0.0.1:1234/v1",
      modelIds: embeddingModel ? [embeddingModel] : [],
      defaultModel: embeddingModel,
      dimensions: Number(env.MEMORY_EMBEDDING_DIMENSIONS ?? "128"),
      status: "available",
      healthStatus: embeddingProviderIsDeterministic ? "ok" : "unknown",
      healthDetail: embeddingProviderIsDeterministic
        ? "Deterministic local fallback is active until an embedding provider is configured."
        : undefined,
    },
  ];
}

export function normalizeProviderInput(
  input: ModelProviderInput,
  createdAt: string,
  updatedAt: string,
): ModelProviderRecord {
  const id = normalizeId(input.id ?? input.label);
  const label = String(input.label ?? "").trim();
  if (!label) {
    throw new Error("Model provider label is required");
  }
  if (!validKinds.includes(input.kind)) {
    throw new Error("Invalid model provider kind");
  }
  if (!validProviderTypes.includes(input.providerType)) {
    throw new Error("Invalid model provider type");
  }

  const status = input.status ?? "available";
  const healthStatus = input.healthStatus ?? "unknown";
  if (!validStatuses.includes(status)) {
    throw new Error("Invalid model provider status");
  }
  if (!validHealthStatuses.includes(healthStatus)) {
    throw new Error("Invalid model provider health status");
  }

  const baseUrl = optionalString(input.baseUrl);
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    throw new Error("Model provider baseUrl must be an http(s) URL");
  }

  const modelIds = uniqueStrings(input.modelIds ?? []);
  const defaultModel = optionalString(input.defaultModel) ?? modelIds[0];
  const apiKeySecretHandle = optionalString(input.apiKeySecretHandle);
  const dimensions = normalizeDimensions(input.kind, input.dimensions);

  return {
    id,
    label,
    kind: input.kind,
    providerType: input.providerType,
    baseUrl,
    modelIds,
    defaultModel,
    apiKeySecretHandle,
    dimensions,
    status,
    healthStatus,
    healthDetail: optionalString(input.healthDetail),
    createdAt,
    updatedAt,
  };
}

export function sortProviders(providers: ModelProviderRecord[]): ModelProviderRecord[] {
  return providers.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.label.localeCompare(b.label);
  });
}

function normalizeId(value: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) {
    throw new Error("Model provider id is required");
  }
  if (id.length > 120) {
    throw new Error("Model provider id is too long");
  }
  return id;
}

function optionalString(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeDimensions(kind: ModelProviderKind, dimensions: unknown): number | undefined {
  if (kind !== "embedding") return undefined;
  const value = typeof dimensions === "number" ? dimensions : Number(dimensions ?? 128);
  if (!Number.isFinite(value)) return 128;
  return Math.max(1, Math.min(8192, Math.round(value)));
}
