import { Module } from "@nestjs/common";
import { CommonModule } from "./common/common.module.js";
import { ConfigModule } from "./config/config.module.js";
import { AuditModule } from "./modules/audit/audit.module.js";
import { ConversationsModule } from "./modules/conversations/conversations.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { MemoryModule } from "./modules/memory/memory.module.js";
import { ModelsModule } from "./modules/models/models.module.js";
import { SecretsModule } from "./modules/secrets/secrets.module.js";
import { UsersModule } from "./modules/users/users.module.js";
import { PersistenceModule } from "./persistence/persistence.module.js";

@Module({
  imports: [
    ConfigModule,
    PersistenceModule,
    CommonModule,
    HealthModule,
    UsersModule,
    ConversationsModule,
    AuditModule,
    MemoryModule,
    SecretsModule,
    ModelsModule,
  ],
})
export class AppModule {}
