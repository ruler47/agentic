import { PgPool } from "../db/pool.js";
import {
  AppendConversationMessageInput,
  CompleteConversationRunInput,
  ConversationThreadMessage,
  ConversationThreadRecord,
  ConversationThreadStore,
  CreateConversationThreadInput,
} from "./types.js";

type ThreadRow = {
  id: string;
  status: "active" | "archived";
  title: string;
  requester_user_id: string;
  channel: string;
  source_chat_id: string | null;
  source_thread_id: string | null;
  latest_run_id: string | null;
  summary: string;
  accepted_facts: string[];
  rejected_attempts: string[];
  open_questions: string[];
  artifact_ids: string[];
  created_at: Date;
  updated_at: Date;
};

type MessageRow = {
  id: string;
  thread_id: string;
  run_id: string | null;
  parent_run_id: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  source_message_id: string | null;
  created_at: Date;
};

export class PostgresConversationThreadStore implements ConversationThreadStore {
  constructor(private readonly pool: PgPool) {}

  async create(input: CreateConversationThreadInput): Promise<ConversationThreadRecord> {
    const id = createThreadId();
    const now = new Date();
    await this.pool.query(
      `
        insert into conversation_threads (
          id, status, title, requester_user_id, channel, source_chat_id, source_thread_id,
          summary, accepted_facts, rejected_attempts, open_questions, artifact_ids,
          created_at, updated_at
        )
        values ($1, 'active', $2, $3, $4, $5, $6, $7, '{}', '{}', '{}', '{}', $8, $8)
      `,
      [
        id,
        truncateTitle(input.title),
        input.requesterUserId,
        input.channel,
        input.sourceChatId ?? null,
        input.sourceThreadId ?? null,
        "New conversation thread. No completed runs yet.",
        now,
      ],
    );

    const thread = await this.get(id);
    if (!thread) throw new Error(`Conversation thread not found after create: ${id}`);
    return thread;
  }

  async list(): Promise<ConversationThreadRecord[]> {
    const rows = await this.pool.query<ThreadRow>(`
      select *
      from conversation_threads
      order by updated_at desc
      limit 100
    `);

    return Promise.all(rows.rows.map((row) => this.hydrateThread(row)));
  }

  async get(id: string): Promise<ConversationThreadRecord | undefined> {
    const rows = await this.pool.query<ThreadRow>(
      `
        select *
        from conversation_threads
        where id = $1
      `,
      [id],
    );

    const row = rows.rows[0];
    return row ? this.hydrateThread(row) : undefined;
  }

  async appendMessage(input: AppendConversationMessageInput): Promise<ConversationThreadMessage> {
    const id = createMessageId();
    const now = new Date();
    await this.pool.query(
      `
        insert into thread_messages (
          id, thread_id, run_id, parent_run_id, role, content, source_message_id, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        id,
        input.threadId,
        input.runId ?? null,
        input.parentRunId ?? null,
        input.role,
        input.content,
        input.sourceMessageId ?? null,
        now,
      ],
    );

    await this.pool.query(
      `
        update conversation_threads
        set latest_run_id = coalesce($1, latest_run_id), updated_at = $2
        where id = $3
      `,
      [input.runId ?? null, now, input.threadId],
    );

    return {
      id,
      threadId: input.threadId,
      runId: input.runId,
      parentRunId: input.parentRunId,
      role: input.role,
      content: input.content,
      sourceMessageId: input.sourceMessageId,
      createdAt: now.toISOString(),
    };
  }

  async completeRun(input: CompleteConversationRunInput): Promise<ConversationThreadRecord | undefined> {
    const thread = await this.get(input.threadId);
    if (!thread) return undefined;

    const artifactIds = input.artifacts?.map((artifact) => artifact.id) ?? [];
    const summary = buildSummary({
      previousSummary: thread.summary,
      task: input.task,
      finalAnswer: input.finalAnswer,
      failedError: input.failedError,
      artifactCount: artifactIds.length,
    });
    const acceptedFacts = input.failedError
      ? thread.acceptedFacts
      : unique([...thread.acceptedFacts, `Latest completed task: ${truncateText(input.task, 180)}`]).slice(-8);
    const rejectedAttempts = input.failedError
      ? unique([
          ...thread.rejectedAttempts,
          `Run ${input.runId} failed: ${truncateText(input.failedError, 220)}`,
        ])
      : thread.rejectedAttempts;
    const now = new Date();

    await this.pool.query(
      `
        update conversation_threads
        set latest_run_id = $1,
            summary = $2,
            accepted_facts = $3,
            rejected_attempts = $4,
            artifact_ids = $5,
            updated_at = $6
        where id = $7
      `,
      [
        input.runId,
        summary,
        acceptedFacts,
        rejectedAttempts,
        unique([...thread.artifactIds, ...artifactIds]),
        now,
        input.threadId,
      ],
    );

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
    const result = await this.pool.query(
      `
        delete from conversation_threads
        where id = $1
      `,
      [id],
    );

    return (result.rowCount ?? 0) > 0;
  }

  private async hydrateThread(row: ThreadRow): Promise<ConversationThreadRecord> {
    const messages = await this.pool.query<MessageRow>(
      `
        select *
        from thread_messages
        where thread_id = $1
        order by created_at asc
      `,
      [row.id],
    );

    return {
      id: row.id,
      status: row.status,
      title: row.title,
      requesterUserId: row.requester_user_id,
      channel: row.channel,
      sourceChatId: row.source_chat_id ?? undefined,
      sourceThreadId: row.source_thread_id ?? undefined,
      latestRunId: row.latest_run_id ?? undefined,
      summary: row.summary,
      acceptedFacts: row.accepted_facts ?? [],
      rejectedAttempts: row.rejected_attempts ?? [],
      openQuestions: row.open_questions ?? [],
      artifactIds: row.artifact_ids ?? [],
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      messages: messages.rows.map(mapMessageRow),
    };
  }
}

function mapMessageRow(row: MessageRow): ConversationThreadMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id ?? undefined,
    parentRunId: row.parent_run_id ?? undefined,
    role: row.role,
    content: row.content,
    sourceMessageId: row.source_message_id ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
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
