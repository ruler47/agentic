import type { LlmToolReply } from "../llm/client.js";
import type { Tool, ToolResult } from "../tools/tool.js";
import { emit } from "./baseAgentRuntime.js";
import type { BaseAgentRunOptions } from "./baseAgentTypes.js";
import type { TaskFrame } from "./taskFrame.js";
import {
  extractUrlFromToolInput,
  readStatusFromToolResult,
  type RunSourceRegistry,
  type SourceReadSkip,
} from "./sourceRegistry.js";

export async function emitSourceReadSkippedEvent(input: {
  call: LlmToolReply["toolCalls"][number];
  skippedRead: SourceReadSkip;
  options: BaseAgentRunOptions;
  skippedSpanId: string;
  llmSpanId: string;
  step: number;
  toolCallNumber: number;
}) {
  await emit(input.options.onEvent, {
    spanId: input.skippedSpanId,
    parentSpanId: input.llmSpanId,
    type: "source-read-skipped",
    actor: input.call.name.replace(/_/g, "."),
    activity: "tool",
    status: "completed",
    title: "Source read skipped",
    detail: input.skippedRead.reason,
    startedAt: new Date(),
    completedAt: new Date(),
    payload: {
      step: input.step,
      toolCallNumber: input.toolCallNumber,
      input: input.call.arguments,
      output: {
        ok: true,
        status: "skipped_reuse",
        reason: input.skippedRead.reason,
        source: input.skippedRead.record,
        originalUrl: input.skippedRead.originalUrl,
        normalizedUrl: input.skippedRead.record.normalizedUrl,
      },
      source: input.skippedRead.record,
      sourceId: input.skippedRead.record.sourceId,
      normalizedUrl: input.skippedRead.record.normalizedUrl,
      reason: input.skippedRead.reason,
    },
  });
}

export async function emitSourceReadExcludedEvent(input: {
  call: LlmToolReply["toolCalls"][number];
  reason: string;
  originalUrl: string;
  normalizedUrl?: string;
  options: BaseAgentRunOptions;
  skippedSpanId: string;
  llmSpanId: string;
  step: number;
  toolCallNumber: number;
}) {
  await emit(input.options.onEvent, {
    spanId: input.skippedSpanId,
    parentSpanId: input.llmSpanId,
    type: "source-read-skipped",
    actor: input.call.name.replace(/_/g, "."),
    activity: "tool",
    status: "completed",
    title: "Source read skipped",
    detail: input.reason,
    startedAt: new Date(),
    completedAt: new Date(),
    payload: {
      step: input.step,
      toolCallNumber: input.toolCallNumber,
      input: input.call.arguments,
      output: {
        ok: true,
        status: "skipped_low_value",
        reason: input.reason,
        originalUrl: input.originalUrl,
        normalizedUrl: input.normalizedUrl,
      },
      normalizedUrl: input.normalizedUrl,
      reason: input.reason,
    },
  });
}

export async function emitSourceEventsForToolResult(input: {
  call: LlmToolReply["toolCalls"][number];
  tool: Tool;
  result: ToolResult;
  sourceUrls: string[];
  sourceRegistry: RunSourceRegistry;
  options: BaseAgentRunOptions;
  toolSpanId: string;
  step: number;
  attemptedToolCalls: number;
}) {
  if (isSearchToolName(input.tool.name) && input.result.ok) {
    const query = typeof input.call.arguments.query === "string" ? input.call.arguments.query : undefined;
    const records = input.sourceRegistry.recordDiscovery({
      urls: input.sourceUrls,
      toolName: input.tool.name,
      eventId: input.toolSpanId,
      query,
      result: input.result,
    });
    for (const record of records.slice(0, 12)) {
      await emit(input.options.onEvent, {
        spanId: `${input.toolSpanId}-source-${record.sourceId}`,
        parentSpanId: input.toolSpanId,
        type: "source-discovered",
        actor: input.tool.name,
        activity: "tool",
        status: "completed",
        title: "Source discovered",
        detail: `${record.sourceType}: ${record.normalizedUrl}`,
        startedAt: new Date(),
        completedAt: new Date(),
        payload: {
          step: input.step,
          toolCallNumber: input.attemptedToolCalls,
          input: { query },
          output: { source: record },
          source: record,
          sourceId: record.sourceId,
          normalizedUrl: record.normalizedUrl,
          sourceType: record.sourceType,
        },
      });
    }
    return;
  }

  if (!isSourceReadTool(input.tool) && !looksLikeSourceReadCall(input.call.name)) return;
  const requestedUrl = extractUrlFromToolInput(input.call.arguments) ?? input.sourceUrls[0];
  if (!requestedUrl) return;
  const readStatus = readStatusFromToolResult(input.result);
  const record = input.sourceRegistry.recordRead({
    url: requestedUrl,
    toolName: input.tool.name,
    eventId: input.toolSpanId,
    status: readStatus,
    reason: input.result.ok ? undefined : input.result.content,
    maxBytes: typeof input.call.arguments.maxBytes === "number" ? input.call.arguments.maxBytes : undefined,
    result: input.result,
  });
  if (!record) return;
  await emit(input.options.onEvent, {
    spanId: `${input.toolSpanId}-source-read`,
    parentSpanId: input.toolSpanId,
    type: readStatus === "passed" ? "source-read-recorded" : "source-rejected",
    actor: input.tool.name,
    activity: "tool",
    status: readStatus === "passed" ? "completed" : "failed",
    title: readStatus === "passed" ? "Source read recorded" : "Source rejected",
    detail: readStatus === "passed"
      ? `${record.sourceType}: ${record.normalizedUrl}`
      : `${readStatus}: ${record.normalizedUrl}`,
    startedAt: new Date(),
    completedAt: new Date(),
    payload: {
      step: input.step,
      toolCallNumber: input.attemptedToolCalls,
      input: input.call.arguments,
      output: {
        ok: input.result.ok,
        status: readStatus,
        source: record,
        reason: input.result.ok ? undefined : input.result.content,
      },
      source: record,
      sourceId: record.sourceId,
      normalizedUrl: record.normalizedUrl,
      sourceType: record.sourceType,
      availability: pageAvailabilityStatus(input.result),
      reason: input.result.ok ? undefined : input.result.content,
    },
  });
}

