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
import {
  ChannelIdentityStatus,
  InMemoryUserStore,
  UserRecord,
  UserStore,
} from "../instance/userStore.js";
import { MemoryListOptions, MemoryUpdateInput, SkillMemoryStore } from "../memory/skillMemory.js";
import {
  evaluateMemoryRetrieval,
  MemoryRetrievalEvaluationCase,
} from "../memory/retrievalEvaluation.js";
import { reviewMemoryProposals } from "../memory/memoryProposalReview.js";
import { AgentRunRecord, RunCreateContext, RunStore } from "../runs/types.js";
import {
  rejectRawSecretPayload,
  SecretHandleInput,
  SecretHandleStore,
} from "../secrets/secretHandleStore.js";
import { ModelTierSettingsStore } from "../settings/modelTierSettings.js";
import {
  ModelProviderInput,
  ModelProviderStore,
  ModelProviderUpdateInput,
} from "../settings/modelProviderStore.js";
import { ToolSchema, ToolStartupMode } from "../tools/tool.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  ToolBuildQaReport,
  ToolBuildRequestStore,
  ToolBuildReviewReport,
} from "../tools/toolBuildRequestStore.js";
import { ToolBuildWorkflow } from "../tools/toolBuildWorkflow.js";
import {
  generatedToolInputFromPackageManifest,
  ToolMetadataStore,
  toolToMetadata,
} from "../tools/toolMetadataStore.js";
import { normalizeToolPackageManifest } from "../tools/toolPackage.js";
import { ToolPackageRunner } from "../tools/toolPackageRunner.js";
import { ToolServiceSupervisor } from "../tools/toolServiceSupervisor.js";
import {
  ToolServiceEventDirection,
  ToolServiceEventInput,
  ToolServiceEventRecord,
  ToolServiceEventStatus,
  ToolServiceEventStore,
} from "../tools/toolServiceEventStore.js";
import {
  ToolMigrationCreateInput,
  ToolMigrationStore,
  validateToolMigrationStatus,
} from "../tools/toolMigrationStore.js";
import { AgentArtifact, AgentEvent, AgentRunResult, ArtifactUploadInput } from "../types.js";

