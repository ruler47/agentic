import type { AgentArtifact, AgentRunResult, ExternalActionProposal, Message } from "../types.js";
import type { LlmClient } from "../llm/client.js";
import type { ModelCapability } from "../settings/modelCatalog.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  attachInitialScopedCandidates,
  buildToolCatalog,
  selectTools,
  type BaseAgentToolCatalogEntry,
} from "./agentToolCatalog.js";
import { DEFAULT_AGENT_LOOP_TIER, DEFAULT_LLM_MAX_TOKENS, DEFAULT_TOOL_TIMEOUT_MS } from "./baseAgentConstants.js";
import { emitBaseAgentContextEvents } from "./baseAgentContextEvents.js";
import { inferRequiredArtifacts } from "./baseAgentEvidence.js";
import { tryRunCurrentFactFastPath } from "./baseAgentCurrentFact.js";
import { finalizeBaseAgentRun } from "./baseAgentFinalization.js";
import { tryRunLocalUtilityFastPath } from "./baseAgentLocalUtility.js";
import { prepareBaseAgentPriorWork } from "./baseAgentPriorWork.js";
import { handleBaseAgentRegisteredToolCall } from "./baseAgentToolExecution.js";
import { buildBaseAgentSystemPrompt, buildBaseAgentToolSchemas, FINAL_STEP_WRAP_UP_NUDGE } from "./baseAgentPrompt.js";
import { handleBaseAgentToolLifecycleCall } from "./baseAgentToolLifecycle.js";
import {
  candidateUseRepairInstructionForModel,
  proofRepairInstructionForModel,
  sourceGroundingRepairInstructionForModel,
} from "./baseAgentProof.js";
import { emit, hasRemainingSteps, hasRemainingToolCalls, runWithTimeout } from "./baseAgentRuntime.js";
import { emitBaseAgentToolEvent, resolveBaseAgentTool } from "./baseAgentToolRuntimeHelpers.js";
import {
  limitText,
  publicToolCreationOutcomeForTrace,
  publicToolEditOutcomeForTrace,
  toolMessage,
} from "./baseAgentToolMessages.js";
import {
  compactToolMessagesForContextBudget,
  pushFinalStepNudge,
  recoverFromContextOverflow,
  requestTruncatedAnswerRepair,
} from "./baseAgentTruncation.js";
import { taskWithThreadContextForFraming } from "./baseAgentThreadContext.js";
import { shouldAnswerWithoutTools } from "./baseAgentToolChoice.js";
import { handleWorkingBoardToolCall, llmSemanticTitle } from "./baseAgentWorkingBoard.js";
import {
  containsRawToolCallSyntax,
  createAgentSpanId,
  createLlmSpanId,
  failedResult,
  normalizeRunContext,
  publicArtifactForTrace,
  publicMessageForTrace,
  publicProofEvidenceForTrace,
} from "./baseAgentTrace.js";
import type {
  BaseAgentRunOptions,
  BaseAgentToolCandidateAccepted,
  CachedToolCall,
  FailedToolCall,
  ProofEvidence,
  ToolPrimaryResult,
  ToolCreationOutcome,
  ToolEditOutcome,
} from "./baseAgentTypes.js";
import { PROOF_SOURCE_URL_LIMIT } from "./proofSourceUrls.js";
import { defaultMaxStepsForTaskFrame, frameTask, researchContractRepairInstructionForModel, shouldRequireResearchContract } from "./taskFrame.js";

export type { BaseAgentToolCatalogEntry } from "./agentToolCatalog.js";
export type { BaseAgentRunContext, BaseAgentRunOptions, BaseAgentToolCandidateAccepted, BaseAgentToolCreationRequest, BaseAgentToolCreationResult, BaseAgentToolEditRequest, BaseAgentToolEditResult } from "./baseAgentTypes.js";

export class BaseAgent {
  constructor(
    private readonly llm: LlmClient,
    private readonly tools: ToolRegistry,
  ) {}

