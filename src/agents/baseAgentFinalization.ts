import type { AgentArtifact, AgentRunResult, ExternalActionProposal } from "../types.js";
import { regradeProofArtifactsAfterFinalAnswer } from "./baseAgentArtifacts.js";
import { buildExternalActionProposal } from "./externalActionPlanning.js";
import {
  determineFailure,
  finalAnswerHasUserValue,
  finalAnswerWithConsistencyNote,
  finalAnswerWithGroundingNote,
  finalAnswerWithProofArtifact,
  finalAnswerWithProofUnavailableNote,
  inspectFinalAnswerConsistency,
  shouldRequireProofArtifact,
} from "./baseAgentEvidence.js";
import { saveSourceEvidenceProofArtifact, shouldRequireExternalDataEvidence, shouldRequireSourceGrounding } from "./baseAgentProof.js";
import { emit } from "./baseAgentRuntime.js";
import { limitText } from "./baseAgentToolMessages.js";
import { findUnusedScopedCandidate, normalizeFinalAnswer, publicArtifactForTrace, publicProofEvidenceForTrace } from "./baseAgentTrace.js";
import type {
  BaseAgentRunContext,
  BaseAgentRunOptions,
  BaseAgentToolCandidateAccepted,
  FailedToolCall,
  ProofEvidence,
  ToolPrimaryResult,
  ToolCreationOutcome,
  ToolEditOutcome,
} from "./baseAgentTypes.js";
import { PROOF_SOURCE_URL_LIMIT } from "./proofSourceUrls.js";
import { shouldRequireResearchContract, type TaskFrame } from "./taskFrame.js";

type BaseAgentFinalizationInput = {
  task: string;
  options: BaseAgentRunOptions;
  startedAt: Date;
  rootSpanId: string;
  maxSteps?: number;
  stoppedByStepLimit: boolean;
  finalAnswer: string;
  latestDraftAnswerForProof: string;
  structuredProofArtifacts: AgentArtifact[];
  taskFrame: TaskFrame;
  successfulResearchToolCalls: number;
  successfulSourceReadToolCalls: number;
  runContext: BaseAgentRunContext;
  artifacts: AgentArtifact[];
  externalDataEvidenceUrls: Set<string>;
  proofEvidenceByUrl: Map<string, ProofEvidence>;
  externalEvidenceUrls: Set<string>;
  actionProposals: ExternalActionProposal[];
  requiredArtifacts: { screenshot: boolean };
  failedToolCalls: FailedToolCall[];
  successfulToolCalls: number;
  attemptedToolCalls: number;
  terminalFailureReason?: string;
  toolCreationRequests: ToolCreationOutcome[];
  toolEditRequests: ToolEditOutcome[];
  usedScopedCandidates: Map<string, BaseAgentToolCandidateAccepted>;
  acceptedCandidateKeys: Set<string>;
  primaryToolResults: ToolPrimaryResult[];
};