export type WebAppOptions = {
  agent: UniversalAgent;
  runStore: RunStore;
  publicDir: string;
  skillMemory?: SkillMemoryStore;
  toolRegistry?: Pick<ToolRegistry, "list"> & Partial<Pick<ToolRegistry, "unregister">>;
  toolMetadataStore?: ToolMetadataStore;
  toolMigrationStore?: ToolMigrationStore;
  toolBuildRequestStore?: ToolBuildRequestStore;
  toolBuildWorkflow?: ToolBuildWorkflow;
  toolServiceSupervisor?: ToolServiceSupervisor;
  toolServiceEventStore?: ToolServiceEventStore;
  toolPackageRunners?: ToolPackageRunner[];
  reloadGeneratedTools?: () => Promise<void>;
  modelTierSettings?: ModelTierSettingsStore;
  modelProviderStore?: ModelProviderStore;
  secretHandleStore?: SecretHandleStore;
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

  if (request.method === "POST" && url.pathname === "/api/users") {
    try {
      const user = await getUserStore(options).create(parseUserCreateInput(await readJsonBody<unknown>(request)));
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "user.created",
        targetType: "user",
        targetId: user.id,
        status: "success",
        summary: `User created: ${user.displayName}`,
        metadata: { role: user.role, roles: user.roles },
      });
      sendJson(response, 201, { user });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid user create request",
      });
    }
    return;
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (request.method === "PATCH" && userMatch) {
    const userId = decodeURIComponent(userMatch[1] ?? "");
    try {
      const user = await getUserStore(options).update(
        userId,
        parseUserUpdateInput(await readJsonBody<unknown>(request)),
      );
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "user.updated",
        targetType: "user",
        targetId: user.id,
        status: "success",
        summary: `User updated: ${user.displayName}`,
        metadata: { role: user.role, roles: user.roles },
      });
      sendJson(response, 200, { user });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid user update request";
      sendJson(response, message.includes("was not found") ? 404 : 400, { error: message });
    }
    return;
  }

  if (request.method === "DELETE" && userMatch) {
    const userId = decodeURIComponent(userMatch[1] ?? "");
    try {
      const deleted = await getUserStore(options).delete(userId);
      if (!deleted) {
        sendJson(response, 404, { error: "User not found" });
        return;
      }
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "user.deleted",
        targetType: "user",
        targetId: userId,
        status: "success",
        summary: `User deleted: ${userId}`,
      });
      sendJson(response, 200, { deleted: true, userId });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Could not delete user",
      });
    }
    return;
  }

  const userIdentityMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/channel-identities$/);
  if (request.method === "POST" && userIdentityMatch) {
    const userId = decodeURIComponent(userIdentityMatch[1] ?? "");
    try {
      const identity = await getUserStore(options).createIdentity(
        parseChannelIdentityCreateInput(await readJsonBody<unknown>(request), userId),
      );
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "channel_identity.created",
        targetType: "channel_identity",
        targetId: identity.id,
        status: identity.allowStatus === "allowed" ? "success" : "pending",
        requesterUserId: identity.userId,
        channel: identity.provider,
        summary: `Channel identity created: ${identity.provider}/${identity.providerUserId}`,
        metadata: {
          userId: identity.userId,
          allowStatus: identity.allowStatus,
        },
      });
      sendJson(response, 201, { identity });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid channel identity create request",
      });
    }
    return;
  }

  const identityMatch = url.pathname.match(/^\/api\/channel-identities\/([^/]+)$/);
  if (request.method === "PATCH" && identityMatch) {
    const identityId = decodeURIComponent(identityMatch[1] ?? "");
    try {
      const identity = await getUserStore(options).updateIdentity(
        identityId,
        parseChannelIdentityUpdateInput(await readJsonBody<unknown>(request)),
      );
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "channel_identity.updated",
        targetType: "channel_identity",
        targetId: identity.id,
        status: identity.allowStatus === "allowed" ? "success" : "pending",
        requesterUserId: identity.userId,
        channel: identity.provider,
        summary: `Channel identity updated: ${identity.provider}/${identity.providerUserId}`,
        metadata: {
          userId: identity.userId,
          allowStatus: identity.allowStatus,
        },
      });
      sendJson(response, 200, { identity });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid channel identity update request";
      sendJson(response, message.includes("was not found") ? 404 : 400, { error: message });
    }
    return;
  }

  if (request.method === "DELETE" && identityMatch) {
    const identityId = decodeURIComponent(identityMatch[1] ?? "");
    const deleted = await getUserStore(options).deleteIdentity(identityId);
    if (!deleted) {
      sendJson(response, 404, { error: "Channel identity not found" });
      return;
    }
    await recordAudit(options, {
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "channel_identity.deleted",
      targetType: "channel_identity",
      targetId: identityId,
      status: "success",
      summary: `Channel identity deleted: ${identityId}`,
    });
    sendJson(response, 200, { deleted: true, identityId });
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

  if (request.method === "GET" && url.pathname === "/api/memories/review-queue") {
    if (!options.skillMemory) {
      sendJson(response, 503, { error: "Memory store is not configured" });
      return;
    }

    const memories = await options.skillMemory.list({ status: "proposed", includeArchived: true });
    const reviews = reviewMemoryProposals(memories);
    sendJson(response, 200, {
      memories,
      reviews,
      summary: {
        total: reviews.length,
        ready: reviews.filter((review) => review.status === "ready").length,
        needsReview: reviews.filter((review) => review.status === "needs_review").length,
        blocked: reviews.filter((review) => review.status === "blocked").length,
      },
    });
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

  if (request.method === "POST" && url.pathname === "/api/tools/package-manifests") {
    if (!options.toolMetadataStore) {
      sendJson(response, 503, { error: "Tool metadata store is not configured" });
      return;
    }

    try {
      const input = parseToolPackageManifestImport(await readJsonBody<unknown>(request));
      const registered = await options.toolMetadataStore.registerGenerated(input);
      await options.reloadGeneratedTools?.();
      const tool = (await options.toolMetadataStore.list()).find((candidate) => candidate.name === registered.name) ?? registered;
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "tool.package_imported",
        targetType: "tool",
        targetId: tool.name,
        status: "success",
        summary: `Imported tool package manifest: ${tool.name}@${tool.version}`,
      });
      sendJson(response, 201, { tool });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid tool package manifest",
      });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tool-package-runners") {
    sendJson(response, 200, {
      runners: (options.toolPackageRunners ?? []).map((runner) =>
        runner.describe
          ? runner.describe()
          : {
              name: `${runner.type} runner`,
              type: runner.type,
              status: "available",
              detail: "Runner does not expose extended diagnostics.",
              supportedPackageTypes: runner.type === "legacy-local-path" ? [] : [runner.type],
            },
      ),
    });
    return;
  }

  const generatedToolVersionsMatch = url.pathname.match(/^\/api\/tools\/generated-modules\/([^/]+)\/versions$/);
  if (request.method === "GET" && generatedToolVersionsMatch) {
    if (!options.toolMetadataStore) {
      sendJson(response, 503, { error: "Tool metadata store is not configured" });
      return;
    }

    try {
      const name = decodeURIComponent(generatedToolVersionsMatch[1] ?? "");
      sendJson(response, 200, { versions: await options.toolMetadataStore.listVersions(name) });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid generated tool version request",
      });
    }
    return;
  }

  const generatedToolManifestMatch = url.pathname.match(
    /^\/api\/tools\/generated-modules\/([^/]+)\/package-manifest$/,
  );
  if (request.method === "GET" && generatedToolManifestMatch) {
    if (!options.toolMetadataStore) {
      sendJson(response, 503, { error: "Tool metadata store is not configured" });
      return;
    }

    const name = decodeURIComponent(generatedToolManifestMatch[1] ?? "");
    const tool = (await options.toolMetadataStore.list()).find((candidate) => candidate.name === name);
    if (!tool) {
      sendJson(response, 404, { error: "Generated tool was not found" });
      return;
    }
    if (!tool.packageManifest) {
      sendJson(response, 404, { error: "Generated tool does not have a package manifest" });
      return;
    }

    sendJson(response, 200, { manifest: tool.packageManifest });
    return;
  }

  const generatedToolDeleteMatch = url.pathname.match(/^\/api\/tools\/generated-modules\/([^/]+)$/);
  if (request.method === "DELETE" && generatedToolDeleteMatch) {
    if (!options.toolMetadataStore) {
      sendJson(response, 503, { error: "Tool metadata store is not configured" });
      return;
    }

    const name = decodeURIComponent(generatedToolDeleteMatch[1] ?? "");
    try {
      const deleted = await options.toolMetadataStore.deleteGenerated(name);
      if (!deleted) {
        sendJson(response, 404, { error: "Generated tool was not found" });
        return;
      }
      options.toolRegistry?.unregister?.(name);
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "tool.deleted",
        targetType: "tool",
        targetId: name,
        status: "success",
        summary: `Generated tool deleted: ${name}`,
      });
      sendJson(response, 200, { deleted: true, name });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid generated tool delete request",
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

  const activateVersionMatch = url.pathname.match(/^\/api\/tools\/generated-modules\/([^/]+)\/activate-version$/);
  if (request.method === "POST" && activateVersionMatch) {
    if (!options.toolMetadataStore) {
      sendJson(response, 503, { error: "Tool metadata store is not configured" });
      return;
    }

    try {
      const name = decodeURIComponent(activateVersionMatch[1] ?? "");
      const body = await readJsonBody<unknown>(request);
      const version = parseRequiredText(isRecord(body) ? body.version : undefined, "version");
      const tool = await options.toolMetadataStore.activateVersion(name, version);
      await options.reloadGeneratedTools?.();
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "tool.version_activated",
        targetType: "tool",
        targetId: name,
        status: "success",
        summary: `Activated ${name} ${version}`,
      });
      sendJson(response, 200, { tool });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid generated tool version activation",
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

  if (request.method === "POST" && url.pathname === "/api/tools/reload-generated") {
    if (!options.reloadGeneratedTools) {
      sendJson(response, 503, { error: "Generated tool reload is not configured" });
      return;
    }

    try {
      await options.reloadGeneratedTools();
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "tool.generated_reload",
        targetType: "tool_registry",
        targetId: "generated-tools",
        status: "success",
        summary: "Generated tools reloaded by operator.",
      });
      sendJson(response, 200, {
        tools: options.toolMetadataStore ? await options.toolMetadataStore.list() : [],
      });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Generated tool reload failed",
      });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tool-services") {
    sendJson(response, 200, {
      services: options.toolServiceSupervisor ? await options.toolServiceSupervisor.list() : [],
    });
    return;
  }

  const toolServiceOutboxMatch = url.pathname.match(/^\/api\/tool-services\/([^/]+)\/outbox$/);
  if (request.method === "GET" && toolServiceOutboxMatch) {
    if (!options.toolServiceSupervisor || !options.toolServiceEventStore) {
      sendJson(response, 503, { error: "Tool service runtime is not configured" });
      return;
    }
    const toolName = decodeURIComponent(toolServiceOutboxMatch[1] ?? "");
    const service = (await options.toolServiceSupervisor.list()).find((candidate) => candidate.toolName === toolName);
    if (!service) {
      sendJson(response, 404, { error: `Tool service was not found: ${toolName}` });
      return;
    }
    const events = await listPendingToolServiceOutbox(options, toolName, parseLimit(url.searchParams.get("limit"), 50));
    sendJson(response, 200, { events });
    return;
  }

  const toolServiceOutboxAckMatch = url.pathname.match(/^\/api\/tool-services\/([^/]+)\/outbox\/([^/]+)\/ack$/);
  if (request.method === "POST" && toolServiceOutboxAckMatch) {
    if (!options.toolServiceSupervisor || !options.toolServiceEventStore) {
      sendJson(response, 503, { error: "Tool service runtime is not configured" });
      return;
    }
    const toolName = decodeURIComponent(toolServiceOutboxAckMatch[1] ?? "");
    const eventId = decodeURIComponent(toolServiceOutboxAckMatch[2] ?? "");
    const service = (await options.toolServiceSupervisor.list()).find((candidate) => candidate.toolName === toolName);
    if (!service) {
      sendJson(response, 404, { error: `Tool service was not found: ${toolName}` });
      return;
    }
    const body = await readJsonBody<unknown>(request);
    try {
      const input = parseToolServiceOutboxAckInput(body);
      const queued = await findToolServiceEvent(options, toolName, eventId);
      if (!queued || queued.direction !== "outbound" || queued.status !== "queued") {
        sendJson(response, 404, { error: `Queued outbound event was not found: ${eventId}` });
        return;
      }
      const event = await options.toolServiceEventStore.record({
        toolName,
        direction: "outbound",
        status: input.status,
        summary: input.summary ?? `${input.status === "sent" ? "Outbound delivered" : "Outbound delivery failed"}: ${queued.summary.slice(0, 160)}`,
        sourceUserId: queued.sourceUserId,
        sourceChatId: queued.sourceChatId,
        sourceMessageId: queued.sourceMessageId,
        threadId: queued.threadId,
        runId: queued.runId,
        payload: {
          sourceEventId: queued.id,
          providerMessageId: input.providerMessageId,
          detail: input.detail,
          ...(input.payload ?? {}),
        },
      });
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: toolName,
        actorType: "tool",
        action: "tool_service.event_recorded",
        targetType: "tool",
        targetId: toolName,
        status: input.status === "sent" ? "success" : "failure",
        runId: queued.runId,
        threadId: queued.threadId,
        requesterUserId: undefined,
        channel: toolName,
        summary: `Outbound ${input.status}: ${queued.summary.slice(0, 160)}`,
        metadata: {
          sourceEventId: queued.id,
          deliveryEventId: event.id,
          providerMessageId: input.providerMessageId,
        },
      });
      sendJson(response, 201, { event });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid outbound ack",
      });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tool-service-events") {
    sendJson(response, 200, {
      events: options.toolServiceEventStore
        ? await options.toolServiceEventStore.list({
            toolName: url.searchParams.get("toolName") ?? undefined,
            direction: parseOptionalToolServiceEventDirection(url.searchParams.get("direction")),
            limit: Number(url.searchParams.get("limit") ?? "100"),
          })
        : [],
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tool-service-events") {
    if (!options.toolServiceEventStore) {
      sendJson(response, 503, { error: "Tool service event store is not configured" });
      return;
    }

    try {
      const input = parseToolServiceEventInput(await readJsonBody<unknown>(request));
      const event = await options.toolServiceEventStore.record(input);
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "tool_service.event_recorded",
        targetType: "tool",
        targetId: event.toolName,
        status: event.status === "failed" ? "failure" : "success",
        runId: event.runId,
        threadId: event.threadId,
        requesterUserId: event.sourceUserId,
        summary: `${event.direction} service event: ${event.summary.slice(0, 160)}`,
        metadata: {
          direction: event.direction,
          status: event.status,
          sourceChatId: event.sourceChatId,
          sourceMessageId: event.sourceMessageId,
        },
      });
      sendJson(response, 201, { event });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid tool service event",
      });
    }
    return;
  }

  const toolServiceInboundMatch = url.pathname.match(/^\/api\/tool-services\/([^/]+)\/inbound$/);
  if (request.method === "POST" && toolServiceInboundMatch) {
    if (!options.toolServiceSupervisor || !options.toolServiceEventStore) {
      sendJson(response, 503, { error: "Tool service runtime is not configured" });
      return;
    }

    const toolName = decodeURIComponent(toolServiceInboundMatch[1] ?? "");
    const service = (await options.toolServiceSupervisor.list()).find((candidate) => candidate.toolName === toolName);
    if (!service) {
      sendJson(response, 404, { error: `Tool service was not found: ${toolName}` });
      return;
    }

    const body = await readJsonBody<unknown>(request);
    try {
      const inbound = parseToolServiceInboundInput(body, toolName);
      const receivedEvent = await options.toolServiceEventStore.record({
        toolName,
        direction: "inbound",
        status: "received",
        summary: inbound.task.slice(0, 240),
        sourceUserId: inbound.sourceUserId,
        sourceChatId: inbound.sourceChatId,
        sourceMessageId: inbound.sourceMessageId,
        payload: isRecord(body) ? sanitizeObject(body) : undefined,
      });
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: toolName,
        actorType: "tool",
        action: "tool_service.event_recorded",
        targetType: "tool",
        targetId: toolName,
        status: "success",
        requesterUserId: inbound.sourceUserId,
        channel: inbound.channel,
        summary: `Inbound event received: ${inbound.task.slice(0, 160)}`,
        metadata: {
          sourceEventId: receivedEvent.id,
          sourceChatId: inbound.sourceChatId,
          sourceMessageId: inbound.sourceMessageId,
        },
      });

      const created = await createAndStartRun(
        {
          ...inbound.originalBody,
          task: inbound.task,
          channel: inbound.channel,
          sourceUserId: inbound.sourceUserId,
          sourceUserAliases: inbound.sourceUserAliases,
          sourceChatId: inbound.sourceChatId,
          threadId: inbound.threadId,
          sourceThreadId: inbound.sourceThreadId,
          sourceMessageId: inbound.sourceMessageId,
        },
        options,
      );
      const run = created.run;
      const queuedEvent = await options.toolServiceEventStore.record({
        toolName,
        direction: "system",
        status: "queued",
        summary: `Run created from inbound event: ${inbound.task.slice(0, 160)}`,
        sourceUserId: inbound.sourceUserId,
        sourceChatId: inbound.sourceChatId,
        sourceMessageId: inbound.sourceMessageId,
        threadId: run?.threadId ?? created.threadResolution?.threadId,
        runId: run?.id,
        payload: {
          sourceEventId: receivedEvent.id,
          threadResolution: created.threadResolution,
        },
      });
      await recordAudit(options, {
        instanceId: run?.instanceId ?? "instance-local",
        actorId: toolName,
        actorType: "tool",
        action: "tool_service.event_recorded",
        targetType: "tool",
        targetId: toolName,
        status: "success",
        runId: run?.id,
        threadId: run?.threadId,
        requesterUserId: run?.requesterUserId,
        channel: run?.channel,
        summary: `Inbound event queued run: ${run?.id ?? "unknown"}`,
        metadata: {
          sourceEventId: receivedEvent.id,
          queuedEventId: queuedEvent.id,
        },
      });
      sendJson(response, 202, {
        event: receivedEvent,
        queuedEvent,
        ...created,
      });
    } catch (error) {
      const input = isRecord(body) ? parseLooseToolServiceInboundInput(body, toolName) : undefined;
      await options.toolServiceEventStore.record({
        toolName,
        direction: "inbound",
        status: "ignored",
        summary: error instanceof Error ? error.message : "Inbound event could not create a run",
        sourceUserId: input?.sourceUserId,
        sourceChatId: input?.sourceChatId,
        sourceMessageId: input?.sourceMessageId,
        payload: isRecord(body) ? sanitizeObject(body) : undefined,
      });
      sendJson(response, error instanceof RunContextError ? error.statusCode : 400, {
        error: error instanceof Error ? error.message : "Invalid inbound tool service event",
      });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tool-services/logs/events") {
    await streamToolServiceLogs(request, response, options, url.searchParams.get("toolName") ?? undefined);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tool-services/logs") {
    sendJson(response, 200, {
      logs: options.toolServiceSupervisor
        ? await options.toolServiceSupervisor.listLogs(
            url.searchParams.get("toolName") ?? undefined,
            Number(url.searchParams.get("limit") ?? "100"),
          )
        : [],
    });
    return;
  }

  const toolServiceActionMatch = url.pathname.match(/^\/api\/tool-services\/([^/]+)\/(start|stop|restart|heartbeat)$/);
  if (request.method === "POST" && toolServiceActionMatch) {
    if (!options.toolServiceSupervisor) {
      sendJson(response, 503, { error: "Tool service supervisor is not configured" });
      return;
    }

    const toolName = decodeURIComponent(toolServiceActionMatch[1] ?? "");
    const action = toolServiceActionMatch[2] ?? "";
    try {
      const auditAction =
        action === "start"
          ? "tool_service.start"
          : action === "stop"
            ? "tool_service.stop"
            : action === "restart"
              ? "tool_service.restart"
              : "tool_service.heartbeat";
      const service =
        action === "start"
          ? await options.toolServiceSupervisor.start(toolName)
          : action === "stop"
            ? await options.toolServiceSupervisor.stop(toolName)
            : action === "restart"
              ? await options.toolServiceSupervisor.restart(toolName)
              : await options.toolServiceSupervisor.heartbeat(toolName);
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: auditAction,
        targetType: "tool",
        targetId: toolName,
        status: service.status === "failed" ? "failure" : "success",
        summary: `Tool service ${action}: ${toolName}`,
        metadata: {
          status: service.status,
          desiredState: service.desiredState,
          detail: service.detail,
        },
      });
      sendJson(response, 200, { service });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid tool service action";
      sendJson(response, message.includes("was not found") ? 404 : 400, { error: message });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tool-migrations") {
    const status = url.searchParams.get("status");
    sendJson(response, 200, {
      migrations: options.toolMigrationStore
        ? await options.toolMigrationStore.list({
            toolName: url.searchParams.get("toolName") ?? undefined,
            status: status ? validateToolMigrationStatus(status) : undefined,
          })
        : [],
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tool-migrations") {
    if (!options.toolMigrationStore) {
      sendJson(response, 503, { error: "Tool migration store is not configured" });
      return;
    }

    try {
      const migration = await options.toolMigrationStore.create(parseToolMigrationCreateInput(await readJsonBody<unknown>(request)));
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "tool-registrar",
        actorType: "agent",
        action: "tool_migration.recorded",
        targetType: "tool_migration",
        targetId: migration.id,
        status: migration.status === "failed" ? "failure" : migration.status === "pending" ? "pending" : "success",
        summary: `Tool migration ${migration.migrationId} recorded for ${migration.toolName}@${migration.toolVersion}`,
        metadata: {
          toolName: migration.toolName,
          toolVersion: migration.toolVersion,
          migrationId: migration.migrationId,
          status: migration.status,
        },
      });
      sendJson(response, 201, { migration });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid tool migration" });
    }
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
      const parsedRequestInput = parseToolBuildRequestInput(await readJsonBody<unknown>(request));
      const requestInput = await assignGeneratedToolName(
        await validateContextualToolBuildTarget(parsedRequestInput, options),
        options,
      );
      let sanitizedRequestInput = await attachInlineCredentialHandle(requestInput, options);
      const rootRun = sanitizedRequestInput.sourceRunId
        ? undefined
        : await createToolBuildRootRun(sanitizedRequestInput, options);
      sanitizedRequestInput = {
        ...sanitizedRequestInput,
        sourceRunId: sanitizedRequestInput.sourceRunId ?? rootRun?.id,
      };
      const buildRequest = await options.toolBuildRequestStore.create(sanitizedRequestInput);
      if (rootRun) {
        await completeToolBuildRootRun(rootRun.id, buildRequest, options);
      }
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
          displayName: buildRequest.displayName,
          desiredToolName: buildRequest.desiredToolName,
          credentialHandles: buildRequest.credentialHandles,
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
      const reworkRequestInput = await attachInlineCredentialHandle({
        capability: original.capability,
        displayName: original.displayName,
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
        credentialHandles: original.credentialHandles,
        credentialNotes: original.credentialNotes,
        reworkOf: original.id,
        feedback,
        replacesToolName: original.replacesToolName,
        replacesVersion: original.replacesVersion,
        startupMode: original.contract.startupMode,
      }, options);
      const reworkRequest = await options.toolBuildRequestStore.create(reworkRequestInput);

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

    const requestId = decodeURIComponent(toolBuildRunMatch[1] ?? "");
    const buildRequest = await options.toolBuildRequestStore?.get(requestId);
    if (buildRequest) {
      await ensureInlineCredentialSecret(buildRequest, options);
    }
    const result = await options.toolBuildWorkflow.runOnce(requestId);
    if (result.request.status === "registered") {
      await options.reloadGeneratedTools?.();
    }
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/secret-handles") {
    sendJson(response, 200, {
      secretHandles: options.secretHandleStore ? await options.secretHandleStore.list() : [],
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/secret-handles") {
    if (!options.secretHandleStore) {
      sendJson(response, 503, { error: "Secret handle store is not configured" });
      return;
    }

    try {
      const body = await readJsonBody<unknown>(request);
      rejectRawSecretPayload(body);
      const secretHandle = await options.secretHandleStore.create(parseSecretHandleInput(body));
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "secret_handle.created",
        targetType: "secret_handle",
        targetId: secretHandle.handle,
        status: "success",
        summary: `Secret handle created: ${secretHandle.handle}`,
        metadata: sanitizeAuditMetadata({
          provider: secretHandle.provider,
          secretRef: secretHandle.secretRef,
          scopes: secretHandle.scopes,
        }),
      });
      sendJson(response, 201, { secretHandle });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid secret handle request",
      });
    }
    return;
  }

  const secretHandleMatch = url.pathname.match(/^\/api\/secret-handles\/([^/]+)$/);
  if (request.method === "GET" && secretHandleMatch) {
    if (!options.secretHandleStore) {
      sendJson(response, 503, { error: "Secret handle store is not configured" });
      return;
    }

    const secretHandle = await options.secretHandleStore.get(decodeURIComponent(secretHandleMatch[1] ?? ""));
    if (!secretHandle) {
      sendJson(response, 404, { error: "Secret handle not found" });
      return;
    }
    sendJson(response, 200, { secretHandle });
    return;
  }

  if (request.method === "DELETE" && secretHandleMatch) {
    if (!options.secretHandleStore) {
      sendJson(response, 503, { error: "Secret handle store is not configured" });
      return;
    }

    const handle = decodeURIComponent(secretHandleMatch[1] ?? "");
    const existing = await options.secretHandleStore.get(handle);
    if (!existing) {
      sendJson(response, 404, { error: "Secret handle not found" });
      return;
    }

    await options.secretHandleStore.delete(handle);
    await recordAudit(options, {
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "secret_handle.deleted",
      targetType: "secret_handle",
      targetId: handle,
      status: "success",
      summary: `Secret handle deleted: ${handle}`,
      metadata: sanitizeAuditMetadata({
        provider: existing.provider,
        secretRef: existing.secretRef,
        scopes: existing.scopes,
      }),
    });
    sendJson(response, 200, { deleted: true, secretHandle: existing });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/settings/model-tiers") {
    sendJson(response, 200, {
      tiers: options.modelTierSettings ? await options.modelTierSettings.list() : [],
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/models/catalog") {
    const providers = options.modelProviderStore ? await options.modelProviderStore.list() : [];
    sendJson(response, 200, {
      chat: {
        baseUrl: process.env.LLM_BASE_URL ?? "http://127.0.0.1:1234/v1",
        defaultModel: process.env.LLM_MODEL ?? "google/gemma-4-26b-a4b",
        models: await listOpenAiCompatibleModels(process.env.LLM_BASE_URL ?? "http://127.0.0.1:1234/v1"),
      },
      embedding: {
        provider: process.env.EMBEDDING_PROVIDER === "deterministic" || !process.env.EMBEDDING_MODEL
          ? "deterministic"
          : "openai-compatible",
        baseUrl: process.env.EMBEDDING_BASE_URL ?? process.env.LLM_BASE_URL ?? "http://127.0.0.1:1234/v1",
        model: process.env.EMBEDDING_MODEL,
        dimensions: Number(process.env.MEMORY_EMBEDDING_DIMENSIONS ?? "128"),
        models: await listOpenAiCompatibleModels(
          process.env.EMBEDDING_BASE_URL ?? process.env.LLM_BASE_URL ?? "http://127.0.0.1:1234/v1",
        ),
      },
      providers,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/model-providers") {
    sendJson(response, 200, {
      providers: options.modelProviderStore ? await options.modelProviderStore.list() : [],
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/model-providers") {
    if (!options.modelProviderStore) {
      sendJson(response, 503, { error: "Model provider store is not configured" });
      return;
    }

    try {
      const provider = await options.modelProviderStore.create(
        parseModelProviderInput(await readJsonBody<unknown>(request)),
      );
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "model_provider.created",
        targetType: "model_provider",
        targetId: provider.id,
        status: "success",
        summary: `Model provider created: ${provider.label}`,
        metadata: sanitizeAuditMetadata({
          kind: provider.kind,
          providerType: provider.providerType,
          modelIds: provider.modelIds,
          apiKeySecretHandle: provider.apiKeySecretHandle,
        }),
      });
      sendJson(response, 201, { provider });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid model provider",
      });
    }
    return;
  }

  const modelProviderMatch = url.pathname.match(/^\/api\/model-providers\/([^/]+)$/);
  if (modelProviderMatch && request.method === "PATCH") {
    if (!options.modelProviderStore) {
      sendJson(response, 503, { error: "Model provider store is not configured" });
      return;
    }

    const id = decodeURIComponent(modelProviderMatch[1] ?? "");
    try {
      const provider = await options.modelProviderStore.update(
        id,
        parseModelProviderUpdate(await readJsonBody<unknown>(request)),
      );
      await recordAudit(options, {
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "model_provider.updated",
        targetType: "model_provider",
        targetId: provider.id,
        status: "success",
        summary: `Model provider updated: ${provider.label}`,
        metadata: sanitizeAuditMetadata({
          kind: provider.kind,
          status: provider.status,
          healthStatus: provider.healthStatus,
        }),
      });
      sendJson(response, 200, { provider });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid model provider update",
      });
    }
    return;
  }

  if (modelProviderMatch && request.method === "DELETE") {
    if (!options.modelProviderStore) {
      sendJson(response, 503, { error: "Model provider store is not configured" });
      return;
    }

    const id = decodeURIComponent(modelProviderMatch[1] ?? "");
    const deleted = await options.modelProviderStore.delete(id);
    if (!deleted) {
      sendJson(response, 404, { error: "Model provider not found" });
      return;
    }
    await recordAudit(options, {
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "model_provider.deleted",
      targetType: "model_provider",
      targetId: id,
      status: "success",
      summary: `Model provider deleted: ${id}`,
    });
    sendJson(response, 200, { deleted: true });
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
  try {
    sendJson(response, 202, await createAndStartRun(body, options));
  } catch (error) {
    sendJson(response, error instanceof RunContextError ? error.statusCode : 400, {
      error: error instanceof Error ? error.message : "Invalid run request",
    });
  }
}

