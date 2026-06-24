import type { AgentRunRecord } from "../../../runs/types.js";
import type { ExternalActionProposal } from "../../../types.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import type { ActionProposalAuditRecorder } from "./action-proposal-audit-recorder.js";
import { findExistingExternalActionCommitExecutor } from "./action-proposal-executor-matching.js";
import {
  buildExternalActionExecutorBuildRequest,
  externalActionCommitBlockReason,
  normalizeExternalActionCommitExecutor,
} from "./action-proposals.shared.js";

export async function attachExistingExecutorIfAvailable(input: {
  run: AgentRunRecord;
  proposal: ExternalActionProposal;
  enabled: boolean;
  toolRegistry: ToolRegistry | undefined;
  recorder: ActionProposalAuditRecorder;
}): Promise<ExternalActionProposal> {
  if (!input.enabled) return input.proposal;
  const executor = normalizeExternalActionCommitExecutor(
    input.proposal.commitExecutor,
  );
  if (!externalActionCommitBlockReason(executor, input.toolRegistry)) {
    return input.proposal;
  }
  const buildRequest = buildExternalActionExecutorBuildRequest(
    input.run,
    input.proposal,
  );
  const existing = findExistingExternalActionCommitExecutor(
    input.toolRegistry,
    buildRequest,
  );
  if (!existing) return input.proposal;
  const readinessSuffix = existing.ready
    ? ""
    : `, but it is not commit-ready yet: ${existing.reason}`;
  await input.recorder.recordExternalActionExecutorAttached({
    run: input.run,
    proposal: input.proposal,
    buildRequest,
    executor: existing,
    reason: `Automode attached existing commit executor ${existing.toolName}${
      existing.toolVersion ? `@${existing.toolVersion}` : ""
    }${readinessSuffix}.`,
  });
  return { ...input.proposal, commitExecutor: existing };
}
