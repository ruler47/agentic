export type AuditAction =
  | "run.created"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "artifact.uploaded"
  | "artifact.generated"
  | "tool.used"
  | "tool.failed"
  | "tool.deleted"
  | "tool.version_activated"
  | "tool_service.start"
  | "tool_service.stop"
  | "tool_service.restart"
  | "tool_service.heartbeat"
  | "tool_build.requested"
  | "tool_build.rework_requested"
  | "tool_build.stopped"
  | "tool_build.deleted"
  | "tool_build.registered"
  | "tool_migration.recorded"
  | "conversation_thread.deleted"
  | "group_profile.updated"
  | "user.created"
  | "user.updated"
  | "user.deleted"
  | "channel_identity.created"
  | "channel_identity.updated"
  | "channel_identity.deleted"
  | "secret_handle.created"
  | "secret_handle.deleted"
  | "model_provider.created"
  | "model_provider.updated"
  | "model_provider.deleted"
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
