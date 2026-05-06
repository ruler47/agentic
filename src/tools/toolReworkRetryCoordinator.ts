import { AgentRunRecord, RunStore } from "../runs/types.js";
import {
  ToolReworkWaitRecord,
  ToolReworkWaitStore,
} from "../runs/toolReworkWaitStore.js";

export type CreateRetryRunStatus =
  | "created"
  | "already_exists"
  | "wait_not_promoted"
  | "wait_not_found"
  | "source_run_not_found";

export type CreateRetryRunOptions = {
  reason?: string;
};

export type CreateRetryRunResult = {
  status: CreateRetryRunStatus;
  wait?: ToolReworkWaitRecord;
  retryRun?: AgentRunRecord;
  alreadyExists?: boolean;
  error?: string;
};

export type ToolReworkRetryAuditEvent = {
  action: "tool_rework_wait.retry_run_created";
  targetType: "tool_rework_wait";
  targetId: string;
  status: "success";
  runId?: string;
  summary: string;
  metadata?: Record<string, unknown>;
};

export type ToolReworkRetryAuditWriter = (event: ToolReworkRetryAuditEvent) => Promise<void> | void;

export type ToolReworkRetryCoordinatorRunStore = Pick<
  RunStore,
  "create" | "get" | "resumeFromToolRework"
>;

export type ToolReworkRetryCoordinatorDeps = {
  toolReworkWaitStore: ToolReworkWaitStore;
  runStore: ToolReworkRetryCoordinatorRunStore;
  audit?: ToolReworkRetryAuditWriter;
};

/**
 * Creates a linked retry run from a promoted ToolReworkWait. The retry run inherits the
 * original run's task, instance/user/channel/thread context, and points back through
 * `parentRunId`. The wait moves to `resumed` with `retryRunId` populated, and the
 * original run returns from `waiting_tool_rework` to `failed` (matching the existing
 * "Mark ready for retry" semantics) so its failure context stays observable.
 *
 * This is intentionally generic: it does not know about browser, telegram, market, or
 * any specific capability. Whatever tool the wait is tracking, the retry run starts
 * with the original task and the registry metadata that the operator/agent already
 * captured in the wait/build/investigation chain.
 *
 * Actual execution of the retry run is handled by the HTTP layer through the same
 * `executeRun` helper that powers `POST /api/runs`. The coordinator stops at the run
 * record, so it stays usable from server, CLI, and future recursive-agent contexts
 * without forcing them all to share an execution loop.
 */
export class ToolReworkRetryCoordinator {
  constructor(private readonly deps: ToolReworkRetryCoordinatorDeps) {}

  async createRetryRun(
    waitId: string,
    options: CreateRetryRunOptions = {},
  ): Promise<CreateRetryRunResult> {
    const previous = await this.deps.toolReworkWaitStore.get(waitId);
    if (!previous) {
      return {
        status: "wait_not_found",
        error: `Tool rework wait ${waitId} was not found`,
      };
    }
    // Idempotency: if a retry run was already created for this wait and still exists,
    // surface it instead of duplicating the work. This check runs BEFORE the
    // status=promoted gate so a wait that has moved on to `resumed` after retry-run
    // creation still resolves to its existing retry run for repeat operator clicks.
    if (previous.retryRunId) {
      const existing = await this.deps.runStore.get(previous.retryRunId);
      if (existing) {
        return {
          status: "already_exists",
          wait: previous,
          retryRun: existing,
          alreadyExists: true,
        };
      }
      // Wait references a retryRunId that no longer exists (e.g. data was cleaned up):
      // fall through and create a new one. The wait will be relinked below.
    }
    if (previous.status !== "promoted") {
      return {
        status: "wait_not_promoted",
        wait: previous,
        error:
          `Tool rework wait is not promoted yet (current status: ${previous.status}); ` +
          "wait until the linked tool build reaches `registered`.",
      };
    }

    const sourceRun = await this.deps.runStore.get(previous.runId);
    if (!sourceRun) {
      return {
        status: "source_run_not_found",
        wait: previous,
        error: `Source run ${previous.runId} for wait ${previous.id} no longer exists`,
      };
    }

    const retryRun = await this.deps.runStore.create(sourceRun.task, {
      instanceId: sourceRun.instanceId,
      requesterUserId: sourceRun.requesterUserId,
      channel: sourceRun.channel,
      threadId: sourceRun.threadId,
      parentRunId: sourceRun.id,
      sourceUserId: sourceRun.sourceUserId,
      sourceMessageId: sourceRun.sourceMessageId,
      sourceChatId: sourceRun.sourceChatId,
      sourceThreadId: sourceRun.sourceThreadId,
    });

    const reason =
      options.reason?.trim() ||
      `Retry run ${retryRun.id} created automatically after tool rework promotion ` +
        `(${previous.toolName ?? "tool"}${previous.promotedVersion ? `@${previous.promotedVersion}` : ""}). ` +
        `Source run ${sourceRun.id} returns to "failed"; the retry run owns the new attempt.`;

    const wait = await this.deps.toolReworkWaitStore.update(previous.id, {
      status: "resumed",
      retryRunId: retryRun.id,
      reason,
    });
    await this.deps.runStore.resumeFromToolRework(sourceRun.id, reason);

    await this.deps.audit?.({
      action: "tool_rework_wait.retry_run_created",
      targetType: "tool_rework_wait",
      targetId: wait.id,
      status: "success",
      runId: wait.runId,
      summary:
        `Tool rework retry run created: ${retryRun.id} ` +
        `(source run ${sourceRun.id}, wait ${wait.id}).`,
      metadata: {
        previousStatus: previous.status,
        sourceRunId: sourceRun.id,
        sourceSpanId: previous.spanId,
        retryRunId: retryRun.id,
        buildRequestId: previous.buildRequestId,
        investigationId: previous.investigationId,
        promotedVersion: previous.promotedVersion,
        toolName: previous.toolName,
      },
    });

    return {
      status: "created",
      wait,
      retryRun,
    };
  }
}
