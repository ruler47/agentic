import type { AuditService } from "../../common/services/audit.service.js";
import { sanitizeAuditMetadata } from "../../common/parsers.js";
import type { ConversationThreadStore } from "../../../conversations/types.js";
import type { AgentRunRecord, RunStore } from "../../../runs/types.js";
import type { AgentRunResult, ExternalActionProposal, ExternalActionProposalStatus } from "../../../types.js";
import type { ToolServiceEventStore } from "../../../tools/toolServiceEventStore.js";
import type { ToolServiceSupervisor } from "../../../tools/toolServiceSupervisor.js";
import { buildRunOutboundDelivery } from "./run-outbound-delivery.js";
import { recordRunOutboundDelivery } from "./run-outbound-event-recorder.js";

export async function completeWaitingRunAfterExternalAction(input: {
  runs: RunStore;
  audit: AuditService;
  threads?: ConversationThreadStore;
  toolServiceSupervisor?: ToolServiceSupervisor;
  toolServiceEvents?: ToolServiceEventStore;
  run: AgentRunRecord;
  proposal: ExternalActionProposal;
  status: "committed" | "rejected";
  message: string;
  parentSpanId?: string;
}): Promise<void> {
  const result = input.run.result;
  if (!result) return;

  const now = new Date().toISOString();
  const proposalStatus: ExternalActionProposalStatus =
    input.status === "committed" ? "committed" : "rejected";
  const updatedResult: AgentRunResult = {
    ...result,
    finalAnswer: externalActionFinalAnswer({
      finalAnswer: result.finalAnswer,
      status: input.status,
      message: input.message,
    }),
    actionProposals: result.actionProposals?.map((proposal) =>
      proposal.id === input.proposal.id
        ? { ...proposal, status: proposalStatus }
        : proposal,
    ),
    runStatus: "completed" as const,
    runFailureReason: undefined,
  };

  await input.runs.complete(input.run.id, updatedResult);
  if (input.run.threadId) {
    await input.threads?.completeRun({
      threadId: input.run.threadId,
      runId: input.run.id,
      task: input.run.task,
      finalAnswer: updatedResult.finalAnswer,
      artifacts: updatedResult.artifacts,
    });
  }
  await recordRunOutboundDelivery({
    run: input.run,
    delivery: buildRunOutboundDelivery(updatedResult),
    toolServiceSupervisor: input.toolServiceSupervisor,
    toolServiceEvents: input.toolServiceEvents,
    audit: input.audit,
  });
  await input.runs.appendEvent(input.run.id, {
    id: `run-resumed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    spanId: `${input.run.id}:approval-resumed`,
    parentSpanId: input.parentSpanId,
    type: "run-completed",
    actor: "coordinator",
    activity: "coordination",
    status: "completed",
    title: "Run resumed after external action decision",
    detail: input.message,
    timestamp: now,
    startedAt: now,
    completedAt: now,
    payload: {
      input: {
        runId: input.run.id,
        proposalId: input.proposal.id,
        decision: input.status,
      },
      output: {
        status: "completed",
        finalAnswer: updatedResult.finalAnswer.slice(0, 1_000),
      },
    },
  });
  await input.audit.record({
    instanceId: input.run.instanceId,
    actorId: "coordinator",
    actorType: "agent",
    action: "run.completed",
    targetType: "run",
    targetId: input.run.id,
    runId: input.run.id,
    threadId: input.run.threadId,
    requesterUserId: input.run.requesterUserId,
    channel: input.run.channel,
    summary: `Run completed after external action ${input.status}: ${input.run.task.slice(0, 160)}`,
    metadata: sanitizeAuditMetadata({
      proposalId: input.proposal.id,
      actionStatus: input.status,
    }),
  });
}

function externalActionFinalAnswer(input: {
  finalAnswer: string;
  status: "committed" | "rejected";
  message: string;
}): string {
  const prefix =
    input.status === "committed"
      ? "External action completed:"
      : "External action did not run:";
  return [input.finalAnswer.trim(), "", `${prefix} ${input.message}`]
    .filter(Boolean)
    .join("\n");
}
