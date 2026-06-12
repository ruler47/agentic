import { Module } from "@nestjs/common";
import { ToolManualRunService } from "./tool-manual-run.service.js";
import { ToolRegistryAdminService } from "./tool-registry-admin.service.js";
import { ToolSettingsService } from "./tool-settings.service.js";
import { ToolVersionLifecycleService } from "./tool-version-lifecycle.service.js";
import { ToolsController } from "./tools.controller.js";
import { ToolsService } from "./tools.service.js";

@Module({
  controllers: [ToolsController],
  providers: [
    ToolsService,
    ToolManualRunService,
    ToolRegistryAdminService,
    ToolSettingsService,
    ToolVersionLifecycleService,
  ],
  // Phase 14: export so RunsModule can inject ToolsService for the
  // council adapter's QA runner.
  exports: [
    ToolsService,
    ToolManualRunService,
    ToolRegistryAdminService,
    ToolSettingsService,
    ToolVersionLifecycleService,
  ],
})
export class ToolsModule {}
