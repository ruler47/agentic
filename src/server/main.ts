import { resolve } from "node:path";
import { UniversalAgent } from "../agents/universalAgent.js";
import { createPool } from "../db/pool.js";
import { LlmClient, readLlmConfigFromEnv } from "../llm/client.js";
import { SkillMemory } from "../memory/skillMemory.js";
import { InMemoryRunStore } from "../runs/inMemoryRunStore.js";
import { PostgresRunStore } from "../runs/postgresRunStore.js";
import { createWebApp } from "./http.js";

const port = Number(process.env.PORT ?? "3000");
const publicDir = resolve("public");
const agent = new UniversalAgent(new LlmClient(readLlmConfigFromEnv()), new SkillMemory());
const runStore = process.env.DATABASE_URL
  ? new PostgresRunStore(createPool())
  : new InMemoryRunStore();
const server = createWebApp({ agent, runStore, publicDir });

server.listen(port, () => {
  console.log(`Agentic web console is running at http://127.0.0.1:${port}`);
});
