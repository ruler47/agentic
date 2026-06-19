import type { AgentArtifact, AgentRunResult, ArtifactCreateInput } from "../types.js";
import type { Tool, ToolResult } from "../tools/tool.js";
import type { ToolRegistry } from "../tools/registry.js";
import { completeBaseAgentToolWork, completeBaseAgentToolWorkFromReuse, failBaseAgentToolWork, findReusableBaseAgentToolWork, claimBaseAgentToolWork } from "./baseAgentToolLedger.js";
import { finalizeBaseAgentRun } from "./baseAgentFinalization.js";
import { maybeSaveArtifact } from "./baseAgentArtifacts.js";
import { emit, runWithTimeout } from "./baseAgentRuntime.js";
import { emitBaseAgentToolEvent } from "./baseAgentToolRuntimeHelpers.js";
import { renderToolResultForModel, safeToolName } from "./baseAgentToolMessages.js";
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
  steps: LocalUtilityStep[];
  finalAnswer: (state: LocalUtilityState) => string;
};

type LocalUtilityStep = {
  tool: Tool;
  input: (state: LocalUtilityState) => Record<string, unknown>;
};

type LocalUtilityState = {
  artifacts: AgentArtifact[];
  results: Array<{ toolName: string; input: Record<string, unknown>; result: ToolResult; reused: boolean }>;
  lastContent?: string;
  outputPath?: string;
  reusedAny: boolean;
};

