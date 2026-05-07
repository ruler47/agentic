import { Module } from "@nestjs/common";
import { RunsModule } from "../runs/runs.module.js";
import { ToolServicesController } from "./tool-services.controller.js";
import { ToolServicesService } from "./tool-services.service.js";

@Module({
  imports: [RunsModule],
  controllers: [ToolServicesController],
  providers: [ToolServicesService],
})
export class ToolServicesModule {}
