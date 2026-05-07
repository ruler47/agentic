import { Module } from "@nestjs/common";
import { CommonModule } from "./common/common.module.js";
import { ConfigModule } from "./config/config.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { PersistenceModule } from "./persistence/persistence.module.js";

@Module({
  imports: [ConfigModule, PersistenceModule, CommonModule, HealthModule],
})
export class AppModule {}
