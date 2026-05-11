import test from "node:test";
import assert from "node:assert/strict";
import {
  brainstormPrompt,
  votePrompt,
  implementPrompt,
  reviewPrompt,
  revisePrompt,
  qaOraclePrompt,
  repairPrompt,
  type CouncilProposal,
  type ToolBuildContext,
} from "../src/agents/toolBuildCouncil.js";

const ctx: ToolBuildContext = {
  name: "weather.openmeteo",
  description: "Return hourly forecast for a city using open-meteo.",
  secretHandle: undefined,
  qaCriteria: [
    "returns 24 hourly entries for tomorrow",
    "graceful failure when the city is unknown",
  ],
};

const winner: CouncilProposal = {
  modelId: "model-A",
  content: "Architecture: ... Packages: axios. Risk: rate limits.",
  packageList: ["axios"],
  externalDependencies: ["api.open-meteo.com"],
};

test("brainstormPrompt embeds name, description, criteria, council size", () => {
  const msgs = brainstormPrompt(ctx, 3);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "system");
  const user = msgs[1].content;
  assert.match(user, /weather\.openmeteo/);
  assert.match(user, /open-meteo/);
  assert.match(user, /returns 24 hourly/);
  assert.match(user, /one of 3 peer proposals/);
  assert.match(user, /"packages"/, "must mention the closing JSON line");
  // Complexity-scaling: prompt must teach the model to bucket the task
  // so we stop seeing full architecture proposals for one-line fixes.
  assert.match(user, /Complexity: TRIVIAL/);
  assert.match(user, /Complexity: BUG/);
  assert.match(user, /Complexity: NEW/);
});

test("brainstormPrompt honours system-prompt override", () => {
  const msgs = brainstormPrompt(ctx, 2, "CUSTOM ROLE PROMPT");
  assert.equal(msgs[0].content, "CUSTOM ROLE PROMPT");
});

test("brainstormPrompt mentions existing tool + bug context on rework", () => {
  const reworkCtx: ToolBuildContext = {
    ...ctx,
    existingToolName: "weather.openmeteo",
    bugContext: "Empty array on humid days.",
  };
  const msgs = brainstormPrompt(reworkCtx, 2);
  const user = msgs[1].content;
  assert.match(user, /Rework target — existing tool: weather\.openmeteo/);
  assert.match(user, /Empty array on humid days\./);
});

test("votePrompt lists all proposals and asks for JSON ranking", () => {
  const proposals: CouncilProposal[] = [
    { modelId: "alpha", content: "alpha proposal text" },
    { modelId: "beta", content: "beta proposal text" },
  ];
  const msgs = votePrompt(ctx, proposals);
  const user = msgs[1].content;
  assert.match(user, /Proposal #0 \(by alpha\)/);
  assert.match(user, /Proposal #1 \(by beta\)/);
  assert.match(user, /JSON ranking/);
});

test("implementPrompt includes proposal text and asks for files JSON", () => {
  const msgs = implementPrompt(ctx, winner);
  const user = msgs[1].content;
  assert.match(user, /Architecture: \.\.\./);
  // TB-005: prompt now pins the exact path the model should emit instead of
  // asking for free-form server/Dockerfile shapes.
  assert.match(user, /src\/tools\/generated\//);
  assert.match(user, /export const tool: Tool/);
  assert.match(user, /"files":\[/);
});

test("reviewPrompt includes code snippet and the JSON verdict template", () => {
  const code = "export function run(input){ return {ok:true}; }";
  const msgs = reviewPrompt(ctx, winner, code);
  const user = msgs[1].content;
  assert.match(user, /Submitted code:/);
  assert.match(user, /return \{ok:true\}/);
  assert.match(user, /"verdict": "pass"\|"needs_revision"/);
});

test("revisePrompt enumerates each review finding", () => {
  const code = "old code";
  const findings = ["no error handling on fetch", "missing timeout"];
  const msgs = revisePrompt(ctx, winner, code, findings);
  const user = msgs[1].content;
  assert.match(user, /no error handling on fetch/);
  assert.match(user, /missing timeout/);
  assert.match(user, /Apply targeted fixes/);
});

test("qaOraclePrompt embeds tool output + criteria + JSON template", () => {
  const msgs = qaOraclePrompt(ctx, { ok: true, content: "ok stub", data: { items: [1, 2, 3] } });
  const user = msgs[1].content;
  assert.match(user, /returns 24 hourly entries/);
  assert.match(user, /ok stub/);
  assert.match(user, /"items"/);
  assert.match(user, /"verdict": "passed"\|"failed"/);
});

test("repairPrompt enumerates each QA failure", () => {
  const failures = ["only 12 entries returned", "missing humidity field"];
  const msgs = repairPrompt(ctx, winner, "stub code", failures);
  const user = msgs[1].content;
  assert.match(user, /only 12 entries returned/);
  assert.match(user, /missing humidity field/);
  // TB-005: scaffolding is owned by the adapter; the prompt asks the
  // model not to re-emit it.
  assert.match(user, /Do not re-emit/);
  assert.match(user, /scaffolding/);
});
