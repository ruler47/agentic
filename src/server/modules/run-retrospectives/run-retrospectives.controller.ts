import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { RunRetrospectivesService } from "./run-retrospectives.service.js";

@Controller("api/run-retrospectives")
export class RunRetrospectivesController {
  constructor(@Inject(RunRetrospectivesService) private readonly service: RunRetrospectivesService) {}

  @Get()
  async list(@Query("runId") runId?: string, @Query("threadId") threadId?: string) {
    return { records: await this.service.list({ runId, threadId }) };
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    return { record: await this.service.create(body) };
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: unknown) {
    return { record: await this.service.update(decodeURIComponent(id), body) };
  }
}
