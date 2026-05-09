import { AgentRunRecord, RunStore } from "../runs/types.js";
import {
  ToolReworkWaitRecord,
  ToolReworkWaitStore,
} from "../runs/toolReworkWaitStore.js";
import { ToolReworkRetryCoordinator } from "./toolReworkRetryCoordinator.js";

export type AutoRetryPolicy = {
  /**
   * When false, the coordinator never creates a retry run automatically. Operators can
   * still create one manually through the `/retry-run` endpoint or the "Create retry
   * run" button.
   */
  enabled: boolean;
  /**
   * Cap on how many auto retries can chain off a single root run. Walking the
   * `parentRunId` chain provides a deterministic, generic counter that does not depend
   * on any specific tool/capability. The default is intentionally conservative — one
   * automatic retry per failure, after which the operator decides what to do next.
   */
  maxAutoRetriesPerRootRun: number;
};

export const DEFAULT_AUTO_RETRY_POLICY: AutoRetryPolicy = {
  enabled: true,
  maxAutoRetriesPerRootRun: 1,
};

export type AutoRetryDecisionStatus =
  | "created"
  | "resumed"
  | "already_exists"
  | "waiting_for_other_waits"
  | "disabled"
  | "wait_not_found"
  | "wait_not_promoted"
  | "source_run_not_found"
  | "source_run_cancelled"
  | "max_depth_reached"
  | "failed";

export type AutoRetryResult = {
  status: AutoRetryDecisionStatus;
  wait?: ToolReworkWaitRecord;
  retryRun?: AgentRunRecord;
  alreadyExists?: boolean;
  reason?: string;
  policy: AutoRetryPolicy;
  retryDepth?: number;
};

export type AutoRetryAuditEvent = {
  action: "tool_rework_wait.auto_retry_decision";
  targetType: "tool_rework_wait";
  targetId: string;
  status: "success" | "failure";
  runId?: string;
  summary: string;
  metadata?: Record<string, unknown>;
};

export type AutoRetryAuditWriter = (event: AutoRetryAuditEvent) => Promise<void> | void;

export type AutoRetryRunStore = Pick<RunStore, "get" | "resumeFromToolRework">;

/**
 * Phase 12 follow-up: when wired, the auto-retry coordinator prefers RESUMING
 * the original run instead of creating a separate retry run. Resume picks up
 * where the original paused (via `RunsService.resume`), reusing the
 * classifier output, plan, and any subtask whose review verdict was
 * `pass`. Falls back to retry-run creation when the hook is not provided.
 */
export type AutoRetryResumeRun = (sourceRunId: string) => Promise<AgentRunRecord | undefined>;

export type ToolReworkAutoRetryCoordinatorDeps = {
  toolReworkWaitStore: ToolReworkWaitStore;
  runStore: AutoRetryRunStore;
  retryCoordinator: ToolReworkRetryCoordinator;
  /**
   * Phase 12 follow-up: optional. When provided, auto-retry resumes the
   * original run instead of creating a separate retry run. The coordinator
   * also waits until ALL open waits for that run are resolved
   * (promoted/resumed/cancelled/failed) before resuming, so a run with
   * multiple concurrent waits does not start before the last build lands.
   */
  resumeRun?: AutoRetryResumeRun;
  audit?: AutoRetryAuditWriter;
  policy?: AutoRetryPolicy;
};

const PARENT_CHAIN_HARD_LIMIT = 16;

/**
 * Generic automatic retry orchestrator for promoted ToolReworkWait records. It does NOT
 * duplicate retry-run creation logic — every retry run still goes through the existing
 * `ToolReworkRetryCoordinator`, which guarantees idempotency and audited transitions.
 *
 * The coordinator stays domain-neutral: any wait reaching `promoted` (browser, telegram,
 * AML, market, chart, document — whatever) is eligible if policy allows. The only inputs
 * are the wait, its source run's lifecycle, and a parent-chain depth counter. There is
 * no special-case logic for any specific capability.
 */
export class ToolReworkAutoRetryCoordinator {
  private readonly policy: AutoRetryPolicy;
  private readonly inFlight = new Map<string, Promise<AutoRetryResult>>();

  constructor(private readonly deps: ToolReworkAutoRetryCoordinatorDeps) {
    this.policy = deps.policy ?? DEFAULT_AUTO_RETRY_POLICY;
  }

  getPolicy(): AutoRetryPolicy {
    return { ...this.policy };
  }

