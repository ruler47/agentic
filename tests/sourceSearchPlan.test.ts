import test from "node:test";
import assert from "node:assert/strict";

import { buildBaseAgentSystemPrompt } from "../src/agents/baseAgentPrompt.js";
import { sourceSearchPlanRepairInstructionForModel } from "../src/agents/sourceSearchPlan.js";
import { formatTaskFrameForPrompt, frameTask } from "../src/agents/taskFrame.js";

test("task frame forbids external research when user explicitly asks for no internet", () => {
  const frame = frameTask("Без интернета. Сравни чай и кофе как утренний напиток для концентрации.");
  const rendered = formatTaskFrameForPrompt(frame);
  const prompt = buildBaseAgentSystemPrompt({ runId: "run_source_plan" }, [], [], frame);

  assert.equal(frame.sourcePolicy.externalResearch, "forbidden");
  assert.equal(frame.researchDepth, "none");
  assert.equal(frame.researchContract.minResearchToolCalls, 0);
  assert.equal(frame.researchContract.minSourceReadToolCalls, 0);
  assert.match(rendered, /Source policy: externalResearch=forbidden/);
  assert.match(prompt, /Do not call web\.search, web\.read, web\.extract, http\.request, browser\.operate, or browser\.screenshot/i);
});

test("broad non-English product research gets a mixed-language source plan", () => {
  const frame = frameTask("Подбери лучший ноутбук для локальных LLM и игр до 2500 долларов, актуально сейчас.");
  const plan = frame.sourcePolicy.searchPlan;

  assert.equal(frame.mode, "product_selection");
  assert.equal(frame.sourcePolicy.externalResearch, "allowed");
  assert.equal(plan?.strategy, "mixed_language");
  assert.equal(plan?.requiresMixedLanguageSearch, true);
  assert.ok(plan?.queries.some((query) => query.language === "ru"));
  assert.ok(plan?.queries.some((query) => query.language === "en" && /laptop/i.test(query.query)));
});

test("source-quality exclusions do not disable external research", () => {
  const frame = frameTask(
    "Подбери ноутбук для локальных LLM и игр до 2500 долларов, актуально сейчас. Не используй страницы поиска или соцсети как источники.",
  );

  assert.equal(frame.sourcePolicy.externalResearch, "allowed");
  assert.equal(frame.sourcePolicy.searchPlan?.strategy, "mixed_language");
});

test("API/documentation tasks prefer official documentation source planning", () => {
  const frame = frameTask("Сделай тулзу по API документации, проверь endpoint и curl examples.");

  assert.equal(frame.sourcePolicy.searchPlan?.strategy, "official_docs");
  assert.ok(frame.sourcePolicy.searchPlan?.queries[0]?.expectedSourceTypes.includes("official_docs"));
});

test("source search plan repair asks for missing mixed-language query angles", () => {
  const frame = frameTask("Подбери лучший ноутбук для локальных LLM и игр до 2500 долларов, актуально сейчас.");
  const instruction = sourceSearchPlanRepairInstructionForModel({
    policy: frame.sourcePolicy,
    executedLanguages: ["ru"],
    toolNames: ["web.search"],
  });

  assert.match(instruction ?? "", /\[en\]/);
  assert.match(instruction ?? "", /laptop/i);
  assert.equal(
    sourceSearchPlanRepairInstructionForModel({
      policy: frame.sourcePolicy,
      executedLanguages: ["ru", "en"],
      toolNames: ["web.search"],
    }),
    undefined,
  );
});
