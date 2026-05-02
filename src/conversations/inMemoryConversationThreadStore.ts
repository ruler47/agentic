import {
  AppendConversationMessageInput,
  CompleteConversationRunInput,
  ConversationThreadMessage,
  ConversationThreadRecord,
  ConversationThreadStore,
  CreateConversationThreadInput,
} from "./types.js";

export class InMemoryConversationThreadStore implements ConversationThreadStore {
  private readonly threads = new Map<string, ConversationThreadRecord>();
  private readonly messages = new Map<string, ConversationThreadMessage[]>();

  async create(input: CreateConversationThreadInput): Promise<ConversationThreadRecord> {
    const now = new Date().toISOString();
    const thread: ConversationThreadRecord = {
      id: createThreadId(),
      status: "active",
      title: truncateTitle(input.title),
      requesterUserId: input.requesterUserId,
      channel: input.channel,
      sourceChatId: input.sourceChatId,
      sourceThreadId: input.sourceThreadId,
      summary: "New conversation thread. No completed runs yet.",
      acceptedFacts: [],
      rejectedAttempts: [],
      openQuestions: [],
      artifactIds: [],
      createdAt: now,
      updatedAt: now,
      messages: [],
    };

    this.threads.set(thread.id, thread);
    this.messages.set(thread.id, []);
    return cloneThread(thread);
  }

  async list(): Promise<ConversationThreadRecord[]> {
    return [...this.threads.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((thread) => cloneThread({ ...thread, messages: this.messages.get(thread.id) ?? [] }));
  }

  async get(id: string): Promise<ConversationThreadRecord | undefined> {
    const thread = this.threads.get(id);
    return thread ? cloneThread({ ...thread, messages: this.messages.get(id) ?? [] }) : undefined;
  }

  async appendMessage(input: AppendConversationMessageInput): Promise<ConversationThreadMessage> {
    const thread = this.mustGet(input.threadId);
    const now = new Date().toISOString();
    const message: ConversationThreadMessage = {
      id: createMessageId(),
      threadId: input.threadId,
      runId: input.runId,
      parentRunId: input.parentRunId,
      role: input.role,
      content: input.content,
      sourceMessageId: input.sourceMessageId,
      createdAt: now,
    };

    const messages = this.messages.get(input.threadId) ?? [];
    messages.push(message);
    this.messages.set(input.threadId, messages);
    thread.latestRunId = input.runId ?? thread.latestRunId;
    thread.updatedAt = now;
    return { ...message };
  }

  async completeRun(input: CompleteConversationRunInput): Promise<ConversationThreadRecord | undefined> {
    const thread = this.threads.get(input.threadId);
    if (!thread) return undefined;

    const now = new Date().toISOString();
    const artifactIds = input.artifacts?.map((artifact) => artifact.id) ?? [];
    thread.latestRunId = input.runId;
    thread.artifactIds = unique([...thread.artifactIds, ...artifactIds]);
    thread.updatedAt = now;

    if (input.failedError) {
      thread.rejectedAttempts = unique([
        ...thread.rejectedAttempts,
        `Run ${input.runId} failed: ${truncateText(input.failedError, 220)}`,
      ]);
    } else {
      thread.acceptedFacts = unique([
        ...thread.acceptedFacts,
        `Latest completed task: ${truncateText(input.task, 180)}`,
      ]).slice(-8);
    }

    thread.summary = buildSummary({
      previousSummary: thread.summary,
      task: input.task,
      finalAnswer: input.finalAnswer,
      failedError: input.failedError,
      artifactCount: artifactIds.length,
    });

    if (input.finalAnswer) {
      await this.appendMessage({
        threadId: input.threadId,
        runId: input.runId,
        role: "assistant",
        content: input.finalAnswer,
      });
    }

    return this.get(input.threadId);
  }

  async delete(id: string): Promise<boolean> {
    const existed = this.threads.delete(id);
    this.messages.delete(id);
    return existed;
  }

  private mustGet(id: string): ConversationThreadRecord {
    const thread = this.threads.get(id);
    if (!thread) throw new Error(`Conversation thread not found: ${id}`);
    return thread;
  }
}

function buildSummary(input: {
  previousSummary: string;
  task: string;
  finalAnswer?: string;
  failedError?: string;
  artifactCount: number;
}) {
  const outcome = input.failedError
    ? `Failed: ${truncateText(input.failedError, 260)}`
    : `Answered: ${truncateText(input.finalAnswer ?? "Completed without final answer.", 420)}`;
  const artifactNote =
    input.artifactCount > 0 ? ` Generated ${input.artifactCount} artifact(s).` : "";

  return truncateText(
    [
      input.previousSummary === "New conversation thread. No completed runs yet."
        ? undefined
        : input.previousSummary,
      `Latest request: ${truncateText(input.task, 260)}`,
      `${outcome}${artifactNote}`,
    ]
      .filter(Boolean)
      .join("\n"),
    1600,
  );
}

function cloneThread(thread: ConversationThreadRecord): ConversationThreadRecord {
  return {
    ...thread,
    acceptedFacts: [...thread.acceptedFacts],
    rejectedAttempts: [...thread.rejectedAttempts],
    openQuestions: [...thread.openQuestions],
    artifactIds: [...thread.artifactIds],
    messages: thread.messages?.map((message) => ({ ...message })),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function truncateTitle(value: string): string {
  return truncateText(value.replace(/\s+/g, " ").trim() || "Untitled thread", 90);
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function createThreadId(): string {
  return `thread_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function createMessageId(): string {
  return `thread_msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
