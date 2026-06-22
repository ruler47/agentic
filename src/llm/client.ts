import { LlmConfig, Message, ModelTier, TokenUsage } from "../types.js";
import {
  ModelTierSettingsInput,
  ModelTierSettingsStore,
} from "../settings/modelTierSettings.js";
import type { ModelCapability } from "../settings/modelCatalog.js";
import { resolveModelRoute, type ModelRouteDecision } from "../settings/modelRouting.js";

type ChatCompletionResponse = {
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: ToolCallFromLlm[];
    };
    finish_reason?: string;
  }>;
  error?: unknown;
};

export type ToolCallFromLlm = {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
};

/**
 * Phase 28 — recursive agent loop needs tool_calls back from the
 * model, not just the text body. This is the typed reply shape
 * `completeWithTools` returns; downstream callers branch on
 * `finishReason` to decide whether to invoke a tool and loop again
 * or treat `content` as the final answer.
 */
export type LlmToolReply = {
  content: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  finishReason: "tool_calls" | "stop" | "length" | "other";
  model?: string;
  usage?: TokenUsage;
};

export type LlmTextReply = {
  content: string;
  finishReason: "tool_calls" | "stop" | "length" | "other";
  model: string;
  usage: TokenUsage;
};

export type LlmToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type LlmRouteOptions = {
  requiredCapabilities?: ModelCapability[];
  preferredCapabilities?: ModelCapability[];
  onRouteDecision?: (decision: ModelRouteDecision) => void | Promise<void>;
};

export class LlmClient {
  constructor(
    private readonly config: LlmConfig,
    private readonly modelTierSettings?: ModelTierSettingsStore,
  ) {}

  async complete(
    messages: Message[],
    options?: {
      temperature?: number;
      modelTier?: ModelTier;
      model?: string;
      /** Aborts the underlying fetch when the operator cancels the run. */
      signal?: AbortSignal;
    } & LlmRouteOptions,
  ): Promise<string> {
    return (await this.completeDetailed(messages, options)).content;
  }