export async function tryRunLocalUtilityFastPath(input: LocalUtilityFastPathInput): Promise<AgentRunResult | undefined> {
  if (input.taskFrame.mode !== "local_utility") return undefined;
  const plan = planInlineDataTransform(input.task, input.tools)
    ?? planFileTransform(input.task, input.tools)
    ?? planDocumentExtractOrRead(input.task, input.tools);
  if (!plan) return undefined;

  const artifacts: AgentArtifact[] = [];
  const failedToolCalls: FailedToolCall[] = [];
  const state: LocalUtilityState = { artifacts, results: [], reusedAny: false };
  let successfulToolCalls = 0;
  let attemptedToolCalls = 0;
  let terminalFailureReason: string | undefined;

  await emit(input.options.onEvent, {
    parentSpanId: input.rootSpanId,
    type: "local-utility-fast-path-selected",
    actor: "base-agent",
    activity: "agent",
    status: "completed",
    title: "Local utility fast path selected",
    detail: `Using ${plan.steps.map((step) => step.tool.name).join(" -> ")} without the general ReAct prompt.`,
    startedAt: input.startedAt,
    completedAt: new Date(),
    payload: {
      taskFrame: input.taskFrame,
      tools: plan.steps.map((step) => step.tool.name),
    },
  });

  for (const step of plan.steps) {
    attemptedToolCalls += 1;
    const toolInput = step.input(state);
    const toolSpanId = createToolSpanId(input.runContext.runId, attemptedToolCalls, step.tool.name);
    const toolStartedAt = Date.now();

    await emit(input.options.onEvent, {
      spanId: toolSpanId,
      parentSpanId: input.rootSpanId,
      type: "tool-started",
      actor: step.tool.name,
      activity: "tool",
      status: "started",
      title: `Tool started: ${step.tool.name}`,
      detail: `Executing ${step.tool.name}${step.tool.version ? `@${step.tool.version}` : ""}.`,
      startedAt: new Date(toolStartedAt),
      payload: { toolName: step.tool.name, toolVersion: step.tool.version, input: toolInput },
    });

    const claim = await claimBaseAgentToolWork({
      ledger: input.options.ledger,
      tool: step.tool,
      toolInput,
      runId: input.runContext.runId,
      threadId: input.runContext.threadId,
      instanceId: input.runContext.instanceId,
      toolSpanId,
      task: input.task,
      step: attemptedToolCalls,
      attemptedToolCalls,
      artifactCount: artifacts.length,
    });

    const reuse = await findReusableBaseAgentToolWork({
      ledger: input.options.ledger,
      tool: step.tool,
      toolInput,
      task: input.task,
      toolSpanId,
    });
    if (reuse) {
      successfulToolCalls += 1;
      state.reusedAny = true;
      state.lastContent = resultContentForAnswer(reuse.result);
      state.results.push({ toolName: step.tool.name, input: toolInput, result: reuse.result, reused: true });
      await completeBaseAgentToolWorkFromReuse({
        ledger: input.options.ledger,
        claim,
        tool: step.tool,
        toolInput,
        reuse,
        toolSpanId,
      });
      await emitBaseAgentToolEvent(input.options.onEvent, step.tool.name, toolInput, true, `Reused passed Work Ledger evidence for ${step.tool.name}.`, Date.now() - toolStartedAt, {
        spanId: toolSpanId,
        parentSpanId: input.rootSpanId,
        toolVersion: step.tool.version,
        ledgerReuse: {
          reusedFromWorkItemId: reuse.reusedFromWorkItemId,
          evidenceIds: reuse.evidenceIds,
          artifactIds: reuse.artifactIds,
          sourceUrls: reuse.sourceUrls,
        },
        output: summarizeToolResultForTrace(reuse.result, reuse.preview),
      });
      continue;
    }

    try {
      const result = await runWithTimeout(`Tool ${step.tool.name}`, input.toolTimeoutMs, input.options.signal, (signal) =>
        input.registry.execute(step.tool, toolInput, {
          signal,
          runId: input.runContext.runId,
          instanceId: input.runContext.instanceId,
          requesterUserId: input.runContext.requesterUserId,
          threadId: input.runContext.threadId,
          spanId: toolSpanId,
          caller: "base-agent-local-utility",
          artifacts: input.options.saveArtifact ? { saveGenerated: saveToolArtifact(input, step.tool, toolSpanId, toolStartedAt, artifacts) } : undefined,
          resolveSecret: input.options.resolveSecret,
          resolveConfiguration: input.options.resolveConfiguration,
          audit: input.options.audit,
          logger: input.options.logger,
          callback: input.options.createToolCallback?.(step.tool.name),
        }));
      const preview = renderToolResultForModel(result, step.tool);
      if (result.ok && input.options.saveArtifact) {
        const artifactResult = await maybeSaveArtifact({
          task: input.task,
          toolName: step.tool.name,
          input: toolInput,
          result,
          proofSourceUrls: [],
          proofEvidence: [],
          proofClaimSignals: [],
          proofRequiresClaimMatch: false,
          saveArtifact: saveToolArtifact(input, step.tool, toolSpanId, toolStartedAt, artifacts),
        });
        if (artifactResult.error) {
          terminalFailureReason = artifactResult.error;
          failedToolCalls.push({ toolName: step.tool.name, message: artifactResult.error });
        }
      }
      await completeBaseAgentToolWork({
        ledger: input.options.ledger,
        claim,
        tool: step.tool,
        toolInput,
        result,
        preview,
        artifacts,
        toolSpanId,
        durationMs: Date.now() - toolStartedAt,
      });
      await emitBaseAgentToolEvent(input.options.onEvent, step.tool.name, toolInput, result.ok, result.content, Date.now() - toolStartedAt, {
        spanId: toolSpanId,
        parentSpanId: input.rootSpanId,
        toolVersion: step.tool.version,
        output: summarizeToolResultForTrace(result, preview),
      });
      if (result.ok) {
        successfulToolCalls += 1;
        state.lastContent = resultContentForAnswer(result);
        state.results.push({ toolName: step.tool.name, input: toolInput, result, reused: false });
      } else {
        terminalFailureReason = result.content || `${step.tool.name} returned a failed result.`;
        failedToolCalls.push({ toolName: step.tool.name, message: terminalFailureReason });
        break;
      }
    } catch (error) {
      terminalFailureReason = error instanceof Error ? error.message : String(error);
      failedToolCalls.push({ toolName: step.tool.name, message: terminalFailureReason });
      await failBaseAgentToolWork({
        ledger: input.options.ledger,
        claim,
        tool: step.tool,
        toolInput,
        error: terminalFailureReason,
        toolSpanId,
        durationMs: Date.now() - toolStartedAt,
      });
      await emitBaseAgentToolEvent(input.options.onEvent, step.tool.name, toolInput, false, terminalFailureReason, Date.now() - toolStartedAt, {
        spanId: toolSpanId,
        parentSpanId: input.rootSpanId,
        toolVersion: step.tool.version,
      });
      break;
    }
  }

  return finalizeBaseAgentRun({
    task: input.task,
    options: input.options,
    startedAt: input.startedAt,
    rootSpanId: input.rootSpanId,
    maxSteps: input.maxSteps,
    stoppedByStepLimit: false,
    finalAnswer: terminalFailureReason ? "" : plan.finalAnswer(state),
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
    attemptedToolCalls,
    terminalFailureReason,
    toolCreationRequests: [],
    toolEditRequests: [],
    usedScopedCandidates: new Map(),
    acceptedCandidateKeys: new Set(),
    primaryToolResults: [],
  });
}

