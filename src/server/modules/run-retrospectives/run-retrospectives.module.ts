import { Module } from "@nestjs/common";
import { RunRetrospectivesController } from "./run-retrospectives.controller.js";
import { RunRetrospectivesService } from "./run-retrospectives.service.js";

@Module({
  controllers: [RunRetrospectivesController],
  providers: [RunRetrospectivesService],
})
export class RunRetrospectivesModule {}