  async run(task: string, options: BaseAgentRunOptions = {}): Promise<AgentRunResult> {
    const startedAt = new Date();
    const artifacts: AgentArtifact[] = [];
    const failedToolCalls: FailedToolCall[] = [];
    const toolCreationRequests: ToolCreationOutcome[] = [];
    const toolEditRequests: ToolEditOutcome[] = [];
    const actionProposals: ExternalActionProposal[] = [];
    const structuredProofArtifacts: AgentArtifact[] = [];
    const primaryToolResults: ToolPrimaryResult[] = [];
    const acceptedCandidateKeys = new Set<string>();
    const usedScopedCandidates = new Map<string, BaseAgentToolCandidateAccepted>();
    const toolResultCache = new Map<string, CachedToolCall>();
    const externalEvidenceUrls = new Set<string>();
    const externalDataEvidenceUrls = new Set<string>();
    const proofEvidenceByUrl = new Map<string, ProofEvidence>();
    const searchQueryHistory = new Map<string, string>();
    let runContext = normalizeRunContext(options.runContext, options.runId, startedAt);
    const taskFrame = frameTask(taskWithThreadContextForFraming(task, runContext));
    const maxSteps = options.maxSteps ?? defaultMaxStepsForTaskFrame(taskFrame);
    const maxToolCalls = options.maxToolCalls ?? maxSteps * 4;
    const llmTimeoutMs = options.llmTimeoutMs;
    const toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    let successfulToolCalls = 0;
    let attemptedToolCalls = 0;
    let terminalFailureReason: string | undefined;
    let stoppedByStepLimit = false;
    let answerRepairExtensions = 0;
    let rawSyntaxRepairAttempts = 0;
    let successfulResearchToolCalls = 0;
    let successfulSourceReadToolCalls = 0;
    let researchRepairAttempts = 0;
    let sourceGroundingRepairAttempts = 0;
    let latestDraftAnswerForProof = "";
    const requiredArtifacts = inferRequiredArtifacts(task);
    const rootSpanId = createAgentSpanId(runContext.runId, "root");
    const contextSpanId = createAgentSpanId(runContext.runId, "context");
    const taskFrameSpanId = createAgentSpanId(runContext.runId, "task-frame");
    let tools = selectTools(this.tools.list(), options.toolPolicy);
    let toolCatalog = buildToolCatalog(tools, options.toolCatalog);
    ({ tools, toolCatalog } = attachInitialScopedCandidates({
      candidates: options.initialScopedToolCandidates ?? [],
      tools,
      toolCatalog,
      toolCreationRequests: toolCreationRequests as unknown as Array<Record<string, unknown>>,
    }));

    await emit(options.onEvent, {
      spanId: rootSpanId,
      type: "agent-invocation-started",
      actor: "base-agent",
      activity: "agent",
      status: "started",
      title: "Base agent started",
      detail: requiredArtifacts.screenshot
        ? "Task requires a screenshot artifact."
        : "Minimal agent loop started.",
      startedAt,
    });

    await emitBaseAgentContextEvents({
      onEvent: options.onEvent,
      rootSpanId,
      contextSpanId,
      runContext,
      tools,
      toolCatalog,
      startedAt,
      maxSteps,
      maxToolCalls,
      llmTimeoutMs,
      toolTimeoutMs,
      toolPolicy: options.toolPolicy,
    });

    await emit(options.onEvent, {
      spanId: taskFrameSpanId,
      parentSpanId: rootSpanId,
      type: "agent-task-framed",
      actor: "base-agent",
      activity: "agent",
      status: "completed",
      title: "Task framed",
      detail: `${taskFrame.mode}: ${taskFrame.reason}`,
      startedAt,
      completedAt: new Date(),
      payload: {
        input: { task },
        output: taskFrame,
        taskFrame,
      },
    });

    const priorWork = await prepareBaseAgentPriorWork({
      task,
      options,
      runContext,
      taskFrame,
      startedAt,
      rootSpanId,
      maxSteps,
    });
    runContext = priorWork.runContext;
    if (priorWork.result) return priorWork.result;

    const localUtilityResult = await tryRunLocalUtilityFastPath({ task, options, runContext, taskFrame, tools, registry: this.tools, startedAt, rootSpanId, maxSteps, toolTimeoutMs });
    if (localUtilityResult) return localUtilityResult;
    const currentFactResult = await tryRunCurrentFactFastPath({ task, options, runContext, taskFrame, tools, registry: this.tools, llm: this.llm, startedAt, rootSpanId, maxSteps, toolTimeoutMs });
    if (currentFactResult) return currentFactResult;

    const messages: Message[] = [
      { role: "system", content: buildBaseAgentSystemPrompt(runContext, tools, toolCatalog, taskFrame) },
      { role: "user", content: task },
    ];
    let finalAnswer = "";
    let proofRepairAttempts = 0;
    let candidateUseRepairAttempts = 0;
    let truncatedAnswerRepairAttempts = 0;

    for (let step = 1; maxSteps === undefined || step <= maxSteps + answerRepairExtensions; step += 1) {
      if (options.signal?.aborted) {
        return failedResult("Run cancelled.", artifacts);
      }

      const llmSpanId = createLlmSpanId(runContext.runId, step);
      const toolSchemas = buildBaseAgentToolSchemas(tools, toolCatalog);
      const isFinalBudgetedStep = maxSteps !== undefined && step >= maxSteps && step > 1;
      if (isFinalBudgetedStep) pushFinalStepNudge(messages, FINAL_STEP_WRAP_UP_NUDGE);
      const stepToolChoice = isFinalBudgetedStep || shouldAnswerWithoutTools({
        step,
        taskFrame,
        hasRunScopedCandidates: (options.initialScopedToolCandidates ?? []).length > 0,
      })
        ? ("none" as const)
        : ("auto" as const);
      const preferredModelCapabilities: ModelCapability[] = stepToolChoice === "auto" && toolSchemas.length > 0
        ? ["tool-calling"]
        : [];
      compactToolMessagesForContextBudget(messages);
      const llmInput = {
        step,
        modelTier: options.modelTier ?? DEFAULT_AGENT_LOOP_TIER,
        toolChoice: stepToolChoice,
        preferredModelCapabilities,
        maxTokens: DEFAULT_LLM_MAX_TOKENS,
        messages: messages.map(publicMessageForTrace),
        tools: toolSchemas.map((schema) => schema.function.name),
      };
      const llmStartedAt = new Date();
      let reply;
      try {
        reply = await runWithTimeout(
          `LLM step ${step}`,
          llmTimeoutMs,
          options.signal,
          (signal) => this.llm.completeWithTools(messages, toolSchemas, {
            modelTier: options.modelTier ?? DEFAULT_AGENT_LOOP_TIER,
            signal,
            toolChoice: stepToolChoice,
            maxTokens: DEFAULT_LLM_MAX_TOKENS,
            preferredCapabilities: preferredModelCapabilities,
            onRouteDecision: async (decision) => {
              await emit(options.onEvent, {
                spanId: `${llmSpanId}:model-route`,
                parentSpanId: rootSpanId,
                type: "model-route-selected",
                actor: "base-agent",
                activity: "llm",
                status: "completed",
                title: "Model route selected",
                detail: decision.reason,
                startedAt: llmStartedAt,
                completedAt: new Date(),
                payload: decision,
              });
            },
          }),
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (recoverFromContextOverflow(messages, errorMessage)) {
          step -= 1;
          continue;
        }
        terminalFailureReason = errorMessage;
        finalAnswer = terminalFailureReason;
        break;
      }

      const llmCompletedAt = new Date();
      await emit(options.onEvent, {
        spanId: llmSpanId,
        parentSpanId: rootSpanId,
        type: "agent-invocation-decision-selected",
        actor: "base-agent",
        activity: "llm",
        status: "completed",
        title: `LLM step ${step}`,
        detail: reply.finishReason === "tool_calls"
          ? `Model requested ${reply.toolCalls.length} tool call(s).`
          : "Model returned a final answer.",
        startedAt: llmStartedAt,
        completedAt: llmCompletedAt,
        durationMs: Math.max(0, llmCompletedAt.getTime() - llmStartedAt.getTime()),
        payload: {
          step,
          semanticTitle: llmSemanticTitle(reply.finishReason, reply.toolCalls.map((call) => call.name)),
          model: reply.model,
          usage: reply.usage,
          input: llmInput,
          output: {
            finishReason: reply.finishReason,
            model: reply.model,
            usage: reply.usage,
            content: limitText(reply.content, 4_000),
            toolCalls: reply.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            })),
          },
          finishReason: reply.finishReason,
          toolCalls: reply.toolCalls.map((call) => ({ id: call.id, name: call.name })),
          contentPreview: limitText(reply.content, 500),
        },
      });

