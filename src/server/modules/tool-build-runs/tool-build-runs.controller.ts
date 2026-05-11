import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
} from "@nestjs/common";
import { RunsService } from "../runs/runs.service.js";

/**
 * Phase 14: REST surface for the tool-build council. POST creates a
 * new "tool-build" run (or a rework run when `existingToolName` is
 * supplied) and immediately starts the council pipeline. GET lists
 * every tool-build run for the operator's "Tool builds" page.
 */
@Controller("api/tool-build-runs")
export class ToolBuildRunsController {
  constructor(@Inject(RunsService) private readonly runs: RunsService) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    return this.runs.createAndStartToolBuild(body);
  }

  @Get()
  async list() {
    return { runs: await this.runs.listToolBuildRuns() };
  }
}
