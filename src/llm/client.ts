import { Agent, fetch as undiciFetch, setGlobalDispatcher } from "undici";

import { LlmConfig, Message, ModelTier } from "../types.js";
import {
  ModelTierSettingsInput,
  ModelTierSettingsStore,
} from "../settings/modelTierSettings.js";

/**
 * Phase 22 Slice D — long-tail LM Studio patience.
 *
 * Local LLMs (LM Studio + 26B-35B Q4 models on consumer GPUs) can
 * genuinely think for 30+ minutes on a single implement or repair
 * call once the reasoning chain + research delegation cycles
 * accumulate to ~100 k tokens. Undici's default
 * `headersTimeout = 5min` cuts that off prematurely with
 * "fetch failed" and the council Borda-falls to a different model
 * mid-thought, wasting work.
 *
 * We initially capped at 30 min as a safety net; in practice
 * Qwen 35 B routinely exceeded that on the implement phase of
 * non-trivial tools (e.g. screenshot.url rework with bumped 250 k
 * LM-Studio context). Setting both timeouts to `0` disables them
 * in undici — the fetch lives as long as the TCP socket does,
 * matching what an operator wants for a healthy-but-slow local
 * model. `connectTimeout` stays at the default so a wedged DNS /
 * TCP handshake still fails fast (that one IS a real infra problem
 * and should not hang the run).
 *
 * The runaway-prompt risk is bounded elsewhere:
 *   - Phase 22 Slice A (cross-LLM repair fallback) re-routes if a
 *     model keeps failing.
 *   - Operator cancel + Phase 19 Slice B "resume from here" let
 *     the human kill a genuinely-stuck run.
 *   - Phase 23 (planned) adds prompt-token instrumentation +
 *     reasoning-budget controls so we shrink prompts at source
 *     instead of timing them out.
 *
 * Using undici's global dispatcher lets unit tests swap a
 * `MockAgent` through the same API to intercept requests.
 */
const LLM_FETCH_TIMEOUT_MS = 0;
setGlobalDispatcher(
  new Agent({
    headersTimeout: LLM_FETCH_TIMEOUT_MS,
    bodyTimeout: LLM_FETCH_TIMEOUT_MS,
  }),
);

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      /**
       * LM Studio (and some other local OpenAI-compatible servers
       * running reasoning models) surface the model's chain-of-thought
       * here when the chat template enters thinking mode. We treat
       * it as a fallback for `content` when the latter is empty —
       * Qwen 3.x in particular has been observed to put its entire
       * answer in `reasoning_content` if `enable_thinking=false` was
       * silently ignored.
       */
      reasoning_content?: string;
    };
    /**
     * OpenAI-compatible servers (LM Studio, vLLM, llama.cpp) set this
     * to "stop" | "length" | "content_filter" | …. When the model
     * returns empty content the reason distinguishes context-window
     * overflow ("length") from a refusal/early-stop ("stop") — we
     * surface it in the error string so the operator can pick the
     * right remediation (shrink prompt vs. reword) from the trace.
     */
    finish_reason?: string;
  }>;
  /**
   * Phase 23 Slice A — token telemetry. Every OpenAI-compatible
   * server emits this on completion responses. Surfaced to council
   * callers via the `onUsage` option so individual span emits can
   * record per-call token cost in `payload.tokens` and the run
   * coordinator can aggregate a per-run total.
   */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: unknown;
};

