import { Inject, Injectable } from "@nestjs/common";
import type { AuditEventInput, AuditEventRecord, AuditEventStore } from "../../../audit/types.js";
import { AUDIT_EVENT_STORE } from "../../persistence/tokens.js";

@Injectable()
export class AuditService {
  constructor(@Inject(AUDIT_EVENT_STORE) private readonly store: AuditEventStore) {}

  async record(input: AuditEventInput): Promise<void> {
    if (!this.store) return;
    await this.store.record(input);
  }

  async list(limit = 100): Promise<AuditEventRecord[]> {
    if (!this.store) return [];
    return this.store.list(limit);
  }
}