  async completeDetailed(
    messages: Message[],
    options?: {
      temperature?: number;
      modelTier?: ModelTier;
      model?: string;
      /** Aborts the underlying fetch when the operator cancels the run. */
      signal?: AbortSignal;
    } & LlmRouteOptions,
  ): Promise<LlmTextReply> {
    // Explicit `model` override bypasses tier resolution. We retry an explicit
    // model once on empty content because local OpenAI-compatible runtimes can
    // occasionally return an empty stream while warming up.
    const attempts = await this.modelAttemptsForTier(options?.modelTier, options);
    const errors: string[] = [];

    for (const model of attempts) {
      // Short-circuit before each attempt so a cancelled run doesn't
      // also burn the fallback candidates.
      if (options?.signal?.aborted) {
        throw new Error("LLM request cancelled by caller");
      }
      try {
        const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            temperature: options?.temperature ?? this.config.temperature,
          }),
          signal: options?.signal,
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

        return {
          content: content.trim(),
          finishReason: mapFinishReason(data.choices?.[0]?.finish_reason),
          model: typeof data.model === "string" && data.model.trim() ? data.model.trim() : model,
          usage: tokenUsageFromResponse(data),
        };
      } catch (error) {
        errors.push(`${model}: ${error instanceof Error ? error.message : "request failed"}`);
      }
    }

    throw new Error(`LLM request failed for all model candidates: ${errors.join("; ")}`);
  }

  /**
   * Phase 28 — chat completion that ALSO returns tool_calls (native
   * OpenAI function-calling shape). Used by the recursive agent loop
   * so the model can request `screenshot.url(...)`, `web.search(...)`,
   * `spawn_subagent(...)`, or `finish(...)` and we invoke them
   * programmatically rather than parsing JSON out of prose.
   *
   * Returns `{ content, toolCalls, finishReason }`. When
   * `finishReason === "tool_calls"` the caller MUST execute every
   * call in `toolCalls`, append the results to `messages`, and call
   * `completeWithTools` again. When `finishReason === "stop"` the
   * `content` is the final answer for this turn.
   *
   * Falls back to `complete()` semantics on retry-on-empty.
   */
  async completeWithTools(
    messages: Message[],
    tools: LlmToolSchema[],
    options?: {
      temperature?: number;
      modelTier?: ModelTier;
      model?: string;
      signal?: AbortSignal;
      toolChoice?: "auto" | "required" | "none";
      maxTokens?: number;
    } & LlmRouteOptions,
  ): Promise<LlmToolReply> {
    const attempts = await this.modelAttemptsForTier(options?.modelTier, options);
    const errors: string[] = [];

    for (const model of attempts) {
      if (options?.signal?.aborted) {
        throw new Error("LLM request cancelled by caller");
      }
      try {
        const body: Record<string, unknown> = {
          model,
          messages,
          temperature: options?.temperature ?? this.config.temperature,
          tools,
        };
        if (options?.toolChoice) body.tool_choice = options.toolChoice;
        if (options?.maxTokens) body.max_tokens = options.maxTokens;
        const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: options?.signal,
        });
        const rawBody = await response.text();
        const data = parseChatCompletionResponse(rawBody);
        if (!response.ok) {
          errors.push(`${model}: ${extractResponseError(data, response.status, rawBody)}`);
          continue;
        }
        const choice = data.choices?.[0];
        if (!choice) {
          errors.push(`${model}: empty choices`);
          continue;
        }
        const rawCalls = choice.message?.tool_calls ?? [];
        const toolCalls = rawCalls
          .map((call, index) => parseToolCall(call, index))
          .filter((call): call is { id: string; name: string; arguments: Record<string, unknown> } => Boolean(call));
        const finish = mapFinishReason(choice.finish_reason);
        // A model that emits `finish_reason=tool_calls` with no
        // parseable tool_calls is unusable — treat as transient
        // error and try next attempt.
        if (finish === "tool_calls" && toolCalls.length === 0) {
          errors.push(`${model}: finish_reason=tool_calls but tool_calls array was empty or malformed`);
          continue;
        }
        return {
          content: (choice.message?.content ?? "").trim(),
          toolCalls,
          finishReason: finish,
          model: typeof data.model === "string" && data.model.trim() ? data.model.trim() : model,
          usage: tokenUsageFromResponse(data),
        };
      } catch (error) {
        errors.push(`${model}: ${error instanceof Error ? error.message : "request failed"}`);
      }
    }

    throw new Error(`LLM tool request failed for all model candidates: ${errors.join("; ")}`);
  }

  async modelForTier(tier?: ModelTier): Promise<string> {
    if (!tier) return this.config.model;
    return (await this.modelsForTier(tier))[0] ?? this.config.model;
  }

  async modelsForTier(tier: ModelTier): Promise<string[]> {
    return (await this.policyForTier(tier)).models;
  }

  async modelAttemptsForTier(tier?: ModelTier, options?: LlmRouteOptions & { model?: string }): Promise<string[]> {
    const decision = await resolveModelRoute({
      requestedTier: tier,
      defaultModel: this.config.model,
      explicitModel: options?.model,
      requiredCapabilities: options?.requiredCapabilities,
      preferredCapabilities: options?.preferredCapabilities,
      policyForTier: (policyTier) => this.policyForTier(policyTier),
    });
    await options?.onRouteDecision?.(decision);
    return decision.attempts;
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

function parseToolCall(
  raw: ToolCallFromLlm,
  index: number,
): { id: string; name: string; arguments: Record<string, unknown> } | undefined {
  if (!raw || typeof raw.function !== "object") return undefined;
  const name = raw.function?.name;
  if (typeof name !== "string" || name.length === 0) return undefined;
  let parsed: Record<string, unknown> = {};
  if (typeof raw.function.arguments === "string" && raw.function.arguments.trim()) {
    try {
      const obj = JSON.parse(raw.function.arguments);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) parsed = obj as Record<string, unknown>;
    } catch {
      // Malformed arguments — leave parsed empty; the agent loop
      // can decide whether to bail or feed back an error so the
      // model retries.
    }
  }
  return {
    id: raw.id || `tool-call-${index}-${Date.now()}`,
    name,
    arguments: parsed,
  };
}

function tokenUsageFromResponse(data: ChatCompletionResponse): TokenUsage {
  const usage = data.usage;
  if (!usage) return { source: "unavailable" };
  const promptTokens = numericUsage(usage.prompt_tokens) ?? numericUsage(usage.promptTokens);
  const completionTokens = numericUsage(usage.completion_tokens) ?? numericUsage(usage.completionTokens);
  const totalTokens =
    numericUsage(usage.total_tokens) ??
    numericUsage(usage.totalTokens) ??
    (promptTokens !== undefined || completionTokens !== undefined ? (promptTokens ?? 0) + (completionTokens ?? 0) : undefined);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return { source: "unavailable" };
  }
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    source: "provider",
  };
}

function numericUsage(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function mapFinishReason(reason: string | undefined): "tool_calls" | "stop" | "length" | "other" {
  if (reason === "tool_calls") return "tool_calls";
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  return "other";
}