export type LlmTokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** The model that produced the usage (post-fallback resolution). */
  model: string;
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
      /** Aborts the underlying fetch when the operator cancels the run. */
      signal?: AbortSignal;
      /**
       * Phase 23 Slice A — fires with the LM Studio `usage` block
       * once a model returns a non-empty completion. Side-channel so
       * existing string-returning callers don't need to change their
       * signatures. Council callers attach the usage to their span
       * payload so the trace shows tokens per card + a per-run total.
       */
      onUsage?: (usage: LlmTokenUsage) => void;
      /**
       * Phase 23 Slice C — hard cap on completion tokens. Forwarded
       * as `max_tokens` to the server. Useful for short phases like
       * brainstorm / vote where letting Qwen run a 200 k-token
       * reasoning chain costs hours without improving the proposal.
       */
      maxTokens?: number;
      /**
       * Phase 23 Slice C — reasoning depth control.
       *   - "disabled": forces `chat_template_kwargs.enable_thinking=false`
       *     (Qwen-specific) + `reasoning_effort: "low"` (OpenAI-style).
       *     Non-reasoning models ignore both.
       *   - "low" | "medium" | "high": maps to `reasoning_effort`
       *     verbatim. Reasoning-capable models honour it; others
       *     ignore.
       * Default (undefined): no parameter sent — server default.
       */
      reasoning?: "disabled" | "low" | "medium" | "high";
    },
  ): Promise<string> {
    // Phase 14: explicit `model` override bypasses tier resolution so the
    // tool-build council can address each peer model directly. Falls
    // through to tier-based attempts when omitted.
    //
    // Phase G follow-up: the council loop is the only caller that sets
    // `options.model`, and it owns its own cross-model fallback via
    // Borda alternates (see `runToolBuildCouncil` in
    // `src/agents/universalAgent.ts`). Re-trying the SAME model with
    // the SAME prompt here only doubled latency on context-window
    // overflows — LM Studio returns 200-with-empty-content
    // deterministically when `finish_reason="length"`, so the second
    // call would have failed identically ~5 ms later. Dropping the
    // duplicate attempt saves ~40 s per gemma-empty fallback without
    // losing recovery: the council loop still tries the next Borda
    // candidate.
    const attempts = options?.model
      ? [options.model]
      : await this.modelAttemptsForTier(options?.modelTier);
    const errors: string[] = [];

    for (const model of attempts) {
      // Short-circuit before each attempt so a cancelled run doesn't
      // also burn the fallback candidates.
      if (options?.signal?.aborted) {
        throw new Error("LLM request cancelled by caller");
      }
      try {
        // Use the NPM-installed undici's fetch (not Node's bundled
        // global fetch) so the long-tail timeout Agent we set at
        // module load via `setGlobalDispatcher` actually intercepts
        // these requests. Tests can swap the dispatcher to a
        // MockAgent through the same API.
        // Phase 23 Slice C — assemble request body with optional
        // per-phase max_tokens + reasoning controls. Disabled
        // reasoning is sent BOTH as `reasoning_effort: "low"` (the
        // OpenAI-style hint that quantised local models often
        // respect) AND `chat_template_kwargs.enable_thinking: false`
        // (the Qwen-specific switch LM Studio honours). Non-reasoning
        // models silently drop both.
        // Phase 28 follow-up — Qwen 3.x family ignores
        // `chat_template_kwargs.enable_thinking: false` for unknown
        // LM Studio reasons (we tested empirically: with
        // enable_thinking=false the model STILL spends all completion
        // tokens in `reasoning_content` and returns empty `content`).
        // The actual switch Qwen honors is the magic `/no_think`
        // string in the system prompt — when present at the start of
        // any system message, Qwen's chat template skips the thinking
        // block entirely. Gemma + other non-Qwen models silently
        // ignore the marker, so it's safe to prepend universally
        // whenever the caller said reasoning is "disabled".
        const effectiveMessages: Message[] = (() => {
          if (options?.reasoning !== "disabled") return [...messages];
          const out: Message[] = [];
          let injected = false;
          for (const msg of messages) {
            if (!injected && msg.role === "system") {
              const already = /^\s*\/no_think\b/.test(msg.content);
              out.push({
                role: "system",
                content: already ? msg.content : `/no_think\n${msg.content}`,
              });
              injected = true;
            } else {
              out.push(msg);
            }
          }
          if (!injected) {
            // No system message in this call — prepend a bare one
            // carrying just the magic marker.
            out.unshift({ role: "system", content: "/no_think" });
          }
          return out;
        })();
        const requestBody: Record<string, unknown> = {
          model,
          messages: effectiveMessages,
          temperature: options?.temperature ?? this.config.temperature,
        };
        if (typeof options?.maxTokens === "number" && options.maxTokens > 0) {
          requestBody.max_tokens = options.maxTokens;
        }
        if (options?.reasoning) {
          if (options.reasoning === "disabled") {
            // Phase 28 follow-up — empirically `reasoning_effort: "low"`
            // is INTERPRETED DIFFERENTLY by different OpenAI-compatible
            // servers and quantised local models: LM Studio's Qwen 3.x
            // only accepts the literal strings `"on"` and `"off"` for
            // `reasoning_effort` and FALLS BACK TO "on" when given an
            // unrecognised value like `"low"` (we saw a fresh warning
            // in the LM Studio log: "Reasoning setting 'low' is not
            // supported … Falling back to reasoning setting 'on'."
            // — i.e. our "disable" attempt was silently turning thinking
            // ON). The `chat_template_kwargs.enable_thinking: false`
            // path is also ignored on this combination.
            //
            // Reliable disable path that does NOT depend on any
            // single server's quirks:
            //   1. Inject `/no_think` into the system prompt above
            //      — Qwen's chat template honours this universally.
            //   2. Trust the operator's model-level setting in
            //      LM Studio (or equivalent) for the deepest layer.
            //
            // Sending no `reasoning_effort` here means we don't
            // collide with whatever the server's defaults are.
            // OpenAI-style "low/medium/high" values are passed
            // through unchanged in the else branch below for
            // hosted reasoning models.
          } else {
            requestBody.reasoning_effort = options.reasoning;
          }
        }
        // Phase 28 follow-up — per-request hard timeout. Without
        // this, a misbehaving model (Qwen burning tokens in
        // `reasoning_content` with unbounded `max_tokens`, a hung
        // LM Studio, a network blip) can hang an entire council run
        // indefinitely. We saw 3+ hour wedges in practice. Default
        // 10 minutes is generous enough for a deep implement+repair
        // pass at normal token budget, short enough that an
        // operator notices the timeout instead of leaving the run
        // stuck overnight. Override via env if needed.
        const perRequestTimeoutMs = (() => {
          const raw = Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 600_000);
          return Number.isFinite(raw) && raw > 0 ? raw : 600_000;
        })();
        const timeoutController = new AbortController();
        const timeoutHandle = setTimeout(() => timeoutController.abort(), perRequestTimeoutMs);
        // Merge upstream cancellation with per-request timeout into a
        // single AbortSignal so either source can kill the fetch.
        if (options?.signal) {
          if (options.signal.aborted) timeoutController.abort();
          else options.signal.addEventListener("abort", () => timeoutController.abort(), { once: true });
        }
        let response;
        try {
          response = await undiciFetch(`${this.config.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(requestBody),
            signal: timeoutController.signal,
          });
        } finally {
          clearTimeout(timeoutHandle);
        }

        const rawBody = await response.text();
        const data = parseChatCompletionResponse(rawBody);

        if (!response.ok) {
          errors.push(`${model}: ${extractResponseError(data, response.status, rawBody)}`);
          continue;
        }

        let content = data.choices?.[0]?.message?.content;
        const finishReason = data.choices?.[0]?.finish_reason;
        // Phase 28 follow-up — `reasoning_content` fallback. Some
        // local reasoning models (Qwen 3.x in LM Studio in
        // particular) return the actual answer inside
        // `reasoning_content` when their template treats the entire
        // turn as "thinking" mode. If `content` is empty but
        // `reasoning_content` carries non-trivial text, surface that
        // as the answer rather than throwing "empty content". Defence
        // in depth — primary fix is the `/no_think` system-prompt
        // injection above; this is the safety net when /no_think
        // didn't take effect.
        if (!content?.trim()) {
          const reasoning = data.choices?.[0]?.message?.reasoning_content;
          if (reasoning && typeof reasoning === "string" && reasoning.trim().length > 0) {
            content = reasoning;
          }
        }
        // Phase G follow-up: treat whitespace-only output as empty
        // too. Gemma occasionally returns "\n\n" on context overflow
        // which would otherwise pass through the falsy-check and hit
        // a downstream JSON parser with an empty string (much worse
        // error message than "empty assistant content").
        if (!content?.trim()) {
          const reasonNote = finishReason ? ` (finish_reason=${finishReason})` : "";
          errors.push(`${model}: empty assistant content${reasonNote}`);
          continue;
        }

        // Phase 23 Slice A — fire onUsage with whatever the server
        // returned. Missing fields default to 0 so the aggregator
        // can sum without null-checks. Server omitting usage entirely
        // is rare (LM Studio always sends it) but possible — skip
        // the callback in that case rather than fire zeros.
        if (options?.onUsage && data.usage) {
          options.onUsage({
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens:
              data.usage.total_tokens ??
              (data.usage.prompt_tokens ?? 0) + (data.usage.completion_tokens ?? 0),
            model,
          });
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
