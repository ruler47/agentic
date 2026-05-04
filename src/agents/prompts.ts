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
Before returning any result to a caller, perform a brief self-check: identify what you are about to return, whether it actually satisfies the requested evidence/output, whether artifacts or tool results are meaningful rather than empty/irrelevant, and whether one retry or a clear limitation statement is needed.
If an available tool is close to the needed capability but its current version cannot satisfy the request, describe the required tool change as a reusable versioned improvement rather than inventing a one-off workaround. Future runtime may turn that into a Tool Build rework request, wait for QA/promotion, and retry the tool.
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
- Before returning, self-check your own output and evidence. Ask: what am I giving back, does it satisfy the subtask, are artifacts/tool results useful and relevant, and should I retry or clearly report a blocker instead of passing weak output upward?
- If the result is weak, irrelevant, empty, unsupported, or has unusable artifacts, say what failed and what retry/alternative is needed instead of presenting it as success.
- If a registered tool failed or returned an incomplete result, explicitly state whether this is operator error, external blocker, credential/policy problem, or a reusable tool improvement request. Include the tool name, current behavior, desired behavior, and acceptance test for a new version.
- For screenshots or browser artifacts, treat blank pages, endless loaders, login walls, bot checks, access-denied pages, unrelated pages, and missing task-relevant content as unusable proof. Retry another source or clearly report that useful proof could not be produced.
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
Fail screenshot/browser evidence that is blank, only a loading screen, a login wall, an access-denied page, a bot-check page, unrelated to the requested source, or otherwise not useful proof.

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
- Before finalizing, self-check that the answer and artifacts are actually useful for the user request. If the available evidence is insufficient, state the limitation plainly instead of dressing a weak result as complete.
- Do not include screenshot/browser artifacts as proof if the evidence indicates they are blank, still loading, blocked, login-only, bot-check pages, or unrelated to the requested content.
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
  "reusableProcedure": "how a future agent can reuse this",
  "scope": "global | group | user | thread | run",
  "status": "accepted | proposed",
  "confidence": 0.0,
  "sensitivity": "normal | sensitive | private",
  "evidence": ["short source reason from this run"]
}

Scope rules:
- Use "global" only for reusable operational patterns that are safe for every future run.
- Use "group" for preferences, stable facts, constraints, or lessons that apply to this assistant instance/group.
- Use "user" for personal preferences, identity facts, health, finance, private plans, or individual constraints.
- Use "thread" for facts useful only when continuing this conversation.
- Use "run" for diagnostics that should not be reused broadly.
- Use "proposed" for group/user/thread/run facts or anything sensitive/private; operators can accept it later.
- Use "accepted" only for non-sensitive global operational lessons.
`.trim();
}

function formatMemories(memories: SkillMemoryEntry[]): string {
  if (memories.length === 0) return "No relevant memories yet.";

  return memories
    .map(
      (memory) => `
- ${memory.title}
  scope: ${memory.scope ?? "global"}${memory.scopeId ? `:${memory.scopeId}` : ""}
  confidence: ${Math.round((memory.confidence ?? 0.75) * 100)}%
  match: ${memory.match?.reason ?? "selected by memory search"}
  tags: ${memory.tags.join(", ")}
  summary: ${truncatePromptText(memory.summary, 900)}
  procedure: ${truncatePromptText(memory.reusableProcedure, 900)}`,
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

function truncatePromptText(text: string | undefined, maxChars: number): string {
  const value = text ?? "";
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}\n  [...truncated...]`;
}
