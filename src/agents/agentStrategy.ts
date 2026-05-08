import type { ModelTier, SkillMemoryEntry, TaskComplexity } from "../types.js";
import type { Tool } from "../tools/tool.js";
import { selectModelTier } from "./modelTier.js";

export type AgentStrategyKind =
  | "direct_answer"
  | "delegated_dag"
  | "tool_use"
  | "tool_build_or_rework"
  | "ledger_reuse_or_wait"
  | "council";

export type AgentStrategyAction =
  | "answer_directly"
  | "delegate_children"
  | "ask_council"
  | "call_tool"
  | "request_tool_build"
  | "request_tool_rework"
  | "check_work_ledger"
  | "reuse_evidence"
  | "wait_for_sibling_work"
  | "self_check_return";

export type AgentReviewStrictness = "light" | "normal" | "strict" | "council";

export type AgentCouncilParticipant = {
  role: string;
  focus: string;
  modelTier: ModelTier;
};

export type AgentStrategyDecision = {
  primary: AgentStrategyKind;
  actions: AgentStrategyAction[];
  modelTier: ModelTier;
  reviewStrictness: AgentReviewStrictness;
  maxChildDepth: number;
  maxParallelChildren: number;
  reasons: string[];
  riskSignals: string[];
  ledgerPolicy: {
    shouldCheck: boolean;
    reuseFreshEvidence: boolean;
    waitForInFlight: boolean;
    revalidateStaleOrFailed: boolean;
  };
  toolPolicy: {
    mayCallTools: boolean;
    mayRequestBuild: boolean;
    mayRequestRework: boolean;
    matchedToolNames: string[];
    missingCapabilityHints: string[];
  };
  council?: {
    reason: string;
    participants: AgentCouncilParticipant[];
  };
};

export type AgentStrategyInput = {
  task: string;
  complexity: TaskComplexity;
  memories?: SkillMemoryEntry[];
  tools?: Tool[];
  hasWorkLedger?: boolean;
  pendingToolImprovements?: number;
};

