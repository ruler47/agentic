import { LlmClient } from "../llm/client.js";
import { SkillMemoryStore } from "../memory/skillMemory.js";
import { ToolRegistry } from "../tools/registry.js";
import { shouldUseWebSearch } from "../tools/webSearchTool.js";
import {
  AgentEvent,
  AgentEventSink,
  AgentRunResult,
  ReviewResult,
  SkillMemoryEntry,
  Subtask,
  TaskComplexity,
  WorkerResult,
} from "../types.js";
import { extractJson } from "../utils/json.js";
import {
  classifyPrompt,
  coordinatorSystemPrompt,
  learningPrompt,
  planPrompt,
  reviewerSystemPrompt,
  synthesizePrompt,
  workerSystemPrompt,
} from "./prompts.js";

type PlanResponse = {
  subtasks: Subtask[];
};

type LearningResponse = {
  shouldStore: boolean;
  title?: string;
  tags?: string[];
  summary?: string;
  reusableProcedure?: string;
};

type RunOptions = {
  onEvent?: AgentEventSink;
};

type AgentEventEmitter = (event: AgentEventDraft) => Promise<void>;

type AgentEventDraft = Omit<AgentEvent, "id" | "timestamp" | "spanId"> & {
  spanId?: string;
};

type ReviewedWorkerResult = {
  workerResult: WorkerResult;
  review: ReviewResult;
};

export class UniversalAgent {
  constructor(
    private readonly llm: LlmClient,
    private readonly skillMemory: SkillMemoryStore,
    private readonly tools = new ToolRegistry(),
  ) {}

  async run(task: string, options: RunOptions = {}): Promise<AgentRunResult> {
    const emit = createEmitter(options.onEvent);
    const runSpanId = createSpanId("run");
    const memorySpanId = createSpanId("memory");
    const classificationSpanId = createSpanId("classification");
    const runStartedAt = new Date();

    await emit({
      spanId: runSpanId,
      type: "run-started",
      actor: "coordinator",
      activity: "coordination",
      status: "started",
      title: "Coordinator run",
      detail: task,
      startedAt: runStartedAt.toISOString(),
    });

    const memoryStartedAt = new Date();
    const memories = await this.skillMemory.search(task);
    await emit({
      spanId: memorySpanId,
      parentSpanId: runSpanId,
      type: "memory-search-completed",
      actor: "coordinator",
      activity: "memory",
      status: "completed",
      title: "Skill memory searched",
      detail: `${memories.length} relevant memories found`,
      startedAt: memoryStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(memoryStartedAt),
      payload: memories,
    });

    const classificationStartedAt = new Date();
    const complexity = await this.classify(task, memories);
    await emit({
      spanId: classificationSpanId,
      parentSpanId: runSpanId,
      type: "classification-completed",
      actor: "coordinator",
      activity: "llm",
      status: "completed",
      title: `Task classified as ${complexity.mode}`,
      detail: complexity.reason,
      startedAt: classificationStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(classificationStartedAt),
      payload: complexity,
    });

    if (complexity.mode === "direct") {
      const synthesisSpanId = createSpanId("synthesis");
      const synthesisStartedAt = new Date();
      await emit({
        spanId: synthesisSpanId,
        parentSpanId: runSpanId,
        type: "synthesis-started",
        actor: "synthesizer",
        activity: "synthesis",
        status: "started",
        title: "Direct answer synthesis started",
        startedAt: synthesisStartedAt.toISOString(),
      });
      const finalAnswer = await this.llm.complete([
        { role: "system", content: coordinatorSystemPrompt },
        {
          role: "user",
          content: synthesizePrompt(task, complexity, [], [], memories),
        },
      ]);
      await emit({
        spanId: synthesisSpanId,
        parentSpanId: runSpanId,
        type: "synthesis-completed",
        actor: "synthesizer",
        activity: "llm",
        status: "completed",
        title: "Direct answer synthesized",
        startedAt: synthesisStartedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: elapsedMs(synthesisStartedAt),
        payload: { finalAnswer },
      });

      const learningStartedAt = new Date();
      const learnedSkill = await this.learn(task, finalAnswer, []);
      await emit({
        spanId: createSpanId("learning"),
        parentSpanId: runSpanId,
        type: "learning-completed",
        actor: "coordinator",
        activity: "memory",
        status: "completed",
        title: learnedSkill ? "Reusable skill stored" : "No reusable skill stored",
        startedAt: learningStartedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: elapsedMs(learningStartedAt),
        payload: learnedSkill,
      });

      await emit({
        spanId: runSpanId,
        type: "run-completed",
        actor: "coordinator",
        activity: "coordination",
        status: "completed",
        title: "Coordinator run",
        startedAt: runStartedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: elapsedMs(runStartedAt),
        payload: { finalAnswer },
      });

      return {
        finalAnswer,
        complexity,
        subtasks: [],
        workerResults: [],
        reviews: [],
        learnedSkill,
      };
    }

    const planningSpanId = createSpanId("planning");
    const planningStartedAt = new Date();
    const subtasks = await this.plan(task, complexity, memories);
    await emit({
      spanId: planningSpanId,
      parentSpanId: runSpanId,
      type: "planning-completed",
      actor: "planner",
      activity: "planning",
      status: "completed",
      title: `${subtasks.length} subtasks planned`,
      startedAt: planningStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(planningStartedAt),
      payload: subtasks,
    });

    const reviewedWorkerResults = await Promise.all(
      subtasks.map((subtask) =>
        this.runWorkerAndRequestReview(task, subtask, memories, emit, planningSpanId),
      ),
    );
    const workerResults = reviewedWorkerResults.map((result) => result.workerResult);
    const reviews = reviewedWorkerResults.map((result) => result.review);
    const synthesisSpanId = createSpanId("synthesis");
    const synthesisStartedAt = new Date();
    await emit({
      spanId: synthesisSpanId,
      parentSpanId: runSpanId,
      type: "synthesis-started",
      actor: "synthesizer",
      activity: "synthesis",
      status: "started",
      title: "Final synthesis started",
      startedAt: synthesisStartedAt.toISOString(),
    });
    const finalAnswer = await this.llm.complete([
      { role: "system", content: coordinatorSystemPrompt },
      {
        role: "user",
        content: synthesizePrompt(task, complexity, workerResults, reviews, memories),
      },
    ]);
    await emit({
      spanId: synthesisSpanId,
      parentSpanId: runSpanId,
      type: "synthesis-completed",
      actor: "synthesizer",
      activity: "llm",
      status: "completed",
      title: "Final answer synthesized",
      startedAt: synthesisStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(synthesisStartedAt),
      payload: { finalAnswer },
    });

    const learningStartedAt = new Date();
    const learnedSkill = await this.learn(task, finalAnswer, workerResults);
    await emit({
      spanId: createSpanId("learning"),
      parentSpanId: runSpanId,
      type: "learning-completed",
      actor: "coordinator",
      activity: "memory",
      status: "completed",
      title: learnedSkill ? "Reusable skill stored" : "No reusable skill stored",
      startedAt: learningStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(learningStartedAt),
      payload: learnedSkill,
    });

    await emit({
      spanId: runSpanId,
      type: "run-completed",
      actor: "coordinator",
      activity: "coordination",
      status: "completed",
      title: "Coordinator run",
      startedAt: runStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(runStartedAt),
      payload: { finalAnswer },
    });

    return {
      finalAnswer,
      complexity,
      subtasks,
      workerResults,
      reviews,
      learnedSkill,
    };
  }

