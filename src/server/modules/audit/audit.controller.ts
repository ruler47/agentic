import { Controller, Get, Inject, Query } from "@nestjs/common";
import type { AuditEventStore } from "../../../audit/types.js";
import { AUDIT_EVENT_STORE } from "../../persistence/tokens.js";

@Controller("api/audit-events")
export class AuditController {
  constructor(@Inject(AUDIT_EVENT_STORE) private readonly store: AuditEventStore | undefined) {}

  @Get()
  async list(@Query("limit") limit?: string) {
    const parsedLimit = Number(limit ?? "100");
    return {
      events: this.store ? await this.store.list(Number.isFinite(parsedLimit) ? parsedLimit : 100) : [],
    };
  }
}
