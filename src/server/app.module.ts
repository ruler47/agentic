import { resolve } from "node:path";
import { Module } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";
import { CommonModule } from "./common/common.module.js";
import { ConfigModule } from "./config/config.module.js";
import { AuditModule } from "./modules/audit/audit.module.js";
import { ConversationsModule } from "./modules/conversations/conversations.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { MemoryModule } from "./modules/memory/memory.module.js";
import { ModelsModule } from "./modules/models/models.module.js";
import { SecretsModule } from "./modules/secrets/secrets.module.js";
import { RunsModule } from "./modules/runs/runs.module.js";
import { ToolBuildsModule } from "./modules/tool-builds/tool-builds.module.js";
import { ToolInvestigationsModule } from "./modules/tool-investigations/tool-investigations.module.js";
import { ToolMigrationsModule } from "./modules/tool-migrations/tool-migrations.module.js";
import { ToolReworkWaitsModule } from "./modules/tool-rework-waits/tool-rework-waits.module.js";
import { ToolServicesModule } from "./modules/tool-services/tool-services.module.js";
import { ToolsModule } from "./modules/tools/tools.module.js";
import { UsersModule } from "./modules/users/users.module.js";
import { PersistenceModule } from "./persistence/persistence.module.js";
import { RuntimeWorkersModule } from "./workers/runtime-workers.module.js";

@Module({
  imports: [
    ConfigModule,
    PersistenceModule,
    RuntimeWorkersModule,
    CommonModule,
    HealthModule,
    UsersModule,
    ConversationsModule,
    AuditModule,
    MemoryModule,
    SecretsModule,
    ModelsModule,
    ToolsModule,
    ToolBuildsModule,
    ToolInvestigationsModule,
    ToolReworkWaitsModule,
    ToolMigrationsModule,
    RunsModule,
    ToolServicesModule,
    ServeStaticModule.forRoot({
      rootPath: resolve(process.env.PUBLIC_DIR ?? "public"),
      serveRoot: "/",
      exclude: ["/api/(.*)"],
      serveStaticOptions: { cacheControl: false },
    }),
  ],
})
export class AppModule {}
