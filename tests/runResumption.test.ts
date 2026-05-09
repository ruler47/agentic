import test from "node:test";
import assert from "node:assert/strict";
import {
  hasResumableProgress,
  isSubtaskFullyDone,
  reconstructProgress,
  toResumptionState,
} from "../src/agents/runResumption.js";
import type { AgentEvent, Subtask, TaskComplexity } from "../src/types.js";

function event(overrides: Partial<AgentEvent>): AgentEvent {
  return {
    id: overrides.id ?? `e-${Math.random()}`,
    spanId: overrides.spanId ?? "span",
    type: overrides.type ?? "run-started",
    actor: overrides.actor ?? "coordinator",
    activity: overrides.activity ?? "coordination",
    status: overrides.status ?? "started",
    title: overrides.title ?? "x",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    payload: overrides.payload,
  } as AgentEvent;
}

const SUBTASK_A: Subtask = {
  id: "sub-a",
  role: "researcher",
  title: "A",
  prompt: "do A",
  expectedOutput: "answer A",
  reviewCriteria: ["criterion"],
  requiredTools: [],
  dependsOn: [],
} as Subtask;

const SUBTASK_B: Subtask = { ...SUBTASK_A, id: "sub-b", title: "B" };

const COMPLEXITY_PAYLOAD: TaskComplexity = {
  mode: "delegated",
  reason: "needs research",
  domains: ["research"],
  riskLevel: "medium",
  intent: ["product-comparison"],
};

test("reconstructProgress: empty events → empty progress", () => {
  const progress = reconstructProgress([]);
  assert.equal(progress.complexity, undefined);
  assert.equal(progress.subtasks, undefined);
  assert.equal(progress.completedWorkers.size, 0);
  assert.equal(progress.completedReviews.size, 0);
  assert.equal(progress.synthesisCompleted, false);
  assert.equal(hasResumableProgress(progress), false);
});

test("reconstructProgress: extracts TaskComplexity from classification-completed", () => {
  const progress = reconstructProgress([
    event({ type: "classification-completed", payload: COMPLEXITY_PAYLOAD as unknown as Record<string, unknown> }),
  ]);
  assert.deepEqual(progress.complexity, COMPLEXITY_PAYLOAD);
  assert.equal(hasResumableProgress(progress), true);
});

test("reconstructProgress: extracts subtasks from planning-completed", () => {
  const progress = reconstructProgress([
    event({ type: "planning-completed", payload: { subtasks: [SUBTASK_A, SUBTASK_B] } as unknown as Record<string, unknown> }),
  ]);
  assert.equal(progress.subtasks?.length, 2);
  assert.equal(progress.subtasks?.[0].id, "sub-a");
  assert.equal(progress.subtasks?.[1].id, "sub-b");
});

test("reconstructProgress: latest worker-completed wins for revisions", () => {
  const progress = reconstructProgress([
    event({
      type: "worker-completed",
      payload: { subtask: SUBTASK_A, output: "first attempt" } as unknown as Record<string, unknown>,
    }),
    event({
      type: "worker-completed",
      payload: { subtask: SUBTASK_A, output: "revised attempt" } as unknown as Record<string, unknown>,
    }),
  ]);
  assert.equal(progress.completedWorkers.size, 1);
  assert.equal(progress.completedWorkers.get("sub-a")?.output, "revised attempt");
});

test("reconstructProgress: review verdict and notes are captured per subtask", () => {
  const progress = reconstructProgress([
    event({
      type: "review-completed",
      payload: {
        subtaskId: "sub-a",
        verdict: "needs_revision",
        notes: "Output is incomplete",
      } as unknown as Record<string, unknown>,
    }),
    event({
      type: "review-completed",
      payload: {
        subtaskId: "sub-a",
        verdict: "pass",
        notes: "Revision is acceptable",
      } as unknown as Record<string, unknown>,
    }),
  ]);
  assert.equal(progress.completedReviews.size, 1);
  assert.equal(progress.completedReviews.get("sub-a")?.verdict, "pass");
  assert.equal(progress.completedReviews.get("sub-a")?.notes, "Revision is acceptable");
});

test("reconstructProgress: synthesis-completed sets the flag", () => {
  const progress = reconstructProgress([
    event({ type: "synthesis-completed" }),
  ]);
  assert.equal(progress.synthesisCompleted, true);
});

test("reconstructProgress: malformed payloads are silently skipped", () => {
  const progress = reconstructProgress([
    event({ type: "classification-completed", payload: { mode: "wat", riskLevel: "low" } as unknown as Record<string, unknown> }),
    event({ type: "planning-completed", payload: { subtasks: ["not an object"] } as unknown as Record<string, unknown> }),
    event({ type: "worker-completed", payload: { output: "missing subtask" } as unknown as Record<string, unknown> }),
    event({ type: "review-completed", payload: { subtaskId: "x" } as unknown as Record<string, unknown> }),
  ]);
  assert.equal(progress.complexity, undefined);
  assert.equal(progress.subtasks?.length ?? 0, 0);
  assert.equal(progress.completedWorkers.size, 0);
  assert.equal(progress.completedReviews.size, 0);
});

test("isSubtaskFullyDone: true only when worker exists and review verdict=pass", () => {
  const workers = new Map([["sub-a", { subtask: SUBTASK_A, output: "x" }]]);
  const passReviews = new Map([["sub-a", { subtaskId: "sub-a", verdict: "pass" as const, notes: "ok" }]]);
  const failReviews = new Map([["sub-a", { subtaskId: "sub-a", verdict: "needs_revision" as const, notes: "no" }]]);
  assert.equal(isSubtaskFullyDone("sub-a", workers, passReviews), true);
  assert.equal(isSubtaskFullyDone("sub-a", workers, failReviews), false);
  assert.equal(isSubtaskFullyDone("sub-a", workers, new Map()), false);
  assert.equal(isSubtaskFullyDone("sub-b", workers, passReviews), false);
});

test("toResumptionState: round-trips a populated progress", () => {
  const events = [
    event({ type: "classification-completed", payload: COMPLEXITY_PAYLOAD as unknown as Record<string, unknown> }),
    event({ type: "planning-completed", payload: { subtasks: [SUBTASK_A, SUBTASK_B] } as unknown as Record<string, unknown> }),
    event({ type: "worker-completed", payload: { subtask: SUBTASK_A, output: "out-a" } as unknown as Record<string, unknown> }),
    event({ type: "review-completed", payload: { subtaskId: "sub-a", verdict: "pass", notes: "ok" } as unknown as Record<string, unknown> }),
  ];
  const state = toResumptionState(reconstructProgress(events), "src-run-1");
  assert.equal(state.sourceRunId, "src-run-1");
  assert.deepEqual(state.complexity, COMPLEXITY_PAYLOAD);
  assert.equal(state.subtasks?.length, 2);
  assert.equal(state.completedWorkers?.length, 1);
  assert.equal(state.completedReviews?.length, 1);
});
