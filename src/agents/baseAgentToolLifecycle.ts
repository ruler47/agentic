import type { LlmToolReply } from "../llm/client.js";
import type { Message } from "../types.js";
import { catalogEntryFromTool, publicToolCatalogEntry, upsertCatalogEntry, upsertTool, type BaseAgentToolCatalogEntry } from "./agentToolCatalog.js";
import { emit } from "./baseAgentRuntime.js";
import { parseToolCreationRequest, parseToolEditRequest, publicToolCreationResult, publicToolEditResult, renderToolCreationResultForModel, renderToolEditResultForModel, toolMessage } from "./baseAgentToolMessages.js";
import type { BaseAgentRunOptions, BaseAgentToolCreationRequest, BaseAgentToolCreationResult, BaseAgentToolEditRequest, BaseAgentToolEditResult, FailedToolCall, ToolCreationOutcome, ToolEditOutcome } from "./baseAgentTypes.js";

type BaseAgentToolLifecycleInput = {
  call: LlmToolReply["toolCalls"][number];
  task: string;
  step: number;
  llmSpanId: string;
  options: BaseAgentRunOptions;
  failedToolCalls: FailedToolCall[];
  messages: Message[];
  toolCreationRequests: ToolCreationOutcome[];
  toolEditRequests: ToolEditOutcome[];
  tools: import("../tools/tool.js").Tool[];
  toolCatalog: BaseAgentToolCatalogEntry[];
};

type BaseAgentToolLifecycleResult = {
  handled: boolean;
  tools: import("../tools/tool.js").Tool[];
  toolCatalog: BaseAgentToolCatalogEntry[];
};

