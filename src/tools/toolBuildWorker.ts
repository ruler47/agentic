import { ToolBuildRequest } from "./toolBuildRequestStore.js";
import { ToolBuildWorkflow, ToolBuildWorkflowResult } from "./toolBuildWorkflow.js";

export type ToolBuildWorkerOptions = {
  intervalMs?: number;
  batchSize?: number;
  claimDetail?: string;
  reloadGeneratedTools?: () => Promise<void>;
  onEvent?: (event: ToolBuildWorkerEvent) => void;
  /**
   * Fires after each workflow run, regardless of status. Used by the HTTP layer to flip
   * any matching ToolReworkWait records to `promoted` and to record the same audit
   * events that the manual PATCH/`/run` endpoints already emit, so a build that the
   * background worker registered produces the same observable lifecycle.
   */
  onAfterCompleted?: (result: ToolBuildWorkflowResult) => Promise<void> | void;
};

export type ToolBuildWorkerEvent = {
  type: "claimed" | "completed" | "idle" | "error";
  requestId?: string;
  status?: string;
  detail?: string;
};

export type ToolBuildWorkerTickResult = {
  claimed: ToolBuildRequest[];
  results: ToolBuildWorkflowResult[];
  errors: string[];
};

export class ToolBuildWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private pendingTick: Promise<ToolBuildWorkerTickResult> | undefined;
  private queuedImmediateTick: Promise<ToolBuildWorkerTickResult> | undefined;
  private onAfterCompleted?: (result: ToolBuildWorkflowResult) => Promise<void> | void;

  constructor(
    private readonly workflow: ToolBuildWorkflow,
    private readonly store: {
      claimNextRequested?: (statusDetail?: string) => Promise<ToolBuildRequest | undefined>;
    },
    private readonly options: ToolBuildWorkerOptions = {},
  ) {
    this.onAfterCompleted = options.onAfterCompleted;
  }

  /**
   * Late-bind the post-workflow callback. The HTTP layer uses this to wire
   * `notifyToolBuildRegistered` and the matching `tool_build.registered` audit so a
   * background-worker-driven build produces the same observable lifecycle as the
   * manual `/run` and PATCH endpoints. Calling this replaces any previous callback.
   */
  setOnAfterCompleted(fn: ((result: ToolBuildWorkflowResult) => Promise<void> | void) | undefined): void {
    this.onAfterCompleted = fn;
  }

  start(): void {
    if (this.timer) return;

    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Trigger an immediate tick without waiting for the configured interval. Used by
   * `ToolImprovementCoordinator.requestImprovement` to hand a freshly created build
   * over to the worker directly. If a tick is already in flight, this method schedules
   * exactly one follow-up tick after it completes. That preserves the single-claimer
   * guard while still catching requests created after the current tick already checked
   * the queue.
   */
  async scheduleImmediate(): Promise<ToolBuildWorkerTickResult> {
    if (this.pendingTick) {
      if (!this.queuedImmediateTick) {
        const currentTick = this.pendingTick;
        this.queuedImmediateTick = (async () => {
          try {
            await currentTick;
          } catch {
            // `tick` records workflow errors in its result, but keep the follow-up
            // trigger resilient if a future implementation throws unexpectedly.
          }
          return this.tick();
        })().finally(() => {
          this.queuedImmediateTick = undefined;
        });
      }
      return this.queuedImmediateTick;
    }
    return this.tick();
  }

  async tick(): Promise<ToolBuildWorkerTickResult> {
    const empty: ToolBuildWorkerTickResult = { claimed: [], results: [], errors: [] };
    if (this.running) return this.pendingTick ?? empty;
    if (!this.store.claimNextRequested) {
      this.emit({ type: "idle", detail: "Tool build store does not support claimNextRequested." });
      return empty;
    }

    this.running = true;
    const tick = this.runTick();
    this.pendingTick = tick;
    try {
      return await tick;
    } finally {
      this.running = false;
      this.pendingTick = undefined;
    }
  }

  private async runTick(): Promise<ToolBuildWorkerTickResult> {
    const result: ToolBuildWorkerTickResult = { claimed: [], results: [], errors: [] };
    for (let index = 0; index < this.batchSize; index += 1) {
      const request = await this.store.claimNextRequested!(this.claimDetail);
      if (!request) {
        if (index === 0) this.emit({ type: "idle", detail: "No requested tool builds are waiting." });
        break;
      }

      result.claimed.push(request);
      this.emit({ type: "claimed", requestId: request.id, status: request.status, detail: request.capability });

      try {
        const workflowResult = await this.workflow.runClaimed(request);
        result.results.push(workflowResult);
        if (workflowResult.request.status === "registered" && !workflowResult.activationReport) {
          await this.options.reloadGeneratedTools?.();
        }
        if (this.onAfterCompleted) {
          try {
            await this.onAfterCompleted(workflowResult);
          } catch (callbackError) {
            const message = callbackError instanceof Error ? callbackError.message : String(callbackError);
            result.errors.push(`onAfterCompleted: ${message}`);
            this.emit({
              type: "error",
              requestId: workflowResult.request.id,
              detail: `onAfterCompleted: ${message}`,
            });
          }
        }
        this.emit({
          type: "completed",
          requestId: workflowResult.request.id,
          status: workflowResult.request.status,
          detail: workflowResult.request.statusDetail,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(message);
        this.emit({ type: "error", requestId: request.id, detail: message });
      }
    }

    return result;
  }

  private get intervalMs(): number {
    const value = this.options.intervalMs ?? 15_000;
    return Number.isFinite(value) ? Math.max(1000, value) : 15_000;
  }

  private get batchSize(): number {
    const value = this.options.batchSize ?? 1;
    return Number.isFinite(value) ? Math.max(1, Math.min(value, 5)) : 1;
  }

  private get claimDetail(): string {
    return this.options.claimDetail ?? "Claimed by background Tool Builder worker.";
  }

  private emit(event: ToolBuildWorkerEvent): void {
    this.options.onEvent?.(event);
  }
}
