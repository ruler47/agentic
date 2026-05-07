import { Body, Controller, Get, HttpCode, Inject, Post, Query } from "@nestjs/common";
import { EvidenceLedgerService } from "./evidence-ledger.service.js";

@Controller("api/evidence-ledger")
export class EvidenceLedgerController {
  constructor(@Inject(EvidenceLedgerService) private readonly service: EvidenceLedgerService) {}

  @Get()
  async list(
    @Query("threadId") threadId?: string,
    @Query("runId") runId?: string,
    @Query("workItemId") workItemId?: string,
    @Query("artifactId") artifactId?: string,
    @Query("sourceUrl") sourceUrl?: string,
  ) {
    return {
      records: await this.service.list({ threadId, runId, workItemId, artifactId, sourceUrl }),
    };
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    return { record: await this.service.create(body) };
  }
}
