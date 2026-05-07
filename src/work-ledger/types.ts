export type WorkLedgerKind =
  | "search"
  | "url_visit"
  | "api_call"
  | "tool_call"
  | "screenshot"
  | "artifact_generation"
  | "data_fetch"
  | "analysis"
  | "other";

export type WorkLedgerStatus =
  | "planned"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "stale"
  | "cancelled";

export const WORK_LEDGER_KINDS: readonly WorkLedgerKind[] = [
  "search",
  "url_visit",
  "api_call",
  "tool_call",
  "screenshot",
  "artifact_generation",
  "data_fetch",
  "analysis",
  "other",
];

export const WORK_LEDGER_STATUSES: readonly WorkLedgerStatus[] = [
  "planned",
  "claimed",
  "running",
  "completed",
  "failed",
  "stale",
  "cancelled",
];

export type WorkLedgerItem = {
  id: string;
  instanceId?: string;
  threadId?: string;
  runId?: string;
  ownerSpanId?: string;
  parentWorkItemId?: string;
  kind: WorkLedgerKind;
  status: WorkLedgerStatus;
  workKey: string;
  title: string;
  summary?: string;
  inputSummary?: string;
  outputSummary?: string;
  sourceUrls: string[];
  artifactIds: string[];
  evidenceIds: string[];
  error?: string;
  confidence?: number;
  freshnessExpiresAt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type WorkLedgerCreateInput = {
  instanceId?: string;
  threadId?: string;
  runId?: string;
  ownerSpanId?: string;
  parentWorkItemId?: string;
  kind: WorkLedgerKind;
  status?: WorkLedgerStatus;
  workKey: string;
  title: string;
  summary?: string;
  inputSummary?: string;
  outputSummary?: string;
  sourceUrls?: string[];
  artifactIds?: string[];
  evidenceIds?: string[];
  error?: string;
  confidence?: number;
  freshnessExpiresAt?: string;
  metadata?: Record<string, unknown>;
};

export type WorkLedgerUpdateInput = {
  status?: WorkLedgerStatus;
  ownerSpanId?: string | null;
  summary?: string | null;
  inputSummary?: string | null;
  outputSummary?: string | null;
  sourceUrls?: string[];
  error?: string | null;
  confidence?: number | null;
  freshnessExpiresAt?: string | null;
  metadata?: Record<string, unknown>;
};

export type WorkClaim = {
  workKey: string;
  ownerSpanId?: string;
  reason?: string;
  kind: WorkLedgerKind;
  title: string;
  threadId?: string;
  runId?: string;
  instanceId?: string;
  parentWorkItemId?: string;
  inputSummary?: string;
  freshnessExpiresAt?: string;
  metadata?: Record<string, unknown>;
};

export type WorkReuseDecisionStatus =
  | "reuse_completed"
  | "wait_for_inflight"
  | "create_new_attempt"
  | "create_revalidation"
  | "blocked_by_recent_failure";

export type WorkReuseDecision = {
  status: WorkReuseDecisionStatus;
  reason: string;
  match?: WorkLedgerItem;
};

export type WorkLedgerStore = {
  createItem(input: WorkLedgerCreateInput): Promise<WorkLedgerItem>;
  updateItemStatus(id: string, update: WorkLedgerUpdateInput): Promise<WorkLedgerItem>;
  claimWork(claim: WorkClaim): Promise<{ item: WorkLedgerItem; decision: WorkReuseDecision }>;
  listByThread(threadId: string, limit?: number): Promise<WorkLedgerItem[]>;
  listByRun(runId: string, limit?: number): Promise<WorkLedgerItem[]>;
  listByWorkKey(workKey: string, limit?: number): Promise<WorkLedgerItem[]>;
  get(id: string): Promise<WorkLedgerItem | undefined>;
  appendEvidenceLink(id: string, evidenceId: string): Promise<WorkLedgerItem>;
  appendArtifactLink(id: string, artifactId: string): Promise<WorkLedgerItem>;
};

export type EvidenceKind =
  | "source_url"
  | "search_result"
  | "browser_snapshot"
  | "screenshot"
  | "api_response"
  | "artifact"
  | "file"
  | "model_observation"
  | "limitation"
  | "other";

export const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "source_url",
  "search_result",
  "browser_snapshot",
  "screenshot",
  "api_response",
  "artifact",
  "file",
  "model_observation",
  "limitation",
  "other",
];

export type EvidenceQaStatus = "unchecked" | "passed" | "failed" | "blocked" | "partial";

export const EVIDENCE_QA_STATUSES: readonly EvidenceQaStatus[] = [
  "unchecked",
  "passed",
  "failed",
  "blocked",
  "partial",
];

