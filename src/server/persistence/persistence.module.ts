import { Global, Module, Provider } from "@nestjs/common";
import { createPool, type PgPool } from "../../db/pool.js";
import { InMemoryAuditEventStore } from "../../audit/inMemoryAuditEventStore.js";
import { PostgresAuditEventStore } from "../../audit/postgresAuditEventStore.js";
import { InMemoryConversationThreadStore } from "../../conversations/inMemoryConversationThreadStore.js";
import { PostgresConversationThreadStore } from "../../conversations/postgresConversationThreadStore.js";
import { InMemoryGroupProfileStore } from "../../instance/groupProfileStore.js";
import { PostgresGroupProfileStore } from "../../instance/postgresGroupProfileStore.js";
import { InMemoryUserStore } from "../../instance/userStore.js";
import { PostgresUserStore } from "../../instance/postgresUserStore.js";
import { InMemoryRunStore } from "../../runs/inMemoryRunStore.js";
import { PostgresRunStore } from "../../runs/postgresRunStore.js";
import { InMemorySecretHandleStore } from "../../secrets/secretHandleStore.js";
import { PostgresSecretHandleStore } from "../../secrets/postgresSecretHandleStore.js";
import { InMemoryModelTierSettingsStore } from "../../settings/modelTierSettings.js";
import { PostgresModelTierSettingsStore } from "../../settings/postgresModelTierSettings.js";
import { InMemoryModelProviderStore } from "../../settings/modelProviderStore.js";
import { PostgresModelProviderStore } from "../../settings/postgresModelProviderStore.js";
import { InMemoryModelProfileStore } from "../../settings/modelProfileStore.js";
import { PostgresModelProfileStore } from "../../settings/postgresModelProfileStore.js";
import { InMemoryToolRuntimeSettingsStore } from "../../settings/toolRuntimeSettings.js";
import { PostgresToolRuntimeSettingsStore } from "../../settings/postgresToolRuntimeSettings.js";
import { SkillMemory } from "../../memory/skillMemory.js";
import { PostgresSkillMemory } from "../../memory/postgresSkillMemory.js";
import { createTextEmbeddingProviderFromEnv } from "../../memory/textEmbedding.js";
import { LocalJsonToolMetadataStore } from "../../tools/toolMetadataStore.js";
import { PostgresToolMetadataStore } from "../../tools/postgresToolMetadataStore.js";
import { InMemoryToolCreationStore } from "../../tools/toolCreationStore.js";
import { PostgresToolCreationStore } from "../../tools/postgresToolCreationStore.js";
import { InMemoryToolContextStore } from "../../tools/toolContextStore.js";
import { PostgresToolContextStore } from "../../tools/postgresToolContextStore.js";
import { InMemoryToolMigrationStore } from "../../tools/toolMigrationStore.js";
import { PostgresToolMigrationStore } from "../../tools/postgresToolMigrationStore.js";
import { InMemoryToolPromotionStore } from "../../tools/toolPromotionStore.js";
import { PostgresToolPromotionStore } from "../../tools/postgresToolPromotionStore.js";
import { InMemoryToolServiceStatusStore } from "../../tools/toolServiceStatusStore.js";
import { PostgresToolServiceStatusStore } from "../../tools/postgresToolServiceStatusStore.js";
import { InMemoryToolServiceLogStore } from "../../tools/toolServiceLogStore.js";
import { PostgresToolServiceLogStore } from "../../tools/postgresToolServiceLogStore.js";
import { InMemoryToolServiceEventStore } from "../../tools/toolServiceEventStore.js";
import { PostgresToolServiceEventStore } from "../../tools/postgresToolServiceEventStore.js";
import {
  DurableArtifactStore,
  FallbackArtifactStore,
  LocalArtifactStore,
  type ArtifactStore,
} from "../../artifacts/artifactStore.js";
import { PostgresArtifactMetadataStore } from "../../artifacts/postgresArtifactMetadataStore.js";
import { S3ObjectStore, s3ConfigFromEnv } from "../../artifacts/s3ObjectStore.js";
import { APP_ENV } from "../config/config.module.js";
import type { AppEnv } from "../config/env.js";
import { LlmClient, readLlmConfigFromEnv } from "../../llm/client.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createCoreToolbelt } from "../../tools/coreToolbelt.js";
import { createScopedToolDbClient } from "../../tools/toolScopedDb.js";
import type { SecretHandleStore } from "../../secrets/secretHandleStore.js";
import type { ToolMetadataStore } from "../../tools/toolMetadataStore.js";
import { InMemoryWorkLedgerStore } from "../../work-ledger/workLedgerStore.js";
import { PostgresWorkLedgerStore } from "../../work-ledger/postgresWorkLedgerStore.js";
import { InMemoryEvidenceLedgerStore } from "../../work-ledger/evidenceLedgerStore.js";
import { PostgresEvidenceLedgerStore } from "../../work-ledger/postgresEvidenceLedgerStore.js";
import { InMemoryRunRetrospectiveStore } from "../../work-ledger/runRetrospectiveStore.js";
import { PostgresRunRetrospectiveStore } from "../../work-ledger/postgresRunRetrospectiveStore.js";
import {
  ARTIFACT_STORE,
  AUDIT_EVENT_STORE,
  CONVERSATION_STORE,
  EVIDENCE_LEDGER_STORE,
  GROUP_PROFILE_STORE,
  LLM_CLIENT,
  MODEL_PROFILE_STORE,
  MODEL_PROVIDER_STORE,
  MODEL_TIER_SETTINGS,
  PG_POOL,
  RUN_RETROSPECTIVE_STORE,
  RUN_STORE,
  SECRET_HANDLE_STORE,
  SKILL_MEMORY,
  TEXT_EMBEDDING_PROVIDER,
  TOOL_CREATION_STORE,
  TOOL_CONTEXT_STORE,
  TOOL_METADATA_STORE,
  TOOL_MIGRATION_STORE,
  TOOL_PROMOTION_STORE,
  TOOL_REGISTRY,
  TOOL_CALLBACK_TOKEN_ISSUER,
  TOOL_RUNTIME_SETTINGS,
  TOOL_SERVICE_EVENT_STORE,
  TOOL_SERVICE_LOG_STORE,
  TOOL_SERVICE_STATUS_STORE,
  USER_STORE,
  WORK_LEDGER_STORE,
} from "./tokens.js";
import { ToolCallbackTokenIssuer } from "../../tools/toolCallbackToken.js";

