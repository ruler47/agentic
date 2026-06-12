import type { AgentArtifact, ArtifactUploadInput } from "../../../types.js";
import type { ConversationThreadContext, ConversationThreadRecord, ConversationThreadStore } from "../../../conversations/types.js";
import { resolveConversationThread, type ThreadResolutionResult } from "../../../conversations/threadResolution.js";
import type { UserRecord, UserStore } from "../../../instance/userStore.js";
import type { AgentRunRecord, RunCreateContext, RunStore } from "../../../runs/types.js";
import { parseOptionalText, parseOptionalTextArray } from "../../common/parsers.js";

export class RunContextError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class RunContextResolver {
  constructor(
    private readonly runs: RunStore,
    private readonly threads: ConversationThreadStore | undefined,
    private readonly users: UserStore,
  ) {}

  async resolveContext(
    body: Record<string, unknown>,
    task: string,
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

    if (this.threads) {
      if (requestedThreadId) {
        thread = await this.threads.get(requestedThreadId);
        if (!thread)
          throw new RunContextError(404, "Conversation thread not found");
        const channel = bodyChannel ?? thread.channel;
        requesterUser = await this.users.resolve({
          requesterUserId: bodyRequesterUserId,
          channel,
          sourceUserId,
          sourceUserAliases,
          fallbackUserId: thread.requesterUserId,
        });
        if (!requesterUser) {
          throw this.requesterError({
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
          reason:
            "The request explicitly selected an existing conversation thread.",
        };
      } else {
        const channel = bodyChannel ?? "web";
        requesterUser = await this.users.resolve({
          requesterUserId: bodyRequesterUserId,
          channel,
          sourceUserId,
          sourceUserAliases,
        });
        if (!requesterUser) {
          throw this.requesterError({
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
          threads: await this.threads.list(),
        });
        thread =
          threadResolution.thread ??
          (await this.threads.create({
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
      (await this.users.resolve({
        requesterUserId: bodyRequesterUserId,
        channel: bodyChannel ?? thread?.channel ?? "web",
        sourceUserId,
        sourceUserAliases,
        fallbackUserId: thread?.requesterUserId,
      }));
    if (!requesterUser) {
      throw this.requesterError({
        requesterUserId: bodyRequesterUserId,
        channel: bodyChannel ?? thread?.channel ?? "web",
        sourceUserId,
      });
    }

    const requesterUserId = requesterUser.id;
    const channel = bodyChannel ?? thread?.channel ?? "web";

    const context: RunCreateContext = {
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
      threadContext: thread ? await this.buildThreadContext(thread) : undefined,
    };
  }

  private async buildThreadContext(
    thread: ConversationThreadRecord,
  ): Promise<ConversationThreadContext> {
    const artifacts = await this.collectThreadArtifacts(thread);
    return {
      summary: thread.summary,
      acceptedFacts: thread.acceptedFacts,
      rejectedAttempts: thread.rejectedAttempts,
      openQuestions: thread.openQuestions,
      relevantArtifactIds: thread.artifactIds,
      relevantArtifacts: artifacts,
    };
  }

  private async collectThreadArtifacts(
    thread: ConversationThreadRecord,
  ): Promise<AgentArtifact[]> {
    if (thread.artifactIds.length === 0) return [];
    const wantedIds = new Set(thread.artifactIds);
    const runs = (await this.runs.list())
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

  private requesterError(input: {
    requesterUserId?: string;
    channel?: string;
    sourceUserId?: string;
    sourceUserAliases?: string[];
  }): RunContextError {
    if (input.requesterUserId) {
      return new RunContextError(
        400,
        `Requester user not found: ${input.requesterUserId}`,
      );
    }
    if (input.sourceUserId) {
      const aliases = input.sourceUserAliases?.length
        ? ` aliases=${input.sourceUserAliases.join(",")}`
        : "";
      return new RunContextError(
        403,
        `Channel identity is not allowed or not mapped: ${input.channel ?? "unknown"}/${input.sourceUserId}${aliases}`,
      );
    }
    return new RunContextError(400, "Requester user could not be resolved");
  }

  parseAttachments(value: unknown): ArtifactUploadInput[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new Error("attachments must be an array");
    }
    return value.map((item) => {
      if (!item || typeof item !== "object") {
        throw new Error("attachments must contain objects");
      }
      const candidate = item as Record<string, unknown>;
      if (
        typeof candidate.filename !== "string" ||
        candidate.filename.trim() === ""
      ) {
        throw new Error("attachment filename is required");
      }
      const filename = candidate.filename.trim();
      const mimeType =
        typeof candidate.mimeType === "string" && candidate.mimeType.trim()
          ? candidate.mimeType.trim()
          : "application/octet-stream";
      const dataField =
        candidate.contentBase64 ?? candidate.data ?? candidate.content;
      if (typeof dataField !== "string") {
        throw new Error(`attachment ${filename} must include base64 data`);
      }
      const description =
        typeof candidate.description === "string"
          ? candidate.description
          : undefined;
      return {
        filename,
        mimeType,
        contentBase64: dataField,
        description,
      };
    });
  }

}
