import { resolve } from "node:path";
import { UniversalAgent } from "../agents/universalAgent.js";
import { InMemoryAuditEventStore } from "../audit/inMemoryAuditEventStore.js";
import { PostgresAuditEventStore } from "../audit/postgresAuditEventStore.js";
import { InMemoryConversationThreadStore } from "../conversations/inMemoryConversationThreadStore.js";
import { PostgresConversationThreadStore } from "../conversations/postgresConversationThreadStore.js";
import { createPool } from "../db/pool.js";
import { LlmClient, readLlmConfigFromEnv } from "../llm/client.js";
import { InMemoryGroupProfileStore } from "../instance/groupProfileStore.js";
import { PostgresGroupProfileStore } from "../instance/postgresGroupProfileStore.js";
import { InMemoryUserStore } from "../instance/userStore.js";
import { PostgresUserStore } from "../instance/postgresUserStore.js";
import { SkillMemory } from "../memory/skillMemory.js";
import { PostgresSkillMemory } from "../memory/postgresSkillMemory.js";
import { createTextEmbeddingProviderFromEnv } from "../memory/textEmbedding.js";
import { InMemoryRunStore } from "../runs/inMemoryRunStore.js";
import { PostgresRunStore } from "../runs/postgresRunStore.js";
import { InMemorySecretHandleStore } from "../secrets/secretHandleStore.js";
import { PostgresSecretHandleStore } from "../secrets/postgresSecretHandleStore.js";
import { InMemoryModelTierSettingsStore } from "../settings/modelTierSettings.js";
import { PostgresModelTierSettingsStore } from "../settings/postgresModelTierSettings.js";
import { createWebApp } from "./http.js";
import { ToolRegistry } from "../tools/registry.js";
import { FileReadTool, FileWriteTool } from "../tools/fileTools.js";
import { WebSearchTool } from "../tools/webSearchTool.js";
import { DurableArtifactStore, FallbackArtifactStore, LocalArtifactStore } from "../artifacts/artifactStore.js";
import { PostgresArtifactMetadataStore } from "../artifacts/postgresArtifactMetadataStore.js";
import { S3ObjectStore, s3ConfigFromEnv } from "../artifacts/s3ObjectStore.js";
import { ChartGenerateTool } from "../tools/chartGenerateTool.js";
import { MarketTimeseriesTool } from "../tools/marketTimeseriesTool.js";
import { BrowserOperateTool } from "../tools/browserOperateTool.js";
import { InMemoryToolMetadataStore } from "../tools/toolMetadataStore.js";
import { PostgresToolMetadataStore } from "../tools/postgresToolMetadataStore.js";
import { InMemoryToolBuildRequestStore } from "../tools/toolBuildRequestStore.js";
import { PostgresToolBuildRequestStore } from "../tools/postgresToolBuildRequestStore.js";
import { InMemoryToolMigrationStore } from "../tools/toolMigrationStore.js";
import { PostgresToolMigrationStore } from "../tools/postgresToolMigrationStore.js";
import { loadGeneratedTools } from "../tools/generatedToolLoader.js";
import { ToolBuildWorkflow } from "../tools/toolBuildWorkflow.js";
import { ToolBuildWorker } from "../tools/toolBuildWorker.js";
import {
  BrowserScreenshotToolBuildProvider,
  CommandToolQaRunner,
  GeneratedToolFileBuilder,
  MetadataToolRegistrar,
} from "../tools/toolBuildProviders.js";

const port = Number(process.env.PORT ?? "3000");
const publicDir = resolve("public");
const pool = process.env.DATABASE_URL ? createPool() : undefined;
const textEmbeddingProvider = createTextEmbeddingProviderFromEnv();
const skillMemory = pool ? new PostgresSkillMemory(pool, textEmbeddingProvider) : new SkillMemory();
console.log(`Memory embedding provider: ${textEmbeddingProvider.name} (${textEmbeddingProvider.dimensions}d).`);
const tools = new ToolRegistry();
tools.register(new WebSearchTool());
tools.register(new FileReadTool());
tools.register(new FileWriteTool());
tools.register(new ChartGenerateTool());
tools.register(new MarketTimeseriesTool());
tools.register(new BrowserOperateTool());
const toolMetadataStore = pool
  ? new PostgresToolMetadataStore(pool)
  : new InMemoryToolMetadataStore();
