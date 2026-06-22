import type { ModelTier } from "../types.js";
import {
  decorateCatalogModel,
  parseModelCapabilityOverrides,
  type CatalogModelRecord,
  type ModelCapability,
  type ModelCapabilityOverrides,
} from "./modelCatalog.js";
import type { ModelTierSettingsInput } from "./modelTierSettings.js";

export type ModelRouteRejectedCandidate = {
  tier: ModelTier;
  model: string;
  capabilities: ModelCapability[];
  reason: string;
};

export type ModelRouteDecision = {
  requestedTier?: ModelTier;
  selectedTier?: ModelTier;
  selectedModel: string;
  attempts: string[];
  requiredCapabilities: ModelCapability[];
  preferredCapabilities: ModelCapability[];
  rejectedCandidates: ModelRouteRejectedCandidate[];
  fallbackUsed: boolean;
  reason: string;
};

export type ModelRouteRequest = {
  requestedTier?: ModelTier;
  defaultModel: string;
  requiredCapabilities?: ModelCapability[];
  preferredCapabilities?: ModelCapability[];
  explicitModel?: string;
  capabilityOverrides?: ModelCapabilityOverrides;
  policyForTier: (tier: ModelTier) => Promise<Required<ModelTierSettingsInput>>;
};

const TIER_ORDER: ModelTier[] = ["S", "M", "L", "XL"];

export async function resolveModelRoute(request: ModelRouteRequest): Promise<ModelRouteDecision> {
  const requiredCapabilities = uniqueCapabilities(request.requiredCapabilities ?? []);
  const preferredCapabilities = uniqueCapabilities(request.preferredCapabilities ?? []);
  const capabilityOverrides = request.capabilityOverrides ?? parseModelCapabilityOverrides(process.env.LLM_MODEL_CAPABILITIES);

  if (request.explicitModel) {
    return {
      requestedTier: request.requestedTier,
      selectedTier: request.requestedTier,
      selectedModel: request.explicitModel,
      attempts: [request.explicitModel, request.explicitModel],
      requiredCapabilities,
      preferredCapabilities,
      rejectedCandidates: [],
      fallbackUsed: false,
      reason: "Explicit model override bypassed tier routing.",
    };
  }

  if (!request.requestedTier) {
    const model = request.defaultModel;
    return {
      selectedModel: model,
      attempts: [model],
      requiredCapabilities,
      preferredCapabilities,
      rejectedCandidates: [],
      fallbackUsed: false,
      reason: "No tier requested; using default model.",
    };
  }

  const rejectedCandidates: ModelRouteRejectedCandidate[] = [];
  const tiers = tiersFrom(request.requestedTier);
  const unfilteredAttempts: string[] = [];
  let firstUnfilteredCandidate: { tier: ModelTier; model: CatalogModelRecord } | undefined;

  for (const tier of tiers) {
    const policy = await request.policyForTier(tier);
    const candidates = uniqueModels(policy.models).map((model) => decorateCatalogModel({ id: model }, capabilityOverrides));
    const compatible = candidates.filter((candidate) => {
      const missing = missingCapabilities(candidate, requiredCapabilities);
      if (missing.length === 0) return true;
      rejectedCandidates.push({
        tier,
        model: candidate.id,
        capabilities: candidate.capabilities,
        reason: `missing ${missing.join(", ")}`,
      });
      return false;
    });

    const attemptCandidates = requiredCapabilities.length > 0
      ? sortByPreferredCapabilities(compatible, preferredCapabilities)
      : sortByPreferredCapabilities(candidates, preferredCapabilities);

    for (const candidate of attemptCandidates) {
      firstUnfilteredCandidate ??= { tier, model: candidate };
      for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
        unfilteredAttempts.push(candidate.id);
      }
    }

    if (requiredCapabilities.length > 0 && attemptCandidates.length > 0) {
      const selected = attemptCandidates[0];
      return {
        requestedTier: request.requestedTier,
        selectedTier: tier,
        selectedModel: selected.id,
        attempts: repeatByPolicy(attemptCandidates, policy.maxAttempts),
        requiredCapabilities,
        preferredCapabilities,
        rejectedCandidates,
        fallbackUsed: tier !== request.requestedTier,
        reason: routeReason({
          requestedTier: request.requestedTier,
          selectedTier: tier,
          selected,
          requiredCapabilities,
          preferredCapabilities,
        }),
      };
    }

    if (!policy.escalateOnFailure) break;
  }

  if (requiredCapabilities.length === 0 && firstUnfilteredCandidate && unfilteredAttempts.length > 0) {
    return {
      requestedTier: request.requestedTier,
      selectedTier: firstUnfilteredCandidate.tier,
      selectedModel: firstUnfilteredCandidate.model.id,
      attempts: unfilteredAttempts,
      requiredCapabilities,
      preferredCapabilities,
      rejectedCandidates,
      fallbackUsed: false,
      reason: routeReason({
        requestedTier: request.requestedTier,
        selectedTier: firstUnfilteredCandidate.tier,
        selected: firstUnfilteredCandidate.model,
        requiredCapabilities,
        preferredCapabilities,
      }),
    };
  }

  if (requiredCapabilities.length > 0) {
    throw new Error(
      [
        `No compatible LLM model found for tier ${request.requestedTier} requiring ${requiredCapabilities.join(", ")}.`,
        formatRejectedCandidates(rejectedCandidates),
        "Configure model capabilities in Models settings or LLM_MODEL_CAPABILITIES.",
      ].filter(Boolean).join(" "),
    );
  }

  const model = request.defaultModel;
  return {
    requestedTier: request.requestedTier,
    selectedModel: model,
    attempts: [model],
    requiredCapabilities,
    preferredCapabilities,
    rejectedCandidates,
    fallbackUsed: true,
    reason: "Tier policy produced no candidates; using default model fallback.",
  };
}

