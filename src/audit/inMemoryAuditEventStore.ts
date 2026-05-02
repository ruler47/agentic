import { AuditEventInput, AuditEventRecord, AuditEventStore } from "./types.js";

export class InMemoryAuditEventStore implements AuditEventStore {
  private readonly events: AuditEventRecord[] = [];

  async record(input: AuditEventInput): Promise<AuditEventRecord> {
    const event: AuditEventRecord = {
      ...input,
      id: createAuditEventId(),
      instanceId: input.instanceId ?? "instance-local",
      actorId: input.actorId ?? input.requesterUserId ?? "system",
      actorType: input.actorType ?? "system",
      status: input.status ?? "success",
      createdAt: new Date().toISOString(),
      metadata: input.metadata ? structuredClone(input.metadata) : undefined,
    };

    this.events.unshift(event);
    return cloneEvent(event);
  }

  async list(limit = 100): Promise<AuditEventRecord[]> {
    return this.events.slice(0, limit).map(cloneEvent);
  }
}

function createAuditEventId(): string {
  return `audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function cloneEvent(event: AuditEventRecord): AuditEventRecord {
  return {
    ...event,
    metadata: event.metadata ? structuredClone(event.metadata) : undefined,
  };
}
