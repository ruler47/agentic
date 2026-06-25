import type { ExternalActionExecutionMode } from "../types.js";
import type { Tool } from "../tools/tool.js";
import {
  inferExternalActionPolicy,
  isExternalActionRequirementsQuestion,
  type ExternalActionPolicy,
} from "./externalActionPlanning.js";
import { THREAD_CONTEXT_ANSWER_FRAME_MARKER } from "./baseAgentThreadContext.js";
import { uniqueProofWorthyUrls } from "./proofSourceUrls.js";
import {
  buildSourceResearchPolicy,
  detectNoExternalResearchInstruction,
  type SourceResearchPolicy,
} from "./sourceSearchPlan.js";

const DEFAULT_MAX_STEPS = 10;

export type TaskFrameMode =
  | "direct_fact"
  | "current_lookup"
  | "exploratory_research"
  | "product_selection"
  | "local_utility"
  | "tool_build_or_rework"
  | "thread_context_answer";

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
  sourcePolicy: SourceResearchPolicy;
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
type TaskFrameCore = Omit<TaskFrame, "sourcePolicy">;

export type TaskFrameOptions = {
  externalActionMode?: ExternalActionExecutionMode;
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
  if (taskFrame.mode === "local_utility") return 6;
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
    || /(?:биткоин|биткоина|btc|цена|цену|курс|акци[ия]|погод[ауы]|новост[ьи]|рынок|котировк[аи])/i.test(task)
    || taskNeedsCommerceLookup(task);
}

/**
 * Purchase / availability / "where to buy" / existence intent. These are
 * inherently current external lookups — whether a product exists, who sells
 * it, and at what price/availability cannot be answered from a model's
 * (outdated) training memory. Generic intent verbs only, never product
 * names. A live failure that motivated this: "найди где купить apple studio
 * m3 ultra 512 gb" was framed as a no-tool direct answer and the model
 * denied a real shipping product from stale memory without searching.
 */
export function taskNeedsCommerceLookup(task: string): boolean {
  return (
    /\b(?:buy|purchase|where\s+to\s+buy|for\s+sale|in[-\s]?stock|availab(?:le|ility)|price\s+of|cost\s+of|how\s+much\s+(?:is|are|does)|shop\s+for|order\s+online)\b/i.test(
      task,
    ) ||
    /(?:купить|купи\b|где\s+(?:можно\s+)?купить|в\s+наличии|заказать|сколько\s+стоит|стоимость|цена\s+на|прайс|продаётся|продается|где\s+взять)/i.test(
      task,
    )
  );
}

export function frameTask(task: string, options: TaskFrameOptions = {}): TaskFrame {
  const frame = frameTaskCore(task, options);
  return {
    ...frame,
    sourcePolicy: buildSourceResearchPolicy({
      task,
      mode: frame.mode,
      researchDepth: frame.researchDepth,
      externalAction: Boolean(frame.externalActionPolicy),
    }),
  };
}

