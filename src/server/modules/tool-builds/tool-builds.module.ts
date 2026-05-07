import { Module } from "@nestjs/common";
import { ToolBuildsController } from "./tool-builds.controller.js";
import { ToolBuildsService } from "./tool-builds.service.js";

@Module({
  controllers: [ToolBuildsController],
  providers: [ToolBuildsService],
})
export class ToolBuildsModule {}
