import type { LlmClient } from "../llm/client.js";
import type { AgentArtifact, AgentRunResult, ArtifactCreateInput, Message, ModelTier } from "../types.js";
import type { Tool, ToolExecutionContext, ToolResult } from "../tools/tool.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  extractProofEvidenceForSourceUrls,
  extractSourceUrls,
  firstStringField,
  inferRequiredArtifacts,
  taskExplicitlyRequestsScreenshot,
  taskForbidsScreenshotProof,
  taskLooksLikeApiOnlyProofTask,
} from "./baseAgentEvidence.js";
import { finalizeBaseAgentRun } from "./baseAgentFinalization.js";
import { bestFocusTextForSource } from "./baseAgentEvidence.js";
import { maybeSaveArtifact } from "./baseAgentArtifacts.js";
import {
  claimBaseAgentToolWork,
  completeBaseAgentToolWork,
  completeBaseAgentToolWorkFromReuse,
  failBaseAgentToolWork,
  findReusableBaseAgentToolWork,
} from "./baseAgentToolLedger.js";
import { DEFAULT_AGENT_LOOP_TIER, DEFAULT_LLM_MAX_TOKENS } from "./baseAgentConstants.js";
import { emit, runWithTimeout } from "./baseAgentRuntime.js";
import { emitBaseAgentToolEvent } from "./baseAgentToolRuntimeHelpers.js";
import { limitText, renderToolResultForModel, safeToolName } from "./baseAgentToolMessages.js";
import { createLlmSpanId, createToolSpanId, publicArtifactForTrace, publicProofEvidenceForTrace, summarizeToolResultForTrace } from "./baseAgentTrace.js";
import { isProofWorthySourceUrl, PROOF_SOURCE_URL_LIMIT } from "./proofSourceUrls.js";
import type { BaseAgentRunContext, BaseAgentRunOptions, FailedToolCall, ProofEvidence, ToolPrimaryResult } from "./baseAgentTypes.js";
import type { TaskFrame } from "./taskFrame.js";

type CurrentFactFastPathInput = {
  task: string;
  options: BaseAgentRunOptions;
  runContext: BaseAgentRunContext;
  taskFrame: TaskFrame;
  tools: Tool[];
  registry: ToolRegistry;
  llm: LlmClient;
  startedAt: Date;
  rootSpanId: string;
  maxSteps?: number;
  toolTimeoutMs: number;
};

type CurrentFactToolRun = {
  tool: Tool;
  input: Record<string, unknown>;
  result: ToolResult;
  preview: string;
  sourceUrls: string[];
  reused: boolean;
};

type CurrentFactState = {
  artifacts: AgentArtifact[];
  failedToolCalls: FailedToolCall[];
  toolRuns: CurrentFactToolRun[];
  externalEvidenceUrls: Set<string>;
  externalDataEvidenceUrls: Set<string>;
  proofEvidenceByUrl: Map<string, ProofEvidence>;
  rejectedSourceUrls: Set<string>;
  readRejectedSourceUrls: Set<string>;
  primarySourceUrl?: string;
  successfulToolCalls: number;
  attemptedToolCalls: number;
  successfulResearchToolCalls: number;
  successfulSourceReadToolCalls: number;
  terminalFailureReason?: string;
};

