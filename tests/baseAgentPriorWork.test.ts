import test from "node:test";
import assert from "node:assert/strict";

import { BaseAgent } from "../src/agents/baseAgent.js";
import type { LlmClient, LlmToolReply, LlmToolSchema } from "../src/llm/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentEvent, Message } from "../src/types.js";
import { RuntimeLedgerCoordinator, type RuntimeLedgerEventDraft } from "../src/work-ledger/runtimeLedgerCoordinator.js";
import { InMemoryEvidenceLedgerStore } from "../src/work-ledger/evidenceLedgerStore.js";
import { InMemoryWorkLedgerStore } from "../src/work-ledger/workLedgerStore.js";

class CountingLlm {
  calls = 0;

  async completeWithTools(_messages: Message[], _tools: LlmToolSchema[]): Promise<LlmToolReply> {
    this.calls += 1;
    return {
      content: "LLM should not be needed for a satisfied prior-work follow-up.",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

test("BaseAgent answers source follow-up from prior Ledger evidence without new tools", async () => {
  const registry = new ToolRegistry();
  let searchCalls = 0;
  registry.register({
    name: "web.search",
    version: "0.1.0",
    description: "Search the web.",
    capabilities: ["web-search"],
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    async run() {
      searchCalls += 1;
      return { ok: true, content: "fresh result should not be used" };
    },
  });

  const workLedger = new InMemoryWorkLedgerStore();
  const evidenceLedger = new InMemoryEvidenceLedgerStore();
  const priorItem = await workLedger.createItem({
    threadId: "thread-prior-btc",
    runId: "run-prior-btc",
    kind: "url_visit",
    status: "completed",
    workKey: "url_visit:web.read:btc",
    title: "Read BTC source",
    sourceUrls: ["https://coinmarketcap.com/currencies/bitcoin/"],
  });
  const priorEvidence = await evidenceLedger.createEvidence({
    threadId: "thread-prior-btc",
    runId: "run-prior-btc",
    workItemId: priorItem.id,
    kind: "source_url",
    sourceUrl: "https://coinmarketcap.com/currencies/bitcoin/",
    toolName: "web.read",
    title: "CoinMarketCap Bitcoin",
    summary: "Prior BTC source used for the earlier answer.",
    contentPreview: "Bitcoin price source page.",
    qaStatus: "passed",
    confidence: 0.9,
  });
  await workLedger.appendEvidenceLink(priorItem.id, priorEvidence.id);

  const ledgerEvents: RuntimeLedgerEventDraft[] = [];
  const ledger = new RuntimeLedgerCoordinator({
    runId: "run-source-follow-up",
    threadId: "thread-prior-btc",
    instanceId: "instance-local",
    workLedgerStore: workLedger,
    evidenceLedgerStore: evidenceLedger,
    emit: async (event) => {
      ledgerEvents.push(event);
    },
  });
  const events: AgentEvent[] = [];
  const llm = new CountingLlm();
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run("какой источник ты использовал для цены биткоина в предыдущем ответе?", {
    runId: "run-source-follow-up",
    ledger,
    onEvent: (event) => {
      events.push(event);
    },
    runContext: {
      runId: "run-source-follow-up",
      threadId: "thread-prior-btc",
      instanceId: "instance-local",
      thread: {
        summary: "Answered: current Bitcoin price was sourced from CoinMarketCap.",
        acceptedFacts: ["Prior source URL: https://coinmarketcap.com/currencies/bitcoin/"],
      },
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(searchCalls, 0);
  assert.equal(llm.calls, 0);
  assert.match(result.finalAnswer, /CoinMarketCap/i);
  assert.match(result.finalAnswer, /https:\/\/coinmarketcap\.com\/currencies\/bitcoin\//);
  assert.doesNotMatch(result.finalAnswer, /Proof note/i);

  assert.ok(ledgerEvents.some((event) => event.type === "work-ledger-prior-context-resolved"));
  assert.ok(ledgerEvents.some((event) => event.type === "work-ledger-prior-context-applied"));
  const decisionEvidence = await evidenceLedger.listByRun("run-source-follow-up");
  assert.equal(decisionEvidence.length, 1);
  assert.equal(decisionEvidence[0]?.kind, "model_observation");
  assert.equal(decisionEvidence[0]?.metadata?.applied, true);
  assert.equal((decisionEvidence[0]?.metadata?.priorWorkDecision as { decision?: string } | undefined)?.decision, "reuse");
  const frameEvent = events.find((event) => event.type === "agent-task-framed");
  assert.equal((frameEvent?.payload as { taskFrame?: { mode?: string } } | undefined)?.taskFrame?.mode, "thread_context_answer");
});