function saveToolArtifact(
  input: LocalUtilityFastPathInput,
  tool: Tool,
  toolSpanId: string,
  toolStartedAt: number,
  artifacts: AgentArtifact[],
): (artifact: ArtifactCreateInput) => Promise<AgentArtifact> {
  return async (artifact) => {
    const saved = await input.options.saveArtifact!(artifact);
    artifacts.push(saved);
    await emit(input.options.onEvent, {
      spanId: `${toolSpanId}-artifact-${safeToolName(saved.id).slice(0, 32)}`,
      parentSpanId: toolSpanId,
      type: "artifact-created",
      actor: tool.name,
      activity: "tool",
      status: "completed",
      title: `Artifact saved: ${saved.filename}`,
      detail: saved.description,
      startedAt: new Date(toolStartedAt),
      completedAt: new Date(),
      payload: {
        artifactId: saved.id,
        filename: saved.filename,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
        quality: saved.quality,
        qualityStatus: saved.quality?.status,
        toolName: tool.name,
        toolVersion: tool.version,
        output: {
          artifactId: saved.id,
          filename: saved.filename,
          url: saved.url,
          qualityStatus: saved.quality?.status,
          quality: saved.quality,
        },
      },
    });
    return saved;
  };
}

function planInlineDataTransform(task: string, tools: Tool[]): LocalUtilityPlan | undefined {
  const tool = tools.find((candidate) => candidate.name === "data.transform");
  if (!tool) return undefined;
  const json = extractFirstJsonLiteral(task);
  if (!json) return undefined;
  const operations = inferTransformOperations(task);
  const outputPath = inferOutputPath(task);
  const outputFormat = inferOutputFormat(task, outputPath);
  const transformInput = { input: json, format: "json", operations, outputFormat };
  const writeTool = outputPath ? tools.find((candidate) => candidate.name === "file.write") : undefined;
  return {
    steps: [
      { tool, input: () => transformInput },
      ...(writeTool && outputPath ? [{ tool: writeTool, input: (state: LocalUtilityState) => ({ path: outputPath, content: state.lastContent ?? "" }) }] : []),
    ],
    finalAnswer: (state) => formatLocalUtilityAnswer(state, outputFormat),
  };
}

function planFileTransform(task: string, tools: Tool[]): LocalUtilityPlan | undefined {
  if (!/(?:json|csv|отсорт|sort|filter|фильтр|transform|convert|преобраз|конверт)/i.test(task)) return undefined;
  const paths = extractFilePathMentions(task);
  const outputPath = inferOutputPath(task, paths);
  const sourcePath = paths.find((path) => path !== outputPath);
  if (!sourcePath || !outputPath) return undefined;
  const readTool = tools.find((candidate) => candidate.name === "file.read");
  const transformTool = tools.find((candidate) => candidate.name === "data.transform");
  const writeTool = tools.find((candidate) => candidate.name === "file.write");
  if (!readTool || !transformTool || !writeTool) return undefined;
  const outputFormat = inferOutputFormat(task, outputPath);
  return {
    steps: [
      { tool: readTool, input: () => ({ path: sourcePath }) },
      {
        tool: transformTool,
        input: (state) => ({
          input: state.lastContent ?? "",
          format: formatFromPath(sourcePath),
          operations: inferTransformOperations(task),
          outputFormat,
        }),
      },
      { tool: writeTool, input: (state) => ({ path: outputPath, content: state.lastContent ?? "" }) },
    ],
    finalAnswer: (state) => formatLocalUtilityAnswer(state, outputFormat),
  };
}