async function createAndStartRun(
  body: Record<string, unknown>,
  options: WebAppOptions,
): Promise<{
  run: AgentRunRecord | undefined;
  thread?: ConversationThreadRecord;
  threadResolution?: { decision: string; reason: string; threadId?: string };
}> {
  const task = typeof body.task === "string" ? body.task.trim() : "";

  if (!task) {
    throw new RunContextError(400, "Task is required");
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
    if (error instanceof RunContextError) throw error;
    throw new RunContextError(400, error instanceof Error ? error.message : "Invalid run context");
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
    throw new RunContextError(400, error instanceof Error ? error.message : "Failed to save attachments");
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
  return {
    run: await options.runStore.get(run.id),
    thread,
    threadResolution: threadResolution
      ? {
          decision: threadResolution.decision,
          reason: threadResolution.reason,
          threadId: threadResolution.thread?.id,
        }
      : undefined,
  };
}

async function createToolBuildRootRun(
  input: ReturnType<typeof parseToolBuildRequestInput>,
  options: WebAppOptions,
): Promise<AgentRunRecord | undefined> {
  const task = [
    input.replacesToolName
      ? `Create a versioned tool change request for ${input.replacesToolName}`
      : `Create a tool build request for ${input.displayName ?? input.capability}`,
    `Capability: ${input.capability}`,
    `Startup mode: ${input.startupMode ?? "on-demand"}`,
    input.feedback ? `Operator feedback: ${input.feedback}` : undefined,
    input.reason ? `Request summary: ${input.reason}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  const run = await options.runStore.create(task, {
    instanceId: "instance-local",
    requesterUserId: "user-admin",
    channel: "web",
  });
  await options.runStore.markRunning(run.id);
  await options.runStore.appendEvent(run.id, createRunEvent({
    spanId: "tool-build-root",
    type: "run-started",
    actor: "tool-builder",
    activity: "coordination",
    status: "started",
    title: "Tool change root run",
    detail: `Queued a root operator run for ${input.displayName ?? input.capability}.`,
    payload: {
      capability: input.capability,
      displayName: input.displayName,
      desiredToolName: input.desiredToolName,
      replacesToolName: input.replacesToolName,
      replacesVersion: input.replacesVersion,
      startupMode: input.startupMode ?? "on-demand",
    },
  }));
  return options.runStore.get(run.id);
}

async function completeToolBuildRootRun(
  runId: string,
  buildRequest: Awaited<ReturnType<ToolBuildRequestStore["create"]>>,
  options: WebAppOptions,
): Promise<void> {
  await options.runStore.appendEvent(runId, createRunEvent({
    spanId: "tool-build-request",
    parentSpanId: "tool-build-root",
    type: "tool-build-requested",
    actor: "tool-builder",
    activity: "tool",
    status: "completed",
    title: "Tool Build request created",
    detail: `${buildRequest.displayName ?? buildRequest.capability} is waiting for Builder/QA/Registrar lifecycle.`,
    payload: {
      requestId: buildRequest.id,
      capability: buildRequest.capability,
      desiredToolName: buildRequest.desiredToolName,
      replacesToolName: buildRequest.replacesToolName,
      replacesVersion: buildRequest.replacesVersion,
      startupMode: buildRequest.contract.startupMode,
      modulePath: buildRequest.contract.modulePath,
      testPath: buildRequest.contract.testPath,
    },
  }));
  await options.runStore.complete(runId, {
    finalAnswer: `Tool Build request ${buildRequest.id} was created for ${buildRequest.displayName ?? buildRequest.capability}. The Builder/QA/Registrar lifecycle will continue from the Tool Builds queue.`,
    complexity: {
      mode: "direct",
      reason: "Operator tool build/change requests are root runs that hand off to the Tool Builder lifecycle.",
      domains: ["tool-builder"],
      riskLevel: buildRequest.contract.startupMode === "always-on" ? "medium" : "low",
    },
    subtasks: [],
    workerResults: [],
    reviews: [],
  });
}

function createRunEvent(input: Omit<AgentEvent, "id" | "timestamp">): AgentEvent {
  return {
    ...input,
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
  };
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
  const sourceUserAliases = parseOptionalTextArray(body.sourceUserAliases);
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
        sourceUserAliases,
        fallbackUserId: thread.requesterUserId,
      });
      if (!requesterUser) {
        throw createRequesterResolutionError({
          requesterUserId: bodyRequesterUserId,
          channel,
          sourceUserId,
          sourceUserAliases,
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
        sourceUserAliases,
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
      sourceUserAliases,
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
    sourceUserId,
    sourceMessageId,
    sourceChatId,
    sourceThreadId,
  };

  return {
    context,
    thread,
    threadResolution,
    threadContext: thread ? await buildConversationThreadContext(thread, options) : undefined,
  };
}

async function buildConversationThreadContext(
  thread: ConversationThreadRecord,
  options: Pick<WebAppOptions, "runStore">,
): Promise<ConversationThreadContext> {
  const artifacts = await collectThreadArtifacts(thread, options.runStore);
  return {
    summary: thread.summary,
    acceptedFacts: thread.acceptedFacts,
    rejectedAttempts: thread.rejectedAttempts,
    openQuestions: thread.openQuestions,
    relevantArtifactIds: thread.artifactIds,
    relevantArtifacts: artifacts,
  };
}

async function collectThreadArtifacts(
  thread: ConversationThreadRecord,
  runStore: RunStore,
): Promise<AgentArtifact[]> {
  if (thread.artifactIds.length === 0) return [];

  const wantedIds = new Set(thread.artifactIds);
  const runs = (await runStore.list())
    .filter((run) => run.threadId === thread.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const artifacts: AgentArtifact[] = [];
  const seen = new Set<string>();

  for (const run of runs) {
    for (const artifact of run.result?.artifacts ?? []) {
      if (!wantedIds.has(artifact.id) || seen.has(artifact.id)) continue;
      artifacts.push(artifact);
      seen.add(artifact.id);
      if (artifacts.length >= 12) return artifacts;
    }
  }

  return artifacts;
}

async function resolveRequesterUser(
  options: WebAppOptions,
  input: {
    requesterUserId?: string;
    channel?: string;
    sourceUserId?: string;
    sourceUserAliases?: string[];
    fallbackUserId?: string;
  },
): Promise<UserRecord | undefined> {
  return getUserStore(options).resolve({
    requesterUserId: input.requesterUserId,
    channel: input.channel,
    sourceUserId: input.sourceUserId,
    sourceUserAliases: input.sourceUserAliases,
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
  sourceUserAliases?: string[];
}): RunContextError {
  if (input.requesterUserId) {
    return new RunContextError(400, `Requester user not found: ${input.requesterUserId}`);
  }

  if (input.sourceUserId) {
    const aliases = input.sourceUserAliases?.length ? ` aliases=${input.sourceUserAliases.join(",")}` : "";
    return new RunContextError(
      403,
      `Channel identity is not allowed or not mapped: ${input.channel ?? "unknown"}/${input.sourceUserId}${aliases}`,
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

async function streamToolServiceLogs(
  request: IncomingMessage,
  response: ServerResponse,
  options: WebAppOptions,
  toolName?: string,
): Promise<void> {
  if (!options.toolServiceSupervisor) {
    sendJson(response, 503, { error: "Tool service supervisor is not configured" });
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  let closed = false;
  const heartbeatTimer = setInterval(() => {
    if (!closed) response.write(": heartbeat\n\n");
  }, 15000);
  const unsubscribe = options.toolServiceSupervisor.onLog((log) => {
    if (closed || (toolName && log.toolName !== toolName)) return;
    response.write(`event: service-log\ndata: ${JSON.stringify({ log })}\n\n`);
  });

  const close = () => {
    closed = true;
    clearInterval(heartbeatTimer);
    unsubscribe();
  };

  request.on("close", close);
  response.write(": connected\n\n");
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
      toolExecutionContext: {
        resolveSecret: options.secretHandleStore?.resolve
          ? (handle) => options.secretHandleStore!.resolve!(handle)
          : undefined,
        resolveConfiguration: async (key) => process.env[key],
        audit: async (event) => {
          await recordAudit(options, {
            instanceId: run?.instanceId,
            actorId: "tool-runtime",
            actorType: "tool",
            action: event.action as AuditEventInput["action"],
            targetType: event.targetType,
            targetId: event.targetId,
            status: event.status,
            runId: id,
            threadId: run?.threadId,
            requesterUserId: run?.requesterUserId,
            channel: run?.channel,
            summary: event.summary,
            metadata: event.metadata,
          });
        },
        logger: {
          info(message, metadata) {
            console.info(`[tool:${id}] ${message}`, metadata ?? "");
          },
          warn(message, metadata) {
            console.warn(`[tool:${id}] ${message}`, metadata ?? "");
          },
          error(message, metadata) {
            console.error(`[tool:${id}] ${message}`, metadata ?? "");
          },
        },
      },
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
    await recordToolServiceOutbound(options, run, {
      runId: id,
      status: "completed",
      summary: `Final answer ready for delivery: ${result.finalAnswer.slice(0, 160)}`,
      payload: {
        finalAnswer: result.finalAnswer,
        artifacts: (result.artifacts ?? []).map((artifact) => ({
          id: artifact.id,
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          url: artifact.url,
        })),
      },
    });
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
    await recordToolServiceOutbound(options, run, {
      runId: id,
      status: "failed",
      summary: `Run failed; error ready for delivery: ${message.slice(0, 160)}`,
      payload: { error: message },
    });
  }
}

async function recordToolServiceOutbound(
  options: WebAppOptions,
  run: AgentRunRecord | undefined,
  delivery: {
    runId: string;
    status: "completed" | "failed";
    summary: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  if (!run?.channel || !options.toolServiceSupervisor || !options.toolServiceEventStore) return;
  if (!run.sourceChatId && !run.sourceUserId) return;
  const service = (await options.toolServiceSupervisor.list()).find((candidate) => candidate.toolName === run.channel);
  if (!service) return;

  const event = await options.toolServiceEventStore.record({
    toolName: run.channel,
    direction: "outbound",
    status: "queued",
    summary: delivery.summary,
    sourceUserId: run.sourceUserId,
    sourceChatId: run.sourceChatId,
    sourceMessageId: run.sourceMessageId,
    threadId: run.threadId,
    runId: delivery.runId,
    payload: {
      ...delivery.payload,
      runStatus: delivery.status,
      requesterUserId: run.requesterUserId,
    },
  });

  await recordAudit(options, {
    instanceId: run.instanceId,
    actorId: run.channel,
    actorType: "tool",
    action: "tool_service.event_recorded",
    targetType: "tool",
    targetId: run.channel,
    status: delivery.status === "completed" ? "pending" : "failure",
    runId: delivery.runId,
    threadId: run.threadId,
    requesterUserId: run.requesterUserId,
    channel: run.channel,
    summary: `Outbound event queued for ${run.channel}: ${delivery.summary.slice(0, 160)}`,
    metadata: {
      serviceEventId: event.id,
      runStatus: delivery.status,
    },
  });
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

async function listOpenAiCompatibleModels(baseUrl: string): Promise<Array<{ id: string; ownedBy?: string }>> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { data?: Array<{ id?: unknown; owned_by?: unknown }> };
    return (payload.data ?? [])
      .map((item) => ({
        id: typeof item.id === "string" ? item.id : "",
        ownedBy: typeof item.owned_by === "string" ? item.owned_by : undefined,
      }))
      .filter((item) => item.id);
  } catch {
    return [];
  }
}

function sanitizeAuditMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return sanitizeObject(value as Record<string, unknown>);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeObject(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes("secret") ||
      lowerKey.includes("token") ||
      lowerKey.includes("password") ||
      lowerKey.includes("apikey") ||
      lowerKey.includes("api_key") ||
      lowerKey.includes("credential")
    ) {
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

function parseOptionalTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(parseOptionalText).filter((item): item is string => Boolean(item)))];
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

function parseUserCreateInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("user create request must be an object");
  }
  const candidate = value as Record<string, unknown>;
  return {
    id: parseOptionalText(candidate.id),
    displayName: parseRequiredText(candidate.displayName, "displayName"),
    role: parseOptionalText(candidate.role),
    roles: parseOptionalStringArray(candidate.roles, "roles"),
  };
}

function parseUserUpdateInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("user update request must be an object");
  }
  const candidate = value as Record<string, unknown>;
  return {
    displayName: parseOptionalText(candidate.displayName),
    role: parseOptionalText(candidate.role),
    roles: parseOptionalStringArray(candidate.roles, "roles"),
  };
}

function parseChannelIdentityCreateInput(value: unknown, userId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("channel identity create request must be an object");
  }
  const candidate = value as Record<string, unknown>;
  return {
    id: parseOptionalText(candidate.id),
    userId,
    provider: parseRequiredText(candidate.provider, "provider"),
    providerUserId: parseRequiredText(candidate.providerUserId, "providerUserId"),
    allowStatus: parseOptionalChannelIdentityStatus(candidate.allowStatus),
    displayMetadata: candidate.displayMetadata === undefined ? undefined : parseOptionalPreferences(candidate.displayMetadata),
    lastSeenAt: parseOptionalText(candidate.lastSeenAt),
  };
}

function parseChannelIdentityUpdateInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("channel identity update request must be an object");
  }
  const candidate = value as Record<string, unknown>;
  return {
    allowStatus: parseOptionalChannelIdentityStatus(candidate.allowStatus),
    displayMetadata: candidate.displayMetadata === undefined ? undefined : parseOptionalPreferences(candidate.displayMetadata),
    lastSeenAt:
      candidate.lastSeenAt === null ? null : parseOptionalText(candidate.lastSeenAt),
  };
}

function parseOptionalChannelIdentityStatus(value: unknown): ChannelIdentityStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "allowed" || value === "blocked") return value;
  throw new Error("allowStatus must be allowed or blocked");
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

function parseToolServiceEventInput(value: unknown): ToolServiceEventInput {
  if (!isRecord(value)) throw new Error("tool service event must be an object");
  return {
    toolName: parseRequiredText(value.toolName, "toolName"),
    direction: parseToolServiceEventDirection(value.direction),
    status: parseToolServiceEventStatus(value.status),
    summary: parseRequiredText(value.summary, "summary"),
    sourceUserId: parseOptionalText(value.sourceUserId),
    sourceChatId: parseOptionalText(value.sourceChatId),
    sourceMessageId: parseOptionalText(value.sourceMessageId),
    threadId: parseOptionalText(value.threadId),
    runId: parseOptionalText(value.runId),
    payload: isRecord(value.payload) ? sanitizeObject(value.payload) : undefined,
  };
}

async function listPendingToolServiceOutbox(
  options: WebAppOptions,
  toolName: string,
  limit: number,
): Promise<ToolServiceEventRecord[]> {
  if (!options.toolServiceEventStore) return [];
  const events = await options.toolServiceEventStore.list({ toolName, direction: "outbound", limit: 200 });
  const completedSourceIds = new Set(
    events
      .filter((event) => event.status === "sent" || event.status === "failed")
      .map((event) => parseOptionalText(event.payload?.sourceEventId))
      .filter((id): id is string => Boolean(id)),
  );

  return events
    .filter((event) => event.status === "queued")
    .filter((event) => !completedSourceIds.has(event.id))
    .slice(0, limit);
}

async function findToolServiceEvent(
  options: WebAppOptions,
  toolName: string,
  eventId: string,
): Promise<ToolServiceEventRecord | undefined> {
  if (!options.toolServiceEventStore) return undefined;
  const events = await options.toolServiceEventStore.list({ toolName, limit: 200 });
  return events.find((event) => event.id === eventId);
}

function parseLimit(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(200, parsed));
}

function parseToolServiceOutboxAckInput(value: unknown): {
  status: "sent" | "failed";
  summary?: string;
  providerMessageId?: string;
  detail?: string;
  payload?: Record<string, unknown>;
} {
  if (!isRecord(value)) throw new Error("outbox ack input must be an object");
  if (value.status !== "sent" && value.status !== "failed") {
    throw new Error("status must be sent or failed");
  }
  return {
    status: value.status,
    summary: parseOptionalText(value.summary),
    providerMessageId: parseOptionalText(value.providerMessageId),
    detail: parseOptionalText(value.detail),
    payload: isRecord(value.payload) ? sanitizeObject(value.payload) : undefined,
  };
}

function parseToolServiceInboundInput(value: unknown, toolName: string) {
  if (!isRecord(value)) throw new Error("inbound service event must be an object");
  const task = parseOptionalText(value.task) ?? parseOptionalText(value.text) ?? parseOptionalText(value.message);
  if (!task) throw new Error("task, text, or message is required");
  return {
    originalBody: sanitizeObject(value),
    task,
    channel: parseOptionalText(value.channel) ?? toolName,
    sourceUserId: parseOptionalText(value.sourceUserId),
    sourceUserAliases: parseOptionalTextArray(value.sourceUserAliases),
    sourceChatId: parseOptionalText(value.sourceChatId),
    threadId: parseOptionalText(value.threadId),
    sourceThreadId: parseOptionalText(value.sourceThreadId),
    sourceMessageId: parseOptionalText(value.sourceMessageId),
  };
}

function parseLooseToolServiceInboundInput(value: Record<string, unknown>, toolName: string) {
  return {
    channel: parseOptionalText(value.channel) ?? toolName,
    sourceUserId: parseOptionalText(value.sourceUserId),
    sourceUserAliases: parseOptionalTextArray(value.sourceUserAliases),
    sourceChatId: parseOptionalText(value.sourceChatId),
    threadId: parseOptionalText(value.threadId),
    sourceThreadId: parseOptionalText(value.sourceThreadId),
    sourceMessageId: parseOptionalText(value.sourceMessageId),
  };
}

function parseOptionalToolServiceEventDirection(value: unknown): ToolServiceEventDirection | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return parseToolServiceEventDirection(value);
}

function parseToolServiceEventDirection(value: unknown): ToolServiceEventDirection {
  if (value === "inbound" || value === "outbound" || value === "system") return value;
  throw new Error("direction must be inbound, outbound, or system");
}

function parseToolServiceEventStatus(value: unknown): ToolServiceEventStatus {
  if (
    value === "received" ||
    value === "queued" ||
    value === "sent" ||
    value === "failed" ||
    value === "ignored"
  ) {
    return value;
  }
  throw new Error("status must be received, queued, sent, failed, or ignored");
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
  if (typeof candidate.reason !== "string" || candidate.reason.trim() === "") {
    throw new Error("reason is required");
  }
  const displayName = parseOptionalText(candidate.displayName);
  const reason = candidate.reason.trim();
  const capability = parseOptionalText(candidate.capability) ?? inferToolBuildCapability(displayName, reason);

  return {
    capability,
    displayName,
    reason,
    sourceRunId: typeof candidate.sourceRunId === "string" ? candidate.sourceRunId : undefined,
    sourceSpanId: typeof candidate.sourceSpanId === "string" ? candidate.sourceSpanId : undefined,
    taskSummary: typeof candidate.taskSummary === "string" ? candidate.taskSummary : undefined,
    desiredToolName: typeof candidate.desiredToolName === "string" ? candidate.desiredToolName : undefined,
    requiredInputs: parseOptionalStringArray(candidate.requiredInputs, "requiredInputs"),
    requiredOutputs: parseOptionalStringArray(candidate.requiredOutputs, "requiredOutputs"),
    qaCriteria: parseOptionalStringArray(candidate.qaCriteria, "qaCriteria"),
    credentialHandles: parseOptionalStringArray(candidate.credentialHandles, "credentialHandles"),
    credentialNotes: parseOptionalText(candidate.credentialNotes),
    reworkOf: typeof candidate.reworkOf === "string" ? candidate.reworkOf : undefined,
    feedback: typeof candidate.feedback === "string" ? candidate.feedback : undefined,
    replacesToolName: typeof candidate.replacesToolName === "string" ? candidate.replacesToolName : undefined,
    replacesVersion: typeof candidate.replacesVersion === "string" ? candidate.replacesVersion : undefined,
    startupMode: parseStartupMode(candidate.startupMode),
  };
}

function inferToolBuildCapability(displayName: string | undefined, reason: string): string {
  const text = `${displayName ?? ""} ${reason}`.toLowerCase();
  const source = displayName ?? reason;
  const slug = slugifyCapabilityPart(source);
  if (/\b(browser|screenshot|screen capture|скрин|скриншот)\b/.test(text)) return "browser-screenshot";
  if (/\b(api|http|https|endpoint|openapi|swagger|webhook|bot|token|key|ключ)\b/.test(text)) {
    return `api.${slug}`;
  }
  return `tool.${slug}`;
}

async function attachInlineCredentialHandle<TInput extends ReturnType<typeof parseToolBuildRequestInput>>(
  input: TInput,
  options: WebAppOptions,
): Promise<TInput> {
  if (!input.credentialNotes?.trim() || input.credentialHandles?.length || !options.secretHandleStore) return input;

  const handle = await ensureInlineCredentialSecret(input, options);
  return {
    ...input,
    credentialHandles: handle ? [handle] : input.credentialHandles,
    credentialNotes: handle
      ? `Credential material was stored in ${handle}; raw operator notes were redacted before queueing.`
      : input.credentialNotes,
  };
}

async function ensureInlineCredentialSecret(
  input: {
    capability: string;
    displayName?: string;
    credentialNotes?: string;
    credentialHandles?: string[];
  },
  options: WebAppOptions,
): Promise<string | undefined> {
  if (!input.credentialNotes?.trim() || input.credentialHandles?.length || !options.secretHandleStore) return undefined;

  const handle = secretHandleFromCapability(input.capability);
  const secretRef = extractInlineCredentialSecret(input.credentialNotes);
  if (!secretRef) return undefined;

  await options.secretHandleStore.create({
    handle,
    label: `${input.displayName ?? input.capability} credentials`,
    provider: "inline",
    secretRef,
    scopes: ["instance-local", `tool:${input.capability}`],
  });
  return handle;
}

function extractInlineCredentialSecret(notes: string | undefined): string | undefined {
  const value = notes?.trim();
  if (!value) return undefined;

  const labelledPatterns = [
    /\b(?:x-api-key|api[_\s-]*key|apikey|access[_\s-]*key|token|bearer|secret|ключ)\b\s*[:=]?\s*["'`]?([A-Za-z0-9][A-Za-z0-9._~+/=-]{3,})["'`]?/i,
    /\b(?:key)\b\s*[:=]\s*["'`]?([A-Za-z0-9][A-Za-z0-9._~+/=-]{3,})["'`]?/i,
  ];

  for (const pattern of labelledPatterns) {
    const match = value.match(pattern);
    const candidate = sanitizeCredentialCandidate(match?.[1]);
    if (candidate && looksLikeCredential(candidate)) return candidate;
  }

  const standalone = value.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,}){2,}\b/);
  const standaloneCandidate = sanitizeCredentialCandidate(standalone?.[0]);
  if (standaloneCandidate && looksLikeCredential(standaloneCandidate)) return standaloneCandidate;

  const compact = value.match(/\b[A-Za-z0-9._~+/=]{16,}\b/);
  const compactCandidate = sanitizeCredentialCandidate(compact?.[0]);
  if (compactCandidate && looksLikeCredential(compactCandidate)) return compactCandidate;

  return undefined;
}

