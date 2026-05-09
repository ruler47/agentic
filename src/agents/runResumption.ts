import {
  AgentEvent,
  ReviewResult,
  Subtask,
  TaskComplexity,
  WorkerResult,
} from "../types.js";

/**
 * Phase 12 follow-up: resume an interrupted run from where it left off
 * instead of restarting from scratch. The runtime already persists every
 * coordinator phase as an event (classify → plan → worker → review →
 * synthesis). This module replays those events to extract durable
 * progress so a resumed run can skip phases the prior process already
 * completed:
 *
 *   - `complexity` from `classification-completed`
 *   - `subtasks` from `planning-completed`
 *   - `completedWorkers` and `completedReviews` per subtask id from
 *     `worker-completed` / `review-completed`
 *   - `synthesisCompleted` flag — if true the final answer is already
 *     in the source run's `result`, no need to re-run
 *
 * Work Ledger / Evidence Ledger preserve heavy external work (web.search,
 * browser.operate) by default, so even subtasks that DO need to re-run
 * pull cached evidence through the existing `claim()` mechanism.
 */

export type RunProgress = {
  complexity?: TaskComplexity;
  subtasks?: Subtask[];
  completedWorkers: Map<string, WorkerResult>;
  completedReviews: Map<string, ReviewResult>;
  synthesisCompleted: boolean;
  /** Span / event type of the last event before the run stopped — useful
   * for traces and explaining why a resume was needed. */
  lastEventType?: string;
};

export type RunResumptionState = {
  complexity?: TaskComplexity;
  subtasks?: Subtask[];
  completedWorkers?: WorkerResult[];
  completedReviews?: ReviewResult[];
  /** Diagnostic only — the resumption layer ignores synthesis state, the
   * caller decides whether to re-run synthesis (cheap LLM call) or
   * short-circuit. */
  sourceRunId?: string;
};

/**
 * Replay run events in order, building up the latest known state for
 * each phase. Workers can be revised multiple times; the LATEST
 * `worker-completed` for a given subtask wins. Reviews follow the same
 * convention. Failed workers are recorded as completed too — the caller
 * decides whether `verdict=needs_revision` requires re-running.
 */
export function reconstructProgress(events: readonly AgentEvent[]): RunProgress {
  const completedWorkers = new Map<string, WorkerResult>();
  const completedReviews = new Map<string, ReviewResult>();
  let complexity: TaskComplexity | undefined;
  let subtasks: Subtask[] | undefined;
  let synthesisCompleted = false;
  let lastEventType: string | undefined;

  for (const event of events) {
    lastEventType = event.type;
    if (event.type === "classification-completed") {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload && typeof payload === "object") {
        const candidate = payload as Partial<TaskComplexity> & Record<string, unknown>;
        if (
          (candidate.mode === "direct" || candidate.mode === "delegated") &&
          typeof candidate.reason === "string" &&
          Array.isArray(candidate.domains) &&
          (candidate.riskLevel === "low" || candidate.riskLevel === "medium" || candidate.riskLevel === "high")
        ) {
          complexity = {
            mode: candidate.mode,
            reason: candidate.reason,
            domains: candidate.domains.filter((d): d is string => typeof d === "string"),
            riskLevel: candidate.riskLevel,
            intent: Array.isArray(candidate.intent)
              ? candidate.intent.filter((i): i is string => typeof i === "string")
              : [],
          };
        }
      }
    } else if (event.type === "planning-completed") {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload && Array.isArray((payload as { subtasks?: unknown }).subtasks)) {
        subtasks = ((payload as { subtasks: unknown[] }).subtasks).filter(
          (item): item is Subtask =>
            !!item && typeof item === "object" && typeof (item as Subtask).id === "string",
        );
      }
    } else if (event.type === "worker-completed") {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload && typeof payload === "object") {
        const subtask = (payload as { subtask?: unknown }).subtask as Subtask | undefined;
        const output = (payload as { output?: unknown }).output;
        if (subtask && typeof subtask.id === "string" && typeof output === "string") {
          const result: WorkerResult = {
            subtask,
            output,
            toolEvidence: Array.isArray((payload as { toolEvidence?: unknown }).toolEvidence)
              ? ((payload as { toolEvidence: unknown[] }).toolEvidence as string[])
              : undefined,
            artifacts: Array.isArray((payload as { artifacts?: unknown }).artifacts)
              ? ((payload as { artifacts: unknown[] }).artifacts as WorkerResult["artifacts"])
              : undefined,
            traceSpanId: typeof event.spanId === "string" ? event.spanId : undefined,
            modelTier: (payload as { modelTier?: WorkerResult["modelTier"] }).modelTier,
          };
          completedWorkers.set(subtask.id, result);
        }
      }
    } else if (event.type === "review-completed") {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload && typeof payload === "object") {
        const subtaskId = (payload as { subtaskId?: unknown }).subtaskId;
        const verdict = (payload as { verdict?: unknown }).verdict;
        const notes = (payload as { notes?: unknown }).notes;
        if (
          typeof subtaskId === "string" &&
          (verdict === "pass" || verdict === "needs_revision") &&
          typeof notes === "string"
        ) {
          completedReviews.set(subtaskId, { subtaskId, verdict, notes });
        }
      }
    } else if (event.type === "synthesis-completed") {
      synthesisCompleted = true;
    } else if (event.type === "run-completed") {
      synthesisCompleted = true;
    }
  }

  return {
    complexity,
    subtasks,
    completedWorkers,
    completedReviews,
    synthesisCompleted,
    lastEventType,
  };
}

/**
 * Decide whether a subtask is "done enough" to skip on resume:
 *   - it must have a worker result
 *   - the matching review must exist with verdict=pass
 * Subtasks with `verdict=needs_revision` and no follow-up pass are
 * re-run so the agent can produce the missing revision.
 */
export function isSubtaskFullyDone(
  subtaskId: string,
  workers: ReadonlyMap<string, WorkerResult>,
  reviews: ReadonlyMap<string, ReviewResult>,
): boolean {
  if (!workers.has(subtaskId)) return false;
  const review = reviews.get(subtaskId);
  return Boolean(review && review.verdict === "pass");
}

/**
 * Helper: convert a `RunProgress` into the shape `agent.run()` accepts as
 * `resumeFrom`. Drops the in-flight bookkeeping and gives the caller a
 * compact snapshot suitable for passing across HTTP / job queues.
 */
export function toResumptionState(progress: RunProgress, sourceRunId?: string): RunResumptionState {
  return {
    complexity: progress.complexity,
    subtasks: progress.subtasks,
    completedWorkers: [...progress.completedWorkers.values()],
    completedReviews: [...progress.completedReviews.values()],
    sourceRunId,
  };
}

/**
 * True when there is meaningful progress to preserve — at minimum the
 * classifier output. If false, the caller should restart from scratch
 * because there is nothing useful to resume from.
 */
export function hasResumableProgress(progress: RunProgress): boolean {
  return Boolean(progress.complexity);
}
