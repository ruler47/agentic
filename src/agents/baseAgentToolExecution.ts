import type { LlmToolReply } from "../llm/client.js";
import type { AgentArtifact, AgentEventSink, ArtifactCreateInput, Message } from "../types.js";
import type { Tool, ToolExecutionContext, ToolResult } from "../tools/tool.js";
import { toolCallCacheKey, type BaseAgentToolCatalogEntry } from "./agentToolCatalog.js";
import { maybeSaveArtifact, saveStructuredDataProofArtifact, shouldSaveStructuredDataProofArtifact } from "./baseAgentArtifacts.js";
import { extractClaimProofSignals, extractProofEvidenceForSourceUrls, extractSourceUrls, finalAnswerWithProofArtifact, isUsableProofArtifact } from "./baseAgentEvidence.js";
import { isScreenshotProofTool, proofInstructionForModel } from "./baseAgentProof.js";
import { emit, runWithTimeout } from "./baseAgentRuntime.js";
import { extractPrimaryResultFields, renderToolResultForModel, runtimeDiagnosticFromError, safeToolName, toolMessage } from "./baseAgentToolMessages.js";
import { createToolSpanId, summarizeToolResultForTrace } from "./baseAgentTrace.js";
import type { BaseAgentRunContext, BaseAgentRunOptions, BaseAgentToolCandidateAccepted, CachedToolCall, FailedToolCall, ProofEvidence, ToolPrimaryResult } from "./baseAgentTypes.js";
import { PROOF_SOURCE_URL_LIMIT, isProofWorthySourceUrl } from "./proofSourceUrls.js";
import { shouldRequireResearchContract, type TaskFrame } from "./taskFrame.js";

type EmitToolEvent = (
  sink: AgentEventSink | undefined,
  toolName: string,
  input: Record<string, unknown>,
  ok: boolean,
  detail: string,
  durationMs: number,
  extraPayload?: Record<string, unknown>,
) => Promise<void>;

type BaseAgentRegisteredToolCallInput = {
  call: LlmToolReply["toolCalls"][number];
  task: string;
  step: number;
  llmSpanId: string;
  options: BaseAgentRunOptions;
  runContext: BaseAgentRunContext;
  taskFrame: TaskFrame;
  tools: Tool[];
  toolCatalog: BaseAgentToolCatalogEntry[];
  messages: Message[];
  artifacts: AgentArtifact[];
  failedToolCalls: FailedToolCall[];
  structuredProofArtifacts: AgentArtifact[];
  toolResultCache: Map<string, CachedToolCall>;
  searchQueryHistory: Map<string, string>;
  externalEvidenceUrls: Set<string>;
  externalDataEvidenceUrls: Set<string>;
  proofEvidenceByUrl: Map<string, ProofEvidence>;
  usedScopedCandidates: Map<string, BaseAgentToolCandidateAccepted>;
  primaryToolResults: ToolPrimaryResult[];
  maxToolCalls?: number;
  toolTimeoutMs: number;
  attemptedToolCalls: number;
  successfulToolCalls: number;
  successfulResearchToolCalls: number;
  successfulSourceReadToolCalls: number;
  terminalFailureReason?: string;
  finalAnswer: string;
  latestDraftAnswerForProof: string;
  proofRepairAttempts: number;
  resolveTool: (name: string, tools: Tool[]) => Tool | undefined;
  executeTool: (
    tool: Tool,
    input: Record<string, unknown>,
    context: Partial<Omit<ToolExecutionContext, "toolName">>,
  ) => Promise<ToolResult>;
  emitToolEvent: EmitToolEvent;
};

type BaseAgentRegisteredToolCallResult = {
  control: "continue" | "break";
  attemptedToolCalls: number;
  successfulToolCalls: number;
  successfulResearchToolCalls: number;
  successfulSourceReadToolCalls: number;
  terminalFailureReason?: string;
  finalAnswer: string;
};

