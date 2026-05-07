import { Global, Module } from "@nestjs/common";
import { AuditService } from "./services/audit.service.js";
import { ToolBuildInputFinalizerService } from "./services/tool-build-input-finalizer.service.js";
import { ToolReworkCoordinatorService } from "./services/tool-rework-coordinator.service.js";

@Global()
@Module({
  providers: [AuditService, ToolBuildInputFinalizerService, ToolReworkCoordinatorService],
  exports: [AuditService, ToolBuildInputFinalizerService, ToolReworkCoordinatorService],
})
export class CommonModule {}
