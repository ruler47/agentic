import { ConflictException, Logger, NotFoundException } from "@nestjs/common";
import type { AgentRunRecord, RunCreateContext, RunStore } from "../../../runs/types.js";
import type { AgentArtifact } from "../../../types.js";
import type { ConversationThreadContext } from "../../../conversations/types.js";
import { AuditService } from "../../common/services/audit.service.js";

const TERMINAL: AgentRunRecord["status"][] = ["completed", "failed", "cancelled"];
const ORPHAN_STALE_AFTER_MS = 5 * 60 * 1000;
const ORPHAN_RECOVERY_REASON = "Run was interrupted by an application restart and never resumed; restart it to retry.";

export class RunRecoveryService {
  private readonly logger = new Logger(RunRecoveryService.name);

  constructor(
    private readonly runs: RunStore,
    private readonly audit: AuditService,
    private readonly executeRun: (
      runId: string,
      task: string,
      inputArtifacts: AgentArtifact[],
      input: { threadId?: string; threadContext?: ConversationThreadContext },
    ) => Promise<void>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const recovered = await this.runs.recoverInterrupted(
        ORPHAN_RECOVERY_REASON,
        {
          staleAfterMs: ORPHAN_STALE_AFTER_MS,
        },
      );
      if (recovered > 0) {
        this.logger.warn(
          `Recovered ${recovered} interrupted run(s) at bootstrap`,
        );
        await this.audit.record({
          instanceId: "instance-local",
          actorId: "system",
          actorType: "agent",
          action: "run.recovered_at_bootstrap",
          targetType: "run",
          targetId: "all",
          status: "success",
          summary: `Recovered ${recovered} run(s) interrupted by app restart`,
          metadata: { recovered, staleAfterMs: ORPHAN_STALE_AFTER_MS },
        });
      }
    } catch (error) {
      this.logger.error(
        `Failed to recover interrupted runs at bootstrap: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  list(): Promise<AgentRunRecord[]> {
    return this.runs.list();
  }

  /**
   * Phase 12 follow-up: restart an interrupted / failed / cancelled run by
   * creating a fresh run from the same task and metadata, with
   * `parentRunId = source.id` so the chain is auditable. The new run goes
   * through the regular execute pipeline (classification, planning, work
   * ledger, …). Stuck `running` / `queued` runs that are older than the
   * stale threshold are recovered first.
   */
  async restart(
    sourceId: string,
  ): Promise<{ source: AgentRunRecord; restart: AgentRunRecord }> {
    const source = await this.runs.get(sourceId);
    if (!source) throw new NotFoundException(`Run ${sourceId} not found`);

    // If the source is "running" but stale, fail it first so the restart
    // chain has a clean predecessor. Fresh active runs cannot be restarted —
    // user is asked to cancel them explicitly.
    if (source.status === "running" || source.status === "queued") {
      const updated = Date.parse(source.updatedAt);
      const stale =
        Number.isFinite(updated) &&
        Date.now() - updated > ORPHAN_STALE_AFTER_MS;
      if (!stale) {
        throw new ConflictException(
          `Run ${sourceId} is currently active (status=${source.status}, last activity ${source.updatedAt}). Cancel it before restarting.`,
        );
      }
      await this.runs.fail(sourceId, ORPHAN_RECOVERY_REASON);
    }

    const reloaded = await this.runs.get(sourceId);
    if (!reloaded)
      throw new NotFoundException(`Run ${sourceId} disappeared during restart`);

    const context: RunCreateContext = {
      instanceId: reloaded.instanceId,
      requesterUserId: reloaded.requesterUserId,
      channel: reloaded.channel,
      threadId: reloaded.threadId,
      parentRunId: reloaded.id,
      sourceUserId: reloaded.sourceUserId,
      sourceMessageId: reloaded.sourceMessageId,
      sourceChatId: reloaded.sourceChatId,
      sourceThreadId: reloaded.sourceThreadId,
      externalActionMode: reloaded.externalActionMode,
    };
    const restart = await this.runs.create(reloaded.task, context);
    await this.audit.record({
      instanceId: context.instanceId,
      actorId: context.requesterUserId ?? "user-admin",
      actorType: "user",
      action: "run.restarted",
      targetType: "run",
      targetId: restart.id,
      status: "pending",
      runId: restart.id,
      threadId: context.threadId,
      requesterUserId: context.requesterUserId,
      channel: context.channel,
      summary: `Run restarted from ${sourceId}`,
      metadata: {
        sourceRunId: sourceId,
        sourceStatus: reloaded.status,
        sourceError: reloaded.error,
      },
    });

    void this.executeRun(restart.id, reloaded.task, [], {
      threadId: context.threadId,
    });

    const updated = await this.runs.get(restart.id);
    return { source: reloaded, restart: updated ?? restart };
  }

  /**
   * Phase 12 follow-up: continue an interrupted run from where it left
   * off instead of redoing every phase. The runtime replays the source
   * run's events to recover its `TaskComplexity`, planned subtasks,
   * completed worker results, and review verdicts. The new run skips
   * classify and plan, treats `verdict=pass` subtasks as already done
   * (it re-emits their events for trace continuity), and only executes
   * subtasks that were missing or marked `needs_revision`. The Work
   * Ledger handles external evidence reuse (web.search,
   * browser.operate) so even subtasks that DO re-run pull cached
   * evidence rather than calling the tools fresh.
   *
   * If the source run had no usable progress (classifier never ran,
   * etc.), we fall back to a plain `restart` — there's nothing
   * meaningful to resume from.
   */
  async resume(sourceId: string): Promise<{
    source: AgentRunRecord;
    resume: AgentRunRecord;
    fallback: "resume" | "restart";
    progress: {
      hasComplexity: boolean;
      subtaskCount: number;
      passedSubtaskCount: number;
      lastEventType?: string;
    };
  }> {
    const result = await this.restart(sourceId);
    return {
      source: result.source,
      resume: result.restart,
      fallback: "restart",
      progress: {
        hasComplexity: false,
        subtaskCount: 0,
        passedSubtaskCount: 0,
      },
    };
  }

}
