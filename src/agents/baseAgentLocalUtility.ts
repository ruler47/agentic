import type { AgentArtifact, AgentRunResult } from "../types.js";
import type { Tool, ToolResult } from "../tools/tool.js";
import type { ToolRegistry } from "../tools/registry.js";
import { completeBaseAgentToolWork, completeBaseAgentToolWorkFromReuse, failBaseAgentToolWork, findReusableBaseAgentToolWork, claimBaseAgentToolWork } from "./baseAgentToolLedger.js";
import { finalizeBaseAgentRun } from "./baseAgentFinalization.js";
import { emit, runWithTimeout } from "./baseAgentRuntime.js";
import { emitBaseAgentToolEvent } from "./baseAgentToolRuntimeHelpers.js";
import { renderToolResultForModel } from "./baseAgentToolMessages.js";
import { createToolSpanId, summarizeToolResultForTrace } from "./baseAgentTrace.js";
import type { BaseAgentRunContext, BaseAgentRunOptions, FailedToolCall } from "./baseAgentTypes.js";
import type { TaskFrame } from "./taskFrame.js";

type LocalUtilityFastPathInput = {
  task: string;
  options: BaseAgentRunOptions;
  runContext: BaseAgentRunContext;
  taskFrame: TaskFrame;
  tools: Tool[];
  registry: ToolRegistry;
  startedAt: Date;
  rootSpanId: string;
  maxSteps?: number;
  toolTimeoutMs: number;
};

type LocalUtilityPlan = {
  tool: Tool;
  toolInput: Record<string, unknown>;
  finalAnswer: (result: ToolResult, reused: boolean) => string;
};

export async function tryRunLocalUtilityFastPath(input: LocalUtilityFastPathInput): Promise<AgentRunResult | undefined> {
  if (input.taskFrame.mode !== "local_utility") return undefined;
  const plan = planDataTransform(input.task, input.tools);
  if (!plan) return undefined;

  const artifacts: AgentArtifact[] = [];
  const failedToolCalls: FailedToolCall[] = [];
  const toolSpanId = createToolSpanId(input.runContext.runId, 1, plan.tool.name);
  const toolStartedAt = Date.now();
  let finalAnswer = "";
  let successfulToolCalls = 0;
  let terminalFailureReason: string | undefined;

  await emit(input.options.onEvent, {
    parentSpanId: input.rootSpanId,
    type: "local-utility-fast-path-selected",
    actor: "base-agent",
    activity: "agent",
    status: "completed",
    title: "Local utility fast path selected",
    detail: `Using ${plan.tool.name} without the general ReAct prompt.`,
    startedAt: input.startedAt,
    completedAt: new Date(),
    payload: {
      taskFrame: input.taskFrame,
      toolName: plan.tool.name,
      input: plan.toolInput,
    },
  });

  await emit(input.options.onEvent, {
    spanId: toolSpanId,
    parentSpanId: input.rootSpanId,
    type: "tool-started",
    actor: plan.tool.name,
    activity: "tool",
    status: "started",
    title: `Tool started: ${plan.tool.name}`,
    detail: `Executing ${plan.tool.name}${plan.tool.version ? `@${plan.tool.version}` : ""}.`,
    startedAt: new Date(toolStartedAt),
    payload: { toolName: plan.tool.name, toolVersion: plan.tool.version, input: plan.toolInput },
  });

  const claim = await claimBaseAgentToolWork({
    ledger: input.options.ledger,
    tool: plan.tool,
    toolInput: plan.toolInput,
    runId: input.runContext.runId,
    threadId: input.runContext.threadId,
    instanceId: input.runContext.instanceId,
    toolSpanId,
    task: input.task,
    step: 1,
    attemptedToolCalls: 1,
    artifactCount: artifacts.length,
  });

  const reuse = await findReusableBaseAgentToolWork({
    ledger: input.options.ledger,
    tool: plan.tool,
    toolInput: plan.toolInput,
    task: input.task,
    toolSpanId,
  });
  if (reuse) {
    successfulToolCalls = 1;
    finalAnswer = plan.finalAnswer(reuse.result, true);
    await completeBaseAgentToolWorkFromReuse({
      ledger: input.options.ledger,
      claim,
      tool: plan.tool,
      toolInput: plan.toolInput,
      reuse,
      toolSpanId,
    });
    await emitBaseAgentToolEvent(input.options.onEvent, plan.tool.name, plan.toolInput, true, `Reused passed Work Ledger evidence for ${plan.tool.name}.`, Date.now() - toolStartedAt, {
      spanId: toolSpanId,
      parentSpanId: input.rootSpanId,
      toolVersion: plan.tool.version,
      ledgerReuse: {
        reusedFromWorkItemId: reuse.reusedFromWorkItemId,
        evidenceIds: reuse.evidenceIds,
        artifactIds: reuse.artifactIds,
        sourceUrls: reuse.sourceUrls,
      },
      output: summarizeToolResultForTrace(reuse.result, reuse.preview),
    });
  } else {
    try {
      const result = await runWithTimeout(
        `Tool ${plan.tool.name}`,
        input.toolTimeoutMs,
        input.options.signal,
        (signal) => input.registry.execute(plan.tool, plan.toolInput, {
          signal,
          runId: input.runContext.runId,
          instanceId: input.runContext.instanceId,
          requesterUserId: input.runContext.requesterUserId,
          threadId: input.runContext.threadId,
          spanId: toolSpanId,
          caller: "base-agent-local-utility",
          resolveSecret: input.options.resolveSecret,
          resolveConfiguration: input.options.resolveConfiguration,
          audit: input.options.audit,
          logger: input.options.logger,
          callback: input.options.createToolCallback?.(plan.tool.name),
        }),
      );
      const preview = renderToolResultForModel(result, plan.tool);
      await completeBaseAgentToolWork({
        ledger: input.options.ledger,
        claim,
        tool: plan.tool,
        toolInput: plan.toolInput,
        result,
        preview,
        artifacts,
        toolSpanId,
        durationMs: Date.now() - toolStartedAt,
      });
      await emitBaseAgentToolEvent(input.options.onEvent, plan.tool.name, plan.toolInput, result.ok, result.content, Date.now() - toolStartedAt, {
        spanId: toolSpanId,
        parentSpanId: input.rootSpanId,
        toolVersion: plan.tool.version,
        output: summarizeToolResultForTrace(result, preview),
      });
      if (result.ok) {
        successfulToolCalls = 1;
        finalAnswer = plan.finalAnswer(result, false);
      } else {
        terminalFailureReason = result.content || `${plan.tool.name} returned a failed result.`;
        failedToolCalls.push({ toolName: plan.tool.name, message: terminalFailureReason });
      }
    } catch (error) {
      terminalFailureReason = error instanceof Error ? error.message : String(error);
      failedToolCalls.push({ toolName: plan.tool.name, message: terminalFailureReason });
      await failBaseAgentToolWork({
        ledger: input.options.ledger,
        claim,
        tool: plan.tool,
        toolInput: plan.toolInput,
        error: terminalFailureReason,
        toolSpanId,
        durationMs: Date.now() - toolStartedAt,
      });
      await emitBaseAgentToolEvent(input.options.onEvent, plan.tool.name, plan.toolInput, false, terminalFailureReason, Date.now() - toolStartedAt, {
        spanId: toolSpanId,
        parentSpanId: input.rootSpanId,
        toolVersion: plan.tool.version,
      });
    }
  }

  return finalizeBaseAgentRun({
    task: input.task,
    options: input.options,
    startedAt: input.startedAt,
    rootSpanId: input.rootSpanId,
    maxSteps: input.maxSteps,
    stoppedByStepLimit: false,
    finalAnswer,
    latestDraftAnswerForProof: "",
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
    failedToolCalls,
    successfulToolCalls,
    attemptedToolCalls: 1,
    terminalFailureReason,
    toolCreationRequests: [],
    toolEditRequests: [],
    usedScopedCandidates: new Map(),
    acceptedCandidateKeys: new Set(),
    primaryToolResults: [],
  });
}

