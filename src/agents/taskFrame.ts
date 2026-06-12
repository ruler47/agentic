import type { Tool } from "../tools/tool.js";
import {
  inferExternalActionPolicy,
  isExternalActionRequirementsQuestion,
  type ExternalActionPolicy,
} from "./externalActionPlanning.js";
import { uniqueProofWorthyUrls } from "./proofSourceUrls.js";

const DEFAULT_MAX_STEPS = 10;

export type TaskFrameMode =
  | "direct_fact"
  | "current_lookup"
  | "exploratory_research"
  | "product_selection"
  | "tool_build_or_rework";

export type ResearchDepth = "none" | "single_source" | "multi_source" | "structured_selection";

export type TaskFrameResearchStep = {
  step: string;
  purpose: string;
  expectedEvidence: string;
  preferredTools: string[];
};

export type TaskFrameAnswerContract = {
  mustDo: string[];
  mustAvoid: string[];
  finalAnswerShape: string[];
  proofStrategy: string;
};

export type TaskFrame = {
  mode: TaskFrameMode;
  reason: string;
  researchDepth: ResearchDepth;
  idealOutcome: string;
  userSuccessCriteria: string[];
  likelyFailureModes: string[];
  exceedExpectations: string[];
  requiredEvidence: string[];
  researchPlan: TaskFrameResearchStep[];
  answerContract: TaskFrameAnswerContract;
  externalActionPolicy?: ExternalActionPolicy;
  researchContract: {
    minResearchToolCalls: number;
    minIndependentSourceUrls: number;
    minSourceReadToolCalls: number;
    mustCheckFreshness: boolean;
    requiresClaimBasedProof: boolean;
  };
};

export type ResearchContractGap = {
  reason: string;
  missingResearchToolCalls: number;
  missingIndependentSourceUrls: number;
  missingSourceReadToolCalls: number;
};

export function defaultMaxStepsForTaskFrame(taskFrame: TaskFrame): number {
  // External-action preparation needs discovery + provider page + form
  // preparation + proof — observed live to exceed the selection budget.
  if (taskFrame.externalActionPolicy) return 18;
  return taskFrame.mode === "product_selection" || taskFrame.researchDepth === "structured_selection"
    ? 12
    : DEFAULT_MAX_STEPS;
}

export function isToolLifecycleOnlyTask(task: string): boolean {
  return /(?:созда[йт]|сдела[йт]|построй|build|create|make).{0,80}(?:tool|тулз|тул|инструмент)/i.test(task)
    || /(?:tool|тулз|тул|инструмент).{0,80}(?:созда[йт]|сдела[йт]|построй|build|create|make)/i.test(task);
}

export function taskNeedsCurrentExternalData(task: string): boolean {
  return /\b(?:bitcoin|btc|price|stock|weather|news|exchange\s+rate|market|quote)\b/i.test(task)
    || /(?:биткоин|биткоина|btc|цена|цену|курс|акци[ия]|погод[ауы]|новост[ьи]|рынок|котировк[аи])/i.test(task);
}