export async function tryRunCurrentFactFastPath(input: CurrentFactFastPathInput): Promise<AgentRunResult | undefined> {
  if (!shouldUseCurrentFactFastPath(input.task, input.taskFrame, input.tools)) return undefined;
  const searchTool = findTool(input.tools, "web.search");
  if (!searchTool) return undefined;
  const readTool = findTool(input.tools, "web.read");
  const screenshotTool = findTool(input.tools, "browser.screenshot");
  const fastPathSpanId = `${input.rootSpanId}-current-fact`;
  const state: CurrentFactState = {
    artifacts: [],
    failedToolCalls: [],
    toolRuns: [],
    externalEvidenceUrls: new Set(),
    externalDataEvidenceUrls: new Set(),
    proofEvidenceByUrl: new Map(),
    rejectedSourceUrls: new Set(),
    readRejectedSourceUrls: new Set(),
    successfulToolCalls: 0,
    attemptedToolCalls: 0,
    successfulResearchToolCalls: 0,
    successfulSourceReadToolCalls: 0,
  };

  await emit(input.options.onEvent, {
    spanId: fastPathSpanId,
    parentSpanId: input.rootSpanId,
    type: "current-fact-fast-path-selected",
    actor: "base-agent",
    activity: "agent",
    status: "completed",
    title: "Current fact fast path selected",
    detail: "Using bounded search/read/proof flow before the general ReAct loop.",
    startedAt: input.startedAt,
    completedAt: new Date(),
    payload: {
      taskFrame: input.taskFrame,
      policy: {
        search: searchTool.name,
        read: readTool?.name,
        screenshot: screenshotTool?.name,
        screenshotRequested: shouldTryScreenshot(input.task),
      },
    },
  });

  const searchRun = await runCurrentFactTool({
    ...input,
    state,
    tool: searchTool,
    toolInput: { query: buildCurrentFactSearchQuery(input.task), limit: 5 },
    parentSpanId: fastPathSpanId,
    toolCallNumber: 1,
    caller: "base-agent-current-fact",
  });
  if (!searchRun?.result.ok) {
    state.terminalFailureReason = searchRun?.result.content || "Current fact search did not return a usable result.";
    return finishCurrentFact(input, state, "");
  }

  const sourceCandidates = chooseBestSourceUrls(searchRun);
  let bestSourceUrl = sourceCandidates[0];
  if (readTool) {
    for (const candidateUrl of sourceCandidates.slice(0, 3)) {
      const readRun = await runCurrentFactTool({
        ...input,
        state,
        tool: readTool,
        toolInput: { url: candidateUrl, maxBytes: 80_000, format: "text" },
        parentSpanId: fastPathSpanId,
        toolCallNumber: state.attemptedToolCalls + 1,
        caller: "base-agent-current-fact",
      });
      if (!readRun?.result.ok) {
        state.readRejectedSourceUrls.add(candidateUrl);
        await emitCurrentFactSourceRejected(input, fastPathSpanId, candidateUrl, readRun?.result.content || "source read failed");
        continue;
      }
      const rejectionReason = currentFactReadRejectionReason(readRun);
      if (rejectionReason) {
        state.readRejectedSourceUrls.add(candidateUrl);
        await emitCurrentFactSourceRejected(input, fastPathSpanId, candidateUrl, rejectionReason);
        if (!shouldTryScreenshot(input.task) && hasStandaloneSearchEvidenceForUrl(searchRun, candidateUrl)) {
          bestSourceUrl = candidateUrl;
          break;
        }
        continue;
      }
      bestSourceUrl = candidateUrl;
      const finalUrl = firstStringField(readRun.result.data, ["finalUrl", "url"]);
      if (finalUrl && isProofWorthySourceUrl(finalUrl)) bestSourceUrl = finalUrl;
      break;
    }
  }
  state.primarySourceUrl = bestSourceUrl;
  prioritizeEvidenceSource(state, bestSourceUrl);

  if (shouldTryScreenshot(input.task) && bestSourceUrl && screenshotTool) {
    const beforeArtifactCount = state.artifacts.length;
    await runCurrentFactTool({
      ...input,
      state,
      tool: screenshotTool,
      toolInput: {
        url: bestSourceUrl,
        focusText: bestFocusTextForSource(bestSourceUrl, [...state.proofEvidenceByUrl.values()]),
        fullPage: false,
      },
      parentSpanId: fastPathSpanId,
      toolCallNumber: state.attemptedToolCalls + 1,
      caller: "base-agent-current-fact-proof",
    });
    const newArtifacts = state.artifacts.slice(beforeArtifactCount);
    const usable = newArtifacts.some((artifact) => artifact.quality?.status !== "failed");
    if (!usable) {
      await emitProofDegraded(input, fastPathSpanId, bestSourceUrl, newArtifacts);
    }
  } else {
    await emitProofSkipped(input, fastPathSpanId, bestSourceUrl, shouldTryScreenshot(input.task) ? "browser.screenshot is unavailable or no source URL was found" : "visual proof was not requested");
  }

  const answer = await synthesizeCurrentFactAnswer(input, fastPathSpanId, state);
  return finishCurrentFact(input, state, answer);
}

