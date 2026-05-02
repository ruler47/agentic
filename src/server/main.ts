import { resolve } from "node:path";
import { UniversalAgent } from "../agents/universalAgent.js";
import { createPool } from "../db/pool.js";
import { LlmClient, readLlmConfigFromEnv } from "../llm/client.js";
import { SkillMemory } from "../memory/skillMemory.js";
import { PostgresSkillMemory } from "../memory/postgresSkillMemory.js";
import { InMemoryRunStore } from "../runs/inMemoryRunStore.js";
import { PostgresRunStore } from "../runs/postgresRunStore.js";
import { InMemoryModelTierSettingsStore } from "../settings/modelTierSettings.js";
import { PostgresModelTierSettingsStore } from "../settings/postgresModelTierSettings.js";
import { createWebApp } from "./http.js";
import { ToolRegistry } from "../tools/registry.js";
import { FileReadTool, FileWriteTool } from "../tools/fileTools.js";
import { WebSearchTool } from "../tools/webSearchTool.js";
import { LocalArtifactStore } from "../artifacts/artifactStore.js";
import { ChartGenerateTool } from "../tools/chartGenerateTool.js";
import { BrowserOperateTool } from "../tools/browserOperateTool.js";
import { InMemoryToolMetadataStore } from "../tools/toolMetadataStore.js";
import { PostgresToolMetadataStore } from "../tools/postgresToolMetadataStore.js";
import { InMemoryToolBuildRequestStore } from "../tools/toolBuildRequestStore.js";
import { PostgresToolBuildRequestStore } from "../tools/postgresToolBuildRequestStore.js";
import { loadGeneratedTools } from "../tools/generatedToolLoader.js";
import { ToolBuildWorkflow } from "../tools/toolBuildWorkflow.js";
import {
  BrowserScreenshotToolBuildProvider,
  CommandToolQaRunner,
  GeneratedToolFileBuilder,
  MetadataToolRegistrar,
} from "../tools/toolBuildProviders.js";

const port = Number(process.env.PORT ?? "3000");
const publicDir = resolve("public");
const pool = process.env.DATABASE_URL ? createPool() : undefined;
const skillMemory = pool ? new PostgresSkillMemory(pool) : new SkillMemory();
const tools = new ToolRegistry();
tools.register(new WebSearchTool());
tools.register(new FileReadTool());
tools.register(new FileWriteTool());
tools.register(new ChartGenerateTool());
tools.register(new BrowserOperateTool());
const toolMetadataStore = pool
  ? new PostgresToolMetadataStore(pool)
  : new InMemoryToolMetadataStore();
await toolMetadataStore.syncBuiltins(tools.list());
const toolBuildRequestStore = pool
  ? new PostgresToolBuildRequestStore(pool)
  : new InMemoryToolBuildRequestStore();
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
const runStore = process.env.DATABASE_URL
  ? new PostgresRunStore(pool ?? createPool())
  : new InMemoryRunStore();
const modelTierSettings = pool
  ? new PostgresModelTierSettingsStore(pool)
  : new InMemoryModelTierSettingsStore();
const artifactStore = new LocalArtifactStore();
const agent = new UniversalAgent(
  new LlmClient(readLlmConfigFromEnv(), modelTierSettings),
  skillMemory,
  tools,
);
const server = createWebApp({
  agent,
  runStore,
  publicDir,
  skillMemory,
  toolRegistry: tools,
  toolMetadataStore,
  toolBuildRequestStore,
  toolBuildWorkflow,
  reloadGeneratedTools,
  modelTierSettings,
  artifactStore,
});

const recoveredRuns = await runStore.recoverInterrupted(
  "Run was interrupted by an application restart before it could finish.",
);
if (recoveredRuns > 0) {
  console.log(`Recovered ${recoveredRuns} interrupted run(s).`);
}

server.listen(port, () => {
  console.log(`Agentic web console is running at http://127.0.0.1:${port}`);
});