      if (reply.finishReason !== "tool_calls" || reply.toolCalls.length === 0) {
        finalAnswer = reply.content || "(empty)";
        if (reply.finishReason === "length") {
          const repair = await requestTruncatedAnswerRepair({
            finalAnswer,
            repairAttempts: truncatedAnswerRepairAttempts,
            step,
            maxSteps,
            messages,
            onEvent: options.onEvent,
            parentSpanId: llmSpanId,
            startedAt,
          });
          if (repair.repaired) {
            truncatedAnswerRepairAttempts = repair.repairAttempts;
            if (maxSteps !== undefined && step >= maxSteps + answerRepairExtensions) {
              answerRepairExtensions += 1;
            }
            finalAnswer = "";
            continue;
          }
          terminalFailureReason = repair.failureReason;
          break;
        }
        // Local models sometimes leak XML/JSON tool-call syntax as prose on
        // the no-tools wrap-up step. One corrective retry, then the
        // finalization gate fails the run honestly.
        if (containsRawToolCallSyntax(finalAnswer) && rawSyntaxRepairAttempts < 1) {
          rawSyntaxRepairAttempts += 1;
          messages.push({ role: "assistant", content: finalAnswer });
          messages.push({
            role: "user",
            content:
              "Your previous output was raw tool-call syntax, which is invalid as a final answer. " +
              "Write the final user-facing answer in plain prose now from the evidence already collected. Do not emit tool-call syntax.",
          });
          if (maxSteps !== undefined && step >= maxSteps + answerRepairExtensions) answerRepairExtensions += 1;
          finalAnswer = "";
          continue;
        }
        const candidateUseRepairInstruction = candidateUseRepairInstructionForModel({
          task,
          finalAnswer,
          toolCreationRequests,
          toolEditRequests,
          usedScopedCandidates,
        });
        if (
          candidateUseRepairInstruction &&
          candidateUseRepairAttempts < 2 &&
          hasRemainingSteps(step, maxSteps) &&
          hasRemainingToolCalls(attemptedToolCalls, maxToolCalls)
        ) {
          candidateUseRepairAttempts += 1;
          messages.push({ role: "assistant", content: finalAnswer });
          messages.push({ role: "user", content: candidateUseRepairInstruction });
          await emit(options.onEvent, {
            parentSpanId: llmSpanId,
            type: "agent-candidate-use-repair-requested",
            actor: "base-agent",
            activity: "agent",
            status: "completed",
            title: "Candidate use repair requested",
            detail: "Final answer was blocked until the run-scoped tool candidate is used.",
            startedAt,
            completedAt: new Date(),
            payload: {
              attempt: candidateUseRepairAttempts,
              input: {
                finalAnswer: limitText(finalAnswer, 4_000),
                toolCreationRequests: toolCreationRequests.map(publicToolCreationOutcomeForTrace),
                toolEditRequests: toolEditRequests.map(publicToolEditOutcomeForTrace),
              },
              output: {
                instruction: candidateUseRepairInstruction,
              },
            },
          });
          finalAnswer = "";
          continue;
        }
        const researchRepairInstruction = researchContractRepairInstructionForModel({
          taskFrame,
          finalAnswer,
          sourceUrls: [...externalDataEvidenceUrls],
          successfulResearchToolCalls,
          successfulSourceReadToolCalls,
          attemptedToolCalls,
          maxToolCalls,
          tools,
        });
        if (
          researchRepairInstruction &&
          researchRepairAttempts < 2 &&
          hasRemainingSteps(step, maxSteps) &&
          hasRemainingToolCalls(attemptedToolCalls, maxToolCalls)
        ) {
          researchRepairAttempts += 1;
          messages.push({ role: "assistant", content: finalAnswer });
          messages.push({ role: "user", content: researchRepairInstruction });
          await emit(options.onEvent, {
            parentSpanId: llmSpanId,
            type: "agent-research-contract-repair-requested",
            actor: "base-agent",
            activity: "agent",
            status: "completed",
            title: "Research contract repair requested",
            detail: "Final answer was blocked until the broad-task research contract is satisfied.",
            startedAt,
            completedAt: new Date(),
            payload: {
              attempt: researchRepairAttempts,
              taskFrame,
              input: {
                finalAnswer: limitText(finalAnswer, 4_000),
                sourceUrls: [...externalDataEvidenceUrls].slice(0, PROOF_SOURCE_URL_LIMIT),
                successfulResearchToolCalls,
                successfulSourceReadToolCalls,
              },
              output: {
                instruction: researchRepairInstruction,
              },
            },
          });
          finalAnswer = "";
          continue;
        }
        const sourceGroundingRepairInstruction = sourceGroundingRepairInstructionForModel({
          taskFrame,
          finalAnswer,
          sourceUrls: [...externalDataEvidenceUrls],
          proofEvidence: [...proofEvidenceByUrl.values()],
          successfulResearchToolCalls,
        });
        if (
          sourceGroundingRepairInstruction &&
          sourceGroundingRepairAttempts < 2 &&
          hasRemainingSteps(step, maxSteps) &&
          hasRemainingToolCalls(attemptedToolCalls, maxToolCalls)
        ) {
          sourceGroundingRepairAttempts += 1;
          messages.push({ role: "assistant", content: finalAnswer });
          messages.push({ role: "user", content: sourceGroundingRepairInstruction });
          await emit(options.onEvent, {
            parentSpanId: llmSpanId,
            type: "agent-source-grounding-repair-requested",
            actor: "base-agent",
            activity: "agent",
            status: "completed",
            title: "Source grounding repair requested",
            detail: "Final answer was blocked until concrete claims are tied to source evidence.",
            startedAt,
            completedAt: new Date(),
            payload: {
              attempt: sourceGroundingRepairAttempts,
              input: {
                finalAnswer: limitText(finalAnswer, 4_000),
                sourceUrls: [...externalDataEvidenceUrls].slice(0, PROOF_SOURCE_URL_LIMIT),
                proofEvidence: [...proofEvidenceByUrl.values()].map(publicProofEvidenceForTrace),
              },
              output: {
                instruction: sourceGroundingRepairInstruction,
              },
            },
          });
          finalAnswer = "";
          continue;
        }
        const proofRepairInstruction = taskFrame.externalActionPolicy
          ? undefined
          : proofRepairInstructionForModel({
              finalAnswer,
              task,
              sourceUrls: [...externalEvidenceUrls],
              proofEvidence: [...proofEvidenceByUrl.values()],
              artifacts,
              tools,
              artifactSavingAvailable: Boolean(options.saveArtifact),
            });
        if (
          proofRepairInstruction &&
          proofRepairAttempts < 2 &&
          hasRemainingSteps(step, maxSteps) &&
          hasRemainingToolCalls(attemptedToolCalls, maxToolCalls)
        ) {
          proofRepairAttempts += 1;
          latestDraftAnswerForProof = finalAnswer;
          messages.push({ role: "assistant", content: finalAnswer });
          messages.push({ role: "user", content: proofRepairInstruction });
          await emit(options.onEvent, {
            parentSpanId: llmSpanId,
            type: "agent-proof-repair-requested",
            actor: "base-agent",
            activity: "agent",
            status: "completed",
            title: "Proof repair requested",
            detail: "Final answer was blocked until a source proof artifact is produced.",
            startedAt,
            completedAt: new Date(),
            payload: {
              attempt: proofRepairAttempts,
              input: {
                finalAnswer: limitText(finalAnswer, 4_000),
                sourceUrls: [...externalEvidenceUrls].slice(0, PROOF_SOURCE_URL_LIMIT),
                artifacts: artifacts.map(publicArtifactForTrace),
              },
              output: {
                instruction: proofRepairInstruction,
              },
            },
          });
          finalAnswer = "";
          continue;
        }
        break;
      }

