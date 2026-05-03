export type AuditAction =
  | "run.created"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "artifact.uploaded"
  | "artifact.generated"
  | "tool.used"
  | "tool.failed"
  | "tool_build.requested"
  | "tool_build.rework_requested"
  | "tool_build.stopped"
  | "tool_build.deleted"
  | "tool_build.registered"
  | "conversation_thread.deleted"
  | "group_profile.updated"
  | "memory.created"
  | "memory.updated"
  | "memory.embeddings_rebuilt";

export type AuditEventStatus = "success" | "failure" | "pending";

export type AuditEventInput = {
  instanceId?: string;
  actorId?: string;
  actorType?: "user" | "agent" | "system" | "tool";
  action: AuditAction;
  targetType: string;
  targetId: string;
  status?: AuditEventStatus;
  runId?: string;
  threadId?: string;
  requesterUserId?: string;
  channel?: string;
  summary: string;
  metadata?: Record<string, unknown>;
};

export type AuditEventRecord = AuditEventInput & {
  id: string;
  instanceId: string;
  actorId: string;
  actorType: "user" | "agent" | "system" | "tool";
  status: AuditEventStatus;
  createdAt: string;
};

export type AuditEventStore = {
  record(input: AuditEventInput): Promise<AuditEventRecord>;
  list(limit?: number): Promise<AuditEventRecord[]>;
};
