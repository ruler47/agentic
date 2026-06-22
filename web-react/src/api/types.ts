/**
 * Shared API types. We re-export only `type`s from the backend so the React
 * bundle never accidentally pulls in node-only runtime modules (pg, fs, ...).
 *
 * Path aliased to ../src via tsconfig "paths" + Vite resolve.alias.
 */

export type {
  AgentArtifact,
  AgentArtifactKind,
  AgentEvent,
  AgentEventType,
  AgentActivity,
  AgentEventStatus,
  AgentRunResult,
  ArtifactQualityCheck,
  ArtifactQualityMetadata,
  ArtifactRequirement,
  ExternalActionCommitExecutor,
  ExternalActionCommitExecutorKind,
  ExternalActionExecutionMode,
  ExternalActionPreparedSession,
  ExternalActionProposal,
  ExternalActionProposalStatus,
  ExternalActionType,
  MemoryScope,
  MemorySensitivity,
  MemoryStatus,
  ModelTier,
  ModelTierSettings,
  ReviewResult,
  SkillMemoryEntry,
  SkillMemoryMatch,
  Subtask,
  TaskComplexity,
  TokenUsage,
  WorkingDecisionCandidate,
  WorkingDecisionDraftStatus,
  WorkingDecisionFact,
  WorkingDecisionNextAction,
  WorkingDecisionPhase,
  WorkingDecisionRejectedEvidence,
  WorkingDecisionSnapshot,
  WorkerResult,
} from "@server/types";

export type {
  AgentRunRecord,
  RunMetrics,
  RunCreateContext,
  RunStatus,
} from "@server/runs/types";

export type {
  AuditAction,
  AuditEventInput,
  AuditEventRecord,
  AuditEventStatus,
} from "@server/audit/types";

export type {
  AppendConversationMessageInput,
  ConversationThreadContext,
  ConversationThreadMessage,
  ConversationThreadMessageRole,
  ConversationThreadRecord,
  ConversationThreadStatus,
  CreateConversationThreadInput,
} from "@server/conversations/types";

export type {
  ToolCatalogEntry,
  ToolCatalogLayer,
} from "@server/tools/toolCatalog";

export type {
  ToolModuleMetadata,
  ToolModuleSource,
  ToolModuleStatus,
  ToolModuleVersionSummary,
  ToolModulePromotionEvidence,
} from "@server/tools/toolMetadataStore";

export type {
  ToolContextKind,
  ToolContextRecord,
} from "@server/tools/toolContextStore";

export type {
  ToolRuntimeSettingInput,
  ToolRuntimeSettingRecord,
} from "@server/settings/toolRuntimeSettings";

export type {
  ModelProviderInput,
  ModelProviderKind,
  ModelProviderRecord,
  ModelProviderStatus,
  ModelProviderType,
  ModelProviderUpdateInput,
} from "@server/settings/modelProviderStore";

export type {
  SecretHandleInput,
  SecretHandleProvider,
  SecretHandleRecord,
} from "@server/secrets/secretHandleStore";

export type {
  GroupProfileRecord,
  GroupProfileUpdateInput,
} from "@server/instance/groupProfileStore";

export type {
  ChannelIdentityCreateInput,
  ChannelIdentityRecord,
  ChannelIdentityStatus,
  ChannelIdentityUpdateInput,
  UserCreateInput,
  UserRecord,
  UserUpdateInput,
} from "@server/instance/userStore";

export type { ToolServiceRestartPolicyInput } from "@server/tools/toolServiceSupervisor";

export type {
  ToolServiceDesiredState,
  ToolServiceRuntimeStatus,
  ToolServiceStatus,
} from "@server/tools/toolServiceStatusStore";

export type {
  ToolServiceEventDirection,
  ToolServiceEventRecord,
  ToolServiceEventStatus,
} from "@server/tools/toolServiceEventStore";

export type {
  EvidenceCreateInput,
  EvidenceKind,
  EvidenceQaStatus,
  EvidenceRecord,
  RunRetrospectiveCreateInput,
  RunRetrospectiveOutcome,
  RunRetrospectiveRecord,
  RunRetrospectiveStatus,
  RunRetrospectiveUpdateInput,
  WorkClaim,
  WorkLedgerCreateInput,
  WorkLedgerItem,
  WorkLedgerKind,
  WorkLedgerStatus,
  WorkLedgerUpdateInput,
} from "@server/work-ledger/types";

// Convenience derived types -----------------------------------------------

export type RunListResponse = { runs: import("@server/runs/types").AgentRunRecord[] };
export type RunDetailResponse = { run: import("@server/runs/types").AgentRunRecord };

export type ThreadResolutionDecision = {
  decision: string;
  reason?: string;
  threadId?: string;
};

export type RunCreateResponse = {
  run: import("@server/runs/types").AgentRunRecord;
  thread?: import("@server/conversations/types").ConversationThreadRecord;
  threadResolution?: ThreadResolutionDecision;
};
