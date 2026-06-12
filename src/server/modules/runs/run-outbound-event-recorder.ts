import type { AuditService } from "../../common/services/audit.service.js";
import type { AgentRunRecord } from "../../../runs/types.js";
import type { ToolServiceEventStore } from "../../../tools/toolServiceEventStore.js";
import type { ToolServiceSupervisor } from "../../../tools/toolServiceSupervisor.js";
import { filterToolServiceOutboundPayload } from "./run-agent-runtime-helpers.js";
import type { RunOutboundDelivery } from "./run-outbound-delivery.js";

export async function recordRunOutboundDelivery(input: {
  run: AgentRunRecord | undefined;
  delivery: RunOutboundDelivery;
  toolServiceSupervisor: ToolServiceSupervisor | undefined;
  toolServiceEvents: ToolServiceEventStore | undefined;
  audit: AuditService;
}): Promise<void> {
  const { run, delivery } = input;
  if (!run?.channel || !input.toolServiceSupervisor || !input.toolServiceEvents)
    return;
  if (!run.sourceChatId && !run.sourceUserId) return;
  const service = (await input.toolServiceSupervisor.list()).find(
    (candidate) => candidate.toolName === run.channel,
  );
  if (!service) return;

  const event = await input.toolServiceEvents.record({
    toolName: run.channel,
    direction: "outbound",
    status: "queued",
    summary: delivery.summary,
    sourceUserId: run.sourceUserId,
    sourceChatId: run.sourceChatId,
    sourceMessageId: run.sourceMessageId,
    threadId: run.threadId,
    runId: run.id,
    payload: {
      ...filterToolServiceOutboundPayload(delivery.payload),
      runStatus: delivery.status,
      requesterUserId: run.requesterUserId,
    },
  });

  await input.audit.record({
    instanceId: run.instanceId,
    actorId: run.channel,
    actorType: "tool",
    action: "tool_service.event_recorded",
    targetType: "tool",
    targetId: run.channel,
    status: delivery.status === "completed" ? "pending" : "failure",
    runId: run.id,
    threadId: run.threadId,
    requesterUserId: run.requesterUserId,
    channel: run.channel,
    summary: `Outbound event queued for ${run.channel}: ${delivery.summary.slice(0, 160)}`,
    metadata: {
      serviceEventId: event.id,
      runStatus: delivery.status,
    },
  });
}
