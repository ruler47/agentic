import { AgentEvent, AgentRunResult } from "../types.js";
import { AgentRunRecord, RunCreateContext, RunStatus, RunStore } from "./types.js";

/**
 * A run is still mutable while queued, running, or paused for approval. The
 * waiting_approval pause is intentionally non-terminal: external-action
 * commit later completes it. completed/failed/cancelled are terminal.
 */
function isActiveStatus(status: RunStatus): boolean {
  return status === "queued" || status === "running" || status === "waiting_approval";
}

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, AgentRunRecord>();

  async create(task: string, context: RunCreateContext = {}): Promise<AgentRunRecord> {
    const now = new Date().toISOString();
    const run: AgentRunRecord = {
      id: createRunId(),
      task,
      status: "queued",
      instanceId: context.instanceId,
      requesterUserId: context.requesterUserId,
      channel: context.channel,
      threadId: context.threadId,
      parentRunId: context.parentRunId,
      sourceUserId: context.sourceUserId,
      sourceMessageId: context.sourceMessageId,
      sourceChatId: context.sourceChatId,
      sourceThreadId: context.sourceThreadId,
      externalActionMode: context.externalActionMode,
      createdAt: now,
      updatedAt: now,
      events: [],
    };

    this.runs.set(run.id, run);
    return cloneRun(run);
  }

  async list(): Promise<AgentRunRecord[]> {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(cloneRun);
  }

  async getMeta(id: string): Promise<{ status: AgentRunRecord["status"]; updatedAt: string; eventCount: number } | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    return { status: run.status, updatedAt: run.updatedAt, eventCount: run.events.length };
  }

  async get(id: string): Promise<AgentRunRecord | undefined> {
    const run = this.runs.get(id);
    return run ? cloneRun(run) : undefined;
  }

  async markRunning(id: string): Promise<void> {
    const run = this.mustGet(id);
    if (run.status === "cancelled") return;
    run.status = "running";
    run.updatedAt = new Date().toISOString();
  }

  async waitForApproval(
    id: string,
    result: AgentRunResult,
    reason: string,
  ): Promise<void> {
    const run = this.mustGet(id);
    if (run.status === "cancelled") return;
    run.status = "waiting_approval";
    run.result = result;
    run.error = reason;
    run.updatedAt = new Date().toISOString();
  }

  async appendEvent(id: string, event: AgentEvent): Promise<void> {
    const run = this.mustGet(id);
    if (run.status === "cancelled") return;
    run.events.push(event);
    run.updatedAt = event.timestamp;
  }

  async complete(id: string, result: AgentRunResult): Promise<void> {
    const run = this.mustGet(id);
    // Terminal results are immutable: only an active run (incl. the
    // waiting_approval pause) may move to completed; a late callback against
    // an already terminal run is a no-op.
    if (!isActiveStatus(run.status)) return;
    run.status = "completed";
    run.result = result;
    run.updatedAt = new Date().toISOString();
  }

  async fail(id: string, error: string): Promise<void> {
    const run = this.mustGet(id);
    if (!isActiveStatus(run.status)) return;
    run.status = "failed";
    run.error = error;
    run.updatedAt = new Date().toISOString();
  }

  async finalizeExternalActionResult(id: string, result: AgentRunResult): Promise<void> {
    const run = this.mustGet(id);
    // Deliberate post-completion external-action write: may overwrite a
    // completed run, but never a cancelled one.
    if (run.status === "cancelled") return;
    run.status = "completed";
    run.result = result;
    run.error = undefined;
    run.updatedAt = new Date().toISOString();
  }

  async cancel(id: string, reason: string): Promise<void> {
    const run = this.mustGet(id);
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return;
    run.status = "cancelled";
    run.error = reason;
    run.updatedAt = new Date().toISOString();
  }

  async recoverInterrupted(
    error: string,
    options: { staleAfterMs?: number } = {},
  ): Promise<number> {
    let recovered = 0;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const threshold = options.staleAfterMs && options.staleAfterMs > 0 ? options.staleAfterMs : 0;

    for (const run of this.runs.values()) {
      if (run.status !== "queued" && run.status !== "running") continue;
      if (threshold > 0) {
        const updated = Date.parse(run.updatedAt);
        if (Number.isFinite(updated) && now - updated < threshold) continue;
      }
      run.status = "failed";
      run.error = error;
      run.updatedAt = nowIso;
      recovered += 1;
    }

    return recovered;
  }

  async deleteByThreadId(threadId: string): Promise<number> {
    let deleted = 0;
    for (const [id, run] of this.runs.entries()) {
      if (run.threadId !== threadId) continue;
      this.runs.delete(id);
      deleted += 1;
    }

    return deleted;
  }

  async delete(id: string): Promise<boolean> {
    return this.runs.delete(id);
  }

  private mustGet(id: string): AgentRunRecord {
    const run = this.runs.get(id);
    if (!run) {
      throw new Error(`Run not found: ${id}`);
    }

    return run;
  }
}

function createRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function cloneRun(run: AgentRunRecord): AgentRunRecord {
  return {
    ...run,
    events: [...run.events],
    result: run.result
      ? {
          ...run.result,
          subtasks: [...run.result.subtasks],
          workerResults: [...run.result.workerResults],
          reviews: [...run.result.reviews],
          actionProposals: run.result.actionProposals
            ? run.result.actionProposals.map((proposal) => ({
                ...proposal,
                allowedWithoutApproval: [...proposal.allowedWithoutApproval],
                prohibitedWithoutApproval: [...proposal.prohibitedWithoutApproval],
                sourceUrls: [...proposal.sourceUrls],
                artifactIds: [...proposal.artifactIds],
                commitExecutor: proposal.commitExecutor
                  ? {
                      ...proposal.commitExecutor,
                      toolInput: proposal.commitExecutor.toolInput
                        ? { ...proposal.commitExecutor.toolInput }
                        : undefined,
                      expectedProof: proposal.commitExecutor.expectedProof
                        ? [...proposal.commitExecutor.expectedProof]
                        : undefined,
                      missing: proposal.commitExecutor.missing
                        ? [...proposal.commitExecutor.missing]
                        : undefined,
                    }
                  : undefined,
              }))
            : undefined,
        }
      : undefined,
  };
}