export async function handleBaseAgentRegisteredToolCall(
  input: BaseAgentRegisteredToolCallInput,
): Promise<BaseAgentRegisteredToolCallResult> {
  const {
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
    latestDraftAnswerForProof,
    proofRepairAttempts,
  } = input;
  let {
    attemptedToolCalls,
    successfulToolCalls,
    successfulResearchToolCalls,
    successfulSourceReadToolCalls,
    terminalFailureReason,
    finalAnswer,
  } = input;
  const output = (control: "continue" | "break"): BaseAgentRegisteredToolCallResult => ({
    control,
    attemptedToolCalls,
    successfulToolCalls,
    successfulResearchToolCalls,
    successfulSourceReadToolCalls,
    terminalFailureReason,
    finalAnswer,
  });

  const repeatedSearch = findRepeatedSearchQuery(call, searchQueryHistory);
  if (repeatedSearch) {
    const skippedSpanId = createToolSpanId(runContext.runId, attemptedToolCalls + 1, call.name);
    const displayName = call.name.replace(/_/g, ".");
    const message = [
      `Reused prior ${displayName} result for repeated or near-duplicate search query: "${repeatedSearch.query}".`,
      `Prior similar query: "${repeatedSearch.priorQuery}".`,
      "Reuse the prior result or change source, query angle, language, or hypothesis materially before searching again.",
    ].join(" ");
    messages.push(toolMessage(call.id, true, message));
    await input.emitToolEvent(options.onEvent, call.name, call.arguments, true, message, 0, {
      spanId: skippedSpanId,
      parentSpanId: llmSpanId,
      step,
      toolCallNumber: attemptedToolCalls + 1,
      duplicateSkipped: true,
      input: call.arguments,
      output: { ok: true, content: message },
    });
    return output("continue");
  }
  rememberSearchQuery(call, searchQueryHistory);

  attemptedToolCalls += 1;
  const toolSpanId = createToolSpanId(runContext.runId, attemptedToolCalls, call.name);
  if (maxToolCalls !== undefined && attemptedToolCalls > maxToolCalls) {
    const message = `Tool call budget exceeded (${maxToolCalls}).`;
    terminalFailureReason = message;
    failedToolCalls.push({ toolName: call.name, message });
    messages.push(toolMessage(call.id, false, message));
    await input.emitToolEvent(options.onEvent, call.name, call.arguments, false, message, 0, {
      spanId: toolSpanId,
      parentSpanId: llmSpanId,
      step,
      toolCallNumber: attemptedToolCalls,
      budgetExceeded: true,
    });
    return output("break");
  }

  const tool = input.resolveTool(call.name, tools);
  if (!tool) {
    const message = `Tool "${call.name}" is not registered.`;
    failedToolCalls.push({ toolName: call.name, message });
    messages.push(toolMessage(call.id, false, message));
    await input.emitToolEvent(options.onEvent, call.name, call.arguments, false, message, 0, {
      spanId: toolSpanId,
      parentSpanId: llmSpanId,
      step,
      toolCallNumber: attemptedToolCalls,
    });
    return output("continue");
  }

  const externalActionGuard = externalActionApprovalToolGuardMessage(taskFrame, tool);
  if (externalActionGuard) {
    failedToolCalls.push({ toolName: tool.name, message: externalActionGuard });
    messages.push(toolMessage(call.id, false, externalActionGuard));
    await input.emitToolEvent(options.onEvent, tool.name, call.arguments, false, externalActionGuard, 0, {
      step,
      spanId: toolSpanId,
      parentSpanId: llmSpanId,
      toolCallNumber: attemptedToolCalls,
      toolVersion: tool.version,
      externalActionApprovalBlocked: true,
      input: call.arguments,
      output: { ok: false, content: externalActionGuard },
    });
    return output("continue");
  }

  const catalogEntry = toolCatalog.find((entry) => entry.name === tool.name);
  const cacheKey = toolCallCacheKey(tool.name, tool.version, call.arguments);
  const cached = toolResultCache.get(cacheKey);
  if (cached) {
    for (const url of cached.sourceUrls.slice(0, PROOF_SOURCE_URL_LIMIT)) externalEvidenceUrls.add(url);
    for (const evidence of cached.proofEvidence) proofEvidenceByUrl.set(evidence.sourceUrl, evidence);
    const proofInstruction = shouldRequireResearchContract({
      taskFrame,
      sourceUrls: [...externalDataEvidenceUrls],
      successfulResearchToolCalls,
      successfulSourceReadToolCalls,
    })
      ? undefined
      : proofInstructionForModel({
          task,
          sourceUrls: [...externalEvidenceUrls],
          proofEvidence: [...proofEvidenceByUrl.values()],
          artifacts,
          tools,
          artifactSavingAvailable: Boolean(options.saveArtifact),
        });
    messages.push(toolMessage(
      call.id,
      true,
      [
        `Reused prior ${tool.name} result for identical input in this run.`,
        cached.preview,
        proofInstruction,
      ].filter(Boolean).join("\n\n"),
    ));
    await input.emitToolEvent(
      options.onEvent,
      tool.name,
      call.arguments,
      true,
      `Reused prior ${tool.name} result for identical input in this run.`,
      0,
      {
        step,
        spanId: toolSpanId,
        parentSpanId: llmSpanId,
        toolCallNumber: attemptedToolCalls,
        toolVersion: tool.version,
        reused: true,
        sourceUrls: cached.sourceUrls,
        output: {
          ok: true,
          content: `Reused prior ${tool.name} result for identical input in this run.`,
          sourceUrls: cached.sourceUrls,
        },
      },
    );
    return output("continue");
  }

  const toolStartedAt = Date.now();
  const saveToolArtifact = options.saveArtifact
    ? async (artifact: ArtifactCreateInput): Promise<AgentArtifact> => {
        const saved = await options.saveArtifact!(artifact);
        artifacts.push(saved);
        await emit(options.onEvent, {
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
            input: {
              toolName: tool.name,
              toolVersion: tool.version,
              artifact: {
                filename: saved.filename,
                mimeType: saved.mimeType,
                sizeBytes: saved.sizeBytes,
              },
            },
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
      }
    : undefined;
  await emit(options.onEvent, {
    spanId: toolSpanId,
    parentSpanId: llmSpanId,
    type: "tool-started",
    actor: tool.name,
    activity: "tool",
    status: "started",
    title: `Tool started: ${tool.name}`,
    detail: `Executing ${tool.name}${tool.version ? `@${tool.version}` : ""}.`,
    startedAt: new Date(toolStartedAt),
    payload: {
      step,
      spanId: toolSpanId,
      toolName: tool.name,
      toolVersion: tool.version,
      toolCallNumber: attemptedToolCalls,
      input: call.arguments,
    },
  });
  let result: ToolResult;
  try {
    result = await runWithTimeout(
      `Tool ${tool.name}`,
      toolTimeoutMs,
      options.signal,
      (signal) => input.executeTool(tool, call.arguments, {
        signal,
        runId: runContext.runId,
        instanceId: runContext.instanceId,
        requesterUserId: runContext.requesterUserId,
        threadId: runContext.threadId,
        spanId: toolSpanId,
        caller: "base-agent",
        artifacts: saveToolArtifact ? { saveGenerated: saveToolArtifact } : undefined,
        resolveSecret: options.resolveSecret,
        resolveConfiguration: options.resolveConfiguration,
        audit: options.audit,
        logger: options.logger,
        callback: options.createToolCallback?.(tool.name),
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = runtimeDiagnosticFromError(error);
    const modelMessage = diagnostic
      ? [
          diagnostic.message,
          diagnostic.missingConfigurationKeys.length
            ? `Missing configuration: ${diagnostic.missingConfigurationKeys.join(", ")}`
            : undefined,
          diagnostic.missingSecretHandles.length
            ? `Missing secret handles: ${diagnostic.missingSecretHandles.join(", ")}`
            : undefined,
          "Do not retry the same call until those runtime requirements are resolved. If you can still produce a useful partial answer, explain the blocked tool requirement.",
        ].filter(Boolean).join("\n")
      : `Tool threw: ${message}`;
    failedToolCalls.push({ toolName: tool.name, message, diagnostic });
    messages.push(toolMessage(call.id, false, modelMessage));
    await input.emitToolEvent(
      options.onEvent,
      tool.name,
      call.arguments,
      false,
      diagnostic ? diagnostic.message : `Tool threw: ${message}`,
      Date.now() - toolStartedAt,
      {
        step,
        spanId: toolSpanId,
        parentSpanId: llmSpanId,
        toolCallNumber: attemptedToolCalls,
        toolVersion: tool.version,
        diagnostic,
        output: {
          ok: false,
          content: diagnostic ? diagnostic.message : `Tool threw: ${message}`,
          diagnostic,
        },
      },
    );
    return output("continue");
  }

  const preview = renderToolResultForModel(result, tool, catalogEntry);
  let savedProofArtifactNotice: string | undefined;
  if (result.ok) {
    successfulToolCalls += 1;
    primaryToolResults.push(...extractPrimaryResultFields(result.data, tool, catalogEntry));
    const sourceUrls = extractSourceUrls(call.arguments, result);
    for (const url of sourceUrls.slice(0, PROOF_SOURCE_URL_LIMIT)) externalEvidenceUrls.add(url);
    if (!isScreenshotProofTool(tool)) {
      if (sourceUrls.some(isProofWorthySourceUrl)) successfulResearchToolCalls += 1;
      if (isSourceReadTool(tool) && sourceUrls.some(isProofWorthySourceUrl)) {
        successfulSourceReadToolCalls += 1;
      }
      for (const url of sourceUrls.slice(0, PROOF_SOURCE_URL_LIMIT)) externalDataEvidenceUrls.add(url);
      for (const evidence of extractProofEvidenceForSourceUrls(sourceUrls, call.arguments, result)) {
        proofEvidenceByUrl.set(evidence.sourceUrl, evidence);
      }
    }
    toolResultCache.set(cacheKey, {
      result,
      preview,
      sourceUrls,
      proofEvidence: sourceUrls.map((url) => proofEvidenceByUrl.get(url)).filter((entry): entry is ProofEvidence => Boolean(entry)),
    });
    if (tool.version) {
      if (catalogEntry?.visibility === "run_scoped_candidate") {
        const key = `${tool.name}@${tool.version}`;
        usedScopedCandidates.set(key, {
          toolName: tool.name,
          toolVersion: tool.version,
          replacesVersion: catalogEntry.versions?.find((version) => version.active)?.version,
          runId: runContext.runId,
          promotionPolicy: catalogEntry.promotionPolicy ?? "auto_on_success",
        });
      }
    }
    const artifactResult = options.saveArtifact
      ? await maybeSaveArtifact({
          task,
          toolName: tool.name,
          input: call.arguments,
          result,
          proofSourceUrls: [...externalDataEvidenceUrls],
          proofEvidence: [...proofEvidenceByUrl.values()],
          proofClaimSignals: taskFrame.researchContract.requiresClaimBasedProof
            ? extractClaimProofSignals(latestDraftAnswerForProof || finalAnswer)
            : [],
          proofRequiresClaimMatch: taskFrame.researchContract.requiresClaimBasedProof,
          saveArtifact: saveToolArtifact!,
        })
      : {};
    if (artifactResult.artifact) {
      // The shared saveToolArtifact callback already pushed and traced it.
      if (
        proofRepairAttempts > 0 &&
        latestDraftAnswerForProof.trim() &&
        artifactResult.artifact.quality?.status !== undefined &&
        isUsableProofArtifact(artifactResult.artifact)
      ) {
        finalAnswer = finalAnswerWithProofArtifact(latestDraftAnswerForProof, artifactResult.artifact);
      }
    }
    if (!artifactResult.artifact && options.saveArtifact && shouldSaveStructuredDataProofArtifact({
      tool,
      sourceUrls,
      taskFrame,
    })) {
      const dataProof = await saveStructuredDataProofArtifact({
        task,
        tool,
        input: call.arguments,
        result,
        sourceUrls,
        proofEvidence: [...proofEvidenceByUrl.values()],
        saveArtifact: saveToolArtifact!,
      });
      if (dataProof.artifact) {
        structuredProofArtifacts.push(dataProof.artifact);
        savedProofArtifactNotice = `Structured proof artifact saved: ${dataProof.artifact.filename}`;
      } else if (dataProof.error) {
        failedToolCalls.push({ toolName: tool.name, message: dataProof.error });
        terminalFailureReason = dataProof.error;
      }
    }
    if (artifactResult.error) {
      failedToolCalls.push({ toolName: tool.name, message: artifactResult.error });
      terminalFailureReason = artifactResult.error;
    }
  } else {
    failedToolCalls.push({ toolName: tool.name, message: result.content });
  }

  messages.push(toolMessage(
    call.id,
    result.ok,
    [
      preview,
      savedProofArtifactNotice,
      result.ok && !taskFrame.researchContract.requiresClaimBasedProof && !shouldRequireResearchContract({
        taskFrame,
        sourceUrls: [...externalDataEvidenceUrls],
        successfulResearchToolCalls,
        successfulSourceReadToolCalls,
      })
        ? proofInstructionForModel({
          task,
          finalAnswer,
          sourceUrls: [...externalEvidenceUrls],
          proofEvidence: [...proofEvidenceByUrl.values()],
          artifacts,
          tools,
          artifactSavingAvailable: Boolean(options.saveArtifact),
        })
        : undefined,
    ].filter(Boolean).join("\n\n"),
  ));
  await input.emitToolEvent(
    options.onEvent,
    tool.name,
    call.arguments,
    result.ok,
    preview.slice(0, 500),
    Date.now() - toolStartedAt,
    {
      step,
      spanId: toolSpanId,
      parentSpanId: llmSpanId,
        toolCallNumber: attemptedToolCalls,
        toolVersion: tool.version,
        artifactCount: artifacts.length,
        output: summarizeToolResultForTrace(result, preview),
    },
  );

  return output("continue");
}

function isSourceReadTool(tool: Tool): boolean {
  const haystack = `${tool.name} ${tool.description} ${tool.capabilities.join(" ")}`;
  return /web[.\s_-]*(?:read|extract)|web-read|web-extract|page[.\s_-]*(?:read|extract)|source[.\s_-]*(?:read|extract)/i
    .test(haystack);
}

function externalActionApprovalToolGuardMessage(
  taskFrame: TaskFrame,
  tool: Tool,
): string | undefined {
  const policy = taskFrame.externalActionPolicy;
  if (!policy?.requiresApprovalBeforeExecution || policy.executionMode === "auto") {
    return undefined;
  }
  if (!isBrowserOperationTool(tool)) return undefined;
  return [
    "External action approval mode blocks direct browser operation inside the agent loop.",
    "Do not use browser automation to prepare, fill, submit, or navigate third-party booking/appointment/purchase forms before a run-scoped proposal is approved.",
    "Finish with a concise proposed action, target, known user inputs, missing inputs, source URL, and confirmation checklist; the platform will create the approval proposal and the operator can run the dedicated preparation/commit flow from the run.",
  ].join(" ");
}

function isBrowserOperationTool(tool: Tool): boolean {
  const haystack = `${tool.name} ${tool.description} ${tool.capabilities.join(" ")}`;
  return /browser[.\s_-]*operate|browser[.\s_-]*automation|form[.\s_-]*(?:fill|submit|prepare)|dom[.\s_-]*(?:click|fill|operate)/i.test(
    haystack,
  );
}

function findRepeatedSearchQuery(
  call: LlmToolReply["toolCalls"][number],
  history: Map<string, string>,
): { query: string; priorQuery: string } | undefined {
  const query = extractSearchQuery(call);
  if (!query) return undefined;
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return undefined;
  for (const [priorNormalized, priorQuery] of history) {
    if (normalized === priorNormalized || searchQuerySimilarity(normalized, priorNormalized) >= 0.82) {
      return { query, priorQuery };
    }
  }
  return undefined;
}

function rememberSearchQuery(
  call: LlmToolReply["toolCalls"][number],
  history: Map<string, string>,
): void {
  const query = extractSearchQuery(call);
  if (!query) return;
  const normalized = normalizeSearchQuery(query);
  if (normalized && !history.has(normalized)) history.set(normalized, query);
}

function extractSearchQuery(call: LlmToolReply["toolCalls"][number]): string | undefined {
  if (!/(?:^|[._-])search$/i.test(call.name) && !/^web[_-]search$/i.test(call.name)) return undefined;
  const query = call.arguments.query;
  return typeof query === "string" && query.trim() ? query.trim() : undefined;
}

function normalizeSearchQuery(query: string): string {
  return query
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/["'`«»“”‘’()[\]{}]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token))
    .join(" ");
}

function searchQuerySimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  const leftTokens = new Set(left.split(/\s+/).filter(Boolean));
  const rightTokens = new Set(right.split(/\s+/).filter(Boolean));
  const tokenUnion = new Set([...leftTokens, ...rightTokens]);
  const tokenIntersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const tokenScore = tokenUnion.size ? tokenIntersection / tokenUnion.size : 0;
  return Math.max(tokenScore, ngramSimilarity(left, right));
}

function ngramSimilarity(left: string, right: string): number {
  const leftGrams = ngrams(left, 3);
  const rightGrams = ngrams(right, 3);
  if (!leftGrams.size || !rightGrams.size) return 0;
  const intersection = [...leftGrams].filter((gram) => rightGrams.has(gram)).length;
  const union = new Set([...leftGrams, ...rightGrams]).size;
  return intersection / union;
}

function ngrams(value: string, size: number): Set<string> {
  const compact = `  ${value.replace(/\s+/g, " ")}  `;
  const result = new Set<string>();
  for (let index = 0; index <= compact.length - size; index += 1) {
    result.add(compact.slice(index, index + size));
  }
  return result;
}

const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "best",
  "for",
  "in",
  "near",
  "of",
  "or",
  "query",
  "research",
  "search",
  "the",
  "to",
  "with",
  "найди",
  "поиск",
  "ресторан",
]);