const providers: Provider[] = [
  {
    provide: PG_POOL,
    inject: [APP_ENV],
    useFactory: (env: AppEnv): PgPool | undefined => (env.databaseUrl ? createPool(env.databaseUrl) : undefined),
  },
  {
    provide: TEXT_EMBEDDING_PROVIDER,
    useFactory: () => createTextEmbeddingProviderFromEnv(),
  },
  {
    provide: SKILL_MEMORY,
    inject: [PG_POOL, TEXT_EMBEDDING_PROVIDER],
    useFactory: (pool: PgPool | undefined, embedding) =>
      pool ? new PostgresSkillMemory(pool, embedding) : new SkillMemory(),
  },
  {
    provide: AUDIT_EVENT_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresAuditEventStore(pool) : new InMemoryAuditEventStore(),
  },
  {
    provide: CONVERSATION_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresConversationThreadStore(pool) : new InMemoryConversationThreadStore(),
  },
  {
    provide: GROUP_PROFILE_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresGroupProfileStore(pool) : new InMemoryGroupProfileStore(),
  },
  {
    provide: USER_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresUserStore(pool) : new InMemoryUserStore(),
  },
  {
    provide: RUN_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) => (pool ? new PostgresRunStore(pool) : new InMemoryRunStore()),
  },
  {
    provide: SECRET_HANDLE_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresSecretHandleStore(pool) : new InMemorySecretHandleStore(),
  },
  {
    provide: MODEL_TIER_SETTINGS,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresModelTierSettingsStore(pool) : new InMemoryModelTierSettingsStore(),
  },
  {
    provide: MODEL_PROVIDER_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresModelProviderStore(pool) : new InMemoryModelProviderStore(),
  },
  {
    provide: MODEL_PROFILE_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresModelProfileStore(pool) : new InMemoryModelProfileStore(),
  },
  {
    provide: TOOL_RUNTIME_SETTINGS,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresToolRuntimeSettingsStore(pool) : new InMemoryToolRuntimeSettingsStore(),
  },
  {
    provide: TOOL_METADATA_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresToolMetadataStore(pool) : new LocalJsonToolMetadataStore("workspace/tool-metadata.json"),
  },
  {
    provide: TOOL_CREATION_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresToolCreationStore(pool) : new InMemoryToolCreationStore(),
  },
  {
    provide: TOOL_CONTEXT_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresToolContextStore(pool) : new InMemoryToolContextStore(),
  },
  {
    provide: TOOL_MIGRATION_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresToolMigrationStore(pool) : new InMemoryToolMigrationStore(),
  },
  {
    provide: TOOL_PROMOTION_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresToolPromotionStore(pool) : new InMemoryToolPromotionStore(),
  },
  {
    provide: TOOL_SERVICE_STATUS_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresToolServiceStatusStore(pool) : new InMemoryToolServiceStatusStore(),
  },
  {
    provide: TOOL_SERVICE_LOG_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresToolServiceLogStore(pool) : new InMemoryToolServiceLogStore(),
  },
  {
    provide: TOOL_SERVICE_EVENT_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresToolServiceEventStore(pool) : new InMemoryToolServiceEventStore(),
  },
  {
    provide: ARTIFACT_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined): ArtifactStore => {
      const local = new LocalArtifactStore();
      const s3Config = s3ConfigFromEnv();
      if (pool && s3Config) {
        return new FallbackArtifactStore(
          new DurableArtifactStore(new PostgresArtifactMetadataStore(pool), new S3ObjectStore(s3Config)),
          local,
        );
      }
      return local;
    },
  },
  {
    provide: WORK_LEDGER_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresWorkLedgerStore(pool) : new InMemoryWorkLedgerStore(),
  },
  {
    provide: EVIDENCE_LEDGER_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresEvidenceLedgerStore(pool) : new InMemoryEvidenceLedgerStore(),
  },
  {
    provide: RUN_RETROSPECTIVE_STORE,
    inject: [PG_POOL],
    useFactory: (pool: PgPool | undefined) =>
      pool ? new PostgresRunRetrospectiveStore(pool) : new InMemoryRunRetrospectiveStore(),
  },
  // Runtime singletons. The rebuilt product starts from generated/package
  // tools; legacy built-in/reference registrations are opt-in only.
  {
    provide: TOOL_REGISTRY,
    inject: [TOOL_METADATA_STORE, PG_POOL, SECRET_HANDLE_STORE, TOOL_RUNTIME_SETTINGS, APP_ENV],
    useFactory: async (
      metadata: ToolMetadataStore | undefined,
      pool: PgPool | undefined,
      secrets: SecretHandleStore | undefined,
      runtimeSettings: { resolve(toolName: string, key: string): Promise<string | undefined> } | undefined,
      env: import("../config/env.js").AppEnv,
    ) => {
      const registry = new ToolRegistry();
      for (const tool of createCoreToolbelt({ enabled: env.builtinToolsEnabled })) {
        registry.register(tool);
      }
      if (metadata) {
        await metadata.syncBuiltins(registry.list());
        registry.setUsageReporter((event) =>
          metadata.recordUsage(event.toolName, event.outcome, event.at),
        );
      }
      registry.setRuntimeContextProvider(({ tool }) => ({
        db: pool ? createScopedToolDbClient(pool, tool) : undefined,
        resolveSecret: secrets?.resolve ? (handle) => secrets.resolve!(handle) : undefined,
        resolveConfiguration: async (key) =>
          (runtimeSettings ? await runtimeSettings.resolve(tool.name, key) : undefined) ?? process.env[key],
      }));
      return registry;
    },
  },
  {
    provide: LLM_CLIENT,
    inject: [MODEL_TIER_SETTINGS, MODEL_PROFILE_STORE],
    useFactory: (tierSettings, modelProfiles) =>
      new LlmClient(readLlmConfigFromEnv(), tierSettings, modelProfiles),
  },
  {
    provide: TOOL_CALLBACK_TOKEN_ISSUER,
    useFactory: () => new ToolCallbackTokenIssuer(),
  },
];

@Global()
@Module({
  providers,
  exports: providers.map((p) => (p as { provide: string }).provide),
})
export class PersistenceModule {}
