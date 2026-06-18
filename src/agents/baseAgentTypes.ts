import type { AgentArtifact, AgentEventSink, ArtifactCreateInput, ModelTier } from "../types.js";
import type { Tool, ToolExecutionContext, ToolResult } from "../tools/tool.js";
import type { BaseAgentToolCatalogEntry } from "./agentToolCatalog.js";

export type BaseAgentRunContext = {
  runId?: string;
  instanceId?: string;
  requesterUserId?: string;
  channel?: string;
  threadId?: string;
  parentRunId?: string;
  sourceUserId?: string;
  sourceMessageId?: string;
  sourceChatId?: string;
  sourceThreadId?: string;
  currentDateTimeIso?: string;
  timeZone?: string;
  locale?: string;
  requester?: {
    id: string;
    displayName: string;
    role?: string;
    roles?: string[];
  };
  groupProfile?: {
    id: string;
    name: string;
    description?: string;
    preferenceKeys?: string[];
  };
  thread?: {
    summary?: string;
    acceptedFacts?: string[];
    rejectedAttempts?: string[];
    openQuestions?: string[];
    relevantArtifactIds?: string[];
    relevantArtifacts?: Array<{
      id: string;
      runId: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      description?: string;
      contentPreview?: string;
      qualityStatus?: NonNullable<AgentArtifact["quality"]>["status"];
      qualitySignals?: string[];
    }>;
  };
  inputArtifacts?: Array<{
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    description?: string;
  }>;
};

export type BaseAgentRunOptions = {
  runId?: string;
  signal?: AbortSignal;
  modelTier?: ModelTier;
  maxSteps?: number;
  maxToolCalls?: number;
  llmTimeoutMs?: number;
  toolTimeoutMs?: number;
  runContext?: BaseAgentRunContext;
  toolPolicy?: {
    allowedToolNames?: string[];
    deniedToolNames?: string[];
    reason?: string;
  };
  toolCatalog?: BaseAgentToolCatalogEntry[];
  initialScopedToolCandidates?: BaseAgentInitialScopedToolCandidate[];
  resolveSecret?: ToolExecutionContext["resolveSecret"];
  resolveConfiguration?: ToolExecutionContext["resolveConfiguration"];
  audit?: ToolExecutionContext["audit"];
  logger?: ToolExecutionContext["logger"];
  createToolCallback?: (toolName: string) => ToolExecutionContext["callback"] | undefined;
  onToolCreationRequested?: BaseAgentToolCreationHandler;
  onToolEditRequested?: BaseAgentToolEditHandler;
  onToolCandidateAccepted?: BaseAgentToolCandidateAcceptedHandler;
  onEvent?: AgentEventSink;
  saveArtifact?: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>;
};

export type BaseAgentInitialScopedToolCandidate = {
  tool: Tool;
  catalogEntry?: BaseAgentToolCatalogEntry;
  reason?: string;
  promotionPolicy?: "auto_on_success" | "manual";
};

export type FailedToolCall = {
  toolName: string;
  message: string;
  diagnostic?: BaseAgentToolRuntimeDiagnostic;
};

export type BaseAgentToolRuntimeDiagnostic = {
  type: "missing_runtime_requirements";
  missingConfigurationKeys: string[];
  missingSecretHandles: string[];
  message: string;
};

export type CachedToolCall = {
  result: ToolResult;
  preview: string;
  sourceUrls: string[];
  proofEvidence: ProofEvidence[];
};

export type ToolPrimaryResult = {
  toolName: string;
  toolVersion?: string;
  path: string;
  value: unknown;
  valuePreview: string;
};

export type ProofEvidence = {
  sourceUrl: string;
  signals: string[];
  focusText?: string;
  title?: string;
  contentPreview?: string;
};

export type SourceGroundingGap = {
  reason: string;
  unsupportedSignals: string[];
  supportedSignals: string[];
};

export type FinalAnswerConsistencyIssue = {
  kind:
    | "relative_date_weekday_mismatch"
    | "proof_artifact_source_mismatch"
    | "referenced_artifact_failed_quality";
  reason: string;
  expected?: string;
  observed?: string;
  artifactFilename?: string;
};

export type ProofTargetPlan = {
  sourceUrl: string;
  focusText?: string;
  claimSignals: string[];
  matchedClaimSignals: string[];
  evidenceSignals: string[];
  reason: string;
};

export type BaseAgentToolCreationRequest = {
  name: string;
  version?: string;
  request: string;
  description?: string;
  capabilities?: string[];
  dependencies?: Record<string, string>;
  behaviorExamples?: unknown[];
  authoringMode?: "auto" | "llm" | "scaffold";
};

export type BaseAgentToolCreationResult = {
  ok: boolean;
  toolName: string;
  toolVersion?: string;
  status: "requested" | "registered" | "failed";
  message: string;
  runId?: string;
  creationId?: string;
  packageRef?: string;
  scopedTool?: Tool;
  scopedCatalogEntry?: BaseAgentToolCatalogEntry;
  reusedCandidate?: boolean;
  promotionPolicy?: "auto_on_success" | "manual";
  /**
   * True when the candidate was attached by the host BEFORE the run
   * started (e.g. an explicitly referenced generated tool), not created
   * on the agent's own request. Initial attachments are offers — the
   * unused-candidate gate must not fail the run when the agent solves
   * the task without them.
   */
  initialAttachment?: boolean;
  error?: string;
};

export type ToolCreationOutcome = BaseAgentToolCreationResult & {
  request: BaseAgentToolCreationRequest;
};

export type BaseAgentToolCreationHandler = (
  request: BaseAgentToolCreationRequest,
) => Promise<BaseAgentToolCreationResult>;

export type BaseAgentToolEditRequest = {
  name: string;
  version?: string;
  request: string;
  description?: string;
  capabilities?: string[];
  dependencies?: Record<string, string>;
  behaviorExamples?: unknown[];
  authoringMode?: "auto" | "llm" | "scaffold";
};

export type BaseAgentToolEditResult = {
  ok: boolean;
  toolName: string;
  toolVersion?: string;
  status: "requested" | "registered" | "failed";
  message: string;
  runId?: string;
  creationId?: string;
  packageRef?: string;
  activeVersion?: string;
  replacesVersion?: string;
  scopedTool?: Tool;
  scopedCatalogEntry?: BaseAgentToolCatalogEntry;
  reusedCandidate?: boolean;
  promotionPolicy?: "auto_on_success" | "manual";
  error?: string;
};

export type ToolEditOutcome = BaseAgentToolEditResult & {
  request: BaseAgentToolEditRequest;
};

export type BaseAgentToolEditHandler = (
  request: BaseAgentToolEditRequest,
) => Promise<BaseAgentToolEditResult>;

export type BaseAgentToolCandidateAccepted = {
  toolName: string;
  toolVersion: string;
  replacesVersion?: string;
  runId?: string;
  promotionPolicy?: "auto_on_success" | "manual";
};

export type BaseAgentToolCandidateAcceptedHandler = (
  candidate: BaseAgentToolCandidateAccepted,
) => Promise<void>;
