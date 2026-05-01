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
import { WebSearchTool } from "../tools/webSearchTool.js";

const port = Number(process.env.PORT ?? "3000");
const publicDir = resolve("public");
const pool = process.env.DATABASE_URL ? createPool() : undefined;
const skillMemory = pool ? new PostgresSkillMemory(pool) : new SkillMemory();
const tools = new ToolRegistry();
tools.register(new WebSearchTool());
const runStore = process.env.DATABASE_URL
  ? new PostgresRunStore(pool ?? createPool())
  : new InMemoryRunStore();
const modelTierSettings = pool
  ? new PostgresModelTierSettingsStore(pool)
  : new InMemoryModelTierSettingsStore();
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
  modelTierSettings,
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
