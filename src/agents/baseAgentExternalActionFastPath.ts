import type { AgentArtifact, AgentRunResult } from "../types.js";
import { finalizeBaseAgentRun } from "./baseAgentFinalization.js";
import { emit } from "./baseAgentRuntime.js";
import type { BaseAgentRunContext, BaseAgentRunOptions } from "./baseAgentTypes.js";
import type { TaskFrame } from "./taskFrame.js";

type ExternalActionFastPathInput = {
  task: string;
  options: BaseAgentRunOptions;
  runContext: BaseAgentRunContext;
  taskFrame: TaskFrame;
  startedAt: Date;
  rootSpanId: string;
  maxSteps?: number;
};

export async function tryRunExternalActionFastPath(
  input: ExternalActionFastPathInput,
): Promise<AgentRunResult | undefined> {
  const url = explicitActionUrl(input.task);
  if (!url || !shouldUseExplicitPrepareUrlFastPath(input.task, input.taskFrame)) {
    return undefined;
  }

  await emit(input.options.onEvent, {
    parentSpanId: input.rootSpanId,
    type: "external-action-fast-path-selected",
    actor: "base-agent",
    activity: "agent",
    status: "completed",
    title: "External action fast path selected",
    detail: "Using explicit action URL to create an approval proposal without source probing.",
    startedAt: input.startedAt,
    completedAt: new Date(),
    payload: {
      input: {
        task: input.task,
        actionType: input.taskFrame.externalActionPolicy?.actionType,
      },
      output: {
        targetUrl: url,
      },
    },
  });

  const finalAnswer = [
    "Подготовлен черновик внешнего действия без отправки.",
    "",
    `Форма: [открыть форму](${url})`,
    "",
    "Данные из запроса будут использованы для подготовки формы после approval. Финальная отправка не выполнена.",
  ].join("\n");

  const artifacts: AgentArtifact[] = [];
  return finalizeBaseAgentRun({
    task: input.task,
    options: input.options,
    startedAt: input.startedAt,
    rootSpanId: input.rootSpanId,
    maxSteps: input.maxSteps,
    stoppedByStepLimit: false,
    finalAnswer,
    latestDraftAnswerForProof: finalAnswer,
    structuredProofArtifacts: [],
    taskFrame: input.taskFrame,
    successfulResearchToolCalls: 0,
    successfulSourceReadToolCalls: 0,
    runContext: input.runContext,
    artifacts,
    externalDataEvidenceUrls: new Set(),
    proofEvidenceByUrl: new Map(),
    externalEvidenceUrls: new Set(),
    actionProposals: [],
    requiredArtifacts: { screenshot: false },
    failedToolCalls: [],
    successfulToolCalls: 0,
    attemptedToolCalls: 0,
    toolCreationRequests: [],
    toolEditRequests: [],
    usedScopedCandidates: new Map(),
    acceptedCandidateKeys: new Set(),
    primaryToolResults: [],
  });
}

function shouldUseExplicitPrepareUrlFastPath(task: string, taskFrame: TaskFrame): boolean {
  const policy = taskFrame.externalActionPolicy;
  if (!policy) return false;
  if (!policy.requiresApprovalBeforeExecution) return false;
  if (!safePrepareWording(task)) return false;
  return !requiresProviderDiscovery(task);
}

function safePrepareWording(task: string): boolean {
  return /(?:тольк[оa]\s+подготовь|не\s+отправляй|без\s+отправк|покажи,?\s+что\s+заполнено|до\s+финальн|перед\s+(?:отправк|подтвержд|сабмит)|do\s+not\s+submit|don't\s+submit|prepare(?:\s+only)?|without\s+(?:submitting|sending))/iu.test(
    task,
  );
}

function requiresProviderDiscovery(task: string): boolean {
  return /(?:найди|подбери|посоветуй|порекомендуй|лучший\s+(?:вариант|ресторан|барбершоп|салон)|find\s+(?:me\s+)?(?:a|the\s+best|best)|recommend|choose\s+(?:the\s+best|a)|pick\s+(?:the\s+best|a))/iu.test(
    task,
  );
}

function explicitActionUrl(task: string): string | undefined {
  const match = task.match(/https?:\/\/[^\s<>"')\]]+/iu);
  if (!match) return undefined;
  try {
    return new URL(match[0].replace(/[.,;:!?]+$/u, "")).href;
  } catch {
    return undefined;
  }
}
