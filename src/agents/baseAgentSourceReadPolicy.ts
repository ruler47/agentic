import type { LlmToolReply } from "../llm/client.js";
import { looksLikeSourceReadCall } from "./baseAgentSourceEvents.js";
import { normalizeSourceUrl, sourceUrlExclusionReason, taskExplicitlyTargetsSourceHost } from "./sourceQuality.js";
import { extractUrlFromToolInput } from "./sourceRegistry.js";
import type { TaskFrame } from "./taskFrame.js";

export type LowValueSourceReadSkipReason = {
  message: string;
  originalUrl: string;
  normalizedUrl?: string;
};

export function lowValueSourceReadSkipReason(
  task: string,
  taskFrame: TaskFrame,
  call: LlmToolReply["toolCalls"][number],
): LowValueSourceReadSkipReason | undefined {
  if (!looksLikeSourceReadCall(call.name)) return undefined;
  if (taskFrame.mode !== "product_selection" && taskFrame.mode !== "exploratory_research") return undefined;
  const originalUrl = extractUrlFromToolInput(call.arguments);
  if (!originalUrl) return undefined;
  if (taskExplicitlyTargetsSourceHost(task, originalUrl)) return undefined;
  const reason = sourceUrlExclusionReason(originalUrl);
  if (!reason) return undefined;
  const normalizedUrl = normalizeSourceUrl(originalUrl);
  return {
    originalUrl,
    normalizedUrl,
    message: `Skipped low-value source read (${reason}): ${normalizedUrl ?? originalUrl}. Choose a durable primary, product, pricing, official docs, or review source instead.`,
  };
}
