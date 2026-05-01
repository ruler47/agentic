import { ModelTier, ModelTierSettings } from "../types.js";

const tiers: ModelTier[] = ["S", "M", "L", "XL"];

export type ModelTierSettingsStore = {
  list(): Promise<ModelTierSettings[]>;
  replace(settings: ModelTierSettingsInput[]): Promise<ModelTierSettings[]>;
};

export type ModelTierSettingsInput = {
  tier: ModelTier;
  models: string[];
  maxAttempts?: number;
  escalateOnFailure?: boolean;
};

export class InMemoryModelTierSettingsStore implements ModelTierSettingsStore {
  private settings = new Map<ModelTier, ModelTierSettings>();

  constructor(initialSettings: ModelTierSettingsInput[] = defaultModelTierSettings()) {
    const now = new Date().toISOString();
    for (const item of normalizeSettings(initialSettings, now)) {
      this.settings.set(item.tier, item);
    }
  }

  async list(): Promise<ModelTierSettings[]> {
    return tiers.map((tier) => this.settings.get(tier)).filter((item): item is ModelTierSettings => Boolean(item));
  }

  async replace(settings: ModelTierSettingsInput[]): Promise<ModelTierSettings[]> {
    const normalized = normalizeSettings(settings, new Date().toISOString());
    this.settings = new Map(normalized.map((item) => [item.tier, item]));
    return this.list();
  }
}

export function defaultModelTierSettings(): ModelTierSettingsInput[] {
  return tiers.map((tier) => ({
    tier,
    models: modelListForTier(tier),
    maxAttempts: tier === "XL" ? 1 : 2,
    escalateOnFailure: tier !== "XL",
  }));
}

export function normalizeSettings(
  settings: ModelTierSettingsInput[],
  updatedAt: string,
): ModelTierSettings[] {
  const byTier = new Map<ModelTier, ModelTierSettingsInput>();
  for (const setting of settings) {
    byTier.set(setting.tier, setting);
  }

  return tiers.map((tier) => {
    const setting = byTier.get(tier);
    const models = uniqueModels(setting?.models ?? modelListForTier(tier));
    return {
      tier,
      models,
      maxAttempts: Math.max(1, Math.min(5, setting?.maxAttempts ?? (tier === "XL" ? 1 : 2))),
      escalateOnFailure: setting?.escalateOnFailure ?? tier !== "XL",
      updatedAt,
    };
  });
}

function modelListForTier(tier: ModelTier): string[] {
  const specific = process.env[`LLM_MODEL_TIER_${tier}`];
  return uniqueModels([...(specific ? specific.split(",") : []), process.env.LLM_MODEL ?? "google/gemma-4-26b-a4b"]);
}

function uniqueModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}