      messages.push({
        role: "assistant",
        content: reply.content || "",
        tool_calls: reply.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      });

      for (const call of reply.toolCalls) {
        if (await handleWorkingBoardToolCall({ call, messages, onEvent: options.onEvent, parentSpanId: llmSpanId, startedAt })) continue;

        if (call.name === "finish") {
          finalAnswer = typeof call.arguments.answer === "string"
            ? call.arguments.answer
            : reply.content || "(empty)";
          const candidateUseRepairInstruction = candidateUseRepairInstructionForModel({
            task,
            finalAnswer,
            toolCreationRequests,
            toolEditRequests,
            usedScopedCandidates,
          });
          if (
            candidateUseRepairInstruction &&
            candidateUseRepairAttempts < 2 &&
            hasRemainingSteps(step, maxSteps) &&
            hasRemainingToolCalls(attemptedToolCalls, maxToolCalls)
          ) {
            candidateUseRepairAttempts += 1;
            messages.push(toolMessage(call.id, false, candidateUseRepairInstruction));
            messages.push({ role: "user", content: candidateUseRepairInstruction });
            await emit(options.onEvent, {
              parentSpanId: llmSpanId,
              type: "agent-candidate-use-repair-requested",
              actor: "base-agent",
              activity: "agent",
              status: "completed",
              title: "Candidate use repair requested",
              detail: "finish() was blocked until the run-scoped tool candidate is used.",
              startedAt,
              completedAt: new Date(),
              payload: {
                attempt: candidateUseRepairAttempts,
                input: {
                  finalAnswer: limitText(finalAnswer, 4_000),
                  toolCreationRequests: toolCreationRequests.map(publicToolCreationOutcomeForTrace),
                  toolEditRequests: toolEditRequests.map(publicToolEditOutcomeForTrace),
                },
                output: {
                  instruction: candidateUseRepairInstruction,
                },
              },
            });
            finalAnswer = "";
            continue;
          }
          const researchRepairInstruction = researchContractRepairInstructionForModel({
            taskFrame,
            finalAnswer,
            sourceUrls: [...externalDataEvidenceUrls],
            successfulResearchToolCalls,
            successfulSourceReadToolCalls,
            attemptedToolCalls,
            maxToolCalls,
            tools,
          });
          if (
            researchRepairInstruction &&
            researchRepairAttempts < 2 &&
            hasRemainingSteps(step, maxSteps) &&
            hasRemainingToolCalls(attemptedToolCalls, maxToolCalls)
          ) {
            researchRepairAttempts += 1;
            messages.push(toolMessage(call.id, false, researchRepairInstruction));
            messages.push({ role: "user", content: researchRepairInstruction });
            await emit(options.onEvent, {
              parentSpanId: llmSpanId,
              type: "agent-research-contract-repair-requested",
              actor: "base-agent",
              activity: "agent",
              status: "completed",
              title: "Research contract repair requested",
              detail: "finish() was blocked until the broad-task research contract is satisfied.",
              startedAt,
              completedAt: new Date(),
              payload: {
                attempt: researchRepairAttempts,
                taskFrame,
                input: {
                  finalAnswer: limitText(finalAnswer, 4_000),
                  sourceUrls: [...externalDataEvidenceUrls].slice(0, PROOF_SOURCE_URL_LIMIT),
                  successfulResearchToolCalls,
                  successfulSourceReadToolCalls,
                },
                output: {
                  instruction: researchRepairInstruction,
                },
              },
            });
            finalAnswer = "";
            continue;
          }
          const sourceGroundingRepairInstruction = sourceGroundingRepairInstructionForModel({
            taskFrame,
            finalAnswer,
            sourceUrls: [...externalDataEvidenceUrls],
            proofEvidence: [...proofEvidenceByUrl.values()],
            successfulResearchToolCalls,
          });
          if (
            sourceGroundingRepairInstruction &&
            sourceGroundingRepairAttempts < 2 &&
            hasRemainingSteps(step, maxSteps) &&
            hasRemainingToolCalls(attemptedToolCalls, maxToolCalls)
          ) {
            sourceGroundingRepairAttempts += 1;
            messages.push(toolMessage(call.id, false, sourceGroundingRepairInstruction));
            messages.push({ role: "user", content: sourceGroundingRepairInstruction });
            await emit(options.onEvent, {
              parentSpanId: llmSpanId,
              type: "agent-source-grounding-repair-requested",
              actor: "base-agent",
              activity: "agent",
              status: "completed",
              title: "Source grounding repair requested",
              detail: "finish() was blocked until concrete claims are tied to source evidence.",
              startedAt,
              completedAt: new Date(),
              payload: {
                attempt: sourceGroundingRepairAttempts,
                input: {
                  finalAnswer: limitText(finalAnswer, 4_000),
                  sourceUrls: [...externalDataEvidenceUrls].slice(0, PROOF_SOURCE_URL_LIMIT),
                  proofEvidence: [...proofEvidenceByUrl.values()].map(publicProofEvidenceForTrace),
                },
                output: {
                  instruction: sourceGroundingRepairInstruction,
                },
              },
            });
            finalAnswer = "";
            continue;
          }
          const proofRepairInstruction = taskFrame.externalActionPolicy
            ? undefined
            : proofRepairInstructionForModel({
                finalAnswer,
                task,
                sourceUrls: [...externalEvidenceUrls],
                proofEvidence: [...proofEvidenceByUrl.values()],
                artifacts,
                tools,
                artifactSavingAvailable: Boolean(options.saveArtifact),
              });
          if (
            proofRepairInstruction &&
            proofRepairAttempts < 2 &&
            hasRemainingSteps(step, maxSteps) &&
            hasRemainingToolCalls(attemptedToolCalls, maxToolCalls)
          ) {
            proofRepairAttempts += 1;
            latestDraftAnswerForProof = finalAnswer;
            messages.push(toolMessage(call.id, false, proofRepairInstruction));
            messages.push({ role: "user", content: proofRepairInstruction });
            await emit(options.onEvent, {
              parentSpanId: llmSpanId,
              type: "agent-proof-repair-requested",
              actor: "base-agent",
              activity: "agent",
              status: "completed",
              title: "Proof repair requested",
              detail: "finish() was blocked until a source proof artifact is produced.",
              startedAt,
              completedAt: new Date(),
              payload: {
                attempt: proofRepairAttempts,
                input: {
                  finalAnswer: limitText(finalAnswer, 4_000),
                  sourceUrls: [...externalEvidenceUrls].slice(0, PROOF_SOURCE_URL_LIMIT),
                  artifacts: artifacts.map(publicArtifactForTrace),
                },
                output: {
                  instruction: proofRepairInstruction,
                },
              },
            });
            finalAnswer = "";
            continue;
          }
          break;
        }

        const lifecycleResult = await handleBaseAgentToolLifecycleCall({
          call,
          task,
          step,
          llmSpanId,
          options,
          failedToolCalls,
          messages,
          toolCreationRequests,
          toolEditRequests,
          tools,
          toolCatalog,
        });
        tools = lifecycleResult.tools;
        toolCatalog = lifecycleResult.toolCatalog;
        if (lifecycleResult.handled) continue;

        const toolCallResult = await handleBaseAgentRegisteredToolCall({
          call,
          task,
          step,
          llmSpanId,
          options,
          runContext,
          taskFrame,
          tools,
          toolCatalog,
          messages,
          artifacts,
          failedToolCalls,
          structuredProofArtifacts,
          toolResultCache,
          searchQueryHistory,
          externalEvidenceUrls,
          externalDataEvidenceUrls,
          proofEvidenceByUrl,
          usedScopedCandidates,
          primaryToolResults,
          maxToolCalls,
          toolTimeoutMs,
          attemptedToolCalls,
          successfulToolCalls,
          successfulResearchToolCalls,
          successfulSourceReadToolCalls,
          terminalFailureReason,
          finalAnswer,
          latestDraftAnswerForProof,
          proofRepairAttempts,
          resolveTool: resolveBaseAgentTool,
          executeTool: (tool, toolInput, context) => this.tools.execute(tool, toolInput, context),
          emitToolEvent: emitBaseAgentToolEvent,
        });
        attemptedToolCalls = toolCallResult.attemptedToolCalls;
        successfulToolCalls = toolCallResult.successfulToolCalls;
        successfulResearchToolCalls = toolCallResult.successfulResearchToolCalls;
        successfulSourceReadToolCalls = toolCallResult.successfulSourceReadToolCalls;
        terminalFailureReason = toolCallResult.terminalFailureReason;
        finalAnswer = toolCallResult.finalAnswer;
        if (toolCallResult.control === "break") break;

      }

      if (finalAnswer || terminalFailureReason) break;
      if (maxSteps !== undefined && step === maxSteps) stoppedByStepLimit = true;
    }

    return finalizeBaseAgentRun({
      task,
      options,
      startedAt,
      rootSpanId,
      maxSteps,
      stoppedByStepLimit,
      finalAnswer,
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
    });
  }
}