  private async classify(task: string, memories: SkillMemoryEntry[]): Promise<TaskComplexity> {
    const output = await this.llm.complete([
      { role: "system", content: coordinatorSystemPrompt },
      { role: "user", content: classifyPrompt(task, memories) },
    ]);

    return extractJson<TaskComplexity>(output);
  }

  private async plan(
    task: string,
    complexity: TaskComplexity,
    memories: SkillMemoryEntry[],
  ): Promise<Subtask[]> {
    const output = await this.llm.complete([
      { role: "system", content: coordinatorSystemPrompt },
      { role: "user", content: planPrompt(task, complexity, memories) },
    ]);

    return extractJson<PlanResponse>(output).subtasks;
  }

  private async runWorker(
    originalTask: string,
    subtask: Subtask,
    memories: SkillMemoryEntry[],
    emit: AgentEventEmitter,
    parentSpanId: string,
  ): Promise<WorkerResult> {
    const spanId = createSpanId(`worker-${subtask.id}`);
    const startedAt = new Date();
    await emit({
      spanId,
      parentSpanId,
      type: "worker-started",
      actor: `worker:${subtask.role}`,
      activity: "worker",
      status: "started",
      title: `Worker: ${subtask.title}`,
      detail: subtask.role,
      startedAt: startedAt.toISOString(),
      payload: subtask,
    });

    const output = await this.llm.complete([
      { role: "system", content: workerSystemPrompt(subtask, memories) },
      {
        role: "user",
        content: `Original user task for context:\n${originalTask}\n\n${await this.collectToolEvidence(
          originalTask,
          subtask,
          emit,
          spanId,
        )}\n\nExecute only your assigned subtask.`,
      },
    ]);

    await emit({
      spanId,
      parentSpanId,
      type: "worker-completed",
      actor: `worker:${subtask.role}`,
      activity: "llm",
      status: "completed",
      title: `Worker: ${subtask.title}`,
      detail: output,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(startedAt),
      payload: { subtask, output },
    });

    return { subtask, output, traceSpanId: spanId };
  }