export function frameTask(task: string): TaskFrame {
  if (isToolLifecycleOnlyTask(task)) {
    return {
      mode: "tool_build_or_rework",
      reason: "The user is asking to create or change a tool capability.",
      researchDepth: "none",
      idealOutcome: "Produce or update the requested tool and make the lifecycle observable.",
      userSuccessCriteria: ["requested tool behavior is explicit", "candidate can be tested", "registration state is clear"],
      likelyFailureModes: ["tool exists only as app code", "behavior contract is vague", "candidate is registered without QA"],
      exceedExpectations: ["include behavior examples", "show QA and registration evidence"],
      requiredEvidence: ["tool creation/edit trace", "QA result", "registered candidate metadata"],
      researchPlan: [
        {
          step: "Capability contract",
          purpose: "Turn the user's request into schemas, examples, runtime needs, and QA obligations.",
          expectedEvidence: "explicit behavior examples and required inputs/outputs",
          preferredTools: ["request_tool_creation", "request_tool_edit"],
        },
        {
          step: "Candidate verification",
          purpose: "Prove the generated version can satisfy the original task before exposing it broadly.",
          expectedEvidence: "package QA, manual run output, and registration state",
          preferredTools: ["generated tool candidate"],
        },
      ],
      answerContract: {
        mustDo: ["state the generated/edited tool name and version", "state QA/registration status", "explain how to test it"],
        mustAvoid: ["describing code-only helpers as usable tools", "claiming global availability before promotion"],
        finalAnswerShape: ["tool/version", "what was verified", "what remains operator-controlled"],
        proofStrategy: "Use tool lifecycle trace, QA result, and manual run output as proof.",
      },
      researchContract: {
        minResearchToolCalls: 0,
        minIndependentSourceUrls: 0,
        minSourceReadToolCalls: 0,
        mustCheckFreshness: false,
        requiresClaimBasedProof: false,
      },
    };
  }

  const normalized = normalizeForTaskFrame(task);
  if (isExternalActionRequirementsQuestion(task, normalized)) {
    return {
      mode: "direct_fact",
      reason: "The user is asking what information would be needed before a future external action, not asking to execute or research the action now.",
      researchDepth: "none",
      idealOutcome: "Return a practical checklist of required inputs and explain the approval boundary.",
      userSuccessCriteria: ["clear required fields", "no premature external action", "next-step wording"],
      likelyFailureModes: ["creating an approval request before user provided data", "doing unnecessary research", "pretending a booking can be submitted"],
      exceedExpectations: ["separate required fields from optional preferences", "state that the next message can contain the booking details"],
      requiredEvidence: [],
      researchPlan: [],
      answerContract: {
        mustDo: ["answer with a concise checklist", "state that execution requires explicit booking instruction or automode", "avoid creating a pending approval"],
        mustAvoid: ["searching the web for generic requirements", "creating an external action proposal", "asking approval for an incomplete draft"],
        finalAnswerShape: ["required data", "optional preferences", "what happens next"],
        proofStrategy: "No proof is required for a requirements checklist.",
      },
      researchContract: {
        minResearchToolCalls: 0,
        minIndependentSourceUrls: 0,
        minSourceReadToolCalls: 0,
        mustCheckFreshness: false,
        requiresClaimBasedProof: false,
      },
    };
  }
  const selectionIntent = /(?:\bfind\b|\bpick\b|\bchoose\b|\brecommend\b|\bbest\b|\bcompare\b|\bselect\b|найди|подбери|выбери|посоветуй|порекомендуй|лучш|сравни|какой|какую|какие)/i.test(task);
  const budgetOrTradeoff = /(?:\bbudget\b|\bunder\b|\bup to\b|\bwithin\b|\$\s?\d|\d+\s?(?:usd|dollars?|eur|евро|доллар)|бюджет|до\s+\d|цена|стоимост|можно\s+пожертвовать|критери|trade[- ]?off|компромисс)/i.test(task);
  const currentNeed = /(?:\bcurrent\b|\blatest\b|\bnow\b|\btoday\b|\btomorrow\b|\btonight\b|\b202\d\b|сейчас|актуальн|новы[еймх]?|последн|сегодня|завтра|сегодня\s+вечером|на\s+вечер)/i.test(task);
  const broadResearchIntent = /(?:\bresearch\b|\banalyze\b|\bcollect\b|\bmarket\b|\boptions\b|\balternatives\b|ресерч|исслед|проанализ|вариант|альтернатив|рынок|обзор)/i.test(task);
  const criteria = inferUserSuccessCriteria(task);
  const multiCriteria = criteria.length >= 3 || countCriteriaConnectors(normalized) >= 3;
  const localServiceSelection = /(?:restaurant|reservation|book a table|hotel|clinic|doctor|lawyer|venue|event|flight|table|barber|barbershop|salon|haircut|ресторан|столик|брон|отель|врач|клиник|юрист|площадк|мероприяти|рейс|барбер|барбершоп|салон|стриж)/i.test(task);
  const externalActionPolicy = inferExternalActionPolicy(task);
  const externalActionPreparation = Boolean(externalActionPolicy);
  const productSelection = selectionIntent && (budgetOrTradeoff || multiCriteria || localServiceSelection || externalActionPreparation);

  if (productSelection) {
    return {
      mode: "product_selection",
      reason: externalActionPreparation
        ? "The task asks for a bookable/actionable recommendation with enough user details to prepare an external action."
        : "The task asks for a recommendation under several criteria/tradeoffs, so a single source or direct answer is not enough.",
      researchDepth: externalActionPreparation ? "single_source" : "structured_selection",
      idealOutcome: externalActionPreparation
        ? "Pick one suitable actionable target, preserve the source URL, and create a concrete approval/commit proposal instead of asking the user to write an internal checklist."
        : "Recommend a short list of current candidates, explain tradeoffs, and make the top choice actionable.",
      userSuccessCriteria: criteria.length ? criteria : [
        "budget fit",
        "primary use-case fit",
        "secondary use-case fit",
        "portability or convenience tradeoff",
      ],
      likelyFailureModes: externalActionPreparation
        ? [
          "treating an action-preparation request as open-ended research",
          "manually navigating or filling third-party booking forms before the approval proposal exists",
          "creating an approval request without a concrete target/source URL",
          "asking the user to restate internal safety/proof instructions",
        ]
        : [
          "answering from one roundup or one snippet",
          "using outdated generations, versions, prices, or availability",
          "missing the user's tradeoffs",
          "naming candidates without source-backed specs",
          "proof artifact shows research scaffolding instead of final candidates",
        ],
      exceedExpectations: externalActionPreparation
        ? [
          "choose the strongest actionable target without over-researching",
          "include the known user details and any missing inputs in the proposal summary",
          "state that browser preparation/proof capture belongs to the run-scoped approval flow",
        ]
        : [
          "separate best overall, best performance, and best portable/value picks when useful",
          "state what to sacrifice and why",
          "include source-backed price/spec/freshness evidence for final candidates",
        ],
      requiredEvidence: externalActionPreparation
        ? [
          "at least one actionable source URL for the selected target",
          "known user inputs needed for the action",
          "explicit final commit boundary",
        ]
        : [
          "freshness baseline for the current market/category",
          "multiple independent candidate sources",
          "source-backed final candidate claims",
          "proof artifact focused on a final candidate or key comparison claim",
        ],
      researchPlan: [
        {
          step: "User intent and failure criteria",
          purpose: "Make explicit what the user would consider an ideal recommendation and what would disappoint them.",
          expectedEvidence: "criteria, constraints, dealbreakers, and ranking logic",
          preferredTools: [],
        },
        {
          step: "Freshness baseline",
          purpose: "Check what current options, generations, availability, or market context make older answers stale.",
          expectedEvidence: "current source URLs with dates, current models/prices/availability where applicable",
          preferredTools: ["web.search", "web.read", "web.extract"],
        },
        {
          step: "Candidate discovery",
          purpose: externalActionPreparation
            ? "Find one or a few viable targets with an online action path, then stop once a concrete target/source is sufficient for a proposal."
            : "Collect a broad enough candidate set from independent sources before choosing finalists.",
          expectedEvidence: externalActionPreparation
            ? "selected target name and actionable source URL"
            : "multiple independent source URLs and candidate names",
          preferredTools: ["web.search", "web.read", "web.extract"],
        },
        {
          step: externalActionPreparation ? "Proposal readiness" : "Finalist verification",
          purpose: externalActionPreparation
            ? "Summarize the chosen target, known user inputs, missing inputs, source URL, and approval boundary so the platform can create the proposal."
            : "Verify final candidates against the user's criteria using source pages, not snippets alone.",
          expectedEvidence: externalActionPreparation
            ? "concise proposal-ready final answer"
            : "source-backed claims for every finalist",
          preferredTools: ["web.read", "web.extract"],
        },
        {
          step: externalActionPreparation ? "Approval-flow proof" : "Proof capture",
          purpose: externalActionPreparation
            ? "Leave filled-form screenshots and post-submit proof to the run-scoped prepare/commit lifecycle after the proposal exists."
            : "Capture proof after finalists/claims are known, focused on the object of interest.",
          expectedEvidence: externalActionPreparation
            ? "proposal proof plan and source URL"
            : "passed screenshot or structured source-evidence artifact",
          preferredTools: externalActionPreparation ? [] : ["browser.screenshot", "source-evidence artifact"],
        },
      ],
      answerContract: {
        mustDo: externalActionPreparation
          ? [
            "choose one actionable target when enough evidence exists",
            "include the target name, source URL, known user inputs, and missing inputs",
            "state the final commit boundary",
            "finish with proposal-ready text so the platform can create the approval proposal",
          ]
          : [
            "show ranked finalists and explain why each fits the user",
            "separate evidence-backed facts from judgment calls",
            "state tradeoffs, uncertainty, and what to confirm before acting",
            "include source links or proof artifact references for final claims",
          ],
        mustAvoid: externalActionPreparation
          ? [
            "manual third-party browser preparation before a proposal exists",
            "over-researching after one adequate actionable target is found",
            "asking the user to restate approval/proof boilerplate",
            "pretending a booking was submitted",
          ]
          : [
            "answering from model memory",
            "using one roundup as the whole research base",
            "showing proof of the research process instead of proof of a final candidate",
            "presenting unavailable/stale options as current",
          ],
        finalAnswerShape: externalActionPreparation
          ? [
            "selected target",
            "known inputs and missing inputs",
            "source URL",
            "approval/commit boundary",
          ]
          : [
            "short recommendation summary",
            "ranked finalists with criteria/tradeoffs",
            "source/proof section",
            "next action or confirmation checklist",
          ],
        proofStrategy: externalActionPreparation
          ? "Do not chase proof screenshots inside the agent loop; source URL plus proposal proof plan is enough before the approval-flow prepares the form."
          : "Capture proof only after final candidates are selected; prefer focused candidate/source proof over generic search screenshots.",
      },
      externalActionPolicy,
      researchContract: {
        minResearchToolCalls: externalActionPreparation ? 1 : 3,
        minIndependentSourceUrls: externalActionPreparation ? 1 : 3,
        minSourceReadToolCalls: externalActionPreparation ? 0 : 1,
        mustCheckFreshness: true,
        requiresClaimBasedProof: !externalActionPreparation,
      },
    };
  }

  if (broadResearchIntent || (selectionIntent && (currentNeed || multiCriteria))) {
    return {
      mode: "exploratory_research",
      reason: "The task is broad enough that the agent should gather and compare evidence before answering.",
      researchDepth: "multi_source",
      idealOutcome: "Synthesize a current answer from multiple independent sources and make uncertainty visible.",
      userSuccessCriteria: criteria.length ? criteria : ["coverage", "freshness", "source-backed synthesis"],
      likelyFailureModes: ["single-source summary", "stale information", "unsupported synthesis"],
      exceedExpectations: ["surface disagreements across sources", "include limitations and next checks"],
      requiredEvidence: ["multiple independent source URLs", "source-backed key claims"],
      researchPlan: [
        {
          step: "Scope and ideal answer",
          purpose: "Clarify what kind of synthesis would best satisfy the user before gathering facts.",
          expectedEvidence: "explicit criteria, coverage target, and uncertainty boundaries",
          preferredTools: [],
        },
        {
          step: "Independent source gathering",
          purpose: "Collect independent sources that cover the main angles of the task.",
          expectedEvidence: "at least three proof-worthy source URLs when possible",
          preferredTools: ["web.search", "web.read", "web.extract"],
        },
        {
          step: "Synthesis verification",
          purpose: "Tie the final claims back to the source evidence and expose disagreements or limits.",
          expectedEvidence: "source-backed key claims and limitations",
          preferredTools: ["web.read", "web.extract"],
        },
      ],
      answerContract: {
        mustDo: ["synthesize across sources", "state uncertainty and limitations", "include source-backed key claims"],
        mustAvoid: ["single-source summary", "unsupported confident conclusions", "stale current claims"],
        finalAnswerShape: ["answer summary", "evidence-backed findings", "limitations/next checks"],
        proofStrategy: "Use source-evidence or focused screenshot proof for the most important final claim.",
      },
      externalActionPolicy,
      researchContract: {
        minResearchToolCalls: 2,
        minIndependentSourceUrls: 3,
        minSourceReadToolCalls: 1,
        mustCheckFreshness: currentNeed,
        requiresClaimBasedProof: true,
      },
    };
  }

  if (taskNeedsCurrentExternalData(task) || currentNeed) {
    return {
      mode: "current_lookup",
      reason: "The task depends on current external facts.",
      researchDepth: "single_source",
      idealOutcome: "Return the current fact with a source and focused proof when possible.",
      userSuccessCriteria: criteria.length ? criteria : ["current value", "source", "proof"],
      likelyFailureModes: ["answering from model memory", "screenshot without primary data"],
      exceedExpectations: ["include timestamp and source"],
      requiredEvidence: ["search/fetch/data source", "focused proof artifact when possible"],
      researchPlan: [
        {
          step: "Current source lookup",
          purpose: "Fetch the current value or fact from a live source.",
          expectedEvidence: "source URL, timestamp/context, and extracted value",
          preferredTools: ["web.search", "web.read", "web.extract", "API/data tool"],
        },
        {
          step: "Proof capture",
          purpose: "Attach focused proof when possible without making it the primary data source.",
          expectedEvidence: "focused screenshot or structured source-evidence artifact",
          preferredTools: ["browser.screenshot", "source-evidence artifact"],
        },
      ],
      answerContract: {
        mustDo: ["give the current fact", "cite the source", "state time/context when useful"],
        mustAvoid: ["answering from model memory", "using a screenshot as the only data source"],
        finalAnswerShape: ["current value/fact", "source", "proof or proof limitation"],
        proofStrategy: "Use text/structured data as the source of truth, then attach focused proof if possible.",
      },
      externalActionPolicy,
      researchContract: {
        minResearchToolCalls: 1,
        minIndependentSourceUrls: 1,
        minSourceReadToolCalls: 0,
        mustCheckFreshness: true,
        requiresClaimBasedProof: false,
      },
    };
  }

  return {
    mode: "direct_fact",
    reason: "The task appears narrow enough for a direct answer unless the model needs a tool.",
    researchDepth: "none",
    idealOutcome: "Answer directly and only use tools if required by current data, files, or artifacts.",
    userSuccessCriteria: criteria,
    likelyFailureModes: ["unnecessary tool use", "missing an explicit artifact request"],
    exceedExpectations: ["keep the answer concise"],
    requiredEvidence: [],
    researchPlan: [],
    answerContract: {
      mustDo: ["answer the specific question directly"],
      mustAvoid: ["expanding a simple task into unnecessary research", "inventing external facts without tools"],
      finalAnswerShape: ["concise answer"],
      proofStrategy: "No proof is required unless the task asks for artifacts or current external facts.",
    },
    externalActionPolicy,
    researchContract: {
      minResearchToolCalls: 0,
      minIndependentSourceUrls: 0,
        minSourceReadToolCalls: 0,
      mustCheckFreshness: false,
      requiresClaimBasedProof: false,
    },
  };
}

