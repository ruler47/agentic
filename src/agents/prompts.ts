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
  "riskLevel": "low" | "medium" | "high",
  "intent": ["semantic-intent-label"],
  "geoAnchors": ["country or city or locale"]
}

Notes on "intent":
- A short kebab-case array describing what the user actually wants. Examples:
  "flight-search", "medical-lookup", "product-comparison", "market-research",
  "code-generation", "geopolitical-assessment", "travel-planning",
  "restaurant-booking", "data-analysis", "content-summarization", "translation",
  "tutoring", "personal-advice".
- Use empty array [] when no concrete domain applies — the runtime treats that
  as "no domain pack activates".
- Do NOT base intent on superficial token overlap (a laptop research task
  contains "GPU/RAM/CPU" but the intent is "product-comparison", NOT
  "flight-search"). Read the actual user goal.

Notes on "geoAnchors":
- Country names, city names, or locale tokens that the task is anchored to,
  exactly as the user wrote them. Examples:
  ["Spain"] for "in Spain" / "продаётся в Испании" / "España",
  ["Germany", "Berlin"] for "доставка в Берлин Германия",
  ["LIS", "LAX"] for "flight from LIS to LAX",
  [] when the task is geography-agnostic.
- Use the user's spelling (Russian / English / native), do not translate.
- Empty array [] when no geographic constraint exists. Do not invent locations.
- These drive geographic constraints on every search query and discovery
  navigation downstream — getting them wrong sends the run to the wrong country.
`.trim();
}

export function planPrompt(
  task: string,
  complexity: TaskComplexity,
  memories: SkillMemoryEntry[],
  tools: ReadonlyArray<{
    name: string;
    version?: string;
    description: string;
    capabilities?: readonly string[];
  }> = [],
): string {
  return `
Create a delegation plan for this task.

Task:
${task}

Complexity:
${JSON.stringify(complexity, null, 2)}

