import { SkillMemoryEntry } from "../types.js";
import {
  MemoryScopeFilter,
  normalizeMemoryScope,
  normalizeMemorySensitivity,
  normalizeMemoryStatus,
} from "./skillMemory.js";

export type MemoryPolicyContext = {
  visibleScopes: MemoryScopeFilter[];
  requesterUserId?: string;
  allowSensitive?: boolean;
  allowPrivate?: boolean;
};

export type MemoryPolicyDecisionStatus = "allowed" | "blocked" | "needs_review";

export type MemoryPolicyDecision = {
  status: MemoryPolicyDecisionStatus;
  matchedScope?: MemoryScopeFilter;
  reasons: string[];
};

export function evaluateMemoryPolicy(
  entry: SkillMemoryEntry,
  context: MemoryPolicyContext,
): MemoryPolicyDecision {
  const reasons: string[] = [];
  const status = normalizeMemoryStatus(entry.status);
  const scope = normalizeMemoryScope(entry.scope);
  const sensitivity = normalizeMemorySensitivity(entry.sensitivity);
  const matchedScope = findMatchingMemoryScope(entry, context.visibleScopes);

  if (status !== "accepted") {
    return {
      status: "blocked",
      matchedScope,
      reasons: [`Memory status is ${status}; only accepted memories can be injected.`],
    };
  }

  if (!matchedScope) {
    return {
      status: "blocked",
      reasons: [
        scope === "global"
          ? "Global scope is not present in the run visibility context."
          : `Run visibility context does not include exact ${scope} scope id ${entry.scopeId ?? "(missing)"}.`,
      ],
    };
  }

  reasons.push(
    scope === "global"
      ? "Global scope is visible to this run."
      : `Exact ${scope} scope id ${entry.scopeId ?? "(missing)"} is visible to this run.`,
  );

  if (sensitivity === "private") {
    if (context.allowPrivate) {
      return {
        status: "allowed",
        matchedScope,
        reasons: [...reasons, "Private memory is allowed by explicit policy override."],
      };
    }

    if (scope === "user" && entry.scopeId && entry.scopeId === context.requesterUserId) {
      return {
        status: "allowed",
        matchedScope,
        reasons: [...reasons, "Private user memory belongs to the requesting user."],
      };
    }

    return {
      status: "blocked",
      matchedScope,
      reasons: [
        ...reasons,
        "Private memory requires the same requester user scope or an explicit private-memory policy grant.",
      ],
    };
  }

  if (sensitivity === "sensitive" && !context.allowSensitive) {
    return {
      status: "needs_review",
      matchedScope,
      reasons: [
        ...reasons,
        "Sensitive memory matches the run context, but strict policy simulation requires an explicit sensitive-memory grant.",
      ],
    };
  }

  return {
    status: "allowed",
    matchedScope,
    reasons: [...reasons, sensitivity === "sensitive" ? "Sensitive memory is allowed by policy." : "Normal memory is allowed."],
  };
}

export function findMatchingMemoryScope(
  entry: SkillMemoryEntry,
  visibleScopes: MemoryScopeFilter[],
): MemoryScopeFilter | undefined {
  const scope = normalizeMemoryScope(entry.scope);
  return visibleScopes.find((candidate) => {
    if (candidate.scope !== scope) return false;
    if (scope === "global") return true;
    return Boolean(candidate.scopeId) && candidate.scopeId === entry.scopeId;
  });
}
