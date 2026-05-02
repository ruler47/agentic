import {
  AgentArtifact,
  SkillMemoryEntry,
  Subtask,
  WorkerResult,
  ReviewResult,
  TaskComplexity,
} from "../types.js";

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
- Add "dependsOn" with subtask IDs when a worker needs outputs or artifacts from earlier workers.
- Leave "dependsOn" empty or omitted only when the subtask can run immediately in parallel.
- If coding is needed, include a separate code review or test review subtask.
- If a review/test subtask is part of the plan, it must depend on the implementation or artifact-producing subtask it reviews.
- If the user requests a chart, screenshot, image, PDF, dataset, source file, or other file, include an artifact-producing subtask whose expected output is the actual artifact requirement, not just code or instructions.
- For every subtask, declare the machine-readable tools and artifacts it requires.
- Use "requiredTools" for capabilities like "web-search", "browser-screenshot", "chart-generation", "file-read", "file-write", or "pdf-generation".
- Use "browser-operate" when a task needs interactive browser actions such as navigation, cookie handling, clicks, typing, form filling, waiting, DOM text extraction, or screenshots after interaction.
- Use "requiredArtifacts" when the worker must produce a real file. Do not hide artifact requirements in prose only.
- A screenshot proof must declare requiredArtifacts with kind "screenshot" and capability "browser-screenshot".
- When a deterministic tool can be called before the worker thinks, include "toolInputs" keyed by the exact tool name. For "browser.operate", provide a generic command list, never site-specific code.
- For public search/result sites, prefer direct route/result/source URLs when they are known or can be inferred safely. Do not plan brittle form automation against generic homepages unless the task truly requires interaction.
- Dependent analysis, synthesis, and review subtasks should use upstream worker outputs and artifacts. Do not add new web-search or screenshot requirements to those subtasks unless they must collect new external evidence.

Return only JSON:
{
  "subtasks": [
    {
      "id": "short-id",
      "title": "short title",
      "role": "researcher | engineer | reviewer | analyst | other specialist",
      "prompt": "specific worker instructions",
      "expectedOutput": "what the worker must return",
      "reviewCriteria": ["criterion"],
      "dependsOn": ["prior-subtask-id"],
      "requiredTools": ["web-search"],
      "toolInputs": {
        "browser.operate": {
          "commands": [
            { "type": "navigate", "url": "https://example.com" },
            { "type": "extractText" },
            { "type": "screenshot", "label": "proof" }
          ]
        }
      },
      "requiredArtifacts": [
        {
          "kind": "screenshot",
          "capability": "browser-screenshot",
          "description": "real screenshot proof of the cited source page",
          "required": true
        }
      ]
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

Rules:
- If provided tool evidence includes artifact URLs, cite those exact URLs.
- Never claim that a file, screenshot, chart, PDF, or dataset was created unless an artifact URL is present in the tool evidence or dependency context.
- Never use placeholder URLs such as example.com, placeholder, fake, or bare filenames as proof.
`.trim();
}

export function reviewerSystemPrompt(workerResult: WorkerResult): string {
  return `
You are a reviewer agent.
Review this worker output against the subtask and criteria.
Be strict about unsupported claims, missing steps, contradictions, and unclear assumptions.
If the subtask or original request requires a generated file/artifact, fail outputs that provide only code, prose, or instructions instead of an actual artifact reference.
Fail any output that uses placeholder links, fake screenshot names, or bare filenames where an actual artifact URL is required.

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
  artifacts: AgentArtifact[] = [],
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

Generated or attached artifacts:
${formatArtifacts(artifacts)}

Rules:
- Answer the original task, not the subtasks.
- Mention important assumptions or confidence limits.
- If reviews found issues, resolve them or clearly state remaining uncertainty.
- If useful artifacts exist, include their filenames and exact artifact URLs from the artifact list.
- Do not replace an artifact URL with only a bare filename.
- Artifact URLs are application-local paths. Copy them exactly as shown; do not prepend a
  host such as api.runs.example.com, localhost, or any invented domain.
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

function formatArtifacts(artifacts: AgentArtifact[]): string {
  if (artifacts.length === 0) return "No artifacts are available.";

  return artifacts
    .map(
      (artifact) =>
        `- ${artifact.kind}: ${artifact.filename} (${artifact.mimeType}, ${artifact.sizeBytes} bytes) ${artifact.url}`,
    )
    .join("\n");
}
