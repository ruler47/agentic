import { Module } from "@nestjs/common";
import { GroupProfileController } from "./group-profile.controller.js";
import { GroupProfileService } from "./group-profile.service.js";
import { HealthController } from "./health.controller.js";

@Module({
  controllers: [HealthController, GroupProfileController],
  providers: [GroupProfileService],
})
export class HealthModule {}
