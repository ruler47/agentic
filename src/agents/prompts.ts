import { SkillMemoryEntry, Subtask, WorkerResult, ReviewResult, TaskComplexity } from "../types.js";

export const coordinatorSystemPrompt = `
You are a universal coordinator agent.
You accept exactly one concrete user task at a time.
Your job is to decide whether to answer directly or delegate focused subtasks to specialist agents.
Prefer delegation when the task requires multiple knowledge domains, research, coding, review, or uncertainty reduction.
Return concise, practical outputs.
`.trim();

export function classifyPrompt(task: string, memories: SkillMemoryEntry[]): string {
  return `
Classify this single user task.

Task:
${task}

Relevant shared skill memory:
${formatMemories(memories)}

Return only JSON:
{
  "mode": "direct" | "delegated",
  "reason": "short reason",
  "domains": ["domain"],
  "riskLevel": "low" | "medium" | "high"
}
`.trim();
}

export function planPrompt(task: string, complexity: TaskComplexity, memories: SkillMemoryEntry[]): string {
  return `
Create a delegation plan for this task.

Task:
${task}

Complexity:
${JSON.stringify(complexity, null, 2)}

Relevant shared skill memory:
${formatMemories(memories)}

Rules:
- Create only subtasks that are needed.
- Each subtask must be narrow enough for one worker agent.
- Include review criteria for each subtask.
- If coding is needed, include a separate code review or test review subtask.

Return only JSON:
{
  "subtasks": [
    {
      "id": "short-id",
      "title": "short title",
      "role": "researcher | engineer | reviewer | analyst | other specialist",
      "prompt": "specific worker instructions",
      "expectedOutput": "what the worker must return",
      "reviewCriteria": ["criterion"]
    }
  ]
}
`.trim();
}

export function workerSystemPrompt(subtask: Subtask, memories: SkillMemoryEntry[]): string {
  return `
You are a focused worker agent.
You are responsible for exactly one subtask and should not solve unrelated parts.

Subtask:
${JSON.stringify(subtask, null, 2)}

Relevant shared skill memory:
${formatMemories(memories)}

Return:
- result
- key assumptions
- evidence or reasoning
- unresolved risks
`.trim();
}

export function reviewerSystemPrompt(workerResult: WorkerResult): string {
  return `
You are a reviewer agent.
Review this worker output against the subtask and criteria.
Be strict about unsupported claims, missing steps, contradictions, and unclear assumptions.

Worker result:
${JSON.stringify(workerResult, null, 2)}

Return only JSON:
{
  "subtaskId": "${workerResult.subtask.id}",
  "verdict": "pass" | "needs_revision",
  "notes": "short review notes"
}
`.trim();
}

export function synthesizePrompt(
  task: string,
  complexity: TaskComplexity,
  workerResults: WorkerResult[],
  reviews: ReviewResult[],
  memories: SkillMemoryEntry[],
): string {
  return `
Synthesize the final answer for the user.

Original task:
${task}

Complexity:
${JSON.stringify(complexity, null, 2)}

Worker results:
${JSON.stringify(workerResults, null, 2)}

Reviews:
${JSON.stringify(reviews, null, 2)}

Relevant shared skill memory:
${formatMemories(memories)}

Rules:
- Answer the original task, not the subtasks.
- Mention important assumptions or confidence limits.
- If reviews found issues, resolve them or clearly state remaining uncertainty.
`.trim();
}

export function learningPrompt(task: string, finalAnswer: string, workerResults: WorkerResult[]): string {
  return `
Extract one reusable skill-memory entry from this completed run, if there is a reusable lesson.

Original task:
${task}

Final answer:
${finalAnswer}

Worker results:
${JSON.stringify(workerResults, null, 2)}

Return only JSON:
{
  "shouldStore": true | false,
  "title": "short reusable skill title",
  "tags": ["tag"],
  "summary": "what was learned",
  "reusableProcedure": "how a future agent can reuse this"
}
`.trim();
}

function formatMemories(memories: SkillMemoryEntry[]): string {
  if (memories.length === 0) return "No relevant memories yet.";

  return memories
    .map(
      (memory) => `
- ${memory.title}
  tags: ${memory.tags.join(", ")}
  summary: ${memory.summary}
  procedure: ${memory.reusableProcedure}`,
    )
    .join("\n");
}