function sanitizeCredentialCandidate(value: string | undefined): string | undefined {
  return value
    ?.trim()
    .replace(/^[`'"(<[{]+|[`'")>\]},.;:]+$/g, "");
}

function looksLikeCredential(value: string): boolean {
  if (value.length < 5) return false;
  if (/^(should|used|use|with|as|bearer|token|secret|key|ключ)$/i.test(value)) return false;
  if (/^\d{5,}$/.test(value)) return true;
  if (/[A-Z]/.test(value) && /\d/.test(value)) return true;
  if (/[-._~+/=]/.test(value) && /\d/.test(value)) return true;
  return value.length >= 24 && /[A-Za-z]/.test(value) && /\d/.test(value);
}

function secretHandleFromCapability(capability: string): string {
  const slug = capability
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, ".")
    .replace(/^[^a-z]+/, "")
    .replace(/[.:-]+$/g, "")
    .slice(0, 96) || "generated.tool";
  return `secret.${slug}`;
}

function slugifyCapabilityPart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9а-яё]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .filter(Boolean)
      .slice(0, 8)
      .join("-")
      .replace(/[^a-z0-9-]+/g, "")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "tool"
  );
}

async function assignGeneratedToolName(
  input: ReturnType<typeof parseToolBuildRequestInput>,
  options: WebAppOptions,
): Promise<ReturnType<typeof parseToolBuildRequestInput>> {
  if (input.desiredToolName?.trim()) return input;

  const baseName = generatedToolNameFromCapability(input.capability);
  const usedNames = new Set<string>();
  for (const tool of (await options.toolMetadataStore?.list()) ?? []) {
    usedNames.add(tool.name);
  }
  for (const request of (await options.toolBuildRequestStore?.list(500)) ?? []) {
    if (request.contract?.toolName) usedNames.add(request.contract.toolName);
    if (request.desiredToolName) usedNames.add(request.desiredToolName);
  }

  let candidate = baseName;
  for (let index = 2; usedNames.has(candidate); index += 1) {
    candidate = `${baseName}.${index}`;
  }
  return {
    ...input,
    desiredToolName: candidate,
  };
}

