import { resolve } from "node:path";
import { UniversalAgent } from "../agents/universalAgent.js";
import { createPool } from "../db/pool.js";
import { LlmClient, readLlmConfigFromEnv } from "../llm/client.js";
import { SkillMemory } from "../memory/skillMemory.js";
import { PostgresSkillMemory } from "../memory/postgresSkillMemory.js";
import { InMemoryRunStore } from "../runs/inMemoryRunStore.js";
import { PostgresRunStore } from "../runs/postgresRunStore.js";
import { createWebApp } from "./http.js";
import { ToolRegistry } from "../tools/registry.js";
import { WebSearchTool } from "../tools/webSearchTool.js";

const port = Number(process.env.PORT ?? "3000");
const publicDir = resolve("public");
const pool = process.env.DATABASE_URL ? createPool() : undefined;
const skillMemory = pool ? new PostgresSkillMemory(pool) : new SkillMemory();
const tools = new ToolRegistry();
tools.register(new WebSearchTool());
const agent = new UniversalAgent(new LlmClient(readLlmConfigFromEnv()), skillMemory, tools);
const runStore = process.env.DATABASE_URL
  ? new PostgresRunStore(pool ?? createPool())
  : new InMemoryRunStore();
const server = createWebApp({ agent, runStore, publicDir, skillMemory, toolRegistry: tools });

server.listen(port, () => {
  console.log(`Agentic web console is running at http://127.0.0.1:${port}`);
});