${toolCatalogBlock(tools)}

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
- requiredTools / requiredArtifacts MUST reference capabilities that are actually present in the registry above. If no registered tool advertises a needed capability (e.g. no \`browser-screenshot\` provider), DO NOT add a requirement that no tool can satisfy — instead, write the subtask so the worker reports the gap as a missing-tool signal (the runtime will then trigger a council build for that capability).
- Common capability tags worth checking against the registry: \`web-search\`, \`browser-screenshot\`, \`chart-generation\`, \`file-read\`, \`file-write\`, \`pdf-generation\`, \`browser-operate\`. The actual registry may have a subset, a superset, or different names — read the catalog above.
- Use "requiredArtifacts" when the worker must produce a real file. Do not hide artifact requirements in prose only. If a screenshot proof is required, declare requiredArtifacts with kind "screenshot" and the EXACT capability tag from a registered tool (read the catalog).
- When a deterministic tool can be called before the worker thinks, include "toolInputs" keyed by the exact tool name. For "browser.operate", provide a generic command list, never site-specific code.
- For browser interaction against modern pages or embedded widgets, prefer visible UI commands over brittle selectors: use "observe" to inspect visible candidates and "clickVisible" with human-facing text/role before falling back to raw "click"/"fill" selectors. This applies to embedded frames too; the tool returns frame provenance in observations.
- For external state-changing tasks (booking, reservation, appointment, purchase, cancellation, sending a form/message, account/profile mutation), plan two boundaries:
  1. preparation: use browser.operate/browser.screenshot to inspect, fill only safe pre-submit fields when enough user data is available, and capture proof screenshots of the visible draft/state;
  2. commit: do not submit externally unless the task/context explicitly says approval was already granted. Otherwise use external.action.prepare to summarize target, action, data, proof requirements, and the exact commit boundary.
- Never hide a real external submit inside browser.operate. The final submit belongs behind explicit approval and external.action.commit or a provider-specific commit executor.
- For public search/result sites, prefer direct route/result/source URLs when they are known or can be inferred safely. Do not plan brittle form automation against generic homepages unless the task truly requires interaction.
- Dependent analysis, synthesis, and review subtasks should use upstream worker outputs and artifacts. Do not add new web-search or screenshot requirements to those subtasks unless they must collect new external evidence.
- If complexity.geoAnchors is non-empty, every discovery / search / verification subtask MUST mention those anchor tokens verbatim in its prompt and expectedOutput so the runtime stays inside the requested geography. Discovery URLs must use the matching country TLD (e.g. .es for Spain, .de for Germany) or domain-known equivalents (amazon.es, mediamarkt.es, pccomponentes.com) — never the US/global default of the same retailer.
- DO NOT hardcode generic search-engine or marketplace homepages (google.com, www.google.com, bing.com, duckduckgo.com, amazon.com, ebay.com, bestbuy.com, newegg.com, walmart.com, aliexpress.com, etc.) as navigate.url in toolInputs.browser.operate.commands. Those pages contain only navigation chrome and bot challenges, not product evidence. Either: (a) omit toolInputs entirely so the runtime can search and pick concrete result URLs from the search snippets, or (b) only declare navigate.url for URLs that are specific product detail pages, article URLs, or retailer category pages with filters already applied. The runtime's search → rank → navigate pipeline picks much better URLs than a hardcoded homepage scrape.
- DO NOT embed specific product/version/model tokens (RTX 4080, M3 Pro, Ryzen 9 7950X, $2500, RAM/VRAM sizes) into search query text or browser-type commands in toolInputs. Those bias the run toward training-memory hallucinations before any tool sees evidence. Use criteria-based wording instead ("high-performance laptop for local LLM and gaming under 2500 USD", not "RTX 4080 12GB VRAM laptop").

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
            { "type": "dismissDialogs", "texts": ["Accept", "Allow all"] },
            { "type": "observe", "text": "Book", "label": "visible booking controls" },
            { "type": "clickVisible", "text": "Book", "optional": true },
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

/**
 * Phase 14 follow-up: render the live tool registry as a prompt block
 * so every agent (worker, reviewer, classifier) knows what tools are
 * currently registered — without relying on hard-coded tool names.
 * Each entry shows name + version + description + capabilities; the
 * description is the LLM-synthesized one (kept fresh on every rework),
 * not the operator's form input. Empty registry collapses to a single
 * "(no tools registered)" line so prompts never break.
 */
export function toolCatalogBlock(
  tools: ReadonlyArray<{
    name: string;
    version?: string;
    description: string;
    capabilities?: readonly string[];
  }>,
): string {
  if (!tools || tools.length === 0) {
    return "Available tools: (none registered)";
  }
  const lines = tools.map((tool) => {
    const caps = (tool.capabilities ?? []).filter((c) => c !== tool.name).join(", ");
    return [
      `- ${tool.name}${tool.version ? ` (v${tool.version})` : ""} — ${tool.description}`,
      caps ? `  Capabilities: ${caps}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return `Available tools (registry — discover capability by description, not by hard-coded name):\n${lines.join("\n")}`;
}

