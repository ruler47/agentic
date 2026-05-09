export type AuditAction =
  | "run.created"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.updated"
  | "run.restarted"
  | "run.recovered_at_bootstrap"
  | "artifact.uploaded"
  | "artifact.generated"
  | "tool.used"
  | "tool.failed"
  | "tool.deleted"
  | "tool.setting_updated"
  | "tool.setting_deleted"
  | "tool.package_imported"
  | "tool.version_activated"
  | "tool.generated_reload"
  | "tool_service.start"
  | "tool_service.stop"
  | "tool_service.restart"
  | "tool_service.restart_policy_updated"
  | "tool_service.heartbeat"
  | "tool_service.event_recorded"
  | "tool_build.requested"
  | "tool_build.rework_requested"
  | "tool_build.stopped"
  | "tool_build.deleted"
  | "tool_build.registered"
  | "tool_investigation.created"
  | "tool_investigation.updated"
  | "tool_rework_wait.created"
  | "tool_rework_wait.updated"
  | "tool_rework_wait.resumed"
  | "tool_rework_wait.retry_run_created"
  | "tool_rework_wait.auto_retry_decision"
  | "work_ledger.created"
  | "work_ledger.updated"
  | "evidence_ledger.created"
  | "run_retrospective.created"
  | "run_retrospective.updated"
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
