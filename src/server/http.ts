import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { readFile } from "node:fs/promises";
import { ArtifactStore } from "../artifacts/artifactStore.js";
import { AuditEventInput, AuditEventStore } from "../audit/types.js";
import { UniversalAgent } from "../agents/universalAgent.js";
import {
  ConversationThreadContext,
  ConversationThreadRecord,
  ConversationThreadStore,
} from "../conversations/types.js";
import {
  resolveConversationThread,
  ThreadResolutionResult,
} from "../conversations/threadResolution.js";
import { GroupProfileStore } from "../instance/groupProfileStore.js";
import { InMemoryUserStore, UserRecord, UserStore } from "../instance/userStore.js";
import { MemoryListOptions, MemoryUpdateInput, SkillMemoryStore } from "../memory/skillMemory.js";
import {
  evaluateMemoryRetrieval,
  MemoryRetrievalEvaluationCase,
} from "../memory/retrievalEvaluation.js";
import { AgentRunRecord, RunCreateContext, RunStore } from "../runs/types.js";
import { ModelTierSettingsStore } from "../settings/modelTierSettings.js";
import { ToolSchema, ToolStartupMode } from "../tools/tool.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolBuildRequestStore } from "../tools/toolBuildRequestStore.js";
import { ToolBuildWorkflow } from "../tools/toolBuildWorkflow.js";
import { ToolMetadataStore, toolToMetadata } from "../tools/toolMetadataStore.js";
import { AgentArtifact, AgentEvent, AgentRunResult, ArtifactUploadInput } from "../types.js";

export type WebAppOptions = {
  agent: UniversalAgent;
  runStore: RunStore;
  publicDir: string;
  skillMemory?: SkillMemoryStore;
  toolRegistry?: Pick<ToolRegistry, "list">;
  toolMetadataStore?: ToolMetadataStore;
  toolBuildRequestStore?: ToolBuildRequestStore;
  toolBuildWorkflow?: ToolBuildWorkflow;
  reloadGeneratedTools?: () => Promise<void>;
  modelTierSettings?: ModelTierSettingsStore;
  artifactStore?: ArtifactStore;
  conversationStore?: ConversationThreadStore;
  auditEventStore?: AuditEventStore;
  groupProfileStore?: GroupProfileStore;
  userStore?: UserStore;
};

const defaultUserStore = new InMemoryUserStore();

