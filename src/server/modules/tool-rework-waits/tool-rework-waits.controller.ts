import { Body, Controller, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { ToolReworkWaitsService } from "./tool-rework-waits.service.js";

@Controller("api")
export class ToolReworkWaitsController {
  constructor(private readonly waits: ToolReworkWaitsService) {}

  @Get("tool-rework-waits")
  async list() {
    return { waits: await this.waits.list() };
  }

  @Post("tool-rework-waits")
  @HttpCode(201)
  async create(@Body() body: unknown) {
    return { wait: await this.waits.create(body) };
  }

  @Get("tool-rework-waits/:id")
  async get(@Param("id") id: string) {
    return { wait: await this.waits.get(decodeURIComponent(id)) };
  }

  @Patch("tool-rework-waits/:id")
  async update(@Param("id") id: string, @Body() body: unknown) {
    return { wait: await this.waits.update(decodeURIComponent(id), body) };
  }

  @Post("tool-rework-waits/:id/resume")
  async resume(@Param("id") id: string, @Body() body: unknown) {
    return this.waits.resume(decodeURIComponent(id), body);
  }

  @Post("tool-rework-waits/:id/retry-run")
  async retryRun(@Param("id") id: string, @Body() body: unknown) {
    return this.waits.retryRun(decodeURIComponent(id), body);
  }

  @Post("tool-rework-waits/:id/auto-retry")
  async autoRetry(@Param("id") id: string) {
    return this.waits.autoRetry(decodeURIComponent(id));
  }

  @Get("runs/:runId/tool-rework-waits")
  async listByRun(@Param("runId") runId: string) {
    return { waits: await this.waits.listByRun(decodeURIComponent(runId)) };
  }
}
