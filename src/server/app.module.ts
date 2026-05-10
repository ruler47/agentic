import { resolve } from "node:path";
import { Module } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";
import { CommonModule } from "./common/common.module.js";
import { ConfigModule } from "./config/config.module.js";
import { AuditModule } from "./modules/audit/audit.module.js";
import { ConversationsModule } from "./modules/conversations/conversations.module.js";
import { SpaModule } from "./modules/spa/spa.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { MemoryModule } from "./modules/memory/memory.module.js";
import { ModelsModule } from "./modules/models/models.module.js";
import { SecretsModule } from "./modules/secrets/secrets.module.js";
import { EvidenceLedgerModule } from "./modules/evidence-ledger/evidence-ledger.module.js";
import { RunRetrospectivesModule } from "./modules/run-retrospectives/run-retrospectives.module.js";
import { RunsModule } from "./modules/runs/runs.module.js";
import { ToolBuildsModule } from "./modules/tool-builds/tool-builds.module.js";
import { ToolCallbacksModule } from "./modules/tool-callbacks/tool-callbacks.module.js";
import { WorkLedgerModule } from "./modules/work-ledger/work-ledger.module.js";
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
    ToolCallbacksModule,
    ToolInvestigationsModule,
    ToolReworkWaitsModule,
    ToolMigrationsModule,
    RunsModule,
    ToolServicesModule,
    WorkLedgerModule,
    EvidenceLedgerModule,
    RunRetrospectivesModule,
    ServeStaticModule.forRoot({
      rootPath: resolve(process.env.PUBLIC_DIR ?? "public"),
      serveRoot: "/",
      exclude: ["/api/{*any}"],
      // Phase 13 follow-up (Bug D): `fallthrough: true` is critical —
      // without it, serve-static answers a request for an unknown path
      // (e.g. /tools) with its own 404 instead of calling next(), and
      // the SPA-fallback middleware never gets a chance to return
      // index.html. With fallthrough, the static layer only handles
      // real files; unknown paths flow on to the next middleware.
      serveStaticOptions: { cacheControl: false, fallthrough: true },
    }),
    // Phase 13 follow-up: SPA fallback. Nest middleware mounted via
    // MiddlewareConsumer so it runs AFTER ServeStaticModule's static
    // layer but BEFORE controller routing — the only place where an
    // unknown non-API HTML request can be turned into the SPA shell
    // without breaking /assets/*.js or /api/*.
    SpaModule,
  ],
})
export class AppModule {}
