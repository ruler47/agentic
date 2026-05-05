import { AgentArtifact } from "../types.js";

export type ConversationThreadStatus = "active" | "archived";

export type ConversationThreadRecord = {
  id: string;
  status: ConversationThreadStatus;
  title: string;
  requesterUserId: string;
  channel: string;
  sourceChatId?: string;
  sourceThreadId?: string;
  latestRunId?: string;
  summary: string;
  acceptedFacts: string[];
  rejectedAttempts: string[];
  openQuestions: string[];
  artifactIds: string[];
  createdAt: string;
  updatedAt: string;
  messages?: ConversationThreadMessage[];
};

export type ConversationThreadMessageRole = "user" | "assistant" | "system";

export type ConversationThreadMessage = {
  id: string;
  threadId: string;
  runId?: string;
  parentRunId?: string;
  role: ConversationThreadMessageRole;
  content: string;
  sourceMessageId?: string;
  createdAt: string;
};

export type ConversationThreadContext = {
  summary: string;
  acceptedFacts: string[];
  rejectedAttempts: string[];
  openQuestions: string[];
  relevantArtifactIds: string[];
  relevantArtifacts?: AgentArtifact[];
};

export type CreateConversationThreadInput = {
  title: string;
  requesterUserId: string;
  channel: string;
  sourceChatId?: string;
  sourceThreadId?: string;
};

export type AppendConversationMessageInput = {
  threadId: string;
  runId?: string;
  parentRunId?: string;
  role: ConversationThreadMessageRole;
  content: string;
  sourceMessageId?: string;
};

export type CompleteConversationRunInput = {
  threadId: string;
  runId: string;
  task: string;
  finalAnswer?: string;
  artifacts?: AgentArtifact[];
  failedError?: string;
};

export type ConversationThreadStore = {
  create(input: CreateConversationThreadInput): Promise<ConversationThreadRecord>;
  list(): Promise<ConversationThreadRecord[]>;
  get(id: string): Promise<ConversationThreadRecord | undefined>;
  appendMessage(input: AppendConversationMessageInput): Promise<ConversationThreadMessage>;
  completeRun(input: CompleteConversationRunInput): Promise<ConversationThreadRecord | undefined>;
  delete(id: string): Promise<boolean>;
};
