import test from "node:test";
import assert from "node:assert/strict";
import { planPrompt } from "../src/agents/prompts.js";

test("planPrompt teaches agents to use visible browser operations and external action boundaries", () => {
  const prompt = planPrompt(
    "Find a barber and book an appointment after approval.",
    { mode: "delegated", reason: "external action", domains: ["booking"], riskLevel: "medium" },
    [],
    [
      {
        name: "browser.operate",
        version: "1.0.0",
        description: "Runs browser commands.",
        capabilities: ["browser-operate"],
      },
      {
        name: "external.action.prepare",
        version: "1.0.0",
        description: "Prepares external action drafts.",
        capabilities: ["external-action-prepare"],
      },
      {
        name: "external.action.commit",
        version: "1.0.0",
        description: "Commits approved external actions.",
        capabilities: ["external-action-commit"],
      },
    ],
  );

  assert.match(prompt, /observe/);
  assert.match(prompt, /clickVisible/);
  assert.match(prompt, /embedded frames/);
  assert.match(prompt, /external\.action\.prepare/);
  assert.match(prompt, /external\.action\.commit/);
  assert.match(prompt, /Never hide a real external submit inside browser\.operate/);
});