async function validateContextualToolBuildTarget(
  input: ReturnType<typeof parseToolBuildRequestInput>,
  options: WebAppOptions,
): Promise<ReturnType<typeof parseToolBuildRequestInput>> {
  if (!input.replacesToolName || !options.toolMetadataStore) return input;

  const tools = await options.toolMetadataStore.list();
  const current = tools.find((tool) => tool.name === input.replacesToolName);
  const text = [
    input.reason,
    input.feedback,
    input.taskSummary,
  ].join(" ");
  const currentScore = current ? scoreToolTargetMatch(current, text) : 0;
  const best = tools
    .map((tool) => ({ tool, score: scoreToolTargetMatch(tool, text) }))
    .filter((item) => item.tool.name !== input.replacesToolName)
    .sort((a, b) => b.score - a.score)[0];

  const clearlyWrongSelectedTool = best && best.score >= 4 && currentScore <= 1 && best.score >= currentScore + 4;
  if (clearlyWrongSelectedTool) {
    throw new Error(
      `Selected tool ${input.replacesToolName} does not appear to match this request. ` +
        `The text looks closer to ${best.tool.name}. No tool build request was created; ` +
        `open the matching tool/span or rewrite the feedback for ${input.replacesToolName}.`,
    );
  }

  return input;
}

