import test from "node:test";
import assert from "node:assert/strict";

import {
  createWorkingDecisionEventSink,
  latestWorkingDecisionSnapshot,
} from "../src/agents/workingDecisionLedger.js";
import type { AgentEvent } from "../src/types.js";

test("working decision sink projects task, llm, and tool events into snapshots", async () => {
  const events: AgentEvent[] = [];
  const sink = createWorkingDecisionEventSink({
    runId: "run_working_board",
    task: "Find the best current laptop for local LLMs.",
    sink: (event) => {
      events.push(event);
    },
  });

  await sink(event({
    id: "frame",
    spanId: "run_working_board-agent-task-frame",
    type: "agent-task-framed",
    title: "Task framed",
    payload: {
      output: {
        mode: "product_selection",
        idealOutcome: "Recommend the best laptop with source-backed reasoning.",
        requiredEvidence: ["current prices", "GPU/VRAM"],
        researchPlan: [
          {
            step: "Candidate discovery",
            expectedEvidence: "retailer/manufacturer pages",
          },
        ],
      },
    },
  }));

  await sink(event({
    id: "llm1",
    spanId: "run_working_board-llm-1",
    type: "agent-invocation-decision-selected",
    activity: "llm",
    title: "LLM step 1",
    payload: {
      finishReason: "tool_calls",
      toolCalls: [{ name: "web_search" }],
    },
  }));

  await sink(event({
    id: "tool1",
    spanId: "run_working_board-tool-1-web_search",
    type: "tool-completed",
    actor: "web.search",
    activity: "tool",
    title: "Tool: web.search",
    detail: "Found https://example.com/laptop with current specs.",
    payload: {
      output: {
        preview: "Example Laptop 2026 specs at https://example.com/laptop",
      },
    },
  }));

  const created = events.find((entry) => entry.type === "working-decision-snapshot-created");
  assert.ok(created);
  const latest = latestWorkingDecisionSnapshot(events);
  assert.ok(latest);
  assert.equal(latest.taskMode, "product_selection");
  assert.equal(latest.objective, "Recommend the best laptop with source-backed reasoning.");
  assert.equal(latest.metricsSummary?.llmCalls, 1);
  assert.equal(latest.metricsSummary?.toolCalls, 1);
  assert.ok(latest.knownFacts.some((fact) => fact.summary.includes("Example Laptop 2026")));
  assert.ok(latest.candidates.some((candidate) => candidate.sourceUrl === "https://example.com/laptop"));
  assert.ok(latest.openQuestions.some((question) => question.includes("GPU/VRAM")));
});

test("working decision sink records repair events as rejected evidence", async () => {
  const events: AgentEvent[] = [];
  const sink = createWorkingDecisionEventSink({
    runId: "run_repair_board",
    task: "Research a current source-backed answer.",
    sink: (event) => {
      events.push(event);
    },
  });

  await sink(event({
    id: "frame",
    spanId: "run_repair_board-agent-task-frame",
    type: "agent-task-framed",
    title: "Task framed",
    payload: { output: { mode: "exploratory_research", idealOutcome: "Answer with checked sources." } },
  }));
  await sink(event({
    id: "repair",
    spanId: "run_repair_board-agent-repair",
    type: "agent-source-grounding-repair-requested",
    title: "Source grounding repair requested",
    detail: "Final answer was blocked until concrete claims are tied to source evidence.",
  }));

  const latest = latestWorkingDecisionSnapshot(events);
  assert.ok(latest);
  assert.equal(latest.phase, "repair_answer");
  assert.equal(latest.rejectedEvidence.length, 1);
  assert.match(latest.rejectedEvidence[0]?.reason ?? "", /concrete claims/);
});

test("working decision sink keeps low-value source reads out of candidate board", async () => {
  const events: AgentEvent[] = [];
  const sink = createWorkingDecisionEventSink({
    runId: "run_low_value_sources",
    task: "Research laptop recommendations.",
    sink: (entry) => {
      events.push(entry);
    },
  });

  await sink(event({
    id: "frame",
    spanId: "run_low_value_sources-agent-task-frame",
    type: "agent-task-framed",
    title: "Task framed",
    payload: { output: { mode: "product_selection", idealOutcome: "Find source-backed candidates." } },
  }));
  await sink(event({
    id: "read-low-value",
    spanId: "run_low_value_sources-tool-1-web_read-source-read",
    type: "source-read-recorded",
    actor: "web.read",
    activity: "tool",
    title: "Source read recorded",
    payload: {
      source: {
        sourceId: "src_youtube_results",
        normalizedUrl: "https://youtube.com/results?search_query=best+laptop",
        sourceType: "search_results",
        qualityScore: 0.18,
      },
    },
  }));

  const latest = latestWorkingDecisionSnapshot(events);
  assert.ok(latest);
  assert.equal(latest.candidates.some((candidate) => candidate.sourceUrl?.includes("youtube.com/results")), false);
  assert.ok(latest.rejectedEvidence.some((rejected) => /not durable enough/i.test(rejected.reason)));
});