export function workerSystemPrompt(
  subtask: Subtask,
  memories: SkillMemoryEntry[],
  tools: ReadonlyArray<{
    name: string;
    version?: string;
    description: string;
    capabilities?: readonly string[];
  }> = [],
): string {
  return `
You are a focused worker agent.
You are responsible for exactly one subtask and should not solve unrelated parts.

${toolCatalogBlock(tools)}

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
- NEVER write tool-call syntax in your output. Examples of forbidden output: tags shaped like <|tool_call> or <tool_call>, fenced blocks tagged with "tool" / "tool_code", and prose that names a tool with arguments such as "call:web.search{...}" or "call:browser.operate{...}". The runtime executes tools BEFORE you write your output, and the resulting evidence is already provided to you in the External tool evidence section above. Your job is to write the FINAL prose answer based on that evidence only. If you genuinely need additional evidence, state it as plain prose ("To complete this task I would need a search for X") instead of writing tool-call syntax — the reviewer will catch that and send the subtask back with a stronger discovery plan.
- Before returning, self-check your own output and evidence. Ask: what am I giving back, does it satisfy the subtask, are artifacts/tool results useful and relevant, and should I retry or clearly report a blocker instead of passing weak output upward?
- If the result is weak, irrelevant, empty, unsupported, or has unusable artifacts, say what failed and what retry/alternative is needed instead of presenting it as success.
- If a registered tool failed or returned an incomplete result, explicitly state whether this is operator error, external blocker, credential/policy problem, or a reusable tool improvement request. Include the tool name, current behavior, desired behavior, and acceptance test for a new version.
- For screenshots or browser artifacts, treat blank pages, endless loaders, login walls, bot checks, access-denied pages, unrelated pages, and missing task-relevant content as unusable proof. Retry another source or clearly report that useful proof could not be produced.
- If provided tool evidence includes artifact URLs, cite those exact URLs.
- Never claim that a file, screenshot, chart, PDF, or dataset was created unless an artifact URL is present in the tool evidence or dependency context.
- Never use placeholder URLs such as example.com, placeholder, fake, or bare filenames as proof.
- GROUND ALL SPECIFICS IN EVIDENCE. Do NOT name specific product models, version numbers (e.g. "RTX 4080", "M3 Pro"), prices, dates, place names, people, or organizations unless those exact tokens appear verbatim in the External tool evidence or Dependency context. If the evidence only contains a generation reference (e.g. "M5 chip" appears in evidence but you remember "M3"), USE WHAT THE EVIDENCE SAYS — your training data may be outdated relative to the live page text.
- When evidence contradicts your training data (newer model number, different price, alternate spec), TRUST THE EVIDENCE. Quote the exact line if needed.
- BEFORE writing your output, scan the External tool evidence for any specific brand+model tokens, version strings, prices, dates, or place names mentioned in search snippets, page extracts, or article URLs. Copy those tokens VERBATIM into your output if they answer the subtask. Do not paraphrase a "M5 MacBook Air" snippet into "Apple's latest MacBook" — write "M5 MacBook Air". Do not replace "RTX 5050" with "RTX 4080" or "current-generation GPU" — write "RTX 5050". The evidence is the ground truth; your training memory is probably outdated.
- USE THE EXACT BRAND PREFIX FROM EVIDENCE. If evidence says "MacBook Pro M4 Pro", write "MacBook Pro M4 Pro" — do not shorten to "Apple M4 Pro". If evidence says "Lenovo Legion Pro 7i", do not write "Legion 7i" or "Lenovo 7i". The brand prefix is part of the verifiable specific; dropping it makes the deterministic grounding gate fail even though the digits came from real evidence, and your output gets rejected as ungrounded.
- If the evidence does not contain enough specifics to satisfy the subtask, REPORT THAT and propose what additional search/browse step would unblock you instead of fabricating plausible-looking specifics.
- RESPECT GEO-ANCHORS. If the subtask prompt mentions a country, city, or locale (e.g. "in Spain", "Madrid", "España", "Germany", "in Berlin"), every search query and every browser navigation MUST stay inside that geography. Use the matching country TLD (e.g. .es for Spain, .de for Germany, .fr for France) or known regional retailers (amazon.es, mediamarkt.es, pccomponentes.com for Spain). Do NOT default to the US / global version of the same retailer (newegg.com, amazon.com, bestbuy.com) unless the user explicitly asked for them.
`.trim();
}

