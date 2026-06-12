import { Module } from "@nestjs/common";
import { ToolsModule } from "../tools/tools.module.js";
import { ActionProposalsService } from "./action-proposals.service.js";
import { ActionProposalAutoModeService } from "./action-proposal-auto-mode.service.js";
import { ExternalActionFixturesController } from "./external-action-fixtures.controller.js";
import { RunsController } from "./runs.controller.js";
import { RunsService } from "./runs.service.js";

@Module({
  imports: [ToolsModule],
  controllers: [RunsController, ExternalActionFixturesController],
  providers: [RunsService, ActionProposalsService, ActionProposalAutoModeService],
  exports: [RunsService, ActionProposalsService, ActionProposalAutoModeService],
})
export class RunsModule {}