export function formatTaskFrameForPrompt(frame: TaskFrame): string {
  return [
    `- Strategy: ${frame.mode}`,
    `- Reason: ${frame.reason}`,
    `- Ideal outcome: ${frame.idealOutcome}`,
    `- Research depth: ${frame.researchDepth}`,
    frame.userSuccessCriteria.length ? `- User success criteria: ${frame.userSuccessCriteria.join("; ")}` : undefined,
    frame.likelyFailureModes.length ? `- Likely failure modes: ${frame.likelyFailureModes.join("; ")}` : undefined,
    frame.exceedExpectations.length ? `- Ways to exceed expectations: ${frame.exceedExpectations.join("; ")}` : undefined,
    frame.requiredEvidence.length ? `- Required evidence: ${frame.requiredEvidence.join("; ")}` : undefined,
    frame.researchPlan.length
      ? `- Research plan:\n${frame.researchPlan.map((step, index) => `  ${index + 1}. ${step.step}: ${step.purpose} Evidence: ${step.expectedEvidence}${step.preferredTools.length ? ` Tools: ${step.preferredTools.join(", ")}` : ""}`).join("\n")}`
      : undefined,
    `- Answer contract must do: ${frame.answerContract.mustDo.join("; ")}`,
    `- Answer contract must avoid: ${frame.answerContract.mustAvoid.join("; ")}`,
    `- Final answer shape: ${frame.answerContract.finalAnswerShape.join("; ")}`,
    `- Proof strategy: ${frame.answerContract.proofStrategy}`,
    frame.externalActionPolicy
      ? [
          `- External action policy: ${frame.externalActionPolicy.actionType}`,
          `mode=${frame.externalActionPolicy.executionMode}`,
          frame.externalActionPolicy.executionMode === "auto"
            ? "modeContract=commit yourself only when required inputs and a commit executor are sufficient; include filled-field text proof, pre-submit screenshot, post-submit proof, and confirmation id/status when available"
            : "modeContract=prepare until the final commit boundary, pause the same run for operator approval, and continue after the operator decision",
          `approvalRequired=${frame.externalActionPolicy.requiresApprovalBeforeExecution ? "yes" : "no"}`,
          `userForbidsAction=${frame.externalActionPolicy.userExplicitlyForbidsAction ? "yes" : "no"}`,
          `allowed=${frame.externalActionPolicy.allowedWithoutApproval.join("; ")}`,
          `prohibited=${frame.externalActionPolicy.prohibitedWithoutApproval.join("; ")}`,
        ].join(", ")
      : undefined,
    `- Research contract: at least ${frame.researchContract.minResearchToolCalls} research tool call(s), ${frame.researchContract.minIndependentSourceUrls} independent source URL(s), ${frame.researchContract.minSourceReadToolCalls} source read/extract call(s), freshness=${frame.researchContract.mustCheckFreshness ? "required" : "not required"}, proof=${frame.researchContract.requiresClaimBasedProof ? "claim-based" : "source-based/optional"}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function shouldRequireResearchContract(input: {
  taskFrame: TaskFrame;
  sourceUrls: string[];
  successfulResearchToolCalls: number;
  successfulSourceReadToolCalls: number;
}): ResearchContractGap | undefined {
  const contract = input.taskFrame.researchContract;
  if (
    contract.minResearchToolCalls <= 0 &&
    contract.minIndependentSourceUrls <= 0 &&
    contract.minSourceReadToolCalls <= 0
  ) return undefined;
  const sourceCount = uniqueProofWorthyUrls(input.sourceUrls).length;
  const missingResearchToolCalls = Math.max(0, contract.minResearchToolCalls - input.successfulResearchToolCalls);
  const missingIndependentSourceUrls = Math.max(0, contract.minIndependentSourceUrls - sourceCount);
  const missingSourceReadToolCalls = Math.max(0, contract.minSourceReadToolCalls - input.successfulSourceReadToolCalls);
  if (missingResearchToolCalls === 0 && missingIndependentSourceUrls === 0 && missingSourceReadToolCalls === 0) return undefined;
  return {
    missingResearchToolCalls,
    missingIndependentSourceUrls,
    missingSourceReadToolCalls,
    reason: `Task frame ${input.taskFrame.mode} requires more research before a final answer: ${input.successfulResearchToolCalls}/${contract.minResearchToolCalls} research tool call(s), ${sourceCount}/${contract.minIndependentSourceUrls} independent source URL(s), ${input.successfulSourceReadToolCalls}/${contract.minSourceReadToolCalls} source read/extract call(s).`,
  };
}

export function researchContractRepairInstructionForModel(input: {
  taskFrame: TaskFrame;
  finalAnswer: string;
  sourceUrls: string[];
  successfulResearchToolCalls: number;
  successfulSourceReadToolCalls: number;
  attemptedToolCalls: number;
  maxToolCalls?: number;
  tools: Tool[];
}): string | undefined {
  const gap = shouldRequireResearchContract({
    taskFrame: input.taskFrame,
    sourceUrls: input.sourceUrls,
    successfulResearchToolCalls: input.successfulResearchToolCalls,
    successfulSourceReadToolCalls: input.successfulSourceReadToolCalls,
  });
  if (!gap) return undefined;
  const remainingToolCalls = input.maxToolCalls === undefined
    ? "unlimited"
    : String(Math.max(0, input.maxToolCalls - input.attemptedToolCalls));
  const hasSearchTool = input.tools.some((tool) => /search|web/i.test(`${tool.name} ${tool.capabilities.join(" ")}`));
  const readToolNames = input.tools
    .filter((tool) => /web[.\s-]*(?:read|extract)|web-read|web-extract/i.test(`${tool.name} ${tool.capabilities.join(" ")}`))
    .map((tool) => tool.name);
  const hasReadTool = readToolNames.length > 0;
  const candidateUrls = uniqueProofWorthyUrls(input.sourceUrls).slice(0, 5);
  return [
    "Return gate blocked the final answer because this broad/current recommendation task has not satisfied its research contract.",
    `Do not finish yet. Preserve useful parts of this draft only if later evidence supports them: ${limitText(input.finalAnswer, 900)}`,
    `Current evidence is too shallow: missing ${gap.missingResearchToolCalls} research tool call(s), ${gap.missingIndependentSourceUrls} independent source URL(s), and ${gap.missingSourceReadToolCalls} source read/extract call(s). Remaining tool-call budget: ${remainingToolCalls}.`,
    "Build the user's ideal answer first: criteria, tradeoffs, freshness baseline, candidates, and source-backed claims.",
    "Run independent research steps for freshness/current generation baseline, candidate discovery, and final candidate verification/pricing/specs.",
    "Do not rely on one roundup, one snippet, or model memory for current product/service recommendations.",
    hasReadTool
      ? [
          `Your next tool call must be a source read/extract call using one of these available tools: ${readToolNames.join(", ")}.`,
          "Do not call web.search again and do not finish until at least one source-read call succeeds.",
          candidateUrls.length ? `Read one of these already discovered URLs first: ${candidateUrls.join(" ; ")}` : "Read the strongest already discovered source URL first.",
          "Snippets alone are not enough for this task frame.",
        ].join(" ")
      : hasSearchTool
        ? "If web.search snippets are not enough to verify final claims, request creation or edit of a web.read/web.extract capability with URL input and structured text output."
        : "No search/read tool is available; request creation of a web search/read capability before answering.",
    input.taskFrame.answerContract.mustDo.length
      ? `Final answer checklist: ${input.taskFrame.answerContract.mustDo.join("; ")}.`
      : "",
    input.taskFrame.answerContract.mustAvoid.length
      ? `Avoid: ${input.taskFrame.answerContract.mustAvoid.join("; ")}.`
      : "",
  ].join("\n");
}

function inferUserSuccessCriteria(task: string): string[] {
  const criteria = new Set<string>();
  const normalized = normalizeForTaskFrame(task);
  const afterPurpose = normalized.split(/\b(?:чтобы|чтоб|so that|for)\b/i).slice(1).join(" ");
  const candidateText = afterPurpose || normalized;
  for (const part of candidateText.split(/[,.;]|\s+\+\s+|\s+and\s+|\s+и\s+/i)) {
    const cleaned = part.replace(/\b(?:можно|если|чтобы|чтоб|was|were|should|could|would)\b/gi, " ").replace(/\s+/g, " ").trim();
    if (cleaned.length >= 4 && cleaned.length <= 80 && !/^(the|a|an|to|in|of|на|в|и|или)$/i.test(cleaned)) {
      criteria.add(cleaned);
    }
    if (criteria.size >= 8) break;
  }
  return [...criteria];
}

function countCriteriaConnectors(normalizedTask: string): number {
  return (normalizedTask.match(/\s(?:and|и|also|также)\s|[,;]/gi) ?? []).length;
}

function normalizeForTaskFrame(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function limitText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