export function createWebApp(options: WebAppOptions) {
  return createServer(async (request, response) => {
    try {
      await routeRequest(request, response, options);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Unknown server error",
      });
    }
  });
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WebAppOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/instance") {
    sendJson(response, 200, {
      instance: {
        id: "instance-local",
        name: "Local Agentic Assistant",
        defaultLanguage: "ru",
        timeZone: process.env.AGENT_TIME_ZONE ?? process.env.TZ ?? "Europe/Madrid",
        locale: "ru-RU",
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/group-profile") {
    if (options.groupProfileStore) {
      sendJson(response, 200, { groupProfile: await options.groupProfileStore.get() });
      return;
    }

    sendJson(response, 200, {
      groupProfile: {
        id: "group-local",
        instanceId: "instance-local",
        name: "Local Group Profile",
        description: "Default one-group profile for local development.",
        preferences: {},
      },
    });
    return;
  }

  if (request.method === "PATCH" && url.pathname === "/api/group-profile") {
    if (!options.groupProfileStore) {
      sendJson(response, 503, { error: "Group profile store is not configured" });
      return;
    }

    try {
      const groupProfile = await options.groupProfileStore.update(
        parseGroupProfileUpdate(await readJsonBody<unknown>(request)),
      );
      await recordAudit(options, {
        instanceId: groupProfile.instanceId,
        actorId: "user-admin",
        actorType: "user",
        action: "group_profile.updated",
        targetType: "group_profile",
        targetId: groupProfile.id,
        status: "success",
        summary: `Group profile updated: ${groupProfile.name}`,
      });
      sendJson(response, 200, { groupProfile });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid group profile update",
      });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/users") {
    const runs = await options.runStore.list();
    const users = await getUserStore(options).list();
    sendJson(response, 200, {
      users: users.map((user) => ({
        ...user,
        status: "active",
        recentRequests: runs
          .filter((run) => run.requesterUserId === user.id)
          .slice(0, 5)
          .map((run) => ({
            id: run.id,
            task: run.task,
            status: run.status,
            channel: run.channel,
            threadId: run.threadId,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
          })),
      })),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/runs") {
    sendJson(response, 200, { runs: await options.runStore.list() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/audit-events") {
    const limit = Number(url.searchParams.get("limit") ?? "100");
    sendJson(response, 200, {
      events: options.auditEventStore ? await options.auditEventStore.list(limit) : [],
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/conversation-threads") {
    sendJson(response, 200, {
      threads: options.conversationStore ? await options.conversationStore.list() : [],
    });
    return;
  }

  const conversationThreadMatch = url.pathname.match(/^\/api\/conversation-threads\/([^/]+)$/);
  if (request.method === "GET" && conversationThreadMatch) {
    if (!options.conversationStore) {
      sendJson(response, 503, { error: "Conversation thread store is not configured" });
      return;
    }

    const thread = await options.conversationStore.get(
      decodeURIComponent(conversationThreadMatch[1] ?? ""),
    );
    if (!thread) {
      sendJson(response, 404, { error: "Conversation thread not found" });
      return;
    }

    sendJson(response, 200, { thread });
    return;
  }

  if (request.method === "DELETE" && conversationThreadMatch) {
    if (!options.conversationStore) {
      sendJson(response, 503, { error: "Conversation thread store is not configured" });
      return;
    }

    const threadId = decodeURIComponent(conversationThreadMatch[1] ?? "");
    const thread = await options.conversationStore.get(threadId);
    if (!thread) {
      sendJson(response, 404, { error: "Conversation thread not found" });
      return;
    }

    const deletedRuns = await options.runStore.deleteByThreadId(threadId);
    const deletedThread = await options.conversationStore.delete(threadId);
    if (!deletedThread) {
      sendJson(response, 404, { error: "Conversation thread not found" });
      return;
    }

    await recordAudit(options, {
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "conversation_thread.deleted",
      targetType: "conversation_thread",
      targetId: threadId,
      status: "success",
      threadId,
      requesterUserId: thread.requesterUserId,
      channel: thread.channel,
      summary: `Conversation deleted: ${thread.title}`,
      metadata: {
        deletedRuns,
        deletedMessages: thread.messages?.length ?? 0,
        deletedArtifactReferences: thread.artifactIds.length,
      },
    });

    sendJson(response, 200, {
      deleted: true,
      thread,
      deletedRuns,
      deletedMessages: thread.messages?.length ?? 0,
      deletedArtifactReferences: thread.artifactIds.length,
    });
    return;
  }

  const conversationThreadRunMatch = url.pathname.match(
    /^\/api\/conversation-threads\/([^/]+)\/runs$/,
  );
  if (request.method === "POST" && conversationThreadRunMatch) {
    const body = await readJsonBody<Record<string, unknown>>(request);
    body.threadId = decodeURIComponent(conversationThreadRunMatch[1] ?? "");
    await createRunFromRequest(body, response, options);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/memories") {
    sendJson(response, 200, {
      memories: options.skillMemory ? await options.skillMemory.list(parseMemoryListOptions(url)) : [],
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/memories") {
    if (!options.skillMemory) {
      sendJson(response, 503, { error: "Memory store is not configured" });
      return;
    }

    try {
      const memory = await options.skillMemory.add(parseMemoryCreateInput(await readJsonBody<unknown>(request)));
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "memory.created",
        targetType: "memory",
        targetId: memory.id,
        status: memory.status === "proposed" ? "pending" : "success",
        runId: memory.sourceRunId,
        threadId: memory.sourceThreadId,
        summary: `Memory created: ${memory.title}`,
        metadata: {
          scope: memory.scope,
          scopeId: memory.scopeId,
          confidence: memory.confidence,
          memoryStatus: memory.status,
        },
      });
      sendJson(response, 201, { memory });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid memory create request",
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/memories/reembed") {
    if (!options.skillMemory?.reembedAll) {
      sendJson(response, 503, { error: "Memory embedding rebuild is not configured" });
      return;
    }

    try {
      const result = await options.skillMemory.reembedAll();
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "memory.embeddings_rebuilt",
        targetType: "memory",
        targetId: "all",
        status: "success",
        summary: `Memory embeddings rebuilt for ${result.updated} item(s)`,
        metadata: {
          updated: result.updated,
        },
      });
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Memory embedding rebuild failed",
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/memories/evaluate-retrieval") {
    if (!options.skillMemory) {
      sendJson(response, 503, { error: "Memory store is not configured" });
      return;
    }

    try {
      const report = await evaluateMemoryRetrieval(
        options.skillMemory,
        parseMemoryRetrievalEvaluationCases(await readJsonBody<unknown>(request)),
      );
      sendJson(response, 200, report);
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid memory retrieval evaluation request",
      });
    }
    return;
  }

  const memoryMatch = url.pathname.match(/^\/api\/memories\/([^/]+)$/);
  if (request.method === "PATCH" && memoryMatch) {
    if (!options.skillMemory?.update) {
      sendJson(response, 503, { error: "Memory update is not configured" });
      return;
    }

    try {
      const memory = await options.skillMemory.update(
        decodeURIComponent(memoryMatch[1] ?? ""),
        parseMemoryUpdateInput(await readJsonBody<unknown>(request)),
      );
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "memory.updated",
        targetType: "memory",
        targetId: memory.id,
        status: memory.status === "proposed" ? "pending" : "success",
        runId: memory.sourceRunId,
        threadId: memory.sourceThreadId,
        summary: `Memory updated: ${memory.title}`,
        metadata: {
          scope: memory.scope,
          scopeId: memory.scopeId,
          confidence: memory.confidence,
          memoryStatus: memory.status,
        },
      });
      sendJson(response, 200, { memory });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid memory update request";
      sendJson(response, message.includes("was not found") ? 404 : 400, { error: message });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tools") {
    const tools = options.toolRegistry?.list() ?? [];
    const metadata = options.toolMetadataStore
      ? await options.toolMetadataStore.list()
      : tools.map((tool) => toolToMetadata(tool));

    sendJson(response, 200, {
      tools: metadata,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tools/generated-modules") {
    if (!options.toolMetadataStore) {
      sendJson(response, 503, { error: "Tool metadata store is not configured" });
      return;
    }

    try {
      const input = parseGeneratedToolModuleInput(await readJsonBody<unknown>(request));
      sendJson(response, 201, { tool: await options.toolMetadataStore.registerGenerated(input) });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid generated tool module",
      });
    }
    return;
  }

  const replacementMatch = url.pathname.match(/^\/api\/tools\/generated-modules\/([^/]+)\/promote-replacement$/);
  if (request.method === "POST" && replacementMatch) {
    if (!options.toolMetadataStore) {
      sendJson(response, 503, { error: "Tool metadata store is not configured" });
      return;
    }

    try {
      const input = parseGeneratedToolReplacementInput(
        decodeURIComponent(replacementMatch[1] ?? ""),
        await readJsonBody<unknown>(request),
      );
      sendJson(response, 200, { tool: await options.toolMetadataStore.promoteReplacement(input) });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid generated tool replacement",
      });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tools/health") {
    const tools = options.toolRegistry?.list() ?? [];
    const health = await Promise.all(
      tools.map(async (tool) => {
        const result = tool.healthcheck
          ? await tool.healthcheck()
          : { ok: true, detail: "No healthcheck registered." };
        await options.toolMetadataStore?.updateHealth(tool.name, result);
        return { name: tool.name, ...result };
      }),
    );

    sendJson(response, 200, { tools: health });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tool-build-requests") {
    sendJson(response, 200, {
      requests: options.toolBuildRequestStore ? await options.toolBuildRequestStore.list() : [],
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tool-build-requests") {
    if (!options.toolBuildRequestStore) {
      sendJson(response, 503, { error: "Tool build request store is not configured" });
      return;
    }

    try {
      const requestInput = parseToolBuildRequestInput(await readJsonBody<unknown>(request));
      const buildRequest = await options.toolBuildRequestStore.create(requestInput);
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "tool_build.requested",
        targetType: "tool_build_request",
        targetId: buildRequest.id,
        status: "pending",
        runId: buildRequest.sourceRunId,
        summary: `Tool build requested: ${buildRequest.capability}`,
        metadata: {
          capability: buildRequest.capability,
          desiredToolName: buildRequest.desiredToolName,
          modulePath: buildRequest.contract.modulePath,
        },
      });
      sendJson(response, 201, { request: buildRequest });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid tool build request",
      });
    }
    return;
  }

  const toolBuildRequestMatch = url.pathname.match(/^\/api\/tool-build-requests\/([^/]+)$/);
  if (request.method === "GET" && toolBuildRequestMatch) {
    if (!options.toolBuildRequestStore) {
      sendJson(response, 503, { error: "Tool build request store is not configured" });
      return;
    }

    const buildRequest = await options.toolBuildRequestStore.get(
      decodeURIComponent(toolBuildRequestMatch[1] ?? ""),
    );
    if (!buildRequest) {
      sendJson(response, 404, { error: "Tool build request not found" });
      return;
    }

    sendJson(response, 200, { request: buildRequest });
    return;
  }

  if (request.method === "PATCH" && toolBuildRequestMatch) {
    if (!options.toolBuildRequestStore) {
      sendJson(response, 503, { error: "Tool build request store is not configured" });
      return;
    }

    try {
      const update = parseToolBuildRequestStatusUpdate(await readJsonBody<unknown>(request));
      const buildRequest = await options.toolBuildRequestStore.updateStatus(
        decodeURIComponent(toolBuildRequestMatch[1] ?? ""),
        update,
      );
      sendJson(response, 200, { request: buildRequest });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid tool build request update";
      sendJson(response, message.includes("was not found") ? 404 : 400, { error: message });
    }
    return;
  }

  if (request.method === "DELETE" && toolBuildRequestMatch) {
    if (!options.toolBuildRequestStore) {
      sendJson(response, 503, { error: "Tool build request store is not configured" });
      return;
    }

    const id = decodeURIComponent(toolBuildRequestMatch[1] ?? "");
    const existing = await options.toolBuildRequestStore.get(id);
    if (!existing) {
      sendJson(response, 404, { error: "Tool build request not found" });
      return;
    }

    const deleted = await options.toolBuildRequestStore.delete(id);
    if (!deleted) {
      sendJson(response, 404, { error: "Tool build request not found" });
      return;
    }

    await recordAudit(options, {
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool_build.deleted",
      targetType: "tool_build_request",
      targetId: id,
      status: "success",
      runId: existing.sourceRunId,
      summary: `Tool build deleted: ${existing.capability}`,
      metadata: {
        capability: existing.capability,
        previousStatus: existing.status,
      },
    });
    sendJson(response, 200, { deleted: true, request: existing });
    return;
  }

  const toolBuildStopMatch = url.pathname.match(/^\/api\/tool-build-requests\/([^/]+)\/stop$/);
  if (request.method === "POST" && toolBuildStopMatch) {
    if (!options.toolBuildRequestStore) {
      sendJson(response, 503, { error: "Tool build request store is not configured" });
      return;
    }

    try {
      const id = decodeURIComponent(toolBuildStopMatch[1] ?? "");
      const stopReason = parseOptionalReason(await readJsonBody<unknown>(request));
      const buildRequest = await options.toolBuildRequestStore.updateStatus(id, {
        status: "blocked",
        statusDetail: stopReason || "Stopped by operator. It can be deleted or reworked into a new request.",
      });
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "tool_build.stopped",
        targetType: "tool_build_request",
        targetId: buildRequest.id,
        status: "success",
        runId: buildRequest.sourceRunId,
        summary: `Tool build stopped: ${buildRequest.capability}`,
        metadata: {
          capability: buildRequest.capability,
          reason: buildRequest.statusDetail,
        },
      });
      sendJson(response, 200, { request: buildRequest });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid tool build stop request";
      sendJson(response, message.includes("was not found") ? 404 : 400, { error: message });
    }
    return;
  }

  const toolBuildReworkMatch = url.pathname.match(/^\/api\/tool-build-requests\/([^/]+)\/rework$/);
  if (request.method === "POST" && toolBuildReworkMatch) {
    if (!options.toolBuildRequestStore) {
      sendJson(response, 503, { error: "Tool build request store is not configured" });
      return;
    }

    try {
      const originalId = decodeURIComponent(toolBuildReworkMatch[1] ?? "");
      const original = await options.toolBuildRequestStore.get(originalId);
      if (!original) {
        sendJson(response, 404, { error: "Tool build request not found" });
        return;
      }

      const feedback = parseToolBuildReworkInput(await readJsonBody<unknown>(request));
      const reworkRequest = await options.toolBuildRequestStore.create({
        capability: original.capability,
        reason: `${original.reason}\n\nRework feedback for ${original.id}:\n${feedback}`,
        sourceRunId: original.sourceRunId,
        sourceSpanId: original.sourceSpanId,
        taskSummary: original.taskSummary,
        desiredToolName: original.desiredToolName,
        requiredInputs: original.requiredInputs,
        requiredOutputs: original.requiredOutputs,
        qaCriteria: uniqueStrings([
          ...(original.qaCriteria ?? []),
          `Rework feedback must be addressed: ${feedback}`,
        ]),
        reworkOf: original.id,
        feedback,
      });

      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "tool_build.rework_requested",
        targetType: "tool_build_request",
        targetId: reworkRequest.id,
        status: "pending",
        runId: reworkRequest.sourceRunId,
        summary: `Tool build rework requested: ${reworkRequest.capability}`,
        metadata: {
          originalRequestId: original.id,
          feedback,
        },
      });
      sendJson(response, 201, { request: reworkRequest, original });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid tool build rework request",
      });
    }
    return;
  }

  const toolBuildRunMatch = url.pathname.match(/^\/api\/tool-build-requests\/([^/]+)\/run$/);
  if (request.method === "POST" && toolBuildRunMatch) {
    if (!options.toolBuildWorkflow) {
      sendJson(response, 503, { error: "Tool build workflow is not configured" });
      return;
    }

    const result = await options.toolBuildWorkflow.runOnce(
      decodeURIComponent(toolBuildRunMatch[1] ?? ""),
    );
    if (result.request.status === "registered") {
      await options.reloadGeneratedTools?.();
    }
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/settings/model-tiers") {
    sendJson(response, 200, {
      tiers: options.modelTierSettings ? await options.modelTierSettings.list() : [],
    });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/settings/model-tiers") {
    if (!options.modelTierSettings) {
      sendJson(response, 503, { error: "Model tier settings are not configured" });
      return;
    }

    const body = await readJsonBody<{ tiers?: unknown }>(request);
    if (!Array.isArray(body.tiers)) {
      sendJson(response, 400, { error: "tiers must be an array" });
      return;
    }

    let parsedTiers;
    try {
      parsedTiers = body.tiers.map((item) => parseTierSettingsInput(item));
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid model tier settings",
      });
      return;
    }

    const tiers = await options.modelTierSettings.replace(parsedTiers);
    sendJson(response, 200, { tiers });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/runs") {
    await createRunFromRequest(await readJsonBody<Record<string, unknown>>(request), response, options);
    return;
  }

  const runEventsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (request.method === "GET" && runEventsMatch) {
    await streamRunEvents(request, response, options, decodeURIComponent(runEventsMatch[1] ?? ""));
    return;
  }

  const runCancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (request.method === "POST" && runCancelMatch) {
    const id = decodeURIComponent(runCancelMatch[1] ?? "");
    const run = await options.runStore.get(id);
    if (!run) {
      sendJson(response, 404, { error: "Run not found" });
      return;
    }
    if (isTerminalRunStatus(run.status)) {
      sendJson(response, 409, { error: `Run is already ${run.status}`, run });
      return;
    }

    const reason =
      parseOptionalReason(await readJsonBody<unknown>(request)) ??
      "Cancelled by operator. In-flight LLM/tool calls may finish, but their result will not replace this terminal state.";
    await options.runStore.cancel(id, reason);
    const cancelled = await options.runStore.get(id);
    await recordAudit(options, {
      instanceId: run.instanceId,
      actorId: "user-admin",
      actorType: "user",
      action: "run.cancelled",
      targetType: "run",
      targetId: id,
      status: "success",
      runId: id,
      threadId: run.threadId,
      requesterUserId: run.requesterUserId,
      channel: run.channel,
      summary: `Run cancelled: ${run.task.slice(0, 160)}`,
      metadata: { reason },
    });
    sendJson(response, 200, { run: cancelled ?? run });
    return;
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (request.method === "GET" && runMatch) {
    const run = await options.runStore.get(runMatch[1] ?? "");

    if (!run) {
      sendJson(response, 404, { error: "Run not found" });
      return;
    }

    sendJson(response, 200, { run });
    return;
  }

  const artifactMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)$/);
  if (request.method === "GET" && artifactMatch) {
    if (!options.artifactStore) {
      sendJson(response, 503, { error: "Artifact store is not configured" });
      return;
    }

    const stored = await options.artifactStore.read(
      decodeURIComponent(artifactMatch[1] ?? ""),
      decodeURIComponent(artifactMatch[2] ?? ""),
    );
    if (!stored) {
      sendJson(response, 404, { error: "Artifact not found" });
      return;
    }

    response.writeHead(200, {
      "content-type": stored.artifact.mimeType,
      "content-length": String(stored.artifact.sizeBytes),
      "content-disposition": `inline; filename="${stored.artifact.filename.replace(/"/g, "")}"`,
      "cache-control": "no-store",
    });
    response.end(stored.content ?? (stored.path ? await readFile(stored.path) : Buffer.alloc(0)));
    return;
  }

  if (request.method === "GET") {
    await serveStatic(url.pathname, response, options.publicDir);
    return;
  }

  sendJson(response, 405, { error: "Method not allowed" });
}