export function decideAgentStrategy(input: AgentStrategyInput): AgentStrategyDecision {
  const taskText = normalizeText(input.task);
  const strategyText = normalizeText([input.task, input.complexity.domains.join(" ")].join("\n"));
  const memoryText = normalizeText(
    (input.memories ?? []).map((memory) => `${memory.title} ${memory.summary} ${memory.reusableProcedure}`).join("\n"),
  );
  const matchedTools = matchTools(taskText, input.tools ?? []);
  const missingCapabilityHints = inferMissingCapabilityHints(taskText, matchedTools);
  const riskSignals = inferRiskSignals(strategyText, input.complexity);
  const councilRecommended = shouldUseCouncil(input.complexity, riskSignals, strategyText);
  const ledgerRelevant = Boolean(input.hasWorkLedger) && isReusableExternalWork(taskText, matchedTools);

  const actions = new Set<AgentStrategyAction>(["self_check_return"]);
  const reasons: string[] = [];
  let primary: AgentStrategyKind;

  if (ledgerRelevant) {
    actions.add("check_work_ledger");
    actions.add("reuse_evidence");
    actions.add("wait_for_sibling_work");
    reasons.push("Reusable or external work should check the Work Ledger before repeating effort.");
  }

  if (matchedTools.length > 0) {
    actions.add("call_tool");
    reasons.push(`Matched available tool(s): ${matchedTools.map((tool) => tool.name).join(", ")}.`);
  }

  if (missingCapabilityHints.length > 0) {
    actions.add("request_tool_build");
    actions.add("request_tool_rework");
    reasons.push(`Possible missing or insufficient capability: ${missingCapabilityHints.join(", ")}.`);
  }

  if (councilRecommended) {
    actions.add("ask_council");
    actions.add("delegate_children");
    primary = "council";
    reasons.push("Risk, ambiguity, or domain breadth warrants independent agent opinions before execution.");
  } else if (input.pendingToolImprovements && input.pendingToolImprovements > 0) {
    primary = "tool_build_or_rework";
    reasons.push("A previous step opened tool improvement waits that should be resolved before a confident return.");
  } else if (missingCapabilityHints.length > 0) {
    primary = "tool_build_or_rework";
  } else if (ledgerRelevant) {
    primary = "ledger_reuse_or_wait";
  } else if (matchedTools.length > 0 && input.complexity.mode === "direct") {
    primary = "tool_use";
  } else if (input.complexity.mode === "direct") {
    actions.add("answer_directly");
    primary = "direct_answer";
    reasons.push("The task is narrow enough for a local answer after self-check.");
  } else {
    actions.add("delegate_children");
    primary = "delegated_dag";
    reasons.push("The task needs multiple focused child agents or subtasks.");
  }

  if (primary === "delegated_dag" || primary === "council") actions.add("delegate_children");

  const modelTier = modelTierForStrategy(primary, input.complexity, riskSignals);
  const reviewStrictness = reviewStrictnessForStrategy(primary, input.complexity, riskSignals);

  return {
    primary,
    actions: [...actions],
    modelTier,
    reviewStrictness,
    maxChildDepth: primary === "council" || input.complexity.riskLevel === "high" ? 2 : 1,
    maxParallelChildren: primary === "council" ? 4 : input.complexity.mode === "delegated" ? 3 : 1,
    reasons: reasons.length > 0
      ? reasons
      : [
          memoryText.length > 0
            ? "No current-task strategy signals were found; retrieved memory remains context only."
            : "No special strategy signals were found.",
        ],
    riskSignals,
    ledgerPolicy: {
      shouldCheck: ledgerRelevant,
      reuseFreshEvidence: ledgerRelevant,
      waitForInFlight: ledgerRelevant,
      revalidateStaleOrFailed: ledgerRelevant,
    },
    toolPolicy: {
      mayCallTools: matchedTools.length > 0,
      mayRequestBuild: missingCapabilityHints.length > 0,
      mayRequestRework: missingCapabilityHints.length > 0 || matchedTools.length > 0,
      matchedToolNames: matchedTools.map((tool) => tool.name),
      missingCapabilityHints,
    },
    council: councilRecommended
      ? {
          reason: "Use independent perspectives, then merge the plan before spending external work.",
          participants: buildCouncilParticipants(input.complexity, riskSignals),
        }
      : undefined,
  };
}

function modelTierForStrategy(
  strategy: AgentStrategyKind,
  complexity: TaskComplexity,
  riskSignals: string[],
): ModelTier {
  if (strategy === "council") return "L";
  if (strategy === "tool_build_or_rework") return "L";
  if (riskSignals.some((signal) => /medical|legal|financial|security/.test(signal))) return "L";
  if (complexity.mode === "delegated") return selectModelTier("planning", complexity);
  return selectModelTier("classification", complexity);
}

function reviewStrictnessForStrategy(
  strategy: AgentStrategyKind,
  complexity: TaskComplexity,
  riskSignals: string[],
): AgentReviewStrictness {
  if (strategy === "council") return "council";
  if (complexity.riskLevel === "high" || riskSignals.length >= 2) return "strict";
  if (complexity.mode === "delegated" || strategy === "tool_build_or_rework") return "normal";
  return "light";
}

function shouldUseCouncil(complexity: TaskComplexity, riskSignals: string[], text: string): boolean {
  if (complexity.riskLevel === "high") return true;
  if (complexity.domains.length >= 3) return true;
  if (riskSignals.length >= 2 && /\b(decide|choose|compare|tradeoff|strategy|architecture|roadmap)\b/.test(text)) {
    return true;
  }
  if (/\b(consensus|council|second opinion|multiple opinions|review from different|compare approaches)\b/.test(text)) {
    return true;
  }
  return false;
}