function scoreToolTargetMatch(
  tool: {
    name: string;
    displayName?: string;
    description?: string;
    capabilities?: string[];
    source?: string;
  },
  text: string,
): number {
  const haystack = normalizeTargetText(text);
  if (!haystack) return 0;
  const aliases = [
    tool.name,
    tool.displayName,
    tool.description,
    ...(tool.capabilities ?? []),
  ].flatMap((value) => targetTokens(value));
  const uniqueAliases = [...new Set(aliases)];
  return uniqueAliases.reduce((score, token) => score + (haystack.includes(token) ? weightTargetToken(token) : 0), 0);
}

function targetTokens(value: string | undefined): string[] {
  const normalized = normalizeTargetText(value ?? "");
  if (!normalized) return [];
  return normalized
    .split(" ")
    .filter((token) => token.length >= 4 && !genericToolTargetTokens.has(token));
}

function normalizeTargetText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9а-яё@._-]+/gi, " ")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function weightTargetToken(token: string): number {
  if (token === "telegram" || token === "whatsapp" || token === "slack") return 4;
  if (token === "browser" || token === "screenshot") return 3;
  if (token === "always" || token === "service") return 2;
  return 1;
}

const genericToolTargetTokens = new Set([
  "tool",
  "generated",
  "service",
  "adapter",
  "capability",
  "http",
  "json",
  "api",
  "with",
  "from",
  "this",
  "that",
  "request",
  "change",
  "version",
]);

