import { Module } from "@nestjs/common";
import { SecretsController } from "./secrets.controller.js";
import { SecretsService } from "./secrets.service.js";

@Module({
  controllers: [SecretsController],
  providers: [SecretsService],
})
export class SecretsModule {}
