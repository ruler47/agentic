import { Module } from "@nestjs/common";
import { ToolsController } from "./tools.controller.js";
import { ToolsService } from "./tools.service.js";

@Module({
  controllers: [ToolsController],
  providers: [ToolsService],
  // Phase 14: export so RunsModule can inject ToolsService for the
  // council adapter's QA runner.
  exports: [ToolsService],
})
export class ToolsModule {}
