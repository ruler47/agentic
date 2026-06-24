import { Inject, Injectable } from "@nestjs/common";
import type { RunStore } from "../../../runs/types.js";
import { RUN_STORE } from "../../persistence/tokens.js";
import { ActionProposalsService } from "./action-proposals.service.js";
import type { ActionProposalQueueItem } from "./action-proposals.shared.js";

@Injectable()
export class ActionProposalAutoModeService {
  constructor(
    @Inject(RUN_STORE) private readonly runs: RunStore,
    @Inject(ActionProposalsService)
    private readonly actionProposals: ActionProposalsService,
  ) {}

  async commitReadyAutoProposalsForRun(
    runId: string,
    rawCommitBody: unknown = {},
  ): Promise<ActionProposalQueueItem[]> {
    const run = await this.runs.get(runId);
    const proposals =
      run?.result?.actionProposals?.filter(
        (proposal) =>
          proposal.executionMode === "auto" &&
          !proposal.approvalRequired &&
          proposal.status === "proposed",
      ) ?? [];
    const outcomes: ActionProposalQueueItem[] = [];
    for (const proposal of proposals) {
      await this.prepareBeforeAutomodeCommit(proposal.id, rawCommitBody);
      outcomes.push(
        await this.actionProposals.commitActionProposal(
          proposal.id,
          rawCommitBody,
        ),
      );
    }
    if (outcomes.length) await this.updateRunSummary(runId, outcomes);
    return outcomes;
  }

  private async prepareBeforeAutomodeCommit(
    proposalId: string,
    rawCommitBody: unknown,
  ): Promise<void> {
    try {
      await this.actionProposals.prepareActionProposal(proposalId, rawCommitBody);
    } catch {
      // Commit readiness produces the operator-facing blocker. Automode should
      // still attempt that diagnosis instead of failing before the proposal can
      // explain why it did not submit.
    }
  }

  private async updateRunSummary(
    runId: string,
    outcomes: ActionProposalQueueItem[],
  ): Promise<void> {
    const run = await this.runs.get(runId);
    if (!run?.result) return;
    const lines = outcomes.map((item) => autoModeOutcomeLine(item));
    const existing = run.result.finalAnswer.trimEnd();
    const finalAnswer = [
      existing,
      "",
      "Automode external action result:",
      ...lines.map((line) => `- ${line}`),
    ].join("\n");
    const proposals = run.result.actionProposals?.map((proposal) => {
      const outcome = outcomes.find((item) => item.proposal.id === proposal.id);
      return outcome?.proposal ?? proposal;
    });
    await this.runs.complete(runId, {
      ...run.result,
      finalAnswer,
      actionProposals: proposals,
    });
  }
}

function autoModeOutcomeLine(item: ActionProposalQueueItem): string {
  if (item.execution?.status === "committed") {
    return `committed "${item.proposal.title}"${
      item.execution.contentPreview ? `: ${item.execution.contentPreview}` : "."
    }`;
  }
  if (item.execution?.status === "failed") {
    return `failed to commit "${item.proposal.title}": ${
      item.execution.reason ?? "commit executor failed"
    }`;
  }
  if (item.execution?.status === "blocked") {
    return `did not submit "${item.proposal.title}": ${
      item.execution.reason ?? "commit executor is not ready"
    }`;
  }
  return `did not submit "${item.proposal.title}": no commit result was recorded`;
}