async function createRunFromRequest(
  body: Record<string, unknown>,
  response: ServerResponse,
  options: WebAppOptions,
): Promise<void> {
  const task = typeof body.task === "string" ? body.task.trim() : "";

  if (!task) {
    sendJson(response, 400, { error: "Task is required" });
    return;
  }

  let context: RunCreateContext;
  let thread: ConversationThreadRecord | undefined;
  let threadContext: ConversationThreadContext | undefined;
  let threadResolution: ThreadResolutionResult | undefined;

  try {
    const resolved = await resolveRunContext(body, task, options);
    context = resolved.context;
    thread = resolved.thread;
    threadContext = resolved.threadContext;
    threadResolution = resolved.threadResolution;
  } catch (error) {
    sendJson(response, error instanceof RunContextError ? error.statusCode : 400, {
      error: error instanceof Error ? error.message : "Invalid run context",
    });
    return;
  }

  const run = await options.runStore.create(task, context);
  await recordAudit(options, {
    instanceId: context.instanceId,
    actorId: context.requesterUserId,
    actorType: "user",
    action: "run.created",
    targetType: "run",
    targetId: run.id,
    status: "pending",
    runId: run.id,
    threadId: context.threadId,
    requesterUserId: context.requesterUserId,
    channel: context.channel,
    summary: `Run created: ${task.slice(0, 160)}`,
    metadata: threadResolution
      ? {
          threadResolution: {
            decision: threadResolution.decision,
            reason: threadResolution.reason,
            threadId: threadResolution.thread?.id,
          },
        }
      : undefined,
  });
  let inputArtifacts: AgentArtifact[] = [];
  try {
    inputArtifacts = options.artifactStore
      ? await Promise.all(
          parseAttachmentInputs(body.attachments).map((attachment) =>
            options.artifactStore!.saveUpload(run.id, attachment),
          ),
        )
      : [];
    await Promise.all(
      inputArtifacts.map((artifact) =>
        recordAudit(options, {
          instanceId: context.instanceId,
          actorId: context.requesterUserId,
          actorType: "user",
          action: "artifact.uploaded",
          targetType: "artifact",
          targetId: artifact.id,
          runId: run.id,
          threadId: context.threadId,
          requesterUserId: context.requesterUserId,
          channel: context.channel,
          summary: `Input artifact uploaded: ${artifact.filename}`,
          metadata: {
            filename: artifact.filename,
            mimeType: artifact.mimeType,
            sizeBytes: artifact.sizeBytes,
          },
        }),
      ),
    );
  } catch (error) {
    await options.runStore.fail(
      run.id,
      error instanceof Error ? error.message : "Failed to save attachments",
    );
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "Failed to save attachments",
    });
    return;
  }

  await options.conversationStore?.appendMessage({
    threadId: context.threadId ?? "",
    runId: run.id,
    parentRunId: context.parentRunId,
    role: "user",
    content: task,
    sourceMessageId: context.sourceMessageId,
  });

  void executeRun(run.id, task, options, inputArtifacts, {
    threadId: context.threadId,
    threadContext,
  });
  sendJson(response, 202, {
    run: await options.runStore.get(run.id),
    thread,
    threadResolution: threadResolution
      ? {
          decision: threadResolution.decision,
          reason: threadResolution.reason,
          threadId: threadResolution.thread?.id,
        }
      : undefined,
  });
}