function generatedToolNameFromCapability(capability: string): string {
  const slug = capability
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "tool";
  return `generated.${slug.replace(/-/g, ".")}`;
}

function parseToolMigrationCreateInput(value: unknown): ToolMigrationCreateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tool migration request must be an object");
  }

  const candidate = value as Record<string, unknown>;
  return {
    toolName: parseRequiredText(candidate.toolName, "toolName"),
    toolVersion: parseRequiredText(candidate.toolVersion, "toolVersion"),
    migrationId: parseRequiredText(candidate.migrationId, "migrationId"),
    checksum: parseRequiredText(candidate.checksum, "checksum"),
    status: candidate.status === undefined ? undefined : validateToolMigrationStatus(String(candidate.status)),
    appliedAt: parseOptionalDate(candidate.appliedAt, "appliedAt"),
    appliedByActor: parseOptionalText(candidate.appliedByActor),
    qaReport: isRecord(candidate.qaReport) ? sanitizeObject(candidate.qaReport) : undefined,
    rollbackNotes: parseOptionalText(candidate.rollbackNotes),
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

function parseOptionalDate(value: unknown, name: string): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be an ISO date string`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be an ISO date string`);
  }
  return parsed;
}

function parseSecretHandleInput(value: unknown): SecretHandleInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("secret handle request must be an object");
  }

  const candidate = value as Record<string, unknown>;
  return {
    handle: parseOptionalText(candidate.handle),
    label: parseRequiredText(candidate.label, "label"),
    provider: parseRequiredText(candidate.provider, "provider") as SecretHandleInput["provider"],
    secretRef: parseRequiredText(candidate.secretRef, "secretRef"),
    scopes: parseOptionalStringArray(candidate.scopes, "scopes"),
  };
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