test("working decision sink applies validated model board updates", async () => {
  const events: AgentEvent[] = [];
  const sink = createWorkingDecisionEventSink({
    runId: "run_model_board",
    task: "Compare two laptop candidates.",
    sink: (entry) => {
      events.push(entry);
    },
  });

  await sink(event({
    id: "frame",
    spanId: "run_model_board-agent-task-frame",
    type: "agent-task-framed",
    title: "Task framed",
    payload: { output: { mode: "product_selection", idealOutcome: "Choose the best candidate." } },
  }));
  await sink(event({
    id: "board-update",
    spanId: "run_model_board-llm-1",
    type: "working-decision-update-requested",
    title: "Working board update requested",
    payload: {
      update: {
        phase: "evaluate_evidence",
        knownFacts: [{ summary: "Candidate A has 32GB RAM.", confidence: "high", sourceUrl: "https://example.com/a" }],
        candidates: [
          {
            label: "Candidate A",
            status: "selected",
            sourceUrl: "https://example.com/a",
            scores: { fit: 0.91, sourceQuality: 0.8 },
            reason: "Best match against the criteria.",
          },
        ],
        nextAction: { description: "Draft the recommendation.", expectedEvidence: "Final gate pass." },
        draftStatus: { status: "drafting", summary: "Evidence is sufficient for a draft." },
      },
    },
  }));

  const latest = latestWorkingDecisionSnapshot(events);
  assert.ok(latest);
  assert.equal(latest.phase, "evaluate_evidence");
  assert.equal(latest.candidates[0]?.status, "selected");
  assert.equal(latest.candidates[0]?.scores?.fit, 0.91);
  assert.equal(latest.knownFacts[0]?.sourceUrl, "https://example.com/a");
  assert.equal(latest.draftStatus.status, "drafting");
});

test("working decision sink projects memory-use records into board snapshots", async () => {
  const events: AgentEvent[] = [];
  const sink = createWorkingDecisionEventSink({
    runId: "run_memory_board",
    task: "какой источник ты использовал?",
    sink: (entry) => {
      events.push(entry);
    },
  });

  await sink(event({
    id: "frame",
    spanId: "run_memory_board-agent-task-frame",
    type: "agent-task-framed",
    title: "Task framed",
    payload: { output: { mode: "thread_context_answer", idealOutcome: "Answer from prior context." } },
  }));
  await sink(event({
    id: "memory-use",
    spanId: "run_memory_board-agent-context-memory-use",
    type: "memory-use-resolved",
    activity: "memory",
    title: "Memory sources resolved",
    payload: {
      memoryUse: [
        {
          source: "thread",
          status: "used",
          reason: "Thread context is answering this follow-up.",
          recordIds: ["thread-1"],
        },
        {
          source: "evidence_ledger",
          status: "used",
          reason: "Prior evidence satisfies this follow-up.",
          recordIds: ["evidence-1"],
        },
      ],
    },
  }));

  const latest = latestWorkingDecisionSnapshot(events);
  assert.ok(latest);
  assert.equal(latest.phase, "use_prior_context");
  assert.equal(latest.memoryUse?.length, 2);
  assert.ok(latest.nextAction?.description.includes("memory"));
});

test("working decision sink rejects invalid model board updates without throwing", async () => {
  const events: AgentEvent[] = [];
  const sink = createWorkingDecisionEventSink({
    runId: "run_bad_model_board",
    task: "Compare options.",
    sink: (entry) => {
      events.push(entry);
    },
  });

  await sink(event({
    id: "frame",
    spanId: "run_bad_model_board-agent-task-frame",
    type: "agent-task-framed",
    title: "Task framed",
    payload: { output: { mode: "product_selection", idealOutcome: "Choose an option." } },
  }));
  await sink(event({
    id: "bad-update",
    spanId: "run_bad_model_board-llm-1",
    type: "working-decision-update-requested",
    title: "Working board update requested",
    payload: { update: { phase: "secret_phase", candidates: "not-an-array" } },
  }));

  assert.ok(events.some((entry) => entry.type === "working-decision-update-rejected"));
  const latest = latestWorkingDecisionSnapshot(events);
  assert.ok(latest);
  assert.equal(latest.phase, "evaluate_evidence");
  assert.match(latest.rejectedEvidence.at(-1)?.reason ?? "", /phase/i);
});

function event(input: Partial<AgentEvent> & Pick<AgentEvent, "id" | "spanId" | "type" | "title">): AgentEvent {
  const timestamp = "2026-06-22T10:00:00.000Z";
  return {
    actor: "base-agent",
    activity: "agent",
    status: "completed",
    timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    ...input,
  };
}