async function resolveRunContext(
  body: Record<string, unknown>,
  task: string,
  options: WebAppOptions,
): Promise<{
  context: RunCreateContext;
  thread?: ConversationThreadRecord;
  threadContext?: ConversationThreadContext;
  threadResolution?: ThreadResolutionResult;
}> {
  const instanceId = parseOptionalText(body.instanceId) ?? "instance-local";
  const bodyRequesterUserId = parseOptionalText(body.requesterUserId);
  const bodyChannel = parseOptionalText(body.channel);
  const sourceUserId = parseOptionalText(body.sourceUserId);
  const sourceMessageId = parseOptionalText(body.sourceMessageId);
  const sourceChatId = parseOptionalText(body.sourceChatId);
  const sourceThreadId = parseOptionalText(body.sourceThreadId);
  const requestedThreadId = parseOptionalText(body.threadId);
  let parentRunId = parseOptionalText(body.parentRunId);
  let thread: ConversationThreadRecord | undefined;
  let threadResolution: ThreadResolutionResult | undefined;
  let requesterUser: UserRecord | undefined;

  if (options.conversationStore) {
    if (requestedThreadId) {
      thread = await options.conversationStore.get(requestedThreadId);
      if (!thread) throw new Error("Conversation thread not found");
      const channel = bodyChannel ?? thread.channel;
      requesterUser = await resolveRequesterUser(options, {
        requesterUserId: bodyRequesterUserId,
        channel,
        sourceUserId,
        fallbackUserId: thread.requesterUserId,
      });
      if (!requesterUser) {
        throw createRequesterResolutionError({
          requesterUserId: bodyRequesterUserId,
          channel,
          sourceUserId,
        });
      }
      if (requesterUser.id !== thread.requesterUserId) {
        throw new RunContextError(
          403,
          "Requester user cannot continue a conversation thread owned by another user",
        );
      }
      threadResolution = {
        decision: "explicit_thread",
        thread,
        reason: "The request explicitly selected an existing conversation thread.",
      };
    } else {
      const channel = bodyChannel ?? "web";
      requesterUser = await resolveRequesterUser(options, {
        requesterUserId: bodyRequesterUserId,
        channel,
        sourceUserId,
      });
      if (!requesterUser) {
        throw createRequesterResolutionError({
          requesterUserId: bodyRequesterUserId,
          channel,
          sourceUserId,
        });
      }
      threadResolution = resolveConversationThread({
        task,
        requesterUserId: requesterUser.id,
        channel,
        sourceChatId,
        sourceThreadId,
        threads: await options.conversationStore.list(),
      });
      thread =
        threadResolution.thread ??
        (await options.conversationStore.create({
          title: task,
          requesterUserId: requesterUser.id,
          channel,
          sourceChatId,
          sourceThreadId,
        }));
    }
    parentRunId = parentRunId ?? thread.latestRunId;
  }

  requesterUser =
    requesterUser ??
    (await resolveRequesterUser(options, {
      requesterUserId: bodyRequesterUserId,
      channel: bodyChannel ?? thread?.channel ?? "web",
      sourceUserId,
      fallbackUserId: thread?.requesterUserId,
    }));
  if (!requesterUser) {
    throw createRequesterResolutionError({
      requesterUserId: bodyRequesterUserId,
      channel: bodyChannel ?? thread?.channel ?? "web",
      sourceUserId,
    });
  }

  const requesterUserId = requesterUser.id;
  const channel = bodyChannel ?? thread?.channel ?? "web";

  const context = {
    instanceId,
    requesterUserId,
    channel,
    threadId: thread?.id ?? requestedThreadId,
    parentRunId,
    sourceMessageId,
    sourceChatId,
    sourceThreadId,
  };

  return {
    context,
    thread,
    threadResolution,
    threadContext: thread
      ? {
          summary: thread.summary,
          acceptedFacts: thread.acceptedFacts,
          rejectedAttempts: thread.rejectedAttempts,
          openQuestions: thread.openQuestions,
          relevantArtifactIds: thread.artifactIds,
        }
      : undefined,
  };
}