// The buy/in-stock status web.read attached to result.data.availability, if present.
function pageAvailabilityStatus(result: ToolResult): string | undefined {
  const data = result.data;
  if (!data || typeof data !== "object") return undefined;
  const availability = (data as Record<string, unknown>).availability;
  if (!availability || typeof availability !== "object") return undefined;
  const status = (availability as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}

export async function emitRejectedSourceForThrownRead(input: {
  call: LlmToolReply["toolCalls"][number];
  toolName: string;
  llmSpanId: string;
  toolSpanId: string;
  options: BaseAgentRunOptions;
  sourceRegistry: RunSourceRegistry;
  step: number;
  attemptedToolCalls: number;
  message: string;
}) {
  if (!looksLikeSourceReadCall(input.call.name) && !/web[.\s_-]*(?:read|extract)/i.test(input.toolName)) return;
  const requestedUrl = extractUrlFromToolInput(input.call.arguments);
  if (!requestedUrl) return;
  const record = input.sourceRegistry.recordRead({
    url: requestedUrl,
    toolName: input.toolName,
    eventId: input.toolSpanId,
    status: "failed",
    reason: input.message,
    maxBytes: typeof input.call.arguments.maxBytes === "number" ? input.call.arguments.maxBytes : undefined,
  });
  if (!record) return;
  await emit(input.options.onEvent, {
    spanId: `${input.toolSpanId}-source-thrown`,
    parentSpanId: input.llmSpanId,
    type: "source-rejected",
    actor: input.toolName,
    activity: "tool",
    status: "failed",
    title: "Source rejected",
    detail: input.message,
    startedAt: new Date(),
    completedAt: new Date(),
    payload: {
      step: input.step,
      toolCallNumber: input.attemptedToolCalls,
      input: input.call.arguments,
      output: { ok: false, status: "failed", source: record, reason: input.message },
      source: record,
      sourceId: record.sourceId,
      normalizedUrl: record.normalizedUrl,
      sourceType: record.sourceType,
      reason: input.message,
    },
  });
}

export function externalSourceToolGuardMessage(taskFrame: TaskFrame, callName: string): string | undefined {
  if (taskFrame.sourcePolicy.externalResearch !== "forbidden") return undefined;
  if (!isExternalSourceCallName(callName)) return undefined;
  return [
    "External research is forbidden by the task frame because the user explicitly requested no internet/web/search or the task must use local/thread context.",
    "Do not call web/search/read/http/browser tools for this task. Answer from available context and state any uncertainty that would require fresh external data.",
  ].join(" ");
}

export function looksLikeSourceReadCall(callName: string): boolean {
  return /(?:^|[._-])(?:read|extract)$/i.test(callName) || /^web[_-](?:read|extract)$/i.test(callName);
}

function isSourceReadTool(tool: Tool): boolean {
  const haystack = `${tool.name} ${tool.description} ${tool.capabilities.join(" ")}`;
  return /web[.\s_-]*(?:read|extract)|web-read|web-extract|page[.\s_-]*(?:read|extract)|source[.\s_-]*(?:read|extract)/i
    .test(haystack);
}

function isExternalSourceCallName(callName: string): boolean {
  const name = callName.replace(/_/g, ".");
  return /^(?:web\.(?:search|read|extract)|http\.request|browser\.(?:operate|screenshot))$/i.test(name);
}

function isSearchToolName(toolName: string): boolean {
  return /(?:^|[._-])search$/i.test(toolName) || /^web[._-]search$/i.test(toolName);
}
