import type { ToolIntegrationContract, ToolIntegrationTarget } from "../../../tools/toolIntegrationContract.js";
import type { ToolBuilderPlan } from "../../../tools/toolBuilderAgent.js";

export function applyToolIntegrationEditConstraints(
  contract: ToolIntegrationContract | undefined,
  contextTexts: Array<string | undefined>,
): ToolIntegrationContract | undefined {
  if (!contract?.targets?.length) return contract;
  const forbiddenTerms = extractForbiddenTargetTerms(contextTexts);
  if (forbiddenTerms.length === 0) return contract;

  const keptTargets = contract.targets.filter((target) => !targetMatchesForbiddenTerm(target, forbiddenTerms));
  const baseUrlBlocked = contract.baseUrl ? termMatchesForbiddenTerm(contract.baseUrl, forbiddenTerms) : false;
  if (keptTargets.length === contract.targets.length && !baseUrlBlocked) return contract;

  const removed = contract.targets
    .filter((target) => targetMatchesForbiddenTerm(target, forbiddenTerms))
    .map((target) => target.baseUrl);
  return {
    ...contract,
    baseUrl: baseUrlBlocked ? undefined : contract.baseUrl,
    targets: keptTargets.length > 0 ? keptTargets : undefined,
    notes: [
      ...(contract.notes ?? []),
      `Removed inherited integration endpoint(s) blocked by current edit context: ${[...removed, ...(baseUrlBlocked && contract.baseUrl ? [contract.baseUrl] : [])].join(", ")}.`,
    ],
  };
}

export function applyToolBuilderPlanIntegrationEditConstraints(
  plan: ToolBuilderPlan,
  contextTexts: Array<string | undefined>,
): ToolBuilderPlan {
  return {
    ...plan,
    input: {
      ...plan.input,
      integrationContract: applyToolIntegrationEditConstraints(plan.input.integrationContract, contextTexts),
    },
    strategy: {
      ...plan.strategy,
      integrationContract: applyToolIntegrationEditConstraints(plan.strategy.integrationContract, contextTexts),
    },
  };
}

function extractForbiddenTargetTerms(contextTexts: Array<string | undefined>): string[] {
  const joined = contextTexts.filter(Boolean).join("\n");
  const sentences = joined.split(/(?<=[.!?])\s+|\n+/).filter(hasNegativeTargetConstraint);
  const terms = sentences.flatMap((sentence) => [
    ...urlLikeTerms(sentence),
    ...negativePhraseTerms(sentence),
  ]);
  return uniqueStrings(terms.map(normalizeTerm).filter((term) => term.length >= 4));
}

function hasNegativeTargetConstraint(sentence: string): boolean {
  return /\b(?:do\s+not|don't|never|remove|delete|invalid|wrong|not\s+in\s+(?:the\s+)?(?:docs|documentation)|must\s+not|should\s+not)\b/i.test(sentence)
    || /\b(?:не\s+использ|нельзя\s+использ|удал|лишн|нету?\s+в\s+документации|не\s+в\s+документации)\b/i.test(sentence);
}

function urlLikeTerms(sentence: string): string[] {
  return [
    ...sentence.matchAll(/https?:\/\/[^\s)"']+/gi),
    ...sentence.matchAll(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s)"']*)?/gi),
  ].map((match) => match[0]);
}

function negativePhraseTerms(sentence: string): string[] {
  const terms: string[] = [];
  for (const match of sentence.matchAll(/\b(?:do\s+not\s+use|don't\s+use|never\s+use|remove(?:\s+invalid)?|delete|must\s+not\s+use|should\s+not\s+use)\s+([a-z0-9._:-]+)/gi)) {
    terms.push(match[1] ?? "");
  }
  for (const match of sentence.matchAll(/\b(?:не\s+использовать|нельзя\s+использовать|удалить|удали)\s+([a-z0-9._:-]+)/gi)) {
    terms.push(match[1] ?? "");
  }
  return terms;
}

function targetMatchesForbiddenTerm(target: ToolIntegrationTarget, terms: string[]): boolean {
  const haystack = normalizeTerm([
    target.baseUrl,
    target.id,
    target.label,
    target.description,
    ...(target.aliases ?? []),
  ].filter(Boolean).join(" "));
  return terms.some((term) => haystack.includes(term));
}

function termMatchesForbiddenTerm(value: string, terms: string[]): boolean {
  const normalized = normalizeTerm(value);
  return terms.some((term) => normalized.includes(term));
}

function normalizeTerm(value: string): string {
  return value.toLowerCase().replace(/^https?:\/\//, "").replace(/[),.;]+$/g, "").trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
