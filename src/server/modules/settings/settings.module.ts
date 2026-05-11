import { Module } from "@nestjs/common";
import { CodingCouncilController } from "./coding-council.controller.js";

/**
 * Phase 14: settings module for instance-level configuration that is
 * neither tool-runtime overrides nor model-tier choices. Currently
 * hosts the coding-council settings; future settings sections plug
 * into the same module.
 */
@Module({
  controllers: [CodingCouncilController],
})
export class SettingsModule {}
