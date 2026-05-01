import { LlmConfig, Message, ModelTier } from "../types.js";
import { ModelTierSettingsStore } from "../settings/modelTierSettings.js";

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

export class LlmClient {
  constructor(
    private readonly config: LlmConfig,
    private readonly modelTierSettings?: ModelTierSettingsStore,
  ) {}

  async complete(messages: Message[], options?: { temperature?: number; modelTier?: ModelTier }): Promise<string> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: await this.modelForTier(options?.modelTier),
        messages,
        temperature: options?.temperature ?? this.config.temperature,
      }),
    });

    const data = (await response.json()) as ChatCompletionResponse;

    if (!response.ok) {
      throw new Error(data.error?.message ?? `LLM request failed with ${response.status}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("LLM response did not contain assistant content");
    }

    return content.trim();
  }

  async modelForTier(tier?: ModelTier): Promise<string> {
    if (!tier) return this.config.model;
    return (await this.modelsForTier(tier))[0] ?? this.config.model;
  }

  async modelsForTier(tier: ModelTier): Promise<string[]> {
    if (this.modelTierSettings) {
      const settings = await this.modelTierSettings.list();
      const models = settings.find((item) => item.tier === tier)?.models ?? [];
      if (models.length > 0) return models;
    }

    const configured = this.config.tierModelCandidates[tier] ?? [];
    const legacy = this.config.tierModels[tier];
    const candidates = [...configured, ...(legacy ? [legacy] : []), this.config.model];
    return [...new Set(candidates.map((model) => model.trim()).filter(Boolean))];
  }
}

export function readLlmConfigFromEnv(): LlmConfig {
  return {
    baseUrl: process.env.LLM_BASE_URL ?? "http://127.0.0.1:1234/v1",
    model: process.env.LLM_MODEL ?? "google/gemma-4-26b-a4b",
    temperature: Number(process.env.LLM_TEMPERATURE ?? "0.2"),
    tierModels: {
      S: process.env.LLM_MODEL_TIER_S,
      M: process.env.LLM_MODEL_TIER_M,
      L: process.env.LLM_MODEL_TIER_L,
      XL: process.env.LLM_MODEL_TIER_XL,
    },
    tierModelCandidates: {
      S: parseModelList(process.env.LLM_MODEL_TIER_S),
      M: parseModelList(process.env.LLM_MODEL_TIER_M),
      L: parseModelList(process.env.LLM_MODEL_TIER_L),
      XL: parseModelList(process.env.LLM_MODEL_TIER_XL),
    },
  };
}

function parseModelList(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean)
    : [];
}