async function resolveRequesterUser(
  options: WebAppOptions,
  input: {
    requesterUserId?: string;
    channel?: string;
    sourceUserId?: string;
    fallbackUserId?: string;
  },
): Promise<UserRecord | undefined> {
  return getUserStore(options).resolve({
    requesterUserId: input.requesterUserId,
    channel: input.channel,
    sourceUserId: input.sourceUserId,
    fallbackUserId: input.fallbackUserId,
  });
}

function getUserStore(options: WebAppOptions): UserStore {
  return options.userStore ?? defaultUserStore;
}

class RunContextError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function createRequesterResolutionError(input: {
  requesterUserId?: string;
  channel?: string;
  sourceUserId?: string;
}): RunContextError {
  if (input.requesterUserId) {
    return new RunContextError(400, `Requester user not found: ${input.requesterUserId}`);
  }

  if (input.sourceUserId) {
    return new RunContextError(
      403,
      `Channel identity is not allowed or not mapped: ${input.channel ?? "unknown"}/${input.sourceUserId}`,
    );
  }

  return new RunContextError(400, "Requester user could not be resolved");
}

async function streamRunEvents(
  request: IncomingMessage,
  response: ServerResponse,
  options: WebAppOptions,
  id: string,
): Promise<void> {
  const initialRun = await options.runStore.get(id);
  if (!initialRun) {
    sendJson(response, 404, { error: "Run not found" });
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  let closed = false;
  let lastSignature = "";
  let pollTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;

  const close = () => {
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  };

  const writeRun = async () => {
    if (closed) return;

    const run = await options.runStore.get(id);
    if (!run) {
      response.write(`event: error\ndata: ${JSON.stringify({ error: "Run not found" })}\n\n`);
      close();
      response.end();
      return;
    }

    const signature = runStreamSignature(run);
    if (signature === lastSignature) return;

    lastSignature = signature;
    response.write(`event: run\ndata: ${JSON.stringify({ run })}\n\n`);

    if (isTerminalRunStatus(run.status)) {
      close();
      response.end();
    }
  };

  pollTimer = setInterval(() => {
    void writeRun().catch((error) => {
      if (closed) return;
      response.write(
        `event: error\ndata: ${JSON.stringify({
          error: error instanceof Error ? error.message : "Run stream failed",
        })}\n\n`,
      );
      close();
      response.end();
    });
  }, 650);

  heartbeatTimer = setInterval(() => {
    if (!closed) response.write(": heartbeat\n\n");
  }, 15000);

  request.on("close", close);
  await writeRun();
}

function runStreamSignature(run: {
  status: string;
  updatedAt: string;
  events: unknown[];
  result?: unknown;
  error?: string;
}) {
  return [
    run.status,
    run.updatedAt,
    run.events.length,
    run.result ? "result" : "",
    run.error ?? "",
  ].join(":");
}

function isTerminalRunStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

async function executeRun(
  id: string,
  task: string,
  options: WebAppOptions,
  inputArtifacts: AgentArtifact[] = [],
  context: { threadId?: string; threadContext?: ConversationThreadContext } = {},
): Promise<void> {
  await options.runStore.markRunning(id);
  const run = await options.runStore.get(id);
  await recordAudit(options, {
    instanceId: run?.instanceId,
    actorId: "coordinator",
    actorType: "agent",
    action: "run.started",
    targetType: "run",
    targetId: id,
    status: "pending",
    runId: id,
    threadId: run?.threadId,
    requesterUserId: run?.requesterUserId,
    channel: run?.channel,
    summary: `Run started: ${task.slice(0, 160)}`,
  });

  try {
    const result = await options.agent.run(task, {
      inputArtifacts,
      threadContext: context.threadContext,
      runId: id,
      instanceId: run?.instanceId ?? "group-local",
      requesterUserId: run?.requesterUserId ?? "user-admin",
      threadId: run?.threadId,
      memoryScopes: [
        { scope: "global" },
        { scope: "group", scopeId: run?.instanceId ?? "group-local" },
        { scope: "group", scopeId: "group-local" },
        { scope: "user", scopeId: run?.requesterUserId ?? "user-admin" },
        ...(run?.threadId ? [{ scope: "thread" as const, scopeId: run.threadId }] : []),
        { scope: "run", scopeId: id },
      ],
      saveArtifact: options.artifactStore
        ? async (artifact) => {
            const saved = await options.artifactStore!.saveGenerated(id, artifact);
            await recordAudit(options, {
              instanceId: run?.instanceId,
              actorId: "coordinator",
              actorType: "agent",
              action: "artifact.generated",
              targetType: "artifact",
              targetId: saved.id,
              runId: id,
              threadId: run?.threadId,
              requesterUserId: run?.requesterUserId,
              channel: run?.channel,
              summary: `Output artifact generated: ${saved.filename}`,
              metadata: {
                filename: saved.filename,
                mimeType: saved.mimeType,
                sizeBytes: saved.sizeBytes,
              },
            });
            return saved;
          }
        : undefined,
      requestToolBuild: options.toolBuildRequestStore
        ? async (request) => {
            const buildRequest = await options.toolBuildRequestStore!.create({ ...request, sourceRunId: id });
            await recordAudit(options, {
              instanceId: run?.instanceId,
              actorId: "coordinator",
              actorType: "agent",
              action: "tool_build.requested",
              targetType: "tool_build_request",
              targetId: buildRequest.id,
              status: "pending",
              runId: id,
              threadId: run?.threadId,
              requesterUserId: run?.requesterUserId,
              channel: run?.channel,
              summary: `Tool build requested for capability: ${buildRequest.capability}`,
              metadata: { capability: buildRequest.capability },
            });
            if (!options.toolBuildWorkflow) return buildRequest;

            const result = await options.toolBuildWorkflow.runOnce(buildRequest.id);
            if (result.request.status === "registered") {
              await options.reloadGeneratedTools?.();
              await recordAudit(options, {
                instanceId: run?.instanceId,
                actorId: "tool-registrar",
                actorType: "agent",
                action: "tool_build.registered",
                targetType: "tool",
                targetId: result.registeredToolName ?? result.request.registeredToolName ?? result.request.id,
                runId: id,
                threadId: run?.threadId,
                requesterUserId: run?.requesterUserId,
                channel: run?.channel,
                summary: `Tool build registered: ${result.registeredToolName ?? result.request.registeredToolName}`,
                metadata: { capability: result.request.capability, requestId: result.request.id },
              });
            }
            return result.request;
          }
        : undefined,
      onEvent: async (event) => {
        const current = await options.runStore.get(id);
        if (!current || current.status === "cancelled") return;
        await options.runStore.appendEvent(id, event);
        await auditTraceEvent(options, id, event, run);
      },
    });
    const current = await options.runStore.get(id);
    if (!current || current.status === "cancelled") return;
    await options.runStore.complete(id, result);
    await auditLearnedMemory(options, id, result, run);
    await recordAudit(options, {
      instanceId: run?.instanceId,
      actorId: "coordinator",
      actorType: "agent",
      action: "run.completed",
      targetType: "run",
      targetId: id,
      runId: id,
      threadId: run?.threadId,
      requesterUserId: run?.requesterUserId,
      channel: run?.channel,
      summary: `Run completed: ${task.slice(0, 160)}`,
      metadata: {
        artifacts: result.artifacts?.length ?? 0,
        subtasks: result.subtasks?.length ?? 0,
        reviews: result.reviews?.length ?? 0,
      },
    });
    if (context.threadId) {
      await options.conversationStore?.completeRun({
        threadId: context.threadId,
        runId: id,
        task,
        finalAnswer: result.finalAnswer,
        artifacts: result.artifacts,
      });
    }
  } catch (error) {
    const current = await options.runStore.get(id);
    if (!current || current.status === "cancelled") return;
    const message = error instanceof Error ? error.message : "Unknown run error";
    await options.runStore.fail(id, message);
    await recordAudit(options, {
      instanceId: run?.instanceId,
      actorId: "coordinator",
      actorType: "agent",
      action: "run.failed",
      targetType: "run",
      targetId: id,
      status: "failure",
      runId: id,
      threadId: run?.threadId,
      requesterUserId: run?.requesterUserId,
      channel: run?.channel,
      summary: `Run failed: ${message.slice(0, 160)}`,
      metadata: { error: message },
    });
    if (context.threadId) {
      await options.conversationStore?.completeRun({
        threadId: context.threadId,
        runId: id,
        task,
        failedError: message,
      });
    }
  }
}

async function auditLearnedMemory(
  options: WebAppOptions,
  runId: string,
  result: AgentRunResult,
  run: AgentRunRecord | undefined,
): Promise<void> {
  if (!result.learnedSkill) return;

  await recordAudit(options, {
    instanceId: run?.instanceId,
    actorId: "coordinator",
    actorType: "agent",
    action: "memory.created",
    targetType: "memory",
    targetId: result.learnedSkill.id,
    status: result.learnedSkill.status === "proposed" ? "pending" : "success",
    runId,
    threadId: run?.threadId ?? result.learnedSkill.sourceThreadId,
    requesterUserId: run?.requesterUserId,
    channel: run?.channel,
    summary: `Memory created from run: ${result.learnedSkill.title}`,
    metadata: {
      scope: result.learnedSkill.scope,
      scopeId: result.learnedSkill.scopeId,
      confidence: result.learnedSkill.confidence,
      memoryStatus: result.learnedSkill.status,
      sensitivity: result.learnedSkill.sensitivity,
    },
  });
}

async function auditTraceEvent(
  options: WebAppOptions,
  runId: string,
  event: AgentEvent,
  run?: { instanceId?: string; threadId?: string; requesterUserId?: string; channel?: string },
): Promise<void> {
  if (event.activity !== "tool") return;
  if (event.status !== "completed" && event.status !== "failed") return;
  const payload = event.payload && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)
    : {};

  await recordAudit(options, {
    instanceId: run?.instanceId,
    actorId: event.actor,
    actorType: "tool",
    action: event.status === "failed" ? "tool.failed" : "tool.used",
    targetType: "tool",
    targetId: String(payload.toolName ?? event.actor),
    status: event.status === "failed" ? "failure" : "success",
    runId,
    threadId: run?.threadId,
    requesterUserId: run?.requesterUserId,
    channel: run?.channel,
    summary: event.title,
    metadata: sanitizeAuditMetadata({
      spanId: event.spanId,
      detail: event.detail,
      payload,
      durationMs: event.durationMs,
    }),
  });
}