function planDocumentExtractOrRead(task: string, tools: Tool[]): LocalUtilityPlan | undefined {
  const paths = extractFilePathMentions(task);
  const outputPath = inferOutputPath(task, paths);
  const sourcePath = paths.find((path) => path !== outputPath) ?? (!outputPath ? paths[0] : undefined);
  if (!sourcePath) return undefined;
  const wantsExtract = /(?:document\.extract|извлеки|extract|распарс|parse|прочитай|read)/i.test(task);
  if (!wantsExtract) return undefined;
  const preferredToolName = needsDocumentExtract(sourcePath, task) ? "document.extract" : "file.read";
  const sourceTool = tools.find((candidate) => candidate.name === preferredToolName);
  const writeTool = outputPath ? tools.find((candidate) => candidate.name === "file.write") : undefined;
  if (!sourceTool) return undefined;
  return {
    steps: [
      { tool: sourceTool, input: () => ({ path: sourcePath }) },
      ...(writeTool && outputPath ? [{ tool: writeTool, input: (state: LocalUtilityState) => ({ path: outputPath, content: state.lastContent ?? "" }) }] : []),
    ],
    finalAnswer: (state) => formatLocalUtilityAnswer(state, inferOutputFormat(task, outputPath)),
  };
}

function formatLocalUtilityAnswer(state: LocalUtilityState, outputFormat: string): string {
  const artifact = state.artifacts.at(-1);
  if (artifact) {
    return [
      state.reusedAny ? "Готово. Использовал проверенный промежуточный результат из Work Ledger и создал файл." : "Готово. Создал файл.",
      "",
      `Файл: ${artifact.filename}`,
    ].join("\n");
  }
  const content = state.lastContent?.trim() ?? "";
  return [
    state.reusedAny ? "Готово. Использовал уже проверенный результат из Work Ledger." : "Готово. Выполнил локальную операцию.",
    "",
    outputFormat === "csv" ? `\`\`\`csv\n${content}\n\`\`\`` : content,
  ].join("\n");
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

function inferOutputPath(task: string, paths = extractFilePathMentions(task)): string | undefined {
  const explicit = task.match(/(?:сохрани|запиши|создай|экспортируй|write|save|export)[\s\S]{0,120}?(?:\sв|\sto|\sas)?\s+([A-Za-z0-9_./-]+\.(?:csv|json|txt|md|html|xml))/i)?.[1];
  if (explicit) return explicit;
  if (/(?:сохрани|запиши|создай|экспортируй|write|save|export)/i.test(task) && paths.length === 1) return paths[0];
  return undefined;
}

function extractFilePathMentions(task: string): string[] {
  const matches = task.matchAll(/(^|[\s"'`(])([A-Za-z0-9_./-]+\.(?:csv|json|txt|md|html|xml|pdf|docx|htm))(?=$|[\s"'`),.;:!?])/gi);
  return Array.from(new Set(Array.from(matches, (match) => match[2])));
}

function inferOutputFormat(task: string, outputPath: string | undefined): string {
  const fromPath = outputPath ? formatFromPath(outputPath) : undefined;
  if (fromPath && fromPath !== "auto") return fromPath;
  if (/\bcsv\b/i.test(task)) return "csv";
  if (/\bjson\b/i.test(task)) return "json";
  return "text";
}

function formatFromPath(path: string): "auto" | "json" | "csv" | "text" {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".csv")) return "csv";
  return "text";
}

function needsDocumentExtract(path: string, task: string): boolean {
  const lower = path.toLowerCase();
  return /(?:document\.extract|извлеки|extract|parse|распарс)/i.test(task)
    || /\.(?:pdf|docx|html|htm)$/i.test(lower);
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
