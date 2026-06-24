import type { ModelCapability } from "./modelCatalog.js";

export type ModelPreferredRole =
  | "classification"
  | "planning"
  | "coding"
  | "vision"
  | "synthesis"
  | "tool-use";

export type ModelProfileRecord = {
  id: string;
  providerId: string;
  modelId: string;
  displayName?: string;
  enabled: boolean;
  capabilities: ModelCapability[];
  capabilitiesOverridden: boolean;
  preferredRoles: ModelPreferredRole[];
  contextWindow?: number;
  maxOutputTokens?: number;
  operatorNotes?: string;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ModelProfileInput = {
  providerId?: string;
  modelId: string;
  displayName?: string;
  enabled?: boolean;
  capabilities?: ModelCapability[];
  capabilitiesOverridden?: boolean;
  preferredRoles?: ModelPreferredRole[];
  contextWindow?: number;
  maxOutputTokens?: number;
  operatorNotes?: string;
  verifiedAt?: string;
};

export type ModelProfileStore = {
  list(): Promise<ModelProfileRecord[]>;
  upsert(input: ModelProfileInput): Promise<ModelProfileRecord>;
  delete(id: string): Promise<boolean>;
};

const capabilities: ModelCapability[] = [
  "chat",
  "embedding",
  "vision",
  "reasoning",
  "coding",
  "tool-calling",
];

const preferredRoles: ModelPreferredRole[] = [
  "classification",
  "planning",
  "coding",
  "vision",
  "synthesis",
  "tool-use",
];

export class InMemoryModelProfileStore implements ModelProfileStore {
  private profiles = new Map<string, ModelProfileRecord>();

  constructor(initialProfiles: ModelProfileInput[] = []) {
    const now = new Date().toISOString();
    for (const input of initialProfiles) {
      const profile = normalizeModelProfileInput(input, now, now);
      this.profiles.set(profile.id, profile);
    }
  }

  async list(): Promise<ModelProfileRecord[]> {
    return sortProfiles([...this.profiles.values()]);
  }

  async upsert(input: ModelProfileInput): Promise<ModelProfileRecord> {
    const id = modelProfileId(input.providerId, input.modelId);
    const existing = this.profiles.get(id);
    const now = new Date().toISOString();
    const profile = normalizeModelProfileInput(
      mergeModelProfileInput(existing, input),
      existing?.createdAt ?? now,
      now,
    );
    this.profiles.set(profile.id, profile);
    return { ...profile };
  }

  async delete(id: string): Promise<boolean> {
    return this.profiles.delete(id);
  }
}

export function modelProfileId(providerId: string | undefined, modelId: string): string {
  return `${normalizeProviderId(providerId)}:${normalizeModelId(modelId)}`;
}

export function normalizeModelProfileInput(
  input: ModelProfileInput,
  createdAt: string,
  updatedAt: string,
): ModelProfileRecord {
  const providerId = normalizeProviderId(input.providerId);
  const modelId = normalizeModelId(input.modelId);
  const normalizedCapabilities = normalizeCapabilities(input.capabilities ?? []);
  return {
    id: modelProfileId(providerId, modelId),
    providerId,
    modelId,
    displayName: optionalString(input.displayName),
    enabled: input.enabled ?? true,
    capabilities: normalizedCapabilities,
    capabilitiesOverridden: input.capabilitiesOverridden ?? normalizedCapabilities.length > 0,
    preferredRoles: normalizePreferredRoles(input.preferredRoles ?? []),
    contextWindow: positiveInteger(input.contextWindow),
    maxOutputTokens: positiveInteger(input.maxOutputTokens),
    operatorNotes: optionalString(input.operatorNotes),
    verifiedAt: optionalDateString(input.verifiedAt),
    createdAt,
    updatedAt,
  };
}

export function capabilityOverridesFromModelProfiles(
  profiles: ModelProfileRecord[],
): Record<string, ModelCapability[]> {
  const overrides: Record<string, ModelCapability[]> = {};
  for (const profile of profiles) {
    if (!profile.enabled || !profile.capabilitiesOverridden) continue;
    overrides[profile.modelId] = profile.capabilities;
    overrides[profile.modelId.toLowerCase()] = profile.capabilities;
  }
  return overrides;
}

export function disabledModelIdsFromProfiles(profiles: ModelProfileRecord[]): string[] {
  return [...new Set(profiles.filter((profile) => !profile.enabled).map((profile) => profile.modelId))];
}

export function profileForModel(
  profiles: ModelProfileRecord[],
  providerId: string | undefined,
  modelId: string,
): ModelProfileRecord | undefined {
  const directId = modelProfileId(providerId, modelId);
  return (
    profiles.find((profile) => profile.id === directId) ??
    profiles.find((profile) => profile.modelId === modelId)
  );
}

export function sortProfiles(profiles: ModelProfileRecord[]): ModelProfileRecord[] {
  return profiles.sort((a, b) => {
    const provider = a.providerId.localeCompare(b.providerId);
    return provider || a.modelId.localeCompare(b.modelId);
  });
}

export function normalizeCapabilities(values: ModelCapability[]): ModelCapability[] {
  const normalized = new Set<ModelCapability>();
  for (const value of values) {
    if (capabilities.includes(value)) normalized.add(value);
  }
  if (normalized.has("embedding")) return ["embedding"];
  return [...normalized];
}

export function mergeModelProfileInput(
  existing: ModelProfileRecord | undefined,
  input: ModelProfileInput,
): ModelProfileInput {
  if (!existing) return input;
  return {
    providerId: input.providerId ?? existing.providerId,
    modelId: input.modelId ?? existing.modelId,
    displayName: input.displayName ?? existing.displayName,
    enabled: input.enabled ?? existing.enabled,
    capabilities: input.capabilities ?? existing.capabilities,
    capabilitiesOverridden: input.capabilitiesOverridden ?? existing.capabilitiesOverridden,
    preferredRoles: input.preferredRoles ?? existing.preferredRoles,
    contextWindow: input.contextWindow ?? existing.contextWindow,
    maxOutputTokens: input.maxOutputTokens ?? existing.maxOutputTokens,
    operatorNotes: input.operatorNotes ?? existing.operatorNotes,
    verifiedAt: input.verifiedAt ?? existing.verifiedAt,
  };
}

function normalizeProviderId(value: string | undefined): string {
  return normalizeId(value ?? "local-chat", "Model profile provider id is required");
}

function normalizeModelId(value: string): string {
  const modelId = String(value ?? "").trim();
  if (!modelId) throw new Error("Model profile modelId is required");
  if (modelId.length > 240) throw new Error("Model profile modelId is too long");
  return modelId;
}

function normalizeId(value: string, message: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) throw new Error(message);
  if (id.length > 120) throw new Error("Model profile provider id is too long");
  return id;
}

function normalizePreferredRoles(values: ModelPreferredRole[]): ModelPreferredRole[] {
  return [...new Set(values.filter((value) => preferredRoles.includes(value)))];
}

function optionalString(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function optionalDateString(value: unknown): string | undefined {
  const text = optionalString(value);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function positiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.round(number);
}