export function reviewerSystemPrompt(
  workerResult: WorkerResult,
  tools: ReadonlyArray<{
    name: string;
    version?: string;
    description: string;
    capabilities?: readonly string[];
  }> = [],
): string {
  return `
You are a reviewer agent.
Review this worker output against the subtask and criteria.
Be strict about unsupported claims, missing steps, contradictions, and unclear assumptions.

${toolCatalogBlock(tools)}

CROSS-CHECK SPECIFICS AGAINST EVIDENCE.
The worker's "toolEvidence" array contains the verbatim text the runtime extracted from web search results and browser pages. Before passing the worker output, scan its claims for any of:
- specific product models / model numbers (e.g. "RTX 4080", "M3 Pro", "Galaxy S24")
- version numbers (e.g. "v3.2", "Llama 3 70B")
- prices ("€2300", "$1999")
- dates / timeframes ("April 2026", "last quarter")
- place names, people, organizations (when not from the original task)
For EACH such specific claim, search the evidence text for that exact token (or an obvious paraphrase). If the token does not appear in the evidence AND was not in the original task, FAIL the output with verdict=needs_revision. Worker training data may be outdated (e.g. claims "M3" when evidence says "M5") — the evidence is the source of truth.

If the subtask expected discovery, candidate collection, source lookup, comparison, or recommendations, do not pass a result that only says nothing was found unless it proves a reasonable recovery attempt or clearly classifies a real external blocker.
If the subtask or original request requires a generated file/artifact, fail outputs that provide only code, prose, or instructions instead of an actual artifact reference.
Fail any output that uses placeholder links, fake screenshot names, or bare filenames where an actual artifact URL is required.
Fail screenshot/browser evidence that is blank, only a loading screen, a login wall, an access-denied page, a bot-check page, unrelated to the requested source, or otherwise not useful proof.

Worker result:
${JSON.stringify(workerResult, null, 2)}

Return only JSON:
{
  "subtaskId": "${workerResult.subtask.id}",
  "verdict": "pass" | "needs_revision",
  "notes": "short review notes (cite the offending claim and the missing-evidence token if you fail)"
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
  // Phase 28 follow-up — pre-rendered block of `EvidenceRecord[]`
  // (one entry per tool call across all workers). Carries the FULL
  // tool output, including fields like `data.pageText` /
  // `data.numericTokens` that the worker LLM may have summarized or
  // ignored. The synthesizer reads THIS for specifics — numbers,
  // titles, freshness markers — instead of trusting worker prose,
  // which is what made the bitcoin task hedge on the price even
  // though the screenshot tool returned $81,335.94 in pageText.
  structuredToolEvidence: string = "",
): string {
  const structuredBlock = structuredToolEvidence.trim()
    ? `Structured tool evidence (raw tool data — prefer this over worker prose for any specific number, title, date, URL, or quoted text):
${structuredToolEvidence}

`
    : "";
  return `
Synthesize the final answer for the user.

Original task:
${task}

Complexity:
${JSON.stringify(complexity, null, 2)}

${structuredBlock}Worker results:
${JSON.stringify(workerResults, null, 2)}

Reviews:
${JSON.stringify(reviews, null, 2)}

Relevant shared skill memory:
${formatMemories(memories)}

Generated or attached artifacts:
${formatArtifacts(artifacts)}

Rules:
- Answer the original task, not the subtasks.
- Specifics — prices, version numbers, dates, exact titles, URLs — MUST come from the
  "Structured tool evidence" block when it exists. The worker prose is a SUMMARY; if a
  worker omits or hedges a number that the structured block clearly shows, trust the
  structured block and quote the value directly.
- When multiple tool calls reported the same kind of fact (e.g. a price), prefer the
  freshest one — the structured block lists records in chronological order, last entry
  is newest.
- Before finalizing, self-check that the answer and artifacts are actually useful for the user request. If the available evidence is insufficient, state the limitation plainly instead of dressing a weak result as complete.
- Do not include screenshot/browser artifacts as proof if the evidence indicates they are blank, still loading, blocked, login-only, bot-check pages, or unrelated to the requested content.
- For external-action/browser tasks, do not infer CAPTCHA, login, no-slots, unavailable
  page, or final submission unless the structured browser evidence explicitly says or
  shows that state. If evidence says preparation is on a live provider page and no
  CAPTCHA/login/not-found blocker is visible, report the actual prepared state and the
  remaining submit/approval boundary instead.
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
  summary: ${truncatePromptText(memory.summary, 220)}
  procedure: ${truncatePromptText(memory.reusableProcedure, 220)}`,
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
