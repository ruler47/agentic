import { Module } from "@nestjs/common";
import { ToolMigrationsController } from "./tool-migrations.controller.js";
import { ToolMigrationsService } from "./tool-migrations.service.js";

@Module({
  controllers: [ToolMigrationsController],
  providers: [ToolMigrationsService],
})
export class ToolMigrationsModule {}
