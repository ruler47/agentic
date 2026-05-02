import test from "node:test";
import assert from "node:assert/strict";
import {
  coordinatorSystemPrompt,
  synthesizePrompt,
  workerSystemPrompt,
} from "../src/agents/prompts.js";
import { Subtask, TaskComplexity } from "../src/types.js";

test("agent prompts require self-check before returning results", () => {
  const subtask: Subtask = {
    id: "proof",
    title: "Collect proof artifact",
    role: "researcher",
    prompt: "Create useful proof.",
    expectedOutput: "Evidence and artifact URL.",
    reviewCriteria: ["artifact is relevant"],
  };
  const complexity: TaskComplexity = {
    mode: "delegated",
    reason: "needs evidence",
    domains: ["research"],
    riskLevel: "medium",
  };

  assert.match(coordinatorSystemPrompt, /self-check/i);
  assert.match(workerSystemPrompt(subtask, []), /self-check your own output/i);
  assert.match(workerSystemPrompt(subtask, []), /blank pages, endless loaders, login walls, bot checks/i);
  assert.match(
    synthesizePrompt("task", complexity, [], [], [], []),
    /self-check that the answer and artifacts are actually useful/i,
  );
  assert.match(synthesizePrompt("task", complexity, [], [], [], []), /still loading, blocked, login-only/i);
});
