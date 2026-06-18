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