  /**
   * Inspect a promoted wait and create a retry run if policy allows it. Idempotent: a
   * second call against the same wait returns the existing retry run without creating a
   * new one. Never throws on expected failure modes; instead returns a structured
   * result so callers (HTTP handler / `notifyBuildRegistered` hook) can decide what to
   * surface.
   */
  async tryAutoRetry(waitId: string): Promise<AutoRetryResult> {
    const policy = this.getPolicy();
    if (!policy.enabled) {
      return { status: "disabled", policy };
    }
    // In-process per-wait lock so a fast double-call from `notifyBuildRegistered` and
    // an operator-issued `/api/tool-rework-waits/:id/auto-retry` cannot race past the
    // retryRunId idempotency gate before either call writes the wait. Postgres adds a
    // separate row-level safeguard; this lock keeps single-process behaviour correct
    // even when the underlying store has no compare-and-set primitive.
    const existing = this.inFlight.get(waitId);
    if (existing) return existing;
    const pending = this.runDecision(waitId, policy).finally(() => {
      this.inFlight.delete(waitId);
    });
    this.inFlight.set(waitId, pending);
    return pending;
  }

  private async runDecision(waitId: string, policy: AutoRetryPolicy): Promise<AutoRetryResult> {

    const wait = await this.deps.toolReworkWaitStore.get(waitId);
    if (!wait) {
      return {
        status: "wait_not_found",
        policy,
        reason: `Tool rework wait ${waitId} was not found`,
      };
    }

    // Idempotency check first so a wait that was already retried (manually or by an
    // earlier auto pass) never gets a second run created. We deliberately accept any
    // wait status here — once a retryRunId is recorded, the orchestrator is finished
    // with this wait, even if the operator later changed its status.
    if (wait.retryRunId) {
      const existing = await this.deps.runStore.get(wait.retryRunId).catch(() => undefined);
      if (existing) {
        return {
          status: "already_exists",
          wait,
          retryRun: existing,
          alreadyExists: true,
          policy,
        };
      }
      // Wait references a retryRunId that no longer exists — fall through and let the
      // retry coordinator create a fresh one. The wait will be relinked.
    }

    if (wait.status !== "promoted") {
      return {
        status: "wait_not_promoted",
        wait,
        policy,
        reason: `Tool rework wait is not promoted yet (current status: ${wait.status}).`,
      };
    }

    const sourceRun = await this.deps.runStore.get(wait.runId).catch(() => undefined);
    if (!sourceRun) {
      const result: AutoRetryResult = {
        status: "source_run_not_found",
        wait,
        policy,
        reason: `Source run ${wait.runId} for wait ${wait.id} no longer exists.`,
      };
      await this.audit(result);
      return result;
    }
    if (sourceRun.status === "cancelled") {
      const result: AutoRetryResult = {
        status: "source_run_cancelled",
        wait,
        policy,
        reason: `Source run ${sourceRun.id} is cancelled; auto retry is suppressed.`,
      };
      await this.audit(result);
      return result;
    }

    // Phase 12 follow-up: when the run has additional open waits, do not
    // resume / retry yet — the next promoted wait will fire this hook
    // again, and only the LAST one to flip should actually unblock the
    // run. Otherwise a run with 4 concurrent waits would start (and
    // finish) on the first one, abandoning the others' build outputs.
    const otherOpenWaits = await this.findOtherOpenWaits(wait);
    if (otherOpenWaits.length > 0) {
      const result: AutoRetryResult = {
        status: "waiting_for_other_waits",
        wait,
        policy,
        reason:
          `Run ${sourceRun.id} still has ${otherOpenWaits.length} open tool rework wait(s); ` +
          `this auto-retry pass defers until all are resolved.`,
      };
      await this.audit(result);
      return result;
    }

    // Phase 12 follow-up: prefer `resumeRun` over `createRetryRun` when the
    // service is wired. Resume picks up exactly where the run paused —
    // classifier output, plan, and any subtask with `verdict=pass` are
    // reused; only the missing/incomplete subtasks run again.
    if (this.deps.resumeRun) {
      try {
        const resumedRun = await this.deps.resumeRun(sourceRun.id);
        if (resumedRun) {
          await this.deps.toolReworkWaitStore.update(wait.id, {
            status: "resumed",
            retryRunId: resumedRun.id,
          });
          // Drop the source run out of `waiting_tool_rework` so the UI
          // reflects the resume action immediately. The new resume run
          // owns the lifecycle from here.
          await this.deps.runStore
            .resumeFromToolRework(sourceRun.id, `Auto-resumed after wait ${wait.id} promoted.`)
            .catch(() => undefined);
          const result: AutoRetryResult = {
            status: "resumed",
            wait: { ...wait, status: "resumed", retryRunId: resumedRun.id },
            retryRun: resumedRun,
            policy,
          };
          await this.audit(result);
          return result;
        }
      } catch (error) {
        // Fall through to legacy retry path on resume failure so the run
        // does not silently stall.
        const reason = error instanceof Error ? error.message : "unknown error";
        const fallback: AutoRetryResult = {
          status: "failed",
          wait,
          policy,
          reason: `resume hook threw: ${reason}; falling back to retry-run creation.`,
        };
        await this.audit(fallback);
      }
    }

    const retryDepth = await this.computeRetryDepth(sourceRun);
    if (retryDepth >= policy.maxAutoRetriesPerRootRun) {
      const result: AutoRetryResult = {
        status: "max_depth_reached",
        wait,
        policy,
        retryDepth,
        reason:
          `Source run already has ${retryDepth} ancestor retry generation(s); ` +
          `the policy cap is ${policy.maxAutoRetriesPerRootRun}.`,
      };
      await this.audit(result);
      return result;
    }

    const created = await this.deps.retryCoordinator.createRetryRun(wait.id, {
      reason:
        `Auto retry after tool rework promotion (${wait.toolName ?? "tool"}` +
        `${wait.promotedVersion ? `@${wait.promotedVersion}` : ""}). ` +
        `Source run ${sourceRun.id}; retry depth ${retryDepth + 1}/${policy.maxAutoRetriesPerRootRun}.`,
    });

    if (created.status === "already_exists") {
      const result: AutoRetryResult = {
        status: "already_exists",
        wait: created.wait,
        retryRun: created.retryRun,
        alreadyExists: true,
        policy,
        retryDepth,
      };
      await this.audit(result);
      return result;
    }
    if (created.status === "created") {
      const result: AutoRetryResult = {
        status: "created",
        wait: created.wait,
        retryRun: created.retryRun,
        policy,
        retryDepth,
      };
      await this.audit(result);
      return result;
    }

    // wait_not_promoted, wait_not_found, source_run_not_found from the underlying
    // coordinator. Treat them all as `failed` from the auto-retry perspective.
    const result: AutoRetryResult = {
      status: "failed",
      wait: created.wait ?? wait,
      policy,
      retryDepth,
      reason: created.error ?? `Underlying retry coordinator returned status=${created.status}.`,
    };
    await this.audit(result);
    return result;
  }