function shouldUseCurrentFactFastPath(task: string, taskFrame: TaskFrame, tools: Tool[]): boolean {
  if (taskFrame.mode !== "current_lookup") return false;
  if (taskFrame.externalActionPolicy) return false;
  if (taskLooksLikeApiOnlyProofTask(task)) return false;
  if (!findTool(tools, "web.search")) return false;
  if (!findTool(tools, "web.read")) return false;
  const normalized = task.toLowerCase();
  if (!/(?:\bcurrent\b|\blatest\b|\btoday\b|\blive\b|\bnow\b|сейчас|текущ|актуальн|сегодня|на сегодня)/iu.test(normalized)) return false;
  if (/(?:best|recommend|compare|choose|pick|найди|подбери|выбери|посоветуй|лучш|сравни)/iu.test(normalized)) return false;
  return true;
}

async function runCurrentFactTool(input: CurrentFactFastPathInput & {
  state: CurrentFactState;
  tool: Tool;
  toolInput: Record<string, unknown>;
  parentSpanId: string;
  toolCallNumber: number;
  caller: string;
}): Promise<CurrentFactToolRun | undefined> {
  const toolSpanId = createToolSpanId(input.runContext.runId, input.toolCallNumber, input.tool.name);
  const toolStartedAt = Date.now();
  input.state.attemptedToolCalls += 1;
  await emit(input.options.onEvent, {
    spanId: toolSpanId,
    parentSpanId: input.parentSpanId,
    type: "tool-started",
    actor: input.tool.name,
    activity: "tool",
    status: "started",
    title: `Tool started: ${input.tool.name}`,
    detail: `Executing ${input.tool.name}${input.tool.version ? `@${input.tool.version}` : ""}.`,
    startedAt: new Date(toolStartedAt),
    payload: {
      toolName: input.tool.name,
      toolVersion: input.tool.version,
      toolCallNumber: input.state.attemptedToolCalls,
      input: input.toolInput,
    },
  });

  const claim = await claimBaseAgentToolWork({
    ledger: input.options.ledger,
    tool: input.tool,
    toolInput: input.toolInput,
    runId: input.runContext.runId,
    threadId: input.runContext.threadId,
    instanceId: input.runContext.instanceId,
    toolSpanId,
    task: input.task,
    step: input.state.attemptedToolCalls,
    attemptedToolCalls: input.state.attemptedToolCalls,
    artifactCount: input.state.artifacts.length,
  });

  const reuse = await findReusableBaseAgentToolWork({
    ledger: input.options.ledger,
    tool: input.tool,
    toolInput: input.toolInput,
    task: input.task,
    toolSpanId,
  });
  if (reuse) {
    input.state.successfulToolCalls += 1;
    addSourceEvidence(input.state, input.tool, input.toolInput, reuse.result, reuse.sourceUrls);
    const run = { tool: input.tool, input: input.toolInput, result: reuse.result, preview: reuse.preview, sourceUrls: reuse.sourceUrls, reused: true };
    input.state.toolRuns.push(run);
    await completeBaseAgentToolWorkFromReuse({
      ledger: input.options.ledger,
      claim,
      tool: input.tool,
      toolInput: input.toolInput,
      reuse,
      toolSpanId,
    });
    await emitBaseAgentToolEvent(input.options.onEvent, input.tool.name, input.toolInput, true, `Reused passed Work Ledger evidence for ${input.tool.name}.`, Date.now() - toolStartedAt, {
      spanId: toolSpanId,
      parentSpanId: input.parentSpanId,
      toolVersion: input.tool.version,
      output: summarizeToolResultForTrace(reuse.result, reuse.preview),
    });
    return run;
  }

  try {
    const result = await runWithTimeout(`Tool ${input.tool.name}`, input.toolTimeoutMs, input.options.signal, (signal) =>
      input.registry.execute(input.tool, input.toolInput, {
        signal,
        runId: input.runContext.runId,
        instanceId: input.runContext.instanceId,
        requesterUserId: input.runContext.requesterUserId,
        threadId: input.runContext.threadId,
        spanId: toolSpanId,
        caller: input.caller,
        artifacts: input.options.saveArtifact ? { saveGenerated: saveToolArtifact(input, toolSpanId, toolStartedAt) } : undefined,
        resolveSecret: input.options.resolveSecret,
        resolveConfiguration: input.options.resolveConfiguration,
        audit: input.options.audit,
        logger: input.options.logger,
        callback: input.options.createToolCallback?.(input.tool.name),
      } satisfies Partial<Omit<ToolExecutionContext, "toolName">>),
    );
    const preview = renderToolResultForModel(result, input.tool);
    if (result.ok) {
      input.state.successfulToolCalls += 1;
      addSourceEvidence(input.state, input.tool, input.toolInput, result);
      if (input.options.saveArtifact) {
        const artifactResult = await maybeSaveArtifact({
          task: input.task,
          toolName: input.tool.name,
          input: input.toolInput,
          result,
          proofSourceUrls: [...input.state.externalDataEvidenceUrls],
          proofEvidence: [...input.state.proofEvidenceByUrl.values()],
          proofClaimSignals: [],
          proofRequiresClaimMatch: false,
          saveArtifact: saveToolArtifact(input, toolSpanId, toolStartedAt),
        });
        if (artifactResult.error) input.state.failedToolCalls.push({ toolName: input.tool.name, message: artifactResult.error });
      }
    } else {
      input.state.failedToolCalls.push({ toolName: input.tool.name, message: result.content });
    }
    await completeBaseAgentToolWork({
      ledger: input.options.ledger,
      claim,
      tool: input.tool,
      toolInput: input.toolInput,
      result,
      preview,
      artifacts: input.state.artifacts,
      toolSpanId,
      durationMs: Date.now() - toolStartedAt,
    });
    await emitBaseAgentToolEvent(input.options.onEvent, input.tool.name, input.toolInput, result.ok, preview.slice(0, 500), Date.now() - toolStartedAt, {
      spanId: toolSpanId,
      parentSpanId: input.parentSpanId,
      toolVersion: input.tool.version,
      artifactCount: input.state.artifacts.length,
      output: summarizeToolResultForTrace(result, preview),
    });
    const run = { tool: input.tool, input: input.toolInput, result, preview, sourceUrls: extractSourceUrls(input.toolInput, result), reused: false };
    input.state.toolRuns.push(run);
    return run;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.state.failedToolCalls.push({ toolName: input.tool.name, message });
    await failBaseAgentToolWork({
      ledger: input.options.ledger,
      claim,
      tool: input.tool,
      toolInput: input.toolInput,
      error: message,
      toolSpanId,
      durationMs: Date.now() - toolStartedAt,
    });
    await emitBaseAgentToolEvent(input.options.onEvent, input.tool.name, input.toolInput, false, message, Date.now() - toolStartedAt, {
      spanId: toolSpanId,
      parentSpanId: input.parentSpanId,
      toolVersion: input.tool.version,
      output: { ok: false, content: message },
    });
    return undefined;
  }
}