function planDataTransform(task: string, tools: Tool[]): LocalUtilityPlan | undefined {
  const tool = tools.find((candidate) => candidate.name === "data.transform");
  if (!tool) return undefined;
  const json = extractFirstJsonLiteral(task);
  if (!json) return undefined;
  const operations = inferTransformOperations(task);
  const outputFormat = /\bcsv\b/i.test(task) ? "csv" : /\bjson\b/i.test(task) ? "json" : "text";
  const toolInput = { input: json, format: "json", operations, outputFormat };
  return {
    tool,
    toolInput,
    finalAnswer: (result, reused) => [
      reused ? "Готово. Использовал уже проверенный результат из Work Ledger." : "Готово. Выполнил локальное преобразование через data.transform.",
      "",
      outputFormat === "csv"
        ? `\`\`\`csv\n${resultContentForAnswer(result).trim()}\n\`\`\``
        : resultContentForAnswer(result).trim(),
    ].join("\n"),
  };
}

function resultContentForAnswer(result: ToolResult): string {
  return result.content.replace(/^Reused passed ledger evidence for [^\n]+\.?\n\n/s, "");
}

function inferTransformOperations(task: string): Array<Record<string, unknown>> {
  const operations: Array<Record<string, unknown>> = [];
  const sortField = task.match(/(?:по|by)\s+([A-Za-zА-Яа-я_][\w.-]*)/i)?.[1];
  if (/(?:sort|отсорт|сортир)/i.test(task) && sortField) {
    operations.push({
      type: "sort",
      path: sortField,
      direction: /(?:desc|descending|убыв|сначала\s+больш|по\s+убыв)/i.test(task) ? "desc" : "asc",
    });
  }
  return operations;
}

function extractFirstJsonLiteral(text: string): string | undefined {
  const start = text.search(/[\[{]/);
  if (start < 0) return undefined;
  const opener = text[start];
  const closer = opener === "[" ? "]" : "}";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === opener) depth += 1;
    if (char === closer) depth -= 1;
    if (depth === 0) {
      const candidate = text.slice(start, index + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
