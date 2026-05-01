import { AgentEvent, AgentRunResult } from "../types.js";
import { AgentRunRecord, RunStore } from "./types.js";

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, AgentRunRecord>();

  async create(task: string): Promise<AgentRunRecord> {
    const now = new Date().toISOString();
    const run: AgentRunRecord = {
      id: createRunId(),
      task,
      status: "queued",
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

  async get(id: string): Promise<AgentRunRecord | undefined> {
    const run = this.runs.get(id);
    return run ? cloneRun(run) : undefined;
  }

  async markRunning(id: string): Promise<void> {
    const run = this.mustGet(id);
    run.status = "running";
    run.updatedAt = new Date().toISOString();
  }

  async appendEvent(id: string, event: AgentEvent): Promise<void> {
    const run = this.mustGet(id);
    run.events.push(event);
    run.updatedAt = event.timestamp;
  }

  async complete(id: string, result: AgentRunResult): Promise<void> {
    const run = this.mustGet(id);
    run.status = "completed";
    run.result = result;
    run.updatedAt = new Date().toISOString();
  }

  async fail(id: string, error: string): Promise<void> {
    const run = this.mustGet(id);
    run.status = "failed";
    run.error = error;
    run.updatedAt = new Date().toISOString();
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
        }
      : undefined,
  };
}