export async function finalizeBaseAgentRun(input: BaseAgentFinalizationInput): Promise<AgentRunResult> {
  const {
    task,
    options,
    startedAt,
    rootSpanId,
    maxSteps,
    stoppedByStepLimit,
    latestDraftAnswerForProof,
    structuredProofArtifacts,
    taskFrame,
    successfulResearchToolCalls,
    successfulSourceReadToolCalls,
    runContext,
    artifacts,
    externalDataEvidenceUrls,
    proofEvidenceByUrl,
    externalEvidenceUrls,
    actionProposals,
    requiredArtifacts,
    failedToolCalls,
    successfulToolCalls,
    attemptedToolCalls,
    terminalFailureReason,
    toolCreationRequests,
    toolEditRequests,
    usedScopedCandidates,
    acceptedCandidateKeys,
    primaryToolResults,
  } = input;
  let { finalAnswer } = input;

  const stepLimitFailureReason = stoppedByStepLimit
    ? `Base agent reached the step budget (${maxSteps ?? "unknown"}) before producing a final answer.`
    : undefined;
  if (!finalAnswer) {
    finalAnswer = latestDraftAnswerForProof.trim()
      ? latestDraftAnswerForProof
      : stepLimitFailureReason ?? "Base agent stopped before producing a final answer.";
  }
  finalAnswer = normalizeFinalAnswer(finalAnswer);
  const latestStructuredProofArtifact = structuredProofArtifacts.at(-1);
  if (latestStructuredProofArtifact && finalAnswerHasUserValue(finalAnswer)) {
    finalAnswer = finalAnswerWithProofArtifact(finalAnswer, latestStructuredProofArtifact);
  }

  const missingPrimaryResults = missingToolPrimaryResults(finalAnswer, primaryToolResults);
  if (missingPrimaryResults.length > 0 && finalAnswerHasUserValue(finalAnswer)) {
    finalAnswer = finalAnswerWithPrimaryToolResults(finalAnswer, missingPrimaryResults);
    await emit(options.onEvent, {
      parentSpanId: rootSpanId,
      type: "agent-tool-contract-fields-added",
      actor: "base-agent",
      activity: "agent",
      status: "completed",
      title: "Tool contract fields added",
      detail: missingPrimaryResults.map(formatPrimaryResult).join("; "),
      startedAt,
      completedAt: new Date(),
      payload: {
        input: {
          finalAnswerPreview: limitText(input.finalAnswer, 2_000),
          primaryToolResults: primaryToolResults.map(publicPrimaryResult),
        },
        output: {
          added: missingPrimaryResults.map(publicPrimaryResult),
        },
      },
    });
  }

  const finalSourceGroundingGap = shouldRequireSourceGrounding({
    taskFrame,
    finalAnswer,
    sourceUrls: [...externalDataEvidenceUrls],
    proofEvidence: [...proofEvidenceByUrl.values()],
    successfulResearchToolCalls,
  });
  if (finalSourceGroundingGap && finalAnswerHasUserValue(finalAnswer)) {
    finalAnswer = finalAnswerWithGroundingNote(finalAnswer, finalSourceGroundingGap);
    await emit(options.onEvent, {
      parentSpanId: rootSpanId,
      type: "agent-source-grounding-degraded",
      actor: "base-agent",
      activity: "agent",
      status: "completed",
      title: "Source grounding degraded",
      detail: finalSourceGroundingGap.reason,
      startedAt,
      completedAt: new Date(),
      payload: {
        input: {
          finalAnswer: limitText(finalAnswer, 4_000),
          sourceUrls: [...externalDataEvidenceUrls].slice(0, PROOF_SOURCE_URL_LIMIT),
          proofEvidence: [...proofEvidenceByUrl.values()].map(publicProofEvidenceForTrace),
        },
        output: finalSourceGroundingGap,
      },
    });
  }

  const finalConsistencyIssues = inspectFinalAnswerConsistency({
    task,
    finalAnswer,
    runContext,
    artifacts,
    proofEvidence: [...proofEvidenceByUrl.values()],
  });
  if (finalConsistencyIssues.length > 0 && finalAnswerHasUserValue(finalAnswer)) {
    finalAnswer = finalAnswerWithConsistencyNote(finalAnswer, finalConsistencyIssues);
    await emit(options.onEvent, {
      parentSpanId: rootSpanId,
      type: "agent-final-answer-grounding-degraded",
      actor: "base-agent",
      activity: "agent",
      status: "completed",
      title: "Final answer consistency note added",
      detail: finalConsistencyIssues.map((issue) => issue.reason).join(" "),
      startedAt,
      completedAt: new Date(),
      payload: {
        input: {
          task,
          finalAnswerPreview: limitText(finalAnswer, 4_000),
          artifacts: artifacts.map(publicArtifactForTrace),
          currentDateTimeIso: runContext.currentDateTimeIso,
          timeZone: runContext.timeZone,
        },
        output: {
          issues: finalConsistencyIssues,
        },
      },
    });
  }

  const regradedProofArtifacts = finalAnswerHasUserValue(finalAnswer)
    ? regradeProofArtifactsAfterFinalAnswer({
        artifacts,
        finalAnswer,
        proofRequiresClaimMatch: taskFrame.researchContract.requiresClaimBasedProof,
      })
    : [];
  if (regradedProofArtifacts.length > 0) {
    await emit(options.onEvent, {
      parentSpanId: rootSpanId,
      type: "artifact-quality-updated",
      actor: "base-agent",
      activity: "agent",
      status: "completed",
      title: "Proof artifacts re-evaluated",
      detail: `${regradedProofArtifacts.length} proof artifact(s) matched final-answer claims after final answer generation.`,
      startedAt,
      completedAt: new Date(),
      payload: {
        input: {
          finalAnswerPreview: limitText(finalAnswer, 2_000),
          artifacts: regradedProofArtifacts.map(publicArtifactForTrace),
        },
        output: {
          regradedArtifacts: regradedProofArtifacts.map(publicArtifactForTrace),
        },
      },
    });
  }

  let missingProofArtifact = taskFrame.externalActionPolicy
    ? undefined
    : shouldRequireProofArtifact({
        task,
        sourceUrls: [...externalEvidenceUrls],
        artifacts,
        artifactSavingAvailable: Boolean(options.saveArtifact),
      });
  if (missingProofArtifact && options.saveArtifact && finalAnswerHasUserValue(finalAnswer)) {
    const sourceProof = await saveSourceEvidenceProofArtifact({
      task,
      finalAnswer,
      taskFrame,
      sourceUrls: missingProofArtifact.sourceUrls,
      proofEvidence: [...proofEvidenceByUrl.values()],
      runId: runContext.runId,
      saveArtifact: options.saveArtifact,
      onEvent: options.onEvent,
      parentSpanId: rootSpanId,
    });
    if (sourceProof.artifact) {
      artifacts.push(sourceProof.artifact);
      finalAnswer = finalAnswerWithProofArtifact(finalAnswer, sourceProof.artifact);
      missingProofArtifact = shouldRequireProofArtifact({
        task,
        sourceUrls: [...externalEvidenceUrls],
        artifacts,
        artifactSavingAvailable: Boolean(options.saveArtifact),
      });
    } else if (sourceProof.warning) {
      finalAnswer = finalAnswerWithProofUnavailableNote(finalAnswer, sourceProof.warning, missingProofArtifact.sourceUrls);
      missingProofArtifact = undefined;
    }
  }

  const externalActionProposal = buildExternalActionProposal({
    task,
    finalAnswer,
    taskFrame,
    runContext,
    artifacts,
    sourceUrls: [...externalDataEvidenceUrls],
    createdAt: new Date().toISOString(),
  });
  if (externalActionProposal && finalAnswerHasUserValue(finalAnswer)) {
    actionProposals.push(externalActionProposal);
    await emit(options.onEvent, {
      parentSpanId: rootSpanId,
      type: "external-action-proposal-created",
      actor: "base-agent",
      activity: "agent",
      status: "completed",
      title: "External action proposal created",
      detail: `${externalActionProposal.actionType}: ${externalActionProposal.title}`,
      startedAt,
      completedAt: new Date(),
      payload: {
        input: {
          task,
          finalAnswerPreview: limitText(finalAnswer, 2_000),
          externalActionPolicy: taskFrame.externalActionPolicy,
        },
        output: externalActionProposal,
        proposal: externalActionProposal,
      },
    });
  }

  const failureReason = determineFailure({
    requiredArtifacts,
    artifacts,
    failedToolCalls,
    successfulToolCalls,
    finalAnswer,
    terminalFailureReason: terminalFailureReason ?? stepLimitFailureReason,
    unusedScopedCandidate: findUnusedScopedCandidate({
      task,
      toolCreationRequests,
      toolEditRequests,
      usedScopedCandidates,
    }),
    missingResearchContract: shouldRequireResearchContract({
      taskFrame,
      sourceUrls: [...externalDataEvidenceUrls],
      successfulResearchToolCalls,
      successfulSourceReadToolCalls,
    }),
    missingProofArtifact,
    missingExternalDataEvidence: shouldRequireExternalDataEvidence({
      task,
      sourceUrls: [...externalDataEvidenceUrls],
      taskFrame,
    }),
    actionProposalCount: actionProposals.length,
  });

  await emit(options.onEvent, {
    parentSpanId: rootSpanId,
    type: "agent-invocation-return-checked",
    actor: "base-agent",
    activity: "agent",
    status: failureReason ? "failed" : "completed",
    title: "Base return gate",
    detail: failureReason ?? "Final answer passed the base return gate.",
    startedAt,
    completedAt: new Date(),
    payload: {
      artifactCount: artifacts.length,
      failedToolCalls: failedToolCalls.length,
      successfulToolCalls,
      attemptedToolCalls,
      successfulResearchToolCalls,
      successfulSourceReadToolCalls,
      taskFrame,
      toolCreationRequests: toolCreationRequests.length,
      toolEditRequests: toolEditRequests.length,
      requiredArtifacts,
      externalEvidenceUrls: [...externalEvidenceUrls].slice(0, PROOF_SOURCE_URL_LIMIT),
      externalDataEvidenceUrls: [...externalDataEvidenceUrls].slice(0, PROOF_SOURCE_URL_LIMIT),
      finalConsistencyIssues,
      actionProposals,
      finalAnswerPreview: limitText(finalAnswer, 500),
      input: {
        finalAnswer: limitText(finalAnswer, 4_000),
        artifacts: artifacts.map(publicArtifactForTrace),
        failedToolCalls,
        successfulToolCalls,
        attemptedToolCalls,
        successfulResearchToolCalls,
        successfulSourceReadToolCalls,
        taskFrame,
        externalEvidenceUrls: [...externalEvidenceUrls].slice(0, PROOF_SOURCE_URL_LIMIT),
        externalDataEvidenceUrls: [...externalDataEvidenceUrls].slice(0, PROOF_SOURCE_URL_LIMIT),
        finalConsistencyIssues,
        actionProposals,
      },
      output: {
        ok: !failureReason,
        reason: failureReason ?? "Final answer passed the base return gate.",
      },
    },
  });

  if (!failureReason && options.onToolCandidateAccepted && usedScopedCandidates.size > 0) {
    for (const [key, candidate] of usedScopedCandidates.entries()) {
      if (acceptedCandidateKeys.has(key)) continue;
      acceptedCandidateKeys.add(key);
      if (candidate.promotionPolicy === "manual") {
        await emit(options.onEvent, {
          parentSpanId: rootSpanId,
          type: "tool-candidate-manual-review-required",
          actor: candidate.toolName,
          activity: "tool",
          status: "completed",
          title: "Run-scoped tool candidate needs manual review",
          detail: `${candidate.toolName}@${candidate.toolVersion} was used in this run, but global promotion is manual.`,
          startedAt,
          completedAt: new Date(),
          payload: {
            ...candidate,
            input: candidate,
            output: {
              accepted: false,
              promotionPolicy: "manual",
            },
          },
        });
        continue;
      }
      try {
        await options.onToolCandidateAccepted(candidate);
        await emit(options.onEvent, {
          parentSpanId: rootSpanId,
          type: "tool-candidate-accepted",
          actor: candidate.toolName,
          activity: "tool",
          status: "completed",
          title: "Run-scoped tool candidate accepted",
          detail: `${candidate.toolName}@${candidate.toolVersion} helped complete the run and was accepted for global availability.`,
          startedAt,
          completedAt: new Date(),
          payload: {
            ...candidate,
            input: candidate,
            output: {
              accepted: true,
              promotionPolicy: "auto_on_success",
            },
          },
        });
      } catch (error) {
        await emit(options.onEvent, {
          parentSpanId: rootSpanId,
          type: "tool-candidate-accepted",
          actor: candidate.toolName,
          activity: "tool",
          status: "failed",
          title: "Run-scoped tool candidate acceptance failed",
          detail: error instanceof Error ? error.message : String(error),
          startedAt,
          completedAt: new Date(),
          payload: {
            ...candidate,
            input: candidate,
            output: {
              accepted: false,
              error: error instanceof Error ? error.message : String(error),
            },
          },
        });
      }
    }
  }

  await emit(options.onEvent, {
    spanId: rootSpanId,
    type: failureReason ? "agent-invocation-failed" : "agent-invocation-completed",
    actor: "base-agent",
    activity: "agent",
    status: failureReason ? "failed" : "completed",
    title: failureReason ? "Base agent failed" : "Base agent completed",
    detail: failureReason ?? finalAnswer,
    startedAt,
    completedAt: new Date(),
    payload: {
      input: {
        task,
        artifactCount: artifacts.length,
        failedToolCalls: failedToolCalls.length,
        successfulToolCalls,
      },
      output: {
        ok: !failureReason,
        finalAnswer: limitText(finalAnswer, 4_000),
        failureReason,
        artifacts: artifacts.map(publicArtifactForTrace),
      },
    },
  });

  return {
    finalAnswer,
    complexity: {
      mode: taskFrame.researchDepth === "none" || taskFrame.researchDepth === "single_source" ? "direct" : "delegated",
      reason: `Base runtime selected ${taskFrame.mode}: ${taskFrame.reason}`,
      domains: [taskFrame.mode],
      riskLevel: failureReason ? "medium" : "low",
    },
    subtasks: [],
    workerResults: [],
    reviews: [],
    artifacts,
    actionProposals,
    toolCreationRequests: toolCreationRequests.map((request) => ({
      toolName: request.toolName,
      toolVersion: request.toolVersion,
      request: request.request.request,
      status: request.status,
      runId: request.runId,
      creationId: request.creationId,
      packageRef: request.packageRef,
      error: request.error,
    })),
    toolEditRequests: toolEditRequests.map((request) => ({
      toolName: request.toolName,
      toolVersion: request.toolVersion,
      request: request.request.request,
      status: request.status,
      runId: request.runId,
      creationId: request.creationId,
      packageRef: request.packageRef,
      activeVersion: request.activeVersion,
      replacesVersion: request.replacesVersion,
      error: request.error,
    })),
    runStatus: failureReason ? "failed" : "completed",
    runFailureReason: failureReason,
  };
}

