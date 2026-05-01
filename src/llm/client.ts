import { LlmConfig, Message, ModelTier } from "../types.js";

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
  constructor(private readonly config: LlmConfig) {}

  async complete(messages: Message[], options?: { temperature?: number; modelTier?: ModelTier }): Promise<string> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.modelForTier(options?.modelTier),
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

  modelForTier(tier?: ModelTier): string {
    if (!tier) return this.config.model;
    return this.config.tierModels[tier] ?? this.config.model;
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
  };
}
