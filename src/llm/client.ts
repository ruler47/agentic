import { LlmConfig, Message, ModelTier } from "../types.js";
import {
  ModelTierSettingsInput,
  ModelTierSettingsStore,
} from "../settings/modelTierSettings.js";

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: unknown;
};

const tierOrder: ModelTier[] = ["S", "M", "L", "XL"];

export class LlmClient {
  constructor(
    private readonly config: LlmConfig,
    private readonly modelTierSettings?: ModelTierSettingsStore,
  ) {}

  async complete(
    messages: Message[],
    options?: { temperature?: number; modelTier?: ModelTier; model?: string },
  ): Promise<string> {
    // Phase 14: explicit `model` override bypasses tier resolution so the
    // tool-build council can address each peer model directly. Falls
    // through to tier-based attempts when omitted. We retry an explicit
    // model once on empty content — LM Studio + large quantised models
    // occasionally return an empty stream the first time the model is
    // warmed up.
    const attempts = options?.model
      ? [options.model, options.model]
      : await this.modelAttemptsForTier(options?.modelTier);
    const errors: string[] = [];

    for (const model of attempts) {
      try {
        const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            temperature: options?.temperature ?? this.config.temperature,
          }),
        });

        const rawBody = await response.text();
        const data = parseChatCompletionResponse(rawBody);

        if (!response.ok) {
          errors.push(`${model}: ${extractResponseError(data, response.status, rawBody)}`);
          continue;
        }

        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          errors.push(`${model}: empty assistant content`);
          continue;
        }

        return content.trim();
      } catch (error) {
        errors.push(`${model}: ${error instanceof Error ? error.message : "request failed"}`);
      }
    }

    throw new Error(`LLM request failed for all model candidates: ${errors.join("; ")}`);
  }

  async modelForTier(tier?: ModelTier): Promise<string> {
    if (!tier) return this.config.model;
    return (await this.modelsForTier(tier))[0] ?? this.config.model;
  }

  async modelsForTier(tier: ModelTier): Promise<string[]> {
    return (await this.policyForTier(tier)).models;
  }

  async modelAttemptsForTier(tier?: ModelTier): Promise<string[]> {
    if (!tier) return [this.config.model];

    const attempts: string[] = [];
    let currentTier: ModelTier | undefined = tier;

    while (currentTier) {
      const policy = await this.policyForTier(currentTier);
      for (const model of policy.models) {
        for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
          attempts.push(model);
        }
      }

      if (!policy.escalateOnFailure) break;
      currentTier = nextTier(currentTier);
    }

    return attempts;
  }

  private async policyForTier(tier: ModelTier): Promise<Required<ModelTierSettingsInput>> {
    if (this.modelTierSettings) {
      const settings = await this.modelTierSettings.list();
      const policy = settings.find((item) => item.tier === tier);
      if (policy && policy.models.length > 0) {
        return {
          tier,
          models: policy.models,
          maxAttempts: policy.maxAttempts,
          escalateOnFailure: policy.escalateOnFailure,
        };
      }
    }

    const configured = this.config.tierModelCandidates[tier] ?? [];
    const legacy = this.config.tierModels[tier];
    const models = uniqueModels([...configured, ...(legacy ? [legacy] : []), this.config.model]);

    return {
      tier,
      models,
      maxAttempts: tier === "XL" ? 1 : 2,
      escalateOnFailure: tier !== "XL",
    };
  }
}

function parseChatCompletionResponse(rawBody: string): ChatCompletionResponse {
  if (!rawBody.trim()) return {};

  try {
    return JSON.parse(rawBody) as ChatCompletionResponse;
  } catch {
    return {};
  }
}

function extractResponseError(data: ChatCompletionResponse, status: number, rawBody: string): string {
  const fallback = rawBody.trim() ? `HTTP ${status}: ${rawBody.slice(0, 500)}` : `HTTP ${status}`;
  const error = data.error;

  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
    if (typeof record.type === "string") return `${record.type}: ${fallback}`;
  }

  return fallback;
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

function uniqueModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

function nextTier(tier: ModelTier): ModelTier | undefined {
  const nextIndex = tierOrder.indexOf(tier) + 1;
  return tierOrder[nextIndex];
}
