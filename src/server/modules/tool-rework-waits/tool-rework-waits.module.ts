import { Module } from "@nestjs/common";
import { ToolReworkWaitsController } from "./tool-rework-waits.controller.js";
import { ToolReworkWaitsService } from "./tool-rework-waits.service.js";

@Module({
  controllers: [ToolReworkWaitsController],
  providers: [ToolReworkWaitsService],
})
export class ToolReworkWaitsModule {}
