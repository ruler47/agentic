import { LlmConfig, Message, ModelTier } from "../types.js";
import {
  ModelTierSettingsInput,
  ModelTierSettingsStore,
} from "../settings/modelTierSettings.js";

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
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
};

export type LlmToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

const tierOrder: ModelTier[] = ["S", "M", "L", "XL"];

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
      maxTokens?: number;
      /** Aborts the underlying fetch when the operator cancels the run. */
      signal?: AbortSignal;
    },
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
      // Short-circuit before each attempt so a cancelled run doesn't
      // also burn the fallback candidates.
      if (options?.signal?.aborted) {
        throw new Error("LLM request cancelled by caller");
      }
      try {
        const timeout = createRequestTimeout(this.config.requestTimeoutMs);
        try {
          const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(addReasoningEffort({
              model,
              messages,
              temperature: options?.temperature ?? this.config.temperature,
              ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
            }, this.config.reasoningEffort)),
            signal: combineSignals(options?.signal, timeout.signal),
          });

          const rawBody = await response.text();
          const data = parseChatCompletionResponse(rawBody);

          if (!response.ok) {
            errors.push(`${model}: ${extractResponseError(data, response.status, rawBody)}`);
            continue;
          }

          const choice = data.choices?.[0];
          const content = normalizeAssistantContent(choice?.message?.content, choice?.message?.reasoning_content);
          if (!content) {
            errors.push(`${model}: empty assistant content`);
            continue;
          }

          return content.trim();
        } finally {
          timeout.clear();
        }
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
    },
  ): Promise<LlmToolReply> {
    const attempts = options?.model
      ? [options.model, options.model]
      : await this.modelAttemptsForTier(options?.modelTier);
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
        addReasoningEffort(body, this.config.reasoningEffort);
        if (options?.toolChoice) body.tool_choice = options.toolChoice;
        if (options?.maxTokens) body.max_tokens = options.maxTokens;
        const timeout = createRequestTimeout(this.config.requestTimeoutMs);
        try {
          const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: combineSignals(options?.signal, timeout.signal),
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
            content: normalizeAssistantContent(choice.message?.content, choice.message?.reasoning_content),
            toolCalls,
            finishReason: finish,
          };
        } finally {
          timeout.clear();
        }
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

  async modelAttemptsForTier(tier?: ModelTier): Promise<string[]> {
    if (!tier) return [this.config.model];

    const attempts: string[] = [];
    const seenModels = new Set<string>();
    let currentTier: ModelTier | undefined = tier;

    while (currentTier) {
      const policy = await this.policyForTier(currentTier);
      for (const model of policy.models) {
        if (seenModels.has(model)) continue;
        seenModels.add(model);
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

function normalizeAssistantContent(content: string | undefined, reasoningContent: string | undefined): string {
  const finalContent = content?.trim();
  if (finalContent) return finalContent;

  // LM Studio can expose local reasoning models as OpenAI-compatible chat
  // completions where all assistant text is placed in `reasoning_content`
  // and `message.content` stays empty. Treat that as usable assistant text
  // so local models do not look like hard failures to the runtime.
  return reasoningContent?.trim() ?? "";
}

export function readLlmConfigFromEnv(): LlmConfig {
  const baseUrl = process.env.LLM_BASE_URL ?? "http://127.0.0.1:1234/v1";
  return {
    baseUrl,
    model: process.env.LLM_MODEL ?? "google/gemma-4-26b-a4b",
    temperature: Number(process.env.LLM_TEMPERATURE ?? "0.2"),
    requestTimeoutMs: parsePositiveInteger(process.env.LLM_REQUEST_TIMEOUT_MS, 120_000),
    reasoningEffort: resolveReasoningEffort(baseUrl),
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

function addReasoningEffort<T extends Record<string, unknown>>(body: T, reasoningEffort: string | undefined): T {
  if (reasoningEffort) {
    (body as Record<string, unknown>).reasoning_effort = reasoningEffort;
  }
  return body;
}

function resolveReasoningEffort(baseUrl: string): string | undefined {
  if (process.env.LLM_REASONING_EFFORT === "disabled") return undefined;
  if (process.env.LLM_REASONING_EFFORT) return process.env.LLM_REASONING_EFFORT;
  return isLocalLmStudioUrl(baseUrl) ? "none" : undefined;
}

function isLocalLmStudioUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    return ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) && parsed.port === "1234";
  } catch {
    return false;
  }
}

function createRequestTimeout(timeoutMs: number | undefined): { signal?: AbortSignal; clear(): void } {
  const ms = timeoutMs ?? 120_000;
  if (!Number.isFinite(ms) || ms <= 0) return { clear() {} };

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`LLM request timed out after ${ms}ms`));
  }, ms);
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
    },
  };
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.round(parsed);
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

function mapFinishReason(reason: string | undefined): "tool_calls" | "stop" | "length" | "other" {
  if (reason === "tool_calls") return "tool_calls";
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  return "other";
}