export type EvidenceRecord = {
  id: string;
  instanceId?: string;
  threadId?: string;
  runId?: string;
  spanId?: string;
  workItemId?: string;
  kind: EvidenceKind;
  sourceUrl?: string;
  provider?: string;
  toolName?: string;
  title: string;
  summary?: string;
  contentPreview?: string;
  artifactId?: string;
  qaStatus: EvidenceQaStatus;
  confidence?: number;
  limitations: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type EvidenceCreateInput = {
  instanceId?: string;
  threadId?: string;
  runId?: string;
  spanId?: string;
  workItemId?: string;
  kind: EvidenceKind;
  sourceUrl?: string;
  provider?: string;
  toolName?: string;
  title: string;
  summary?: string;
  contentPreview?: string;
  artifactId?: string;
  qaStatus?: EvidenceQaStatus;
  confidence?: number;
  limitations?: string[];
  metadata?: Record<string, unknown>;
};

export type EvidenceLedgerStore = {
  createEvidence(input: EvidenceCreateInput): Promise<EvidenceRecord>;
  get(id: string): Promise<EvidenceRecord | undefined>;
  listByThread(threadId: string, limit?: number): Promise<EvidenceRecord[]>;
  listByRun(runId: string, limit?: number): Promise<EvidenceRecord[]>;
  listByWorkItem(workItemId: string, limit?: number): Promise<EvidenceRecord[]>;
  listByArtifact(artifactId: string, limit?: number): Promise<EvidenceRecord[]>;
  listBySourceUrl(sourceUrl: string, limit?: number): Promise<EvidenceRecord[]>;
};

export type RunRetrospectiveStatus = "proposed" | "reviewed" | "archived";
export type RunRetrospectiveOutcome = "completed" | "failed" | "cancelled" | "waiting_tool_rework";

export const RUN_RETROSPECTIVE_STATUSES: readonly RunRetrospectiveStatus[] = [
  "proposed",
  "reviewed",
  "archived",
];

export const RUN_RETROSPECTIVE_OUTCOMES: readonly RunRetrospectiveOutcome[] = [
  "completed",
  "failed",
  "cancelled",
  "waiting_tool_rework",
];

export type RunRetrospectiveProposalKind =
  | "memory"
  | "tool_investigation"
  | "policy_change"
  | "prompt_change";

export type RunRetrospectiveRecord = {
  id: string;
  instanceId?: string;
  threadId?: string;
  runId: string;
  status: RunRetrospectiveStatus;
  runOutcome: RunRetrospectiveOutcome;
  whatWorked: string[];
  whatFailed: string[];
  suspectedRootCauses: string[];
  duplicatedWork: string[];
  weakTools: string[];
  weakModels: string[];
  missingCapabilities: string[];
  usefulEvidenceIds: string[];
  proposedMemoryIds: string[];
  proposedToolInvestigationIds: string[];
  proposedPolicyChanges: string[];
  proposedPromptChanges: string[];
  summary?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type RunRetrospectiveCreateInput = {
  instanceId?: string;
  threadId?: string;
  runId: string;
  status?: RunRetrospectiveStatus;
  runOutcome: RunRetrospectiveOutcome;
  whatWorked?: string[];
  whatFailed?: string[];
  suspectedRootCauses?: string[];
  duplicatedWork?: string[];
  weakTools?: string[];
  weakModels?: string[];
  missingCapabilities?: string[];
  usefulEvidenceIds?: string[];
  proposedMemoryIds?: string[];
  proposedToolInvestigationIds?: string[];
  proposedPolicyChanges?: string[];
  proposedPromptChanges?: string[];
  summary?: string;
  metadata?: Record<string, unknown>;
};

export type RunRetrospectiveUpdateInput = {
  status?: RunRetrospectiveStatus;
  summary?: string | null;
  whatWorked?: string[];
  whatFailed?: string[];
  suspectedRootCauses?: string[];
  duplicatedWork?: string[];
  weakTools?: string[];
  weakModels?: string[];
  missingCapabilities?: string[];
  usefulEvidenceIds?: string[];
  metadata?: Record<string, unknown>;
};

export type RunRetrospectiveStore = {
  create(input: RunRetrospectiveCreateInput): Promise<RunRetrospectiveRecord>;
  get(id: string): Promise<RunRetrospectiveRecord | undefined>;
  listByRun(runId: string, limit?: number): Promise<RunRetrospectiveRecord[]>;
  listByThread(threadId: string, limit?: number): Promise<RunRetrospectiveRecord[]>;
  updateStatus(id: string, update: RunRetrospectiveUpdateInput): Promise<RunRetrospectiveRecord>;
  appendLinkedProposal(
    id: string,
    proposalKind: RunRetrospectiveProposalKind,
    proposalId: string,
  ): Promise<RunRetrospectiveRecord>;
};