function buildCouncilParticipants(
  complexity: TaskComplexity,
  riskSignals: string[],
): AgentCouncilParticipant[] {
  const participants: AgentCouncilParticipant[] = [
    { role: "planner", focus: "Create a minimal safe plan and identify dependencies.", modelTier: "M" },
    { role: "critic", focus: "Find risks, missing evidence, duplicated work, and false assumptions.", modelTier: "L" },
  ];

  if (complexity.domains.length >= 2) {
    participants.push({
      role: "domain-specialist",
      focus: `Focus on ${complexity.domains.slice(0, 3).join(", ")} evidence and constraints.`,
      modelTier: "L",
    });
  }

  if (riskSignals.some((signal) => /medical|legal|financial|security/.test(signal))) {
    participants.push({
      role: "high-stakes-reviewer",
      focus: "Check safety, uncertainty, policy, and escalation requirements.",
      modelTier: "XL",
    });
  }

  return participants;
}

function matchTools(text: string, tools: Tool[]): Tool[] {
  return tools.filter((tool) => {
    const name = normalizeText(tool.name);
    return (name.length > 0 && text.includes(name)) ||
      tool.capabilities.some((capability) => capabilityMatches(text, capability));
  });
}

function capabilityMatches(text: string, capability: string): boolean {
  const normalized = normalizeText(capability);
  if (normalized && text.includes(normalized)) return true;
  if (normalized.includes("browser") && /\b(browser|screenshot|web page|page)\b|скриншот|страниц/.test(text)) return true;
  if (normalized.includes("web") && /\b(web|search|research|find)\b|поиск|найди/.test(text)) return true;
  if (normalized.includes("chart") && /\b(chart|graph|plot)\b|график|диаграм/.test(text)) return true;
  if (normalized.includes("document") && /\b(pdf|document|report|docx)\b|документ|отчет/.test(text)) return true;
  const tokens = normalized.split(/[^a-z0-9]+/).filter((token) => token.length >= 4);
  return tokens.length > 0 && tokens.every((token) => tokenMatchesText(text, token));
}

function inferMissingCapabilityHints(text: string, matchedTools: Tool[]): string[] {
  const hints = new Set<string>();
  const hasTool = (capability: string) =>
    matchedTools.some((tool) => tool.capabilities.some((item) => normalizeText(item).includes(capability)));

  if (/\b(pdf|document|report|docx)\b/.test(text) && !hasTool("document")) hints.add("document-generation");
  if (/\b(chart|graph|plot|diagram|график|диаграм)\b/.test(text) && !hasTool("chart")) hints.add("chart-generation");
  if (/\b(screenshot|browser|web page|скриншот|страниц)\b/.test(text) && !hasTool("browser")) hints.add("browser-automation");
  if (/\b(api|endpoint|openapi|webhook|bot|telegram|slack|whatsapp)\b/.test(text) && !hasTool("api")) {
    hints.add("external-integration");
  }
  if (/\b(voice|audio|transcribe|stt|голосов|аудио)\b/.test(text)) hints.add("speech-to-text");

  return [...hints];
}

function inferRiskSignals(text: string, complexity: TaskComplexity): string[] {
  const signals = new Set<string>();
  if (complexity.riskLevel === "high") signals.add("high-risk-classification");
  if (/\b(medical|medicine|doctor|clinical|dose|treatment|медицин|лекарств|дозиров)\b/.test(text)) signals.add("medical");
  if (/\b(legal|law|contract|compliance|gdpr|AML|санкци|юрид)\b/i.test(text)) signals.add("legal-compliance");
  if (/\b(financial|investment|buy|sell|tax|trading|money|купить|продать|налог)\b/.test(text)) signals.add("financial");
  if (/\b(security|credential|secret|token|password|auth|vulnerability)\b/.test(text)) signals.add("security");
  if (/\b(send|book|reserve|purchase|broadcast|delete|notify|message|заброни|отправ|удал)\b/.test(text)) {
    signals.add("outbound-or-state-changing-action");
  }
  return [...signals];
}

function isReusableExternalWork(text: string, matchedTools: Tool[]): boolean {
  if (matchedTools.length > 0) return true;
  return /\b(search|research|find|scrape|screenshot|browser|api|download|upload|file|chart|pdf|найди|поиск|скриншот)\b/.test(
    text,
  );
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е");
}

function tokenMatchesText(text: string, token: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}([^a-z0-9]|$)`).test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
