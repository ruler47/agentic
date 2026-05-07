import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { WorkLedgerService } from "./work-ledger.service.js";

@Controller("api/work-ledger")
export class WorkLedgerController {
  constructor(private readonly service: WorkLedgerService) {}

  @Get()
  async list(
    @Query("threadId") threadId?: string,
    @Query("runId") runId?: string,
    @Query("workKey") workKey?: string,
  ) {
    return { items: await this.service.list({ threadId, runId, workKey }) };
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    return { item: await this.service.create(body) };
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: unknown) {
    return { item: await this.service.update(decodeURIComponent(id), body) };
  }

  @Post(":id/evidence")
  async appendEvidence(@Param("id") id: string, @Body() body: unknown) {
    return { item: await this.service.appendEvidence(decodeURIComponent(id), body) };
  }

  @Post(":id/artifacts")
  async appendArtifact(@Param("id") id: string, @Body() body: unknown) {
    return { item: await this.service.appendArtifact(decodeURIComponent(id), body) };
  }
}
