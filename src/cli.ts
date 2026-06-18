import { BaseAgent } from "./agents/baseAgent.js";
import { LlmClient, readLlmConfigFromEnv } from "./llm/client.js";
import { ToolRegistry } from "./tools/registry.js";

async function main(): Promise<void> {
  const task = process.argv.slice(2).join(" ").trim();

  if (!task) {
    console.error('Usage: npm run dev -- "one concrete task"');
    process.exitCode = 1;
    return;
  }

  const llm = new LlmClient(readLlmConfigFromEnv());
  const registry = new ToolRegistry();
  const agent = new BaseAgent(llm, registry);

  const result = await agent.run(task);

  console.log("\n=== Final Answer ===\n");
  console.log(result.finalAnswer);

  console.log("\n=== Execution Trace ===\n");
  console.log(`Mode: ${result.complexity.mode}`);
  console.log(`Reason: ${result.complexity.reason}`);
  console.log(`Domains: ${result.complexity.domains.join(", ") || "none"}`);
  console.log(`Risk: ${result.complexity.riskLevel}`);

  if (result.subtasks.length > 0) {
    console.log("\nSubtasks:");
    for (const subtask of result.subtasks) {
      console.log(`- [${subtask.id}] ${subtask.title} (${subtask.role})`);
    }
  }

  if (result.reviews.length > 0) {
    console.log("\nReviews:");
    for (const review of result.reviews) {
      console.log(`- [${review.subtaskId}] ${review.verdict}: ${review.notes}`);
    }
  }

  if (result.learnedSkill) {
    console.log(`\nStored skill memory: ${result.learnedSkill.title}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