function missingToolPrimaryResults(finalAnswer: string, primaryResults: ToolPrimaryResult[]): ToolPrimaryResult[] {
  const unique = new Map<string, ToolPrimaryResult>();
  for (const result of primaryResults) {
    unique.set(`${result.toolName}:${result.toolVersion ?? ""}:${result.path}:${result.valuePreview}`, result);
  }
  return [...unique.values()].filter((result) => !finalAnswerIncludesPrimaryResult(finalAnswer, result));
}

function finalAnswerIncludesPrimaryResult(finalAnswer: string, result: ToolPrimaryResult): boolean {
  const answer = finalAnswer.toLowerCase();
  const path = result.path.toLowerCase();
  const label = result.path.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const value = result.valuePreview.toLowerCase().replace(/^"|"$/g, "");
  return (answer.includes(path) || answer.includes(label)) && (!value || answer.includes(value));
}

function finalAnswerWithPrimaryToolResults(finalAnswer: string, results: ToolPrimaryResult[]): string {
  return `${finalAnswer.trim()}\n\nTool contract fields: ${results.map(formatPrimaryResult).join("; ")}`;
}

function formatPrimaryResult(result: ToolPrimaryResult): string {
  const version = result.toolVersion ? `@${result.toolVersion}` : "";
  return `${result.toolName}${version}.${result.path} = ${result.valuePreview}`;
}

function publicPrimaryResult(result: ToolPrimaryResult): Record<string, unknown> {
  return {
    toolName: result.toolName,
    toolVersion: result.toolVersion,
    path: result.path,
    valuePreview: result.valuePreview,
  };
}