async function recordAudit(options: WebAppOptions, input: AuditEventInput): Promise<void> {
  if (!options.auditEventStore) return;
  await options.auditEventStore.record(input);
}

function sanitizeAuditMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return sanitizeObject(value as Record<string, unknown>);
}

function sanitizeObject(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes("secret") || lowerKey.includes("token") || lowerKey.includes("password")) {
      result[key] = "[redacted]";
      continue;
    }
    if (Array.isArray(item)) {
      result[key] = item.map((entry) =>
        entry && typeof entry === "object" ? sanitizeObject(entry as Record<string, unknown>) : entry,
      );
      continue;
    }
    if (item && typeof item === "object") {
      result[key] = sanitizeObject(item as Record<string, unknown>);
      continue;
    }
    result[key] = item;
  }
  return result;
}

function parseOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function parseGroupProfileUpdate(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("group profile update must be an object");
  }

  const candidate = value as Record<string, unknown>;
  const preferences = parseOptionalPreferences(candidate.preferences);
  return {
    name: parseOptionalText(candidate.name),
    description: typeof candidate.description === "string" ? candidate.description.trim() : undefined,
    preferences,
  };
}

function parseOptionalPreferences(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("preferences must be an object");
  }
  return sanitizeObject(value as Record<string, unknown>);
}

