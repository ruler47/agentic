import { ToolBuildRequest } from "./toolBuildRequestStore.js";
import { ToolBuildWorkflow, ToolBuildWorkflowResult } from "./toolBuildWorkflow.js";

export type ToolBuildWorkerOptions = {
  intervalMs?: number;
  batchSize?: number;
  claimDetail?: string;
  reloadGeneratedTools?: () => Promise<void>;
  onEvent?: (event: ToolBuildWorkerEvent) => void;
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

  constructor(
    private readonly workflow: ToolBuildWorkflow,
    private readonly store: {
      claimNextRequested?: (statusDetail?: string) => Promise<ToolBuildRequest | undefined>;
    },
    private readonly options: ToolBuildWorkerOptions = {},
  ) {}

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

  async tick(): Promise<ToolBuildWorkerTickResult> {
    const empty: ToolBuildWorkerTickResult = { claimed: [], results: [], errors: [] };
    if (this.running) return empty;
    if (!this.store.claimNextRequested) {
      this.emit({ type: "idle", detail: "Tool build store does not support claimNextRequested." });
      return empty;
    }

    this.running = true;
    try {
      const result: ToolBuildWorkerTickResult = { claimed: [], results: [], errors: [] };
      for (let index = 0; index < this.batchSize; index += 1) {
        const request = await this.store.claimNextRequested(this.claimDetail);
        if (!request) {
          if (index === 0) this.emit({ type: "idle", detail: "No requested tool builds are waiting." });
          break;
        }

        result.claimed.push(request);
        this.emit({ type: "claimed", requestId: request.id, status: request.status, detail: request.capability });

        try {
          const workflowResult = await this.workflow.runClaimed(request);
          result.results.push(workflowResult);
          if (workflowResult.request.status === "registered") {
            await this.options.reloadGeneratedTools?.();
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
    } finally {
      this.running = false;
    }
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
