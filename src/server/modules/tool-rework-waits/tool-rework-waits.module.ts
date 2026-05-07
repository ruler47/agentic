import { Module } from "@nestjs/common";
import { RunsModule } from "../runs/runs.module.js";
import { ToolReworkWaitsController } from "./tool-rework-waits.controller.js";
import { ToolReworkWaitsService } from "./tool-rework-waits.service.js";

@Module({
  imports: [RunsModule],
  controllers: [ToolReworkWaitsController],
  providers: [ToolReworkWaitsService],
})
export class ToolReworkWaitsModule {}