function parseAttachmentInputs(value: unknown): ArtifactUploadInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("attachments must be an array");
  }

  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("attachments must contain objects");
    }

    const candidate = item as Record<string, unknown>;
    if (typeof candidate.filename !== "string" || candidate.filename.trim() === "") {
      throw new Error("attachment filename is required");
    }
    if (typeof candidate.contentBase64 !== "string" || candidate.contentBase64.trim() === "") {
      throw new Error("attachment contentBase64 is required");
    }

    return {
      filename: candidate.filename,
      mimeType: typeof candidate.mimeType === "string" ? candidate.mimeType : undefined,
      contentBase64: candidate.contentBase64,
      description: typeof candidate.description === "string" ? candidate.description : undefined,
    };
  });
}

function parseMemoryListOptions(url: URL): MemoryListOptions {
  const options: MemoryListOptions = {};
  const scope = url.searchParams.get("scope");
  const status = url.searchParams.get("status");
  const scopeId = url.searchParams.get("scopeId");
  const limit = Number(url.searchParams.get("limit") ?? "");
  if (scope) options.scope = parseMemoryScope(scope);
  if (status) options.status = parseMemoryStatus(status);
  if (scopeId) options.scopeId = scopeId;
  if (url.searchParams.get("includeArchived") === "true") options.includeArchived = true;
  if (Number.isFinite(limit) && limit > 0) options.limit = Math.min(Math.floor(limit), 500);
  return options;
}

function parseMemoryCreateInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("memory create request must be an object");
  }

  const candidate = value as Record<string, unknown>;
  const title = parseRequiredText(candidate.title, "title");
  const summary = parseRequiredText(candidate.summary, "summary");
  const reusableProcedure = parseRequiredText(candidate.reusableProcedure, "reusableProcedure");

  return {
    title,
    summary,
    reusableProcedure,
    tags: parseOptionalStringArray(candidate.tags, "tags") ?? [],
    scope: candidate.scope === undefined ? "global" : parseMemoryScope(candidate.scope),
    scopeId: parseOptionalText(candidate.scopeId),
    status: candidate.status === undefined ? "proposed" : parseMemoryStatus(candidate.status),
    confidence: parseOptionalConfidence(candidate.confidence),
    sensitivity: candidate.sensitivity === undefined ? "normal" : parseMemorySensitivity(candidate.sensitivity),
    sourceRunId: parseOptionalText(candidate.sourceRunId),
    sourceThreadId: parseOptionalText(candidate.sourceThreadId),
    evidence: parseOptionalStringArray(candidate.evidence, "evidence") ?? [],
  };
}

function parseMemoryUpdateInput(value: unknown): MemoryUpdateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("memory update request must be an object");
  }

  const candidate = value as Record<string, unknown>;
  const update: MemoryUpdateInput = {};
  if (candidate.title !== undefined) update.title = parseRequiredText(candidate.title, "title");
  if (candidate.summary !== undefined) update.summary = parseRequiredText(candidate.summary, "summary");
  if (candidate.reusableProcedure !== undefined) {
    update.reusableProcedure = parseRequiredText(candidate.reusableProcedure, "reusableProcedure");
  }
  if (candidate.tags !== undefined) update.tags = parseOptionalStringArray(candidate.tags, "tags") ?? [];
  if (candidate.scope !== undefined) update.scope = parseMemoryScope(candidate.scope);
  if (candidate.scopeId !== undefined) update.scopeId = parseOptionalText(candidate.scopeId);
  if (candidate.status !== undefined) update.status = parseMemoryStatus(candidate.status);
  if (candidate.confidence !== undefined) update.confidence = parseOptionalConfidence(candidate.confidence);
  if (candidate.sensitivity !== undefined) update.sensitivity = parseMemorySensitivity(candidate.sensitivity);
  if (candidate.sourceRunId !== undefined) update.sourceRunId = parseOptionalText(candidate.sourceRunId);
  if (candidate.sourceThreadId !== undefined) update.sourceThreadId = parseOptionalText(candidate.sourceThreadId);
  if (candidate.evidence !== undefined) update.evidence = parseOptionalStringArray(candidate.evidence, "evidence") ?? [];
  return update;
}

function parseMemoryRetrievalEvaluationCases(value: unknown): MemoryRetrievalEvaluationCase[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("memory retrieval evaluation request must be an object");
  }

  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.cases) || candidate.cases.length === 0) {
    throw new Error("cases must be a non-empty array");
  }

  return candidate.cases.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`cases[${index}] must be an object`);
    }

    const entry = item as Record<string, unknown>;
    const expectedMemoryIds = parseOptionalStringArray(entry.expectedMemoryIds, `cases[${index}].expectedMemoryIds`);
    if (!expectedMemoryIds?.length) {
      throw new Error(`cases[${index}].expectedMemoryIds must contain at least one memory id`);
    }

    return {
      id: parseRequiredText(entry.id, `cases[${index}].id`),
      query: parseRequiredText(entry.query, `cases[${index}].query`),
      expectedMemoryIds,
      visibleScopes: parseOptionalMemoryScopeFilters(entry.visibleScopes, `cases[${index}].visibleScopes`),
      limit: parseOptionalPositiveInteger(entry.limit, `cases[${index}].limit`),
      minRecall: parseOptionalConfidence(entry.minRecall),
    };
  });
}

