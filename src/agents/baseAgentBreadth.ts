import type { AgentEventSink, Message } from "../types.js";
import { emit, hasRemainingSteps, hasRemainingToolCalls } from "./baseAgentRuntime.js";
import { toolMessage } from "./baseAgentToolMessages.js";
import type { RunSourceRegistry } from "./sourceRegistry.js";
import { presentedLinkVerifyInstruction } from "./baseAgentVerifyLinks.js";
import type { TaskFrame } from "./taskFrame.js";

export type ResearchCoverageCounts = {
  discovered: number; // candidate sources surfaced by search
  opened: number; // distinct sources with >= 1 read attempt (passed/blocked/failed)
};

// Return-gate wrapper for research quality, mirroring requestSourceSearchPlanRepair: block the
// finish and push one corrective turn. Two checks in priority order — (1) breadth: open more of
// what search discovered; (2) presented-link verification: drop/confirm links the answer shows
// as buy/source links but never opened this run. Either blocks the finish; bounded attempts +
// remaining budget keep it from looping.
export async function requestResearchQualityRepair(input: {
  taskFrame: TaskFrame;
  sourceRegistry: RunSourceRegistry;
  repairAttempts: number;
  step: number;
  maxSteps?: number;
  attemptedToolCalls: number;
  maxToolCalls?: number;
  messages: Message[];
  finalAnswer: string;
  onEvent?: AgentEventSink;
  parentSpanId: string;
  startedAt: Date;
  toolCallId?: string;
}): Promise<{ repaired: boolean; repairAttempts: number }> {
  const breadth = researchBreadthRepairInstruction({
    taskFrame: input.taskFrame,
    coverage: input.sourceRegistry.coverageCounts(),
    attemptedToolCalls: input.attemptedToolCalls,
    maxToolCalls: input.maxToolCalls ?? Number.POSITIVE_INFINITY,
  });
  const verify = breadth
    ? undefined
    : presentedLinkVerifyInstruction({
        taskFrame: input.taskFrame,
        finalAnswer: input.finalAnswer,
        registry: input.sourceRegistry,
      });
  const instruction = breadth ?? verify;
  if (
    !instruction ||
    input.repairAttempts >= 3 ||
    !hasRemainingSteps(input.step, input.maxSteps) ||
    !hasRemainingToolCalls(input.attemptedToolCalls, input.maxToolCalls)
  ) {
    return { repaired: false, repairAttempts: input.repairAttempts };
  }
  const repairAttempts = input.repairAttempts + 1;
  if (input.toolCallId) {
    input.messages.push(toolMessage(input.toolCallId, false, instruction));
  } else {
    input.messages.push({ role: "assistant", content: input.finalAnswer });
  }
  input.messages.push({ role: "user", content: instruction });
  await emit(input.onEvent, {
    parentSpanId: input.parentSpanId,
    type: "agent-source-search-plan-repair-requested",
    actor: "base-agent",
    activity: "agent",
    status: "completed",
    title: breadth ? "Research breadth repair requested" : "Presented-link verify repair requested",
    detail: breadth
      ? "Final answer was blocked: discovered many sources but opened too few; opening more before answering."
      : "Final answer was blocked: presents links not opened/confirmed this run; verify or drop them.",
    startedAt: input.startedAt,
    completedAt: new Date(),
    payload: { attempt: repairAttempts, output: { instruction } },
  });
  return { repaired: true, repairAttempts };
}

// Block a grounding-hard answer that found many candidate sources via search but opened only
// a few before answering, and force it to actually open more of what it found and return
// concrete results — instead of finishing with advice on where/how the USER should search
// (the "go look it up yourself" failure). This is a general breadth floor over
// RunSourceRegistry counts (not a domain keyword pipeline). Blocked/out-of-stock reads still
// count as opened, so shop 403s don't trap the loop. Returns the corrective instruction, or
// undefined when breadth is already adequate / not applicable / out of budget.
export function researchBreadthRepairInstruction(input: {
  taskFrame: TaskFrame;
  coverage: ResearchCoverageCounts;
  attemptedToolCalls: number;
  maxToolCalls: number;
}): string | undefined {
  // Only for tasks that require external research at all.
  if (input.taskFrame.researchContract.minResearchToolCalls < 1) return undefined;
  // Need budget left to open more.
  if (input.attemptedToolCalls >= input.maxToolCalls) return undefined;
  const { discovered, opened } = input.coverage;
  if (discovered < DISCOVERY_FLOOR) return undefined;
  const target = openTarget(discovered);
  if (opened >= target) return undefined;
  return [
    `RESEARCH TOO SHALLOW: search surfaced ${discovered} candidate sources but you opened only ${opened} of them before answering.`,
    `Open more of those candidates with web.read — aim for at least ${target} distinct sources across different sites — and extract the concrete answer the user asked for (for a "where to buy" task: specific listings with price and availability).`,
    `Do NOT answer by telling the user where or how to search (no "go to site X and use the filters", no "check eBay or local resellers") — running that search and returning concrete, verified results is exactly your job.`,
    `A blocked or out-of-stock page still counts as opened: move on to the next candidate and keep going until you have concrete verified results or have genuinely exhausted the candidates.`,
  ].join(" ");
}

const DISCOVERY_FLOOR = 6;

// Moderate, derived (not a magic constant tuned to one case): open a meaningful share of what
// was discovered, capped so a huge discovery set does not force a runaway number of reads.
// Tune from researchCoverage observability rather than guessing higher.
function openTarget(discovered: number): number {
  return Math.min(discovered, Math.max(5, Math.ceil(discovered / 3)), 8);
}