async function synthesizeCurrentFactAnswer(input: CurrentFactFastPathInput, parentSpanId: string, state: CurrentFactState): Promise<string> {
  const llmSpanId = createLlmSpanId(input.runContext.runId, 1);
  const evidence = currentFactEvidenceRuns(state)
    .filter((run) => !isRejectedToolRunSource(run, state))
    .map((run, index) => [
      `#${index + 1} ${run.tool.name}${run.tool.version ? `@${run.tool.version}` : ""}${run.reused ? " reused" : ""}`,
      `Input: ${JSON.stringify(run.input)}`,
      `Sources: ${sourceUrlsForSynthesis(run, state).join(", ") || "none"}`,
      limitText(currentFactSynthesisPreview(run, state), 2_500),
    ].join("\n"))
    .join("\n\n");
  const messages: Message[] = [
    {
      role: "system",
      content:
        "You answer narrow current factual questions from provided tool evidence only. " +
        "Prefer successful web.read evidence over search snippets. Be concise. Include the source URL/name and runtime timestamp when useful. " +
        "For price/rate questions, give one primary value from the strongest source in the requested or default currency; do not add alternate currencies unless the user asks. " +
        "If sources disagree, mention the discrepancy briefly instead of presenting multiple values as one answer. " +
        "If visual proof is unavailable, say the text/source evidence was used instead. Do not invent unsupported values.",
    },
    {
      role: "user",
      content: [
        `Task: ${input.task}`,
        `Runtime timestamp: ${input.runContext.currentDateTimeIso ?? input.startedAt.toISOString()}`,
        `Timezone: ${input.runContext.timeZone ?? "unknown"}`,
        "Tool evidence:",
        evidence || "No evidence.",
      ].join("\n\n"),
    },
  ];
  const llmStartedAt = new Date();
  try {
    const reply = await runWithTimeout("Current fact synthesis", input.options.llmTimeoutMs, input.options.signal, (signal) =>
      input.llm.completeWithTools(messages, [], {
        modelTier: (input.options.modelTier ?? DEFAULT_AGENT_LOOP_TIER) as ModelTier,
        signal,
        toolChoice: "none",
        maxTokens: DEFAULT_LLM_MAX_TOKENS,
        onRouteDecision: async (decision) => {
          await emit(input.options.onEvent, {
            spanId: `${llmSpanId}:model-route`,
            parentSpanId,
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
    const llmCompletedAt = new Date();
    await emit(input.options.onEvent, {
      spanId: llmSpanId,
      parentSpanId,
      type: "current-fact-synthesis-completed",
      actor: "base-agent",
      activity: "llm",
      status: "completed",
      title: "Current fact synthesis",
      detail: "Synthesized a narrow current answer without additional tool calls.",
      startedAt: llmStartedAt,
      completedAt: llmCompletedAt,
      durationMs: Math.max(0, llmCompletedAt.getTime() - llmStartedAt.getTime()),
      payload: {
        model: reply.model,
        usage: reply.usage,
        input: {
          modelTier: input.options.modelTier ?? DEFAULT_AGENT_LOOP_TIER,
          toolChoice: "none",
          messages,
        },
        output: {
          finishReason: reply.finishReason,
          model: reply.model,
          usage: reply.usage,
          content: limitText(reply.content, 4_000),
          toolCalls: reply.toolCalls.map((call) => ({ id: call.id, name: call.name })),
        },
      },
    });
    return reply.content.trim() || fallbackCurrentFactAnswer(input, state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const llmCompletedAt = new Date();
    await emit(input.options.onEvent, {
      spanId: llmSpanId,
      parentSpanId,
      type: "current-fact-synthesis-failed",
      actor: "base-agent",
      activity: "llm",
      status: "failed",
      title: "Current fact synthesis failed",
      detail: message,
      startedAt: llmStartedAt,
      completedAt: llmCompletedAt,
      durationMs: Math.max(0, llmCompletedAt.getTime() - llmStartedAt.getTime()),
      payload: { error: message },
    });
    return fallbackCurrentFactAnswer(input, state);
  }
}

function finishCurrentFact(input: CurrentFactFastPathInput, state: CurrentFactState, finalAnswer: string): Promise<AgentRunResult> {
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
    successfulResearchToolCalls: state.successfulResearchToolCalls,
    successfulSourceReadToolCalls: state.successfulSourceReadToolCalls,
    runContext: input.runContext,
    artifacts: state.artifacts,
    externalDataEvidenceUrls: state.externalDataEvidenceUrls,
    proofEvidenceByUrl: state.proofEvidenceByUrl,
    externalEvidenceUrls: state.externalEvidenceUrls,
    actionProposals: [],
    requiredArtifacts: inferRequiredArtifacts(input.task),
    failedToolCalls: state.failedToolCalls,
    successfulToolCalls: state.successfulToolCalls,
    attemptedToolCalls: state.attemptedToolCalls,
    terminalFailureReason: state.terminalFailureReason,
    toolCreationRequests: [],
    toolEditRequests: [],
    usedScopedCandidates: new Map(),
    acceptedCandidateKeys: new Set(),
    primaryToolResults: [] satisfies ToolPrimaryResult[],
  });
}

function saveToolArtifact(
  input: CurrentFactFastPathInput & { state: CurrentFactState; tool: Tool },
  toolSpanId: string,
  toolStartedAt: number,
) {
  return async (artifact: ArtifactCreateInput): Promise<AgentArtifact> => {
    const saved = await input.options.saveArtifact!(artifact);
    input.state.artifacts.push(saved);
    await emit(input.options.onEvent, {
      spanId: `${toolSpanId}-artifact-${safeToolName(saved.id).slice(0, 32)}`,
      parentSpanId: toolSpanId,
      type: "artifact-created",
      actor: input.tool.name,
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
        input: { toolName: input.tool.name, artifact: { filename: saved.filename, mimeType: saved.mimeType } },
        output: { artifactId: saved.id, filename: saved.filename, url: saved.url, qualityStatus: saved.quality?.status },
      },
    });
    return saved;
  };
}

function addSourceEvidence(state: CurrentFactState, tool: Tool, toolInput: Record<string, unknown>, result: ToolResult, explicitSourceUrls?: string[]): void {
  if (tool.name === "web.search") {
    addSearchSourceEvidence(state, result);
    return;
  }
  const sourceUrls = explicitSourceUrls?.length ? explicitSourceUrls : extractSourceUrls(toolInput, result);
  for (const url of sourceUrls.slice(0, PROOF_SOURCE_URL_LIMIT)) state.externalEvidenceUrls.add(url);
  if (isScreenshotTool(tool)) return;
  if (sourceUrls.some(isProofWorthySourceUrl)) state.successfulResearchToolCalls += 1;
  if (tool.name === "web.read" && sourceUrls.some(isProofWorthySourceUrl)) state.successfulSourceReadToolCalls += 1;
  for (const url of sourceUrls.slice(0, PROOF_SOURCE_URL_LIMIT)) state.externalDataEvidenceUrls.add(url);
  for (const evidence of extractProofEvidenceForSourceUrls(sourceUrls, toolInput, result)) {
    state.proofEvidenceByUrl.set(evidence.sourceUrl, evidence);
  }
}

function addSearchSourceEvidence(state: CurrentFactState, result: ToolResult): void {
  const candidates = searchSourceCandidates(result.data);
  for (const candidate of candidates.filter(isAcceptableSearchSourceCandidate).slice(0, PROOF_SOURCE_URL_LIMIT)) {
    if (!isProofWorthySourceUrl(candidate.url)) continue;
    state.externalEvidenceUrls.add(candidate.url);
    state.externalDataEvidenceUrls.add(candidate.url);
    const signals = extractProofEvidenceForSourceUrls(
      [candidate.url],
      {},
      {
        ok: true,
        content: [candidate.title, candidate.content].filter(Boolean).join("\n"),
        data: {
          url: candidate.url,
          title: candidate.title,
          snippet: candidate.content,
        },
      },
    )[0];
    if (signals) state.proofEvidenceByUrl.set(candidate.url, signals);
  }
  if (candidates.some(isAcceptableSearchSourceCandidate)) {
    state.successfulResearchToolCalls += 1;
  }
}

function chooseBestSourceUrls(run: CurrentFactToolRun): string[] {
  const structuredUrls = rankSearchDataSources(run.result.data)
    .filter(isAcceptableSearchSourceCandidate)
    .map((candidate) => candidate.url);
  const fallbackUrls = structuredUrls.length > 0 ? [] : run.sourceUrls;
  const urls = [...structuredUrls, ...fallbackUrls].filter(isProofWorthySourceUrl);
  return [...new Set(urls)];
}

type SearchSourceCandidate = {
  url: string;
  title: string;
  content: string;
  index: number;
};

function rankSearchDataSources(data: unknown): SearchSourceCandidate[] {
  return searchSourceCandidates(data).sort((a, b) => scoreSearchSourceCandidate(b) - scoreSearchSourceCandidate(a));
}

function searchSourceCandidates(data: unknown): SearchSourceCandidate[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((item, index): SearchSourceCandidate | undefined => {
      if (!item || typeof item !== "object") return undefined;
      const record = item as Record<string, unknown>;
      const url = typeof record.url === "string" ? record.url.trim() : "";
      if (!url) return undefined;
      return {
        url,
        title: typeof record.title === "string" ? record.title : "",
        content: typeof record.content === "string" ? record.content : "",
        index,
      };
    })
    .filter((candidate): candidate is SearchSourceCandidate => Boolean(candidate));
}

function scoreSearchSourceCandidate(candidate: SearchSourceCandidate): number {
  const url = safeUrl(candidate.url);
  const host = url?.hostname.replace(/^www\./, "") ?? "";
  const path = url?.pathname ?? "";
  const haystack = `${candidate.title} ${candidate.content} ${host} ${path}`.toLowerCase();
  let score = 100 - candidate.index;
  if (/(?:current|live|today|price|quote|rate|market|data|real[ -]?time|сейчас|сегодня|курс|цена|рынок|данные)/iu.test(haystack)) score += 35;
  if (/(?:official|dashboard|chart|tracker|exchange|converter|ticker|api|status|index|reference|docs|documentation)/iu.test(haystack)) score += 15;
  if (hasNumericCurrencySignal(candidate)) score += 30;
  if (candidate.content.trim().length < 20) score -= 28;
  if (/(?:facebook|instagram|tiktok|linkedin|pinterest|reddit|x\.com|twitter|youtube)\./iu.test(host)) score -= 80;
  if (/(?:\/posts?\/|\/profile|\/user\/|\/watch|\/reel|\/status\/|\/share\/)/iu.test(path)) score -= 35;
  if (/(?:blog|forum|community|news|article|opinion|press|story|guide|best-|top-)/iu.test(haystack)) score -= 12;
  if (containsStaleDate(haystack)) score -= 45;
  if (!isProofWorthySourceUrl(candidate.url)) score -= 100;
  return score;
}

function hasNumericCurrencySignal(candidate: SearchSourceCandidate): boolean {
  const text = `${candidate.title} ${candidate.content}`;
  return /(?:[$€£₽]|usd|rub|eur|долл|руб).{0,40}\d|\d[\d\s.,]*(?:[$€£₽]|usd|rub|eur|долл|руб|тыс)/iu.test(text);
}

function hasStandaloneSearchEvidenceForUrl(searchRun: CurrentFactToolRun, sourceUrl: string): boolean {
  const candidate = searchSourceCandidates(searchRun.result.data).find((item) => item.url === sourceUrl);
  if (!candidate) return false;
  return candidate.content.trim().length >= 60 && hasNumericCurrencySignal(candidate);
}

function isAcceptableSearchSourceCandidate(candidate: SearchSourceCandidate): boolean {
  return isProofWorthySourceUrl(candidate.url) && scoreSearchSourceCandidate(candidate) >= 80;
}

function containsStaleDate(text: string): boolean {
  const currentYear = new Date().getUTCFullYear();
  for (const match of text.matchAll(/\b(20\d{2})\b/g)) {
    const year = Number(match[1]);
    if (year > 2000 && currentYear - year >= 2) return true;
  }
  return /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+20(?:0\d|1\d|2[0-4])\b/iu.test(text);
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function currentFactReadRejectionReason(run: CurrentFactToolRun): string | undefined {
  const text = [run.result.content, firstStringField(run.result.data, ["title", "text", "content", "markdown", "description", "summary"])]
    .filter((entry): entry is string => Boolean(entry))
    .join("\n")
    .toLowerCase();
  if (!text.trim()) return "read returned no visible text";
  if (/(?:verify that you'?re not a robot|captcha|recaptcha|cloudflare|security check|access denied|enable javascript|javascript is disabled)/iu.test(text)) {
    return "read returned a blocker or anti-bot page";
  }
  if (text.trim().length < 80) return "read returned too little source text";
  return undefined;
}

function isRejectedToolRunSource(run: CurrentFactToolRun, state: CurrentFactState): boolean {
  if (run.tool.name !== "web.read") return false;
  const inputUrl = typeof run.input.url === "string" ? run.input.url : undefined;
  return Boolean(inputUrl && state.readRejectedSourceUrls.has(inputUrl));
}

function currentFactSynthesisPreview(run: CurrentFactToolRun, state: CurrentFactState): string {
  if (run.tool.name !== "web.search") return run.preview || run.result.content;
  const candidates = searchSourceCandidates(run.result.data)
    .filter((candidate) => !state.primarySourceUrl || candidate.url === state.primarySourceUrl)
    .filter((candidate) => isAcceptableSearchSourceCandidate(candidate) && !state.rejectedSourceUrls.has(candidate.url))
    .slice(0, PROOF_SOURCE_URL_LIMIT);
  if (candidates.length === 0) return "No accepted search results.";
  return candidates
    .map((candidate, index) => `${index + 1}. ${candidate.title || "Untitled"}\n${candidate.url}\n${candidate.content || "No snippet."}`)
    .join("\n\n");
}

function sourceUrlsForSynthesis(run: CurrentFactToolRun, state: CurrentFactState): string[] {
  return run.sourceUrls
    .filter((url) => isProofWorthySourceUrl(url) && !state.rejectedSourceUrls.has(url))
    .filter((url) => !state.primarySourceUrl || run.tool.name !== "web.search" || url === state.primarySourceUrl)
    .slice(0, PROOF_SOURCE_URL_LIMIT);
}

function currentFactEvidenceRuns(state: CurrentFactState): CurrentFactToolRun[] {
  return [...state.toolRuns].sort((a, b) => currentFactRunEvidencePriority(a) - currentFactRunEvidencePriority(b));
}

function currentFactRunEvidencePriority(run: CurrentFactToolRun): number {
  if (run.tool.name === "web.read" && run.result.ok) return 0;
  if (run.tool.name === "web.search" && run.result.ok) return 1;
  if (run.result.ok) return 2;
  return 3;
}

function prioritizeEvidenceSource(state: CurrentFactState, sourceUrl: string | undefined): void {
  if (!sourceUrl || !isProofWorthySourceUrl(sourceUrl)) return;
  state.externalEvidenceUrls = new Set([sourceUrl, ...[...state.externalEvidenceUrls].filter((url) => url !== sourceUrl)]);
  state.externalDataEvidenceUrls = new Set([sourceUrl, ...[...state.externalDataEvidenceUrls].filter((url) => url !== sourceUrl)]);
  const evidence = state.proofEvidenceByUrl.get(sourceUrl);
  if (!evidence) return;
  state.proofEvidenceByUrl = new Map([
    [sourceUrl, evidence],
    ...[...state.proofEvidenceByUrl.entries()].filter(([url]) => url !== sourceUrl),
  ]);
}

async function emitCurrentFactSourceRejected(
  input: CurrentFactFastPathInput,
  parentSpanId: string,
  sourceUrl: string,
  reason: string,
): Promise<void> {
  await emit(input.options.onEvent, {
    parentSpanId,
    type: "current-fact-source-rejected",
    actor: "base-agent",
    activity: "agent",
    status: "completed",
    title: "Current fact source rejected",
    detail: reason,
    startedAt: input.startedAt,
    completedAt: new Date(),
    payload: { sourceUrl, reason },
  });
}

function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}

function buildCurrentFactSearchQuery(task: string): string {
  return task.replace(/\s+/g, " ").trim();
}

function shouldTryScreenshot(task: string): boolean {
  return taskExplicitlyRequestsScreenshot(task) && !taskForbidsScreenshotProof(task);
}

function isScreenshotTool(tool: Tool): boolean {
  return tool.name === "browser.screenshot" || /screenshot/i.test(`${tool.name} ${tool.capabilities.join(" ")}`);
}

async function emitProofSkipped(input: CurrentFactFastPathInput, parentSpanId: string, sourceUrl: string | undefined, reason: string): Promise<void> {
  await emit(input.options.onEvent, {
    parentSpanId,
    type: "proof-skipped",
    actor: "base-agent",
    activity: "agent",
    status: "completed",
    title: "Visual proof skipped",
    detail: reason,
    startedAt: input.startedAt,
    completedAt: new Date(),
    payload: { sourceUrl, reason },
  });
}

async function emitProofDegraded(input: CurrentFactFastPathInput, parentSpanId: string, sourceUrl: string, artifacts: AgentArtifact[]): Promise<void> {
  await emit(input.options.onEvent, {
    parentSpanId,
    type: "proof-degraded",
    actor: "base-agent",
    activity: "agent",
    status: "completed",
    title: "Visual proof degraded",
    detail: "Screenshot proof was attempted but no accepted screenshot artifact was produced; source evidence can still prove the answer.",
    startedAt: input.startedAt,
    completedAt: new Date(),
    payload: {
      sourceUrl,
      artifacts: artifacts.map(publicArtifactForTrace),
      proofEvidence: [...input.taskFrame.requiredEvidence, ...artifacts.flatMap((artifact) => artifact.quality?.checks?.flatMap((check) => check.signals ?? []) ?? [])].slice(0, 20),
    },
  });
}

function fallbackCurrentFactAnswer(input: CurrentFactFastPathInput, state: CurrentFactState): string {
  const best = state.toolRuns.find((run) => run.tool.name === "web.read" && run.result.ok)
    ?? state.toolRuns.find((run) => run.result.ok);
  const sourceUrls = [...state.externalDataEvidenceUrls].filter(isProofWorthySourceUrl);
  return [
    "Не удалось получить отдельный LLM-синтез, поэтому возвращаю проверяемый источник и выдержку из результата.",
    best ? limitText(best.result.content || best.preview, 900) : undefined,
    sourceUrls.length ? `Источник: ${sourceUrls[0]}` : undefined,
    `Время проверки: ${input.runContext.currentDateTimeIso ?? input.startedAt.toISOString()}`,
  ].filter(Boolean).join("\n\n");
}
