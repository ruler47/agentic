import { Module } from "@nestjs/common";
import { RunsController } from "./runs.controller.js";
import { RunsService } from "./runs.service.js";
import { ToolsModule } from "../tools/tools.module.js";

@Module({
  // Phase 14: ToolsModule provides ToolsService — needed by the
  // council adapter's QA runner.
  imports: [ToolsModule],
  controllers: [RunsController],
  providers: [RunsService],
  exports: [RunsService],
})
export class RunsModule {}
