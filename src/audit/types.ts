export type AuditAction =
  | "run.created"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.waiting_approval"
  | "run.cancelled"
  | "run.updated"
  | "run.restarted"
  | "run.recovered_at_bootstrap"
  | "external_action.proposed"
  | "external_action.approved"
  | "external_action.rejected"
  | "external_action.prepared"
  | "external_action.prepare_failed"
  | "external_action.profile_hydration_approved"
  | "external_action.executor_build_requested"
  | "external_action.executor_build_failed"
  | "external_action.executor_attached"
  | "external_action.commit_blocked"
  | "external_action.commit_failed"
  | "external_action.committed"
  | "artifact.uploaded"
  | "artifact.generated"
  | "artifact.deleted"
  | "tool.used"
  | "tool.failed"
  | "tool.deleted"
  | "tool.creation_deleted"
  | "tool.manual_run"
  | "tool.setting_updated"
  | "tool.setting_deleted"
  | "tool.package_imported"
  | "tool.version_created"
  | "tool.version_activated"
  | "tool.version_rejected"
  | "tool.generated_reload"
  | "tool_service.start"
  | "tool_service.stop"
  | "tool_service.restart"
  | "tool_service.restart_policy_updated"
  | "tool_service.heartbeat"
  | "tool_service.event_recorded"
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