  /**
   * Phase 12 follow-up: find every open wait belonging to the same run
   * EXCEPT the wait we just received. "Open" means status is not yet
   * resolved (waiting / build_running). Promoted, resumed, cancelled,
   * failed are all considered resolved — the caller decides whether
   * promoted-but-not-yet-retried counts as resolved (we treat it as
   * resolved here because the build has landed and the run is free to
   * proceed).
   */
  private async findOtherOpenWaits(currentWait: { id: string; runId: string }) {
    const peers = await this.deps.toolReworkWaitStore
      .listByRun(currentWait.runId)
      .catch(() => []);
    return peers.filter(
      (peer) => peer.id !== currentWait.id && (peer.status === "waiting" || peer.status === "build_running"),
    );
  }

  private async computeRetryDepth(run: AgentRunRecord): Promise<number> {
    let depth = 0;
    let current: AgentRunRecord | undefined = run;
    let safety = 0;
    while (current?.parentRunId && safety < PARENT_CHAIN_HARD_LIMIT) {
      const parent: AgentRunRecord | undefined = await this.deps.runStore
        .get(current.parentRunId)
        .catch(() => undefined);
      if (!parent) break;
      depth += 1;
      current = parent;
      safety += 1;
    }
    return depth;
  }

  private async audit(result: AutoRetryResult): Promise<void> {
    if (!this.deps.audit) return;
    if (!result.wait) return;
    await this.deps.audit({
      action: "tool_rework_wait.auto_retry_decision",
      targetType: "tool_rework_wait",
      targetId: result.wait.id,
      status:
        result.status === "created" || result.status === "already_exists"
          ? "success"
          : "failure",
      runId: result.wait.runId,
      summary: `Auto retry decision for wait ${result.wait.id}: ${result.status}.`,
      metadata: {
        decision: result.status,
        autoRetry: true,
        policyEnabled: result.policy.enabled,
        maxAutoRetriesPerRootRun: result.policy.maxAutoRetriesPerRootRun,
        retryDepth: result.retryDepth,
        retryRunId: result.retryRun?.id,
        sourceRunId: result.wait.runId,
        spanId: result.wait.spanId,
        toolName: result.wait.toolName,
        toolVersion: result.wait.toolVersion,
        promotedVersion: result.wait.promotedVersion,
        buildRequestId: result.wait.buildRequestId,
        investigationId: result.wait.investigationId,
        reason: result.reason,
      },
    });
  }
}
