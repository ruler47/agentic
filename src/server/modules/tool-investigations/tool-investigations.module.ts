import { Module } from "@nestjs/common";
import { ToolInvestigationsController } from "./tool-investigations.controller.js";
import { ToolInvestigationsService } from "./tool-investigations.service.js";

@Module({
  controllers: [ToolInvestigationsController],
  providers: [ToolInvestigationsService],
})
export class ToolInvestigationsModule {}
