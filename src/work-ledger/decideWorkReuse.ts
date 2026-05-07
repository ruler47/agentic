import {
  WorkClaim,
  WorkLedgerItem,
  WorkReuseDecision,
} from "./types.js";

export type DecideWorkReuseOptions = {
  /**
   * Items that share `claim.workKey`. Callers should already filter by workKey before
   * passing the slice in; the decider is intentionally pure and does not query a store.
   */
  existingItems: WorkLedgerItem[];
  claim: Pick<WorkClaim, "workKey" | "ownerSpanId" | "reason" | "freshnessExpiresAt">;
  /**
   * Window during which a recent failure on the same workKey blocks a new attempt
   * unless the proposed claim explicitly says it is a revalidation / alternate-source
   * retry. Default: 10 minutes. Tests can shrink this for determinism.
   */
  recentFailureWindowMs?: number;
  /** Reference time. Defaults to `new Date()`. Useful for deterministic tests. */
  now?: Date;
};

const DEFAULT_RECENT_FAILURE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Pure work-reuse decision. The decision tree is intentionally explicit so two
 * branches that compute the same `workKey` with the same ledger snapshot always
 * return the same status. This function never mutates any record and never reads
 * external state.
 */
export function decideWorkReuse(options: DecideWorkReuseOptions): WorkReuseDecision {
  const reason = options.claim.reason?.toLowerCase() ?? "";
  const allowsRevalidation = /revalidat|alternate|fresher|retry|recover/.test(reason);
  const now = options.now ?? new Date();
  const recentFailureWindowMs = options.recentFailureWindowMs ?? DEFAULT_RECENT_FAILURE_WINDOW_MS;

  const matches = options.existingItems.filter((item) => item.workKey === options.claim.workKey);
  if (matches.length === 0) {
    return {
      status: "create_new_attempt",
      reason: "No prior work item matches this workKey; safe to create a new attempt.",
    };
  }

  const sorted = [...matches].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  // First check: an explicitly running/claimed item by another span.
  const inflight = sorted.find(
    (item) =>
      (item.status === "claimed" || item.status === "running") &&
      (!item.ownerSpanId || item.ownerSpanId !== options.claim.ownerSpanId),
  );
  if (inflight) {
    return {
      status: "wait_for_inflight",
      reason: `Another span (${inflight.ownerSpanId ?? "unknown"}) is already working this workKey; wait or subscribe instead of duplicating.`,
      match: inflight,
    };
  }

  // Reuse the latest fresh completed item if its freshness has not expired.
  const completed = sorted.find((item) => item.status === "completed");
  if (completed) {
    const expired = isExpired(completed.freshnessExpiresAt, now);
    if (!expired) {
      return {
        status: "reuse_completed",
        reason: "A completed work item with the same workKey exists and is still fresh; reuse its evidence and artifacts.",
        match: completed,
      };
    }
    if (allowsRevalidation) {
      return {
        status: "create_revalidation",
        reason: "Completed work exists but its freshness window expired; the proposed claim asks for a revalidation.",
        match: completed,
      };
    }
    return {
      status: "create_revalidation",
      reason: "Completed work exists but its freshness window expired; the next attempt should refresh the evidence.",
      match: completed,
    };
  }

  // Stale items always need a new versioned attempt.
  const stale = sorted.find((item) => item.status === "stale");
  if (stale) {
    return {
      status: "create_revalidation",
      reason: "A stale work item with the same workKey exists; a new attempt should refresh the evidence.",
      match: stale,
    };
  }

  // Recent failure: block unless the caller explicitly says they want to revalidate /
  // try an alternate source, in which case we still create a fresh attempt.
  const failed = sorted.find((item) => item.status === "failed");
  if (failed) {
    const failedAt = Date.parse(failed.updatedAt);
    const ageMs = Number.isFinite(failedAt) ? now.getTime() - failedAt : Number.POSITIVE_INFINITY;
    if (ageMs < recentFailureWindowMs && !allowsRevalidation) {
      return {
        status: "blocked_by_recent_failure",
        reason: `A recent failure on the same workKey was recorded ${Math.max(0, Math.round(ageMs / 1000))}s ago; the claim must explicitly say revalidation/alternate to retry.`,
        match: failed,
      };
    }
    return {
      status: "create_new_attempt",
      reason:
        ageMs < recentFailureWindowMs
          ? "Recent failure exists, but the claim explicitly asks for a revalidation/alternate source."
          : "Failure exists but is outside the recent-failure window; safe to create a new attempt.",
      match: failed,
    };
  }

  // Cancelled or planned items don't block — let the caller create a fresh attempt and
  // surface the previous record so the agent can see it.
  return {
    status: "create_new_attempt",
    reason: "Existing items for this workKey are not active; create a new attempt and link the prior record for context.",
    match: sorted[0],
  };
}

function isExpired(freshnessExpiresAt: string | undefined, now: Date): boolean {
  if (!freshnessExpiresAt) return false;
  const ts = Date.parse(freshnessExpiresAt);
  if (!Number.isFinite(ts)) return false;
  return ts <= now.getTime();
}
