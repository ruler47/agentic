import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  ConversationThreadRecord,
  ConversationThreadStore,
} from "../../../conversations/types.js";
import type { RunStore } from "../../../runs/types.js";
import { AuditService } from "../../common/services/audit.service.js";
import { CONVERSATION_STORE, RUN_STORE } from "../../persistence/tokens.js";

@Injectable()
export class ConversationsService {
  constructor(
    @Inject(CONVERSATION_STORE) private readonly threads: ConversationThreadStore | undefined,
    @Inject(RUN_STORE) private readonly runs: RunStore,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<ConversationThreadRecord[]> {
    return this.threads ? this.threads.list() : [];
  }

  async get(id: string): Promise<ConversationThreadRecord> {
    if (!this.threads) {
      throw new ServiceUnavailableException("Conversation thread store is not configured");
    }
    const thread = await this.threads.get(id);
    if (!thread) throw new NotFoundException("Conversation thread not found");
    return thread;
  }

  async delete(id: string): Promise<{
    deleted: true;
    thread: ConversationThreadRecord;
    deletedRuns: number;
    deletedMessages: number;
    deletedArtifactReferences: number;
  }> {
    if (!this.threads) {
      throw new ServiceUnavailableException("Conversation thread store is not configured");
    }
    const thread = await this.threads.get(id);
    if (!thread) throw new NotFoundException("Conversation thread not found");

    const deletedRuns = await this.runs.deleteByThreadId(id);
    const deletedThread = await this.threads.delete(id);
    if (!deletedThread) throw new NotFoundException("Conversation thread not found");

    const deletedMessages = thread.messages?.length ?? 0;
    const deletedArtifactReferences = thread.artifactIds.length;

    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "conversation_thread.deleted",
      targetType: "conversation_thread",
      targetId: id,
      status: "success",
      threadId: id,
      requesterUserId: thread.requesterUserId,
      channel: thread.channel,
      summary: `Conversation deleted: ${thread.title}`,
      metadata: {
        deletedRuns,
        deletedMessages,
        deletedArtifactReferences,
      },
    });

    return { deleted: true, thread, deletedRuns, deletedMessages, deletedArtifactReferences };
  }
}