function frameTaskCore(task: string, options: TaskFrameOptions): TaskFrameCore {
  if (task.includes(THREAD_CONTEXT_ANSWER_FRAME_MARKER)) {
    return {
      mode: "thread_context_answer",
      reason: "The current request is a follow-up that can be answered from the existing conversation thread context.",
      researchDepth: "none",
      idealOutcome: "Answer from prior thread summary, accepted facts, open questions, and artifact metadata before doing fresh research.",
      userSuccessCriteria: ["use prior answer context", "do not reacquire the same data", "say when the thread context is insufficient"],
      likelyFailureModes: ["repeating the original web search", "treating prior-answer questions as fresh current lookups", "inventing missing prior context"],
      exceedExpectations: ["quote the relevant prior source/fact when available", "clearly identify when a fresh check would be needed"],
      requiredEvidence: ["thread summary or accepted thread fact"],
      researchPlan: [],
      answerContract: {
        mustDo: ["answer against the previous conversation context", "state if the requested detail is missing from the thread context"],
        mustAvoid: ["fresh web/API lookup unless the user explicitly asks to refresh", "claiming a source/fact that is absent from thread context"],
        finalAnswerShape: ["answer from prior context", "source/fact reference or limitation"],
        proofStrategy: "Conversation context is the evidence; no new proof artifact is required unless the user asks for a refreshed external fact.",
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
  const externalActionPolicy = inferExternalActionPolicy(task, {
    externalActionMode: options.externalActionMode,
  });
  const externalActionPreparation = Boolean(externalActionPolicy);
  const productSelection = selectionIntent && (budgetOrTradeoff || multiCriteria || localServiceSelection || externalActionPreparation);

  if (looksLikeLocalUtilityTask(task) && !externalActionPreparation) {
    return {
      mode: "local_utility",
      reason: "The task explicitly asks for local file, document, or data transformation work.",
      researchDepth: "none",
      idealOutcome: "Use the smallest local toolchain that reads/extracts/transforms/writes the provided data and returns any requested artifact.",
      userSuccessCriteria: criteria.length ? criteria : ["correct local transformation", "no unnecessary web discovery", "requested file/artifact is attached"],
      likelyFailureModes: ["web-searching for a local transformation", "answering without creating the requested file", "losing the transformed data"],
      exceedExpectations: ["include the exact output filename when a file is written", "summarize the performed operation briefly"],
      requiredEvidence: ["local tool result", "written artifact when requested"],
      researchPlan: [
        {
          step: "Local toolchain",
          purpose: "Run only the local core tools needed by the task.",
          expectedEvidence: "document/file extraction, deterministic transform, or file-write result",
          preferredTools: ["document.extract", "data.transform", "file.read", "file.write"],
        },
      ],
      answerContract: {
        mustDo: ["use local tools directly when an artifact or transformation is requested", "name the produced file/artifact when present"],
        mustAvoid: ["web search or browser discovery unless explicitly requested", "screenshot proof for local-only data work"],
        finalAnswerShape: ["short completion summary", "artifact/file reference if created"],
        proofStrategy: "The local tool result and generated artifact are the proof; no browser proof is required.",
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

  if (detectNoExternalResearchInstruction(task) && !externalActionPreparation) {
    const reasoningComparison = selectionIntent || broadResearchIntent || multiCriteria;
    return {
      mode: reasoningComparison ? "exploratory_research" : "direct_fact",
      reason: "The user explicitly asked not to use internet/web/search, so the task must be answered from local context and reasoning only.",
      researchDepth: "none",
      idealOutcome: reasoningComparison
        ? "Compare or reason from available context without external lookup, and clearly mark any uncertainty that would require fresh sources."
        : "Answer directly from available context, or state that the requested current fact cannot be checked without external access.",
      userSuccessCriteria: criteria.length ? criteria : ["respect no-internet constraint", "be explicit about uncertainty"],
      likelyFailureModes: ["calling web/search/read tools despite the user's constraint", "pretending current external facts were checked", "hiding uncertainty"],
      exceedExpectations: ["separate general reasoning from facts that would require a fresh check", "ask for permission before refreshing externally"],
      requiredEvidence: reasoningComparison ? ["local/thread context or general reasoning only"] : [],
      researchPlan: reasoningComparison
        ? [
          {
            step: "Reasoning-only comparison",
            purpose: "Use local context and general criteria without external lookup.",
            expectedEvidence: "User-provided facts, thread context, and explicitly stated assumptions.",
            preferredTools: ["update_working_board"],
          },
        ]
        : [],
      answerContract: {
        mustDo: [
          "respect the no-internet/no-web constraint",
          "state when a claim would require a fresh external check",
          reasoningComparison ? "compare criteria and assumptions explicitly" : "answer concisely",
        ],
        mustAvoid: [
          "web.search, web.read, browser, or HTTP calls",
          "claiming current external verification",
          "inventing citations or proof artifacts",
        ],
        finalAnswerShape: reasoningComparison
          ? ["short answer", "criteria comparison", "assumptions/uncertainty"]
          : ["direct answer", "limitation if current data is needed"],
        proofStrategy: "No external proof is allowed under the user's no-internet constraint; use local/context evidence only.",
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
        minResearchToolCalls: externalActionPreparation ? 1 : 2,
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
    if (taskNeedsCommerceLookup(task)) {
      // "Where to buy" tasks must END with concrete buy links, not advice.
      // A live failure (run_1782421416298_2kkuuok3) searched well but read
      // NEWS about a config being pulled and then told the user to "check
      // eBay" / "did you mean SSD?" instead of opening real shop/marketplace
      // listings and returning direct product URLs with seller/price/stock.
      return {
        mode: "current_lookup",
        reason: "The task asks where to buy a product; it needs concrete current shopping listings.",
        researchDepth: "single_source",
        idealOutcome:
          "Return a ranked list of CONCRETE places to buy the item: direct product/listing URLs with seller, price, and availability. Open real shop/marketplace pages — never just name a platform or tell the user to search.",
        userSuccessCriteria: criteria.length
          ? criteria
          : ["direct product/listing links", "seller", "price", "in stock or not"],
        likelyFailureModes: [
          "answering from model memory",
          "reading news/analysis instead of shop pages",
          "naming platforms without a direct product link",
          "telling the user where else to search instead of finding it",
        ],
        exceedExpectations: [
          "several ranked buy links (official, retailer, marketplace)",
          "current price and stock per link",
        ],
        requiredEvidence: ["opened retailer/marketplace product pages", "direct product/listing URLs"],
        researchPlan: [
          {
            step: "Shopping search",
            purpose: "Search retailers and marketplaces for the exact product in stock with price.",
            expectedEvidence: "candidate shop/listing URLs",
            preferredTools: ["web.search"],
          },
          {
            step: "Open listing pages",
            purpose: "Open the actual product/listing pages and extract seller, price, availability, and the direct buy URL.",
            expectedEvidence: "direct product/listing URLs with price and stock",
            preferredTools: ["web.read", "browser.operate", "browser.screenshot"],
          },
        ],
        answerContract: {
          mustDo: [
            "list concrete buy links (direct product/listing URLs the user can open and purchase from) — take them from the search results or opened pages",
            "for each link give seller, price, and availability/stock when visible",
            "rank official store > reputable retailer > marketplace",
            "if the exact config is unavailable, give the closest CONCRETE buyable alternative link, not advice",
          ],
          mustAvoid: [
            "answering whether the product exists from model memory",
            "naming a platform (eBay/Amazon) without a real product/listing URL",
            "telling the user to search elsewhere or 'check' a site themselves",
            "generic buying advice instead of concrete links",
          ],
          finalAnswerShape: [
            "short verdict: where it can be bought",
            "ranked list of direct buy links with seller / price / stock",
            "closest buyable alternative link if the exact item is unavailable",
          ],
          proofStrategy: "Use the shop/listing pages found via search as the source of truth; a product URL from a search result is a valid buy link even if the page could not be fully read.",
        },
        externalActionPolicy,
        // Keep the gate satisfiable by search alone: modern shop pages often
        // block scraping, so requiring a successful page READ would fail the
        // run instead of returning the product URLs the search already found.
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
    `- Source policy: externalResearch=${frame.sourcePolicy.externalResearch}; ${frame.sourcePolicy.reason}`,
    frame.sourcePolicy.searchPlan?.queries.length
      ? [
          `- Source search plan: ${frame.sourcePolicy.searchPlan.strategy}; mixedLanguage=${frame.sourcePolicy.searchPlan.requiresMixedLanguageSearch ? "required" : "not required"}`,
          ...frame.sourcePolicy.searchPlan.queries.map((query, index) =>
            `  ${index + 1}. [${query.language}] ${query.query} — ${query.purpose} Expected source types: ${query.expectedSourceTypes.join(", ")}`,
          ),
        ].join("\n")
      : undefined,
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

function looksLikeLocalUtilityTask(task: string): boolean {
  const normalized = normalizeForTaskFrame(task);
  if (/\b(?:file\.read|file\.write|document\.extract|data\.transform)\b/i.test(task)) return true;
  if (/(?:сохрани|запиши|создай|write|save|create).{0,120}\.(?:csv|json|txt|md|html|xml)\b/i.test(task)) return true;
  if (/(?:прочитай|извлеки|extract|read|parse|распарс).{0,80}\b(?:pdf|docx|document|документ|файл)\b/i.test(task)) return true;
  if (/\b(?:pdf|docx|document|документ|файл)\b.{0,80}(?:прочитай|извлеки|extract|read|parse|распарс)/i.test(task)) return true;
  if (/\.(?:csv|json|txt|md|pdf|docx|html)\b/i.test(task) && /(?:прочитай|извлеки|extract|read|parse|преобраз|конверт|convert|transform|сохрани|save|write)/i.test(task)) {
    return true;
  }
  if (/(?:json|csv|таблиц|массив|список|строк).{0,140}(?:csv|json|отсорт|sort|фильтр|filter|преобраз|конверт|transform|convert|template)/i.test(normalized)) {
    return true;
  }
  if (/(?:отсорт|sort|фильтр|filter|преобраз|конверт|transform|convert).{0,140}(?:json|csv|таблиц|массив|список|строк)/i.test(normalized)) {
    return true;
  }
  return false;
}

function limitText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