function parseOptionalQaReport(value: unknown): ToolBuildQaReport | undefined {
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
    reviews: parseOptionalToolBuildReviews(candidate.reviews),
  };
}

function parseOptionalToolBuildReviews(value: unknown): ToolBuildReviewReport[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("qaReport.reviews must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`qaReport.reviews[${index}] must be an object`);
    }
    const candidate = item as Record<string, unknown>;
    const kind = candidate.kind;
    if (kind !== "code" && kind !== "behavior") {
      throw new Error(`qaReport.reviews[${index}].kind is invalid`);
    }
    const decision = candidate.decision;
    if (decision !== "pass" && decision !== "needs_revision" && decision !== "fail") {
      throw new Error(`qaReport.reviews[${index}].decision is invalid`);
    }
    if (typeof candidate.summary !== "string" || candidate.summary.trim() === "") {
      throw new Error(`qaReport.reviews[${index}].summary is required`);
    }
    return {
      kind,
      decision,
      summary: candidate.summary.trim(),
      findings: parseRequiredStringArray(candidate.findings, `qaReport.reviews[${index}].findings`),
    } satisfies ToolBuildReviewReport;
  });
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
    displayName: parseOptionalText(candidate.displayName),
    version,
    description,
    capabilities: parseRequiredStringArray(candidate.capabilities, "capabilities"),
    startupMode: parseStartupMode(candidate.startupMode),
    inputSchema: parseOptionalToolSchema(candidate.inputSchema, "inputSchema"),
    outputSchema: parseOptionalToolSchema(candidate.outputSchema, "outputSchema"),
    modulePath: parseRequiredPath(candidate.modulePath, "modulePath"),
    testPath: parseOptionalPath(candidate.testPath, "testPath"),
    requiredConfigurationKeys: parseOptionalStringArray(candidate.requiredConfigurationKeys, "requiredConfigurationKeys"),
    requiredSecretHandles: parseOptionalStringArray(candidate.requiredSecretHandles, "requiredSecretHandles"),
    settingsSchema: parseOptionalToolSchema(candidate.settingsSchema, "settingsSchema"),
    storage: parseOptionalStorageContract(candidate.storage),
    docsMarkdown: parseOptionalText(candidate.docsMarkdown),
    changeSummary: parseOptionalText(candidate.changeSummary),
    examples: parseOptionalToolExamples(candidate.examples),
    packageManifest:
      candidate.packageManifest === undefined
        ? undefined
        : normalizeToolPackageManifest(candidate.packageManifest),
  };
}

function parseToolPackageManifestImport(value: unknown) {
  const body =
    value && typeof value === "object" && !Array.isArray(value) && "manifest" in value
      ? (value as Record<string, unknown>).manifest
      : value;
  const manifest = normalizeToolPackageManifest(body);
  return generatedToolInputFromPackageManifest(manifest);
}

function parseOptionalStorageContract(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("storage must be an object");
  }
  const candidate = value as Record<string, unknown>;
  return {
    schema: parseOptionalText(candidate.schema),
    tables: parseOptionalStringArray(candidate.tables, "storage.tables"),
    migrations: parseOptionalStringArray(candidate.migrations, "storage.migrations"),
    retention: parseOptionalText(candidate.retention),
    permissions: parseOptionalStringArray(candidate.permissions, "storage.permissions"),
    destructiveCapabilities: parseOptionalStringArray(
      candidate.destructiveCapabilities,
      "storage.destructiveCapabilities",
    ),
  };
}

function parseOptionalToolExamples(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("examples must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`examples[${index}] must be an object`);
    }
    const candidate = item as Record<string, unknown>;
    return {
      title: parseRequiredText(candidate.title, `examples[${index}].title`),
      input: sanitizeObject(isRecord(candidate.input) ? candidate.input : {}),
      output: candidate.output,
    };
  });
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

function parseModelProviderInput(item: unknown): ModelProviderInput {
  if (!item || typeof item !== "object") {
    throw new Error("Invalid model provider");
  }
  const candidate = item as Record<string, unknown>;
  return {
    id: optionalString(candidate.id),
    label: requiredString(candidate.label, "label"),
    kind: parseModelProviderKind(candidate.kind),
    providerType: parseModelProviderType(candidate.providerType),
    baseUrl: optionalString(candidate.baseUrl),
    modelIds: parseStringList(candidate.modelIds),
    defaultModel: optionalString(candidate.defaultModel),
    apiKeySecretHandle: optionalString(candidate.apiKeySecretHandle),
    dimensions: parseOptionalNumber(candidate.dimensions),
    status: parseOptionalModelProviderStatus(candidate.status),
    healthStatus: parseOptionalModelProviderHealthStatus(candidate.healthStatus),
    healthDetail: optionalString(candidate.healthDetail),
  };
}

function parseModelProviderUpdate(item: unknown): ModelProviderUpdateInput {
  if (!item || typeof item !== "object") {
    throw new Error("Invalid model provider update");
  }
  const candidate = item as Record<string, unknown>;
  return {
    label: optionalString(candidate.label),
    kind: candidate.kind === undefined ? undefined : parseModelProviderKind(candidate.kind),
    providerType:
      candidate.providerType === undefined ? undefined : parseModelProviderType(candidate.providerType),
    baseUrl: optionalString(candidate.baseUrl),
    modelIds: candidate.modelIds === undefined ? undefined : parseStringList(candidate.modelIds),
    defaultModel: optionalString(candidate.defaultModel),
    apiKeySecretHandle: optionalString(candidate.apiKeySecretHandle),
    dimensions: parseOptionalNumber(candidate.dimensions),
    status: parseOptionalModelProviderStatus(candidate.status),
    healthStatus: parseOptionalModelProviderHealthStatus(candidate.healthStatus),
    healthDetail: optionalString(candidate.healthDetail),
  };
}

function parseModelProviderKind(value: unknown): "chat" | "embedding" {
  if (value === "chat" || value === "embedding") return value;
  throw new Error("Invalid model provider kind");
}

function parseModelProviderType(value: unknown): ModelProviderInput["providerType"] {
  if (
    value === "local" ||
    value === "remote" ||
    value === "openai-compatible" ||
    value === "deterministic"
  ) {
    return value;
  }
  throw new Error("Invalid model provider type");
}

function parseOptionalModelProviderStatus(value: unknown): ModelProviderInput["status"] {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "available" || value === "disabled" || value === "failed") return value;
  throw new Error("Invalid model provider status");
}

function parseOptionalModelProviderHealthStatus(value: unknown): ModelProviderInput["healthStatus"] {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "unknown" || value === "ok" || value === "failed") return value;
  throw new Error("Invalid model provider health status");
}

function requiredString(value: unknown, field: string): string {
  const text = optionalString(value);
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseStringList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
  }
  throw new Error("modelIds must be an array or comma-separated string");
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
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