await toolMetadataStore.syncBuiltins(tools.list());
tools.setUsageReporter((event) =>
  toolMetadataStore.recordUsage(event.toolName, event.outcome, event.at),
);
const toolBuildRequestStore = pool
  ? new PostgresToolBuildRequestStore(pool)
  : new InMemoryToolBuildRequestStore();
const toolMigrationStore = pool
  ? new PostgresToolMigrationStore(pool)
  : new InMemoryToolMigrationStore();
const generatedToolResults = await loadGeneratedTools(tools, toolMetadataStore);
const loadedGeneratedTools = generatedToolResults.filter((result) => result.loaded);
if (loadedGeneratedTools.length > 0) {
  console.log(`Loaded ${loadedGeneratedTools.length} generated tool(s).`);
}
const reloadGeneratedTools = async () => {
  const results = await loadGeneratedTools(tools, toolMetadataStore);
  const loaded = results.filter((result) => result.loaded);
  if (loaded.length > 0) {
    console.log(`Reloaded ${loaded.length} generated tool(s).`);
  }
};
const toolBuildWorkflow = new ToolBuildWorkflow(
  toolBuildRequestStore,
  new GeneratedToolFileBuilder([new BrowserScreenshotToolBuildProvider()]),
  new CommandToolQaRunner(),
  new MetadataToolRegistrar(toolMetadataStore),
);
const toolBuildWorker = new ToolBuildWorker(toolBuildWorkflow, toolBuildRequestStore, {
  intervalMs: Number(process.env.TOOL_BUILD_WORKER_INTERVAL_MS ?? "15000"),
  batchSize: Number(process.env.TOOL_BUILD_WORKER_BATCH_SIZE ?? "1"),
  reloadGeneratedTools,
  onEvent(event) {
    if (event.type === "idle") return;
    console.log(
      [
        `Tool Builder worker ${event.type}`,
        event.requestId ? `request=${event.requestId}` : undefined,
        event.status ? `status=${event.status}` : undefined,
        event.detail,
      ]
        .filter(Boolean)
        .join(" "),
    );
  },
});
const runStore = process.env.DATABASE_URL
  ? new PostgresRunStore(pool ?? createPool())
  : new InMemoryRunStore();
const conversationStore = pool
  ? new PostgresConversationThreadStore(pool)
  : new InMemoryConversationThreadStore();
const modelTierSettings = pool
  ? new PostgresModelTierSettingsStore(pool)
  : new InMemoryModelTierSettingsStore();
const auditEventStore = pool ? new PostgresAuditEventStore(pool) : new InMemoryAuditEventStore();
const groupProfileStore = pool ? new PostgresGroupProfileStore(pool) : new InMemoryGroupProfileStore();
const userStore = pool ? new PostgresUserStore(pool) : new InMemoryUserStore();
const secretHandleStore = pool ? new PostgresSecretHandleStore(pool) : new InMemorySecretHandleStore();
const localArtifactStore = new LocalArtifactStore();
const s3Config = s3ConfigFromEnv();
const artifactStore =
  pool && s3Config
    ? new FallbackArtifactStore(
        new DurableArtifactStore(new PostgresArtifactMetadataStore(pool), new S3ObjectStore(s3Config)),
        localArtifactStore,
      )
    : localArtifactStore;
const agent = new UniversalAgent(
  new LlmClient(readLlmConfigFromEnv(), modelTierSettings),
  skillMemory,
  tools,
);
const server = createWebApp({
  agent,
  runStore,
  conversationStore,
  publicDir,
  skillMemory,
  toolRegistry: tools,
  toolMetadataStore,
  toolMigrationStore,
  toolBuildRequestStore,
  toolBuildWorkflow,
  reloadGeneratedTools,
  modelTierSettings,
  artifactStore,
  auditEventStore,
  groupProfileStore,
  userStore,
  secretHandleStore,
});

const recoveredRuns = await runStore.recoverInterrupted(
  "Run was interrupted by an application restart before it could finish.",
);
if (recoveredRuns > 0) {
  console.log(`Recovered ${recoveredRuns} interrupted run(s).`);
}

server.listen(port, () => {
  console.log(`Agentic web console is running at http://127.0.0.1:${port}`);
  if (process.env.TOOL_BUILD_WORKER !== "disabled") {
    toolBuildWorker.start();
    console.log("Background Tool Builder worker is enabled.");
  }
});

server.on("close", () => {
  toolBuildWorker.stop();
});
