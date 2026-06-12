import test from "node:test";
import assert from "node:assert/strict";
import { decideAgentStrategy } from "../src/agents/agentStrategy.js";
import type { SkillMemoryEntry, TaskComplexity } from "../src/types.js";
import type { Tool } from "../src/tools/tool.js";

const directLow: TaskComplexity = {
  mode: "direct",
  reason: "simple local answer",
  domains: ["general"],
  riskLevel: "low",
};

function tool(name: string, capabilities: string[]): Tool {
  return {
    name,
    description: `${name} reusable tool`,
    capabilities,
    async run() {
      return { ok: true, content: "ok" };
    },
  };
}

test("agent strategy chooses direct answer for narrow low-risk tasks", () => {
  const noisyMemory: SkillMemoryEntry = {
    id: "mem-noisy",
    title: "Old browser proof workflow",
    tags: ["browser", "search"],
    summary: "For unrelated evidence tasks, search the web and capture screenshots.",
    reusableProcedure: "Use browser.operate only when the current task actually needs external proof.",
    scope: "group",
    status: "accepted",
    confidence: 0.9,
    sensitivity: "normal",
    createdAt: new Date(0).toISOString(),
  };

  const decision = decideAgentStrategy({
    task: "Скажи одним предложением что такое универсальный агент.",
    complexity: directLow,
    memories: [noisyMemory],
    tools: [
      tool("web.search", ["web-search"]),
      tool("browser.operate", ["browser-automation"]),
    ],
  });

  assert.equal(decision.primary, "direct_answer");
  assert.deepEqual(decision.actions, ["self_check_return", "answer_directly"]);
  assert.deepEqual(decision.toolPolicy.matchedToolNames, []);
  assert.equal(decision.reviewStrictness, "light");
  assert.equal(decision.maxChildDepth, 1);
});

test("agent strategy does not treat classifier negation as a tool request", () => {
  const decision = decideAgentStrategy({
    task: "Define universal agent in one sentence.",
    complexity: {
      mode: "direct",
      reason: "The task can be answered immediately without research or specialized tools.",
      domains: ["AI", "General Knowledge"],
      riskLevel: "low",
    },
    tools: [
      tool("web.search", ["web-search"]),
      tool("file.read", ["workspace-file-read"]),
      tool("channel.telegram.bot", ["provider:telegram", "messaging-service"]),
    ],
    hasWorkLedger: true,
  });

  assert.equal(decision.primary, "direct_answer");
  assert.deepEqual(decision.toolPolicy.matchedToolNames, []);
  assert.equal(decision.ledgerPolicy.shouldCheck, false);
});

test("agent strategy recommends council for high-risk multi-domain decisions", () => {
  const decision = decideAgentStrategy({
    task: "Compare medical, legal, and financial risks and choose a strategy.",
    complexity: {
      mode: "delegated",
      reason: "high-stakes decision across domains",
      domains: ["medical", "legal", "financial"],
      riskLevel: "high",
    },
    tools: [],
    hasWorkLedger: true,
  });

  assert.equal(decision.primary, "council");
  assert.equal(decision.reviewStrictness, "council");
  assert.equal(decision.modelTier, "L");
  assert.ok(decision.actions.includes("ask_council"));
  assert.ok(decision.actions.includes("delegate_children"));
  assert.ok(decision.council);
  assert.ok(decision.council!.participants.some((participant) => participant.modelTier === "XL"));
});

test("agent strategy routes external work through tools and the Work Ledger", () => {
  const decision = decideAgentStrategy({
    task: "Search the web, open the browser page, and attach a screenshot proof.",
    complexity: {
      mode: "delegated",
      reason: "requires live external evidence",
      domains: ["research"],
      riskLevel: "medium",
    },
    tools: [tool("web.search", ["web-search"]), tool("browser.operate", ["browser-automation"])],
    hasWorkLedger: true,
  });

  assert.equal(decision.primary, "ledger_reuse_or_wait");
  assert.ok(decision.actions.includes("check_work_ledger"));
  assert.ok(decision.actions.includes("call_tool"));
  assert.deepEqual(decision.toolPolicy.matchedToolNames.sort(), ["browser.operate", "web.search"]);
  assert.equal(decision.ledgerPolicy.reuseFreshEvidence, true);
  assert.equal(decision.ledgerPolicy.waitForInFlight, true);
});

test("agent strategy exposes prepare and commit tools for external action tasks", () => {
  const decision = decideAgentStrategy({
    task:
      "Find a barber, prepare an appointment form before submit, attach proof, and only commit after explicit approval.",
    complexity: {
      mode: "delegated",
      reason: "external action needs approval boundary",
      domains: ["booking"],
      riskLevel: "medium",
    },
    tools: [
      tool("external.action.prepare", ["external-action-prepare", "form-preparation", "approval-required"]),
      tool("external.action.commit", ["external-action-commit", "external-submit"]),
    ],
    hasWorkLedger: true,
  });

  assert.deepEqual(decision.toolPolicy.matchedToolNames.sort(), [
    "external.action.commit",
    "external.action.prepare",
  ]);
  assert.ok(decision.actions.includes("call_tool"));
});

test("agent strategy records capability gaps without waiting for the inactive builder", () => {
  const decision = decideAgentStrategy({
    task: "Create a PDF report with a chart and voice transcript from an uploaded audio file.",
    complexity: {
      mode: "delegated",
      reason: "needs artifacts and media processing",
      domains: ["documents", "media"],
      riskLevel: "medium",
    },
    tools: [],
    hasWorkLedger: true,
  });

  assert.equal(decision.primary, "delegated_dag");
  assert.equal(decision.actions.includes("request_tool_build"), false);
  assert.equal(decision.actions.includes("request_tool_rework"), false);
  assert.equal(decision.toolPolicy.mayRequestBuild, false);
  assert.equal(decision.toolPolicy.mayRequestRework, false);
  assert.deepEqual(decision.toolPolicy.missingCapabilityHints.sort(), [
    "chart-generation",
    "document-generation",
    "speech-to-text",
  ]);
});

test("agent strategy includes memory context without leaking full memory payloads", () => {
  const memory: SkillMemoryEntry = {
    id: "mem-1",
    title: "Use browser evidence",
    tags: ["browser"],
    summary: "Screenshots need semantic QA.",
    reusableProcedure: "Use browser.operate then inspect artifact quality.",
    scope: "group",
    status: "accepted",
    confidence: 0.9,
    sensitivity: "normal",
    createdAt: new Date(0).toISOString(),
  };

  const decision = decideAgentStrategy({
    task: "Need browser proof for a page.",
    complexity: directLow,
    memories: [memory],
    tools: [tool("browser.operate", ["browser-automation"])],
    hasWorkLedger: true,
  });

  assert.equal(decision.primary, "ledger_reuse_or_wait");
  assert.deepEqual(decision.toolPolicy.matchedToolNames, ["browser.operate"]);
});
