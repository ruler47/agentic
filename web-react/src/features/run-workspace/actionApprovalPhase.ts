import type { ActionProposalQueueItem } from "@/api/runs";
import { buildCommitReadiness } from "@/features/approvals/commitReadiness";

export type ActionApprovalPhase = {
  title: string;
  badge: string;
  tone: "ok" | "warn" | "danger";
};

export function buildActionApprovalPhase(
  items: ActionProposalQueueItem[],
  runStatus: string,
): ActionApprovalPhase {
  if (!items.length) {
    return {
      title: "Run external action state",
      badge: runStatus,
      tone: runStatus === "failed" ? "danger" : "ok",
    };
  }

  const readinesses = items.map((item) => ({
    item,
    readiness: buildCommitReadiness(item),
  }));

  if (readinesses.some(({ readiness }) => readiness.status === "ready_to_commit")) {
    return {
      title: "External action is ready for final submit",
      badge: "ready to submit",
      tone: "ok",
    };
  }

  if (readinesses.some(({ readiness }) => readiness.status === "needs_profile_approval")) {
    return {
      title: "External action needs data approval before submit",
      badge: "needs data approval",
      tone: "warn",
    };
  }

  const blocked = readinesses.find(({ readiness }) =>
    readiness.status === "blocked" ||
    readiness.status === "failed" ||
    readiness.status === "needs_preparation" ||
    readiness.status === "needs_replay" ||
    readiness.status === "needs_executor"
  );
  if (blocked) {
    if (isFinalSubmitBlocked(blocked.readiness.reason)) {
      return {
        title: isSubmitControlBlocker(blocked.readiness.reason)
          ? "External action was not submitted: provider submit control was not detected"
          : "External action was not submitted",
        badge: "not submitted",
        tone: blocked.readiness.tone,
      };
    }
    return {
      title: "External action is not ready to submit",
      badge: blocked.readiness.label.toLowerCase(),
      tone: blocked.readiness.tone,
    };
  }

  if (items.some((item) => item.proposal.status === "proposed")) {
    return {
      title: "Run is paused until this action is approved or rejected",
      badge: "waiting approval",
      tone: "warn",
    };
  }

  if (items.some((item) => item.proposal.status === "approved")) {
    return {
      title: "Run is paused until the approved external action is finished or rejected",
      badge: "approved",
      tone: "warn",
    };
  }

  if (items.some((item) => item.proposal.status === "committed")) {
    return {
      title: "External action completed",
      badge: "committed",
      tone: "ok",
    };
  }

  if (items.some((item) => item.proposal.status === "rejected")) {
    return {
      title: "External action was rejected",
      badge: "rejected",
      tone: "danger",
    };
  }

  return {
    title: "Run external action state",
    badge: runStatus,
    tone: runStatus === "failed" ? "danger" : "ok",
  };
}

function isFinalSubmitBlocked(reason: string): boolean {
  return /final submit|commit|submit\/control|external submit|proof artifact|provider phone\/SMS/i.test(
    reason,
  );
}

function isSubmitControlBlocker(reason: string): boolean {
  return /submit\/control|concrete external submit control|clickable control|typed commit target/i.test(
    reason,
  );
}
