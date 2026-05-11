import { Module } from "@nestjs/common";
import { RunsModule } from "../runs/runs.module.js";
import { ToolBuildRunsController } from "./tool-build-runs.controller.js";

@Module({
  imports: [RunsModule],
  controllers: [ToolBuildRunsController],
})
export class ToolBuildRunsModule {}