  private async collectToolEvidence(
    originalTask: string,
    subtask: Subtask,
    emit: AgentEventEmitter,
    parentSpanId: string,
  ): Promise<string> {
    const webSearch = this.tools.get("web.search");
    const toolNeedText = `${originalTask}\n${subtask.title}\n${subtask.role}\n${subtask.prompt}`;

    if (!webSearch || !shouldUseWebSearch(toolNeedText)) {
      return "No external tool evidence was collected for this subtask.";
    }

    const spanId = createSpanId(`tool-${webSearch.name}`);
    const startedAt = new Date();
    const query = `${subtask.title}: ${subtask.prompt}`;

    await emit({
      spanId,
      parentSpanId,
      type: "tool-started",
      actor: webSearch.name,
      activity: "tool",
      status: "started",
      title: `Tool: ${webSearch.name}`,
      detail: query,
      startedAt: startedAt.toISOString(),
      payload: { tool: webSearch.name, query },
    });

    const result = await webSearch.run({ query, limit: 5 });
    await emit({
      spanId,
      parentSpanId,
      type: "tool-completed",
      actor: webSearch.name,
      activity: "tool",
      status: result.ok ? "completed" : "failed",
      title: `Tool: ${webSearch.name}`,
      detail: result.content,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(startedAt),
      payload: result,
    });

    return result.ok
      ? `External tool evidence from ${webSearch.name}:\n${result.content}`
      : `External tool ${webSearch.name} failed:\n${result.content}`;
  }

  private async runWorkerAndRequestReview(
    originalTask: string,
    subtask: Subtask,
    memories: SkillMemoryEntry[],
    emit: AgentEventEmitter,
    parentSpanId: string,
  ): Promise<ReviewedWorkerResult> {
    const workerResult = await this.runWorker(originalTask, subtask, memories, emit, parentSpanId);
    const review = await this.review(workerResult, emit, workerResult.traceSpanId ?? parentSpanId);

    return { workerResult, review };
  }

  private async review(
    workerResult: WorkerResult,
    emit: AgentEventEmitter,
    parentSpanId: string,
  ): Promise<ReviewResult> {
    const spanId = createSpanId(`review-${workerResult.subtask.id}`);
    const startedAt = new Date();
    await emit({
      spanId,
      parentSpanId,
      type: "review-started",
      actor: "reviewer",
      activity: "review",
      status: "started",
      title: `Review: ${workerResult.subtask.title}`,
      startedAt: startedAt.toISOString(),
      payload: workerResult,
    });

    const output = await this.llm.complete([
      { role: "system", content: reviewerSystemPrompt(workerResult) },
      { role: "user", content: "Review the worker result now." },
    ]);

    const review = extractJson<ReviewResult>(output);
    await emit({
      spanId,
      parentSpanId,
      type: "review-completed",
      actor: "reviewer",
      activity: "llm",
      status: review.verdict === "pass" ? "completed" : "failed",
      title: `Review: ${workerResult.subtask.title}`,
      detail: `${review.verdict}: ${review.notes}`,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsedMs(startedAt),
      payload: review,
    });

    return review;
  }

  private async learn(
    task: string,
    finalAnswer: string,
    workerResults: WorkerResult[],
  ): Promise<SkillMemoryEntry | undefined> {
    const output = await this.llm.complete([
      { role: "system", content: "You extract compact reusable operational knowledge." },
      { role: "user", content: learningPrompt(task, finalAnswer, workerResults) },
    ]);
    const learning = extractJson<LearningResponse>(output);

    if (!learning.shouldStore || !learning.title || !learning.summary || !learning.reusableProcedure) {
      return undefined;
    }

    return this.skillMemory.add({
      title: learning.title,
      tags: learning.tags ?? [],
      summary: learning.summary,
      reusableProcedure: learning.reusableProcedure,
    });
  }
}

function createEmitter(sink?: AgentEventSink): AgentEventEmitter {
  return async (event) => {
    if (!sink) return;

    const enriched: AgentEvent = {
      ...event,
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      spanId: event.spanId ?? createSpanId(event.type),
      timestamp: new Date().toISOString(),
    };

    await sink(enriched);
  };
}

function createSpanId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function elapsedMs(startedAt: Date): number {
  return Date.now() - startedAt.getTime();
}