export async function handleBaseAgentToolLifecycleCall(input: BaseAgentToolLifecycleInput): Promise<BaseAgentToolLifecycleResult> {
  const { call, task, step, llmSpanId, options, failedToolCalls, messages, toolCreationRequests, toolEditRequests } = input;
  let { tools, toolCatalog } = input;

  if (call.name === "request_tool_creation") {
    const creationStartedAt = Date.now();
    let request: BaseAgentToolCreationRequest;
    try {
      request = parseToolCreationRequest(call.arguments, task);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedToolCalls.push({ toolName: call.name, message });
      messages.push(toolMessage(call.id, false, message));
      await emit(options.onEvent, {
        parentSpanId: llmSpanId,
        type: "tool-missing",
        actor: "base-agent",
        activity: "agent",
        status: "failed",
        title: "Tool creation request rejected",
        detail: message,
        startedAt: new Date(creationStartedAt),
        completedAt: new Date(),
        payload: { step, arguments: call.arguments },
      });
      return { handled: true, tools, toolCatalog };
    }

    await emit(options.onEvent, {
      parentSpanId: llmSpanId,
      type: "tool-missing",
      actor: "base-agent",
      activity: "agent",
      status: "completed",
      title: "Agent requested a missing capability",
      detail: `${request.name}: ${request.request}`,
      startedAt: new Date(creationStartedAt),
      completedAt: new Date(),
      payload: {
        step,
        request,
        input: call.arguments,
        output: request,
      },
    });

    if (!options.onToolCreationRequested) {
      const message = "Tool creation request cannot be handled in this runtime.";
      failedToolCalls.push({ toolName: call.name, message });
      messages.push(toolMessage(call.id, false, message));
      return { handled: true, tools, toolCatalog };
    }

    let creationResult: BaseAgentToolCreationResult;
    try {
      creationResult = await options.onToolCreationRequested(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      creationResult = {
        ok: false,
        toolName: request.name,
        toolVersion: request.version,
        status: "failed",
        message,
        error: message,
      };
    }
    toolCreationRequests.push({ ...creationResult, request });
    messages.push(toolMessage(call.id, creationResult.ok, renderToolCreationResultForModel(creationResult)));
    if (creationResult.ok && creationResult.scopedTool && creationResult.toolVersion) {
      tools = upsertTool(tools, creationResult.scopedTool);
      const scopedCatalogEntry = {
        ...(creationResult.scopedCatalogEntry ?? {
          ...catalogEntryFromTool(creationResult.scopedTool),
          source: "generated" as const,
          status: "loaded" as const,
          visibility: "run_scoped_candidate" as const,
          changeSummary: `Run-scoped generated candidate for: ${request.request}`,
        }),
        promotionPolicy: creationResult.promotionPolicy ?? "auto_on_success",
      };
      toolCatalog = upsertCatalogEntry(
        toolCatalog,
        scopedCatalogEntry,
      );
      await emit(options.onEvent, {
        parentSpanId: llmSpanId,
        type: "agent-tool-catalog-updated",
        actor: "base-agent",
        activity: "agent",
        status: "completed",
        title: creationResult.reusedCandidate
          ? "Existing generated candidate attached"
          : "Generated candidate attached to run",
        detail: `${creationResult.toolName}@${creationResult.toolVersion} is callable only inside this run until accepted.`,
        startedAt: new Date(creationStartedAt),
        completedAt: new Date(),
        payload: {
          step,
          toolName: creationResult.toolName,
          toolVersion: creationResult.toolVersion,
          reusedCandidate: creationResult.reusedCandidate,
          promotionPolicy: creationResult.promotionPolicy ?? "auto_on_success",
          catalog: publicToolCatalogEntry(
            toolCatalog.find((entry) => entry.name === creationResult.toolName)
              ?? catalogEntryFromTool(creationResult.scopedTool),
          ),
          input: {
            request,
            result: publicToolCreationResult(creationResult),
          },
          output: {
            catalogEntry: publicToolCatalogEntry(
              toolCatalog.find((entry) => entry.name === creationResult.toolName)
                ?? catalogEntryFromTool(creationResult.scopedTool),
            ),
          },
        },
      });
    }
    await emit(options.onEvent, {
      parentSpanId: llmSpanId,
      type: creationResult.ok ? "tool-creation-completed" : "tool-creation-failed",
      actor: "tool-builder",
      activity: "tool",
      status: creationResult.ok ? "completed" : "failed",
      title: creationResult.ok ? "Linked tool creation completed" : "Linked tool creation failed",
      detail: creationResult.message,
      startedAt: new Date(creationStartedAt),
      completedAt: new Date(),
      durationMs: Date.now() - creationStartedAt,
      payload: {
        step,
        request,
        result: publicToolCreationResult(creationResult),
        input: request,
        output: publicToolCreationResult(creationResult),
      },
    });
    if (!creationResult.ok) {
      failedToolCalls.push({
        toolName: call.name,
        message: creationResult.error ?? creationResult.message,
      });
    }
    return { handled: true, tools, toolCatalog };
  }

  if (call.name === "request_tool_edit") {
    const editStartedAt = Date.now();
    let request: BaseAgentToolEditRequest;
    try {
      request = parseToolEditRequest(call.arguments, task);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedToolCalls.push({ toolName: call.name, message });
      messages.push(toolMessage(call.id, false, message));
      await emit(options.onEvent, {
        parentSpanId: llmSpanId,
        type: "tool-missing",
        actor: "base-agent",
        activity: "agent",
        status: "failed",
        title: "Tool edit request rejected",
        detail: message,
        startedAt: new Date(editStartedAt),
        completedAt: new Date(),
        payload: { step, arguments: call.arguments },
      });
      return { handled: true, tools, toolCatalog };
    }

    await emit(options.onEvent, {
      parentSpanId: llmSpanId,
      type: "tool-missing",
      actor: "base-agent",
      activity: "agent",
      status: "completed",
      title: "Agent requested a tool edit",
      detail: `${request.name}: ${request.request}`,
      startedAt: new Date(editStartedAt),
      completedAt: new Date(),
      payload: {
        step,
        request,
        input: call.arguments,
        output: request,
      },
    });

    if (!options.onToolEditRequested) {
      const message = "Tool edit request cannot be handled in this runtime.";
      failedToolCalls.push({ toolName: call.name, message });
      messages.push(toolMessage(call.id, false, message));
      return { handled: true, tools, toolCatalog };
    }

    let editResult: BaseAgentToolEditResult;
    try {
      editResult = await options.onToolEditRequested(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      editResult = {
        ok: false,
        toolName: request.name,
        toolVersion: request.version,
        status: "failed",
        message,
        error: message,
      };
    }
    toolEditRequests.push({ ...editResult, request });
    messages.push(toolMessage(call.id, editResult.ok, renderToolEditResultForModel(editResult)));
    if (editResult.ok && editResult.scopedTool && editResult.toolVersion) {
      tools = upsertTool(tools, editResult.scopedTool);
      const scopedCatalogEntry = {
        ...(editResult.scopedCatalogEntry ?? {
          ...catalogEntryFromTool(editResult.scopedTool),
          source: "generated" as const,
          status: "loaded" as const,
          visibility: "run_scoped_candidate" as const,
          changeSummary: `Run-scoped edited candidate for: ${request.request}`,
        }),
        promotionPolicy: editResult.promotionPolicy ?? "auto_on_success",
      };
      toolCatalog = upsertCatalogEntry(
        toolCatalog,
        scopedCatalogEntry,
      );
      await emit(options.onEvent, {
        parentSpanId: llmSpanId,
        type: "agent-tool-catalog-updated",
        actor: "base-agent",
        activity: "agent",
        status: "completed",
        title: editResult.reusedCandidate
          ? "Existing edited candidate attached"
          : "Edited candidate attached to run",
        detail: `${editResult.toolName}@${editResult.toolVersion} is callable only inside this run until accepted.`,
        startedAt: new Date(editStartedAt),
        completedAt: new Date(),
        payload: {
          step,
          toolName: editResult.toolName,
          toolVersion: editResult.toolVersion,
          activeVersion: editResult.activeVersion,
          replacesVersion: editResult.replacesVersion,
          reusedCandidate: editResult.reusedCandidate,
          promotionPolicy: editResult.promotionPolicy ?? "auto_on_success",
          catalog: publicToolCatalogEntry(
            toolCatalog.find((entry) => entry.name === editResult.toolName)
              ?? catalogEntryFromTool(editResult.scopedTool),
          ),
          input: {
            request,
            result: publicToolEditResult(editResult),
          },
          output: {
            catalogEntry: publicToolCatalogEntry(
              toolCatalog.find((entry) => entry.name === editResult.toolName)
                ?? catalogEntryFromTool(editResult.scopedTool),
            ),
          },
        },
      });
    }
    await emit(options.onEvent, {
      parentSpanId: llmSpanId,
      type: editResult.ok ? "tool-creation-completed" : "tool-creation-failed",
      actor: "tool-builder",
      activity: "tool",
      status: editResult.ok ? "completed" : "failed",
      title: editResult.ok ? "Linked tool edit completed" : "Linked tool edit failed",
      detail: editResult.message,
      startedAt: new Date(editStartedAt),
      completedAt: new Date(),
      durationMs: Date.now() - editStartedAt,
      payload: {
        step,
        request,
        result: publicToolEditResult(editResult),
        input: request,
        output: publicToolEditResult(editResult),
      },
    });
    if (!editResult.ok) {
      failedToolCalls.push({
        toolName: call.name,
        message: editResult.error ?? editResult.message,
      });
    }
    return { handled: true, tools, toolCatalog };
  }

  return { handled: false, tools, toolCatalog };
}