function tiersFrom(start: ModelTier): ModelTier[] {
  const index = TIER_ORDER.indexOf(start);
  return index >= 0 ? TIER_ORDER.slice(index) : [start];
}

function missingCapabilities(candidate: CatalogModelRecord, required: ModelCapability[]): ModelCapability[] {
  return required.filter((capability) => !candidate.capabilities.includes(capability));
}

function sortByPreferredCapabilities(
  candidates: CatalogModelRecord[],
  preferred: ModelCapability[],
): CatalogModelRecord[] {
  if (preferred.length === 0) return candidates;
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: preferred.filter((capability) => candidate.capabilities.includes(capability)).length,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.candidate);
}

function repeatByPolicy(candidates: CatalogModelRecord[], maxAttempts: number): string[] {
  const attempts: string[] = [];
  for (const candidate of candidates) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      attempts.push(candidate.id);
    }
  }
  return attempts;
}

function routeReason(input: {
  requestedTier: ModelTier;
  selectedTier: ModelTier;
  selected: CatalogModelRecord;
  requiredCapabilities: ModelCapability[];
  preferredCapabilities: ModelCapability[];
}): string {
  const parts = [`selected ${input.selected.id} from tier ${input.selectedTier}`];
  if (input.selectedTier !== input.requestedTier) parts.push(`escalated from ${input.requestedTier}`);
  if (input.requiredCapabilities.length > 0) {
    parts.push(`required ${input.requiredCapabilities.join(", ")}`);
  }
  const matchedPreferred = input.preferredCapabilities.filter((capability) =>
    input.selected.capabilities.includes(capability),
  );
  if (matchedPreferred.length > 0) parts.push(`preferred ${matchedPreferred.join(", ")}`);
  return `${parts.join("; ")}.`;
}

function formatRejectedCandidates(rejected: ModelRouteRejectedCandidate[]): string {
  if (rejected.length === 0) return "";
  return `Rejected candidates: ${rejected
    .slice(0, 8)
    .map((candidate) => `${candidate.tier}:${candidate.model} (${candidate.reason})`)
    .join("; ")}.`;
}

function uniqueModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

function uniqueCapabilities(capabilities: ModelCapability[]): ModelCapability[] {
  return [...new Set(capabilities)];
}