function parseOptionalMemoryScopeFilters(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);

  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${field}[${index}] must be an object`);
    }

    const candidate = item as Record<string, unknown>;
    return {
      scope: parseMemoryScope(candidate.scope),
      scopeId: parseOptionalText(candidate.scopeId),
    };
  });
}

function parseOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error(`${field} must be an integer from 1 to 100`);
  }
  return parsed;
}

function parseRequiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function parseMemoryScope(value: unknown): "global" | "group" | "user" | "thread" | "run" {
  if (value === "global" || value === "group" || value === "user" || value === "thread" || value === "run") {
    return value;
  }
  throw new Error("memory scope is invalid");
}

function parseMemoryStatus(value: unknown): "proposed" | "accepted" | "rejected" | "archived" {
  if (value === "proposed" || value === "accepted" || value === "rejected" || value === "archived") {
    return value;
  }
  throw new Error("memory status is invalid");
}

function parseMemorySensitivity(value: unknown): "normal" | "sensitive" | "private" {
  if (value === "normal" || value === "sensitive" || value === "private") {
    return value;
  }
  throw new Error("memory sensitivity is invalid");
}

function parseOptionalConfidence(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const confidence = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("confidence must be a number from 0 to 1");
  }
  return confidence;
}

function parseToolBuildRequestInput(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("tool build request must be an object");
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.capability !== "string" || candidate.capability.trim() === "") {
    throw new Error("capability is required");
  }
  if (typeof candidate.reason !== "string" || candidate.reason.trim() === "") {
    throw new Error("reason is required");
  }

  return {
    capability: candidate.capability.trim(),
    reason: candidate.reason.trim(),
    sourceRunId: typeof candidate.sourceRunId === "string" ? candidate.sourceRunId : undefined,
    sourceSpanId: typeof candidate.sourceSpanId === "string" ? candidate.sourceSpanId : undefined,
    taskSummary: typeof candidate.taskSummary === "string" ? candidate.taskSummary : undefined,
    desiredToolName: typeof candidate.desiredToolName === "string" ? candidate.desiredToolName : undefined,
    requiredInputs: parseOptionalStringArray(candidate.requiredInputs, "requiredInputs"),
    requiredOutputs: parseOptionalStringArray(candidate.requiredOutputs, "requiredOutputs"),
    qaCriteria: parseOptionalStringArray(candidate.qaCriteria, "qaCriteria"),
    reworkOf: typeof candidate.reworkOf === "string" ? candidate.reworkOf : undefined,
    feedback: typeof candidate.feedback === "string" ? candidate.feedback : undefined,
  };
}

function parseToolBuildReworkInput(value: unknown): string {
  if (!value || typeof value !== "object") {
    throw new Error("tool build rework request must be an object");
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.feedback !== "string" || candidate.feedback.trim() === "") {
    throw new Error("feedback is required");
  }
  return candidate.feedback.trim();
}

function parseOptionalReason(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.reason === "string" && candidate.reason.trim() ? candidate.reason.trim() : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseToolBuildRequestStatusUpdate(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("tool build request update must be an object");
  }

  const candidate = value as Record<string, unknown>;
  const status = String(candidate.status ?? "");
  if (!["requested", "building", "qa_failed", "qa_passed", "registered", "blocked"].includes(status)) {
    throw new Error("status is invalid");
  }

  return {
    status: status as "requested" | "building" | "qa_failed" | "qa_passed" | "registered" | "blocked",
    statusDetail: typeof candidate.statusDetail === "string" ? candidate.statusDetail.trim() : undefined,
    registeredToolName:
      typeof candidate.registeredToolName === "string" ? candidate.registeredToolName.trim() : undefined,
    qaReport: parseOptionalQaReport(candidate.qaReport),
  };
}

function parseOptionalQaReport(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("qaReport must be an object");
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.ok !== "boolean") {
    throw new Error("qaReport.ok must be a boolean");
  }
  if (typeof candidate.summary !== "string" || candidate.summary.trim() === "") {
    throw new Error("qaReport.summary is required");
  }

  return {
    ok: candidate.ok,
    summary: candidate.summary.trim(),
    checks: parseRequiredStringArray(candidate.checks, "qaReport.checks"),
    artifacts: parseOptionalStringArray(candidate.artifacts, "qaReport.artifacts"),
  };
}

function parseGeneratedToolModuleInput(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("generated tool module must be an object");
  }

  const candidate = value as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const version = typeof candidate.version === "string" ? candidate.version.trim() : "";
  const description = typeof candidate.description === "string" ? candidate.description.trim() : "";
  if (!/^[a-z][a-z0-9.-]{1,80}$/i.test(name)) {
    throw new Error("name must be a stable tool id such as generated.browser.screenshot");
  }
  if (!version) throw new Error("version is required");
  if (!description) throw new Error("description is required");

  return {
    name,
    version,
    description,
    capabilities: parseRequiredStringArray(candidate.capabilities, "capabilities"),
    startupMode: parseStartupMode(candidate.startupMode),
    inputSchema: parseOptionalToolSchema(candidate.inputSchema, "inputSchema"),
    outputSchema: parseOptionalToolSchema(candidate.outputSchema, "outputSchema"),
    modulePath: parseRequiredPath(candidate.modulePath, "modulePath"),
    testPath: parseOptionalPath(candidate.testPath, "testPath"),
  };
}

function parseGeneratedToolReplacementInput(expectedName: string, value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("generated tool replacement must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const parsed = parseGeneratedToolModuleInput(value);
  const replacesVersion = typeof candidate.replacesVersion === "string" ? candidate.replacesVersion.trim() : "";
  if (parsed.name !== expectedName) {
    throw new Error(`replacement path name ${expectedName} does not match body name ${parsed.name}`);
  }
  if (!replacesVersion) throw new Error("replacesVersion is required");

  return {
    ...parsed,
    replacesVersion,
  };
}

function parseRequiredPath(value: unknown, name: string): string {
  const parsed = parseOptionalPath(value, name);
  if (!parsed) throw new Error(`${name} is required`);
  return parsed;
}

function parseOptionalPath(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.includes("..") || trimmed.startsWith("/") || trimmed.includes("\\")) {
    throw new Error(`${name} must be a relative project path`);
  }
  return trimmed;
}

function parseRequiredStringArray(value: unknown, name: string): string[] {
  const parsed = parseOptionalStringArray(value, name);
  if (!parsed?.length) throw new Error(`${name} must contain at least one value`);
  return parsed;
}

function parseStartupMode(value: unknown): ToolStartupMode | undefined {
  if (value === undefined) return undefined;
  if (value === "always-on" || value === "on-demand" || value === "ephemeral") return value;
  throw new Error("startupMode is invalid");
}

function parseOptionalToolSchema(value: unknown, name: string): ToolSchema | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "object" || !candidate.properties || typeof candidate.properties !== "object") {
    throw new Error(`${name} must be a ToolSchema object`);
  }

  return candidate as ToolSchema;
}

function parseOptionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item) => String(item).trim()).filter(Boolean);
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return {} as T;

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

async function serveStatic(pathname: string, response: ServerResponse, publicDir: string): Promise<void> {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentType(filePath),
      "cache-control": "no-store",
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function parseTierSettingsInput(item: unknown) {
  if (!item || typeof item !== "object") {
    throw new Error("Invalid tier settings item");
  }

  const candidate = item as {
    tier?: unknown;
    models?: unknown;
    maxAttempts?: unknown;
    escalateOnFailure?: unknown;
  };

  if (!["S", "M", "L", "XL"].includes(String(candidate.tier))) {
    throw new Error("Invalid model tier");
  }

  if (!Array.isArray(candidate.models)) {
    throw new Error("models must be an array");
  }

  return {
    tier: candidate.tier as "S" | "M" | "L" | "XL",
    models: candidate.models.map((model) => String(model)),
    maxAttempts:
      typeof candidate.maxAttempts === "number" ? candidate.maxAttempts : undefined,
    escalateOnFailure:
      typeof candidate.escalateOnFailure === "boolean"
        ? candidate.escalateOnFailure
        : undefined,
  };
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
