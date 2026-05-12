import test from "node:test";
import assert from "node:assert/strict";
import type { LlmClient } from "../src/llm/client.js";
import type { Message } from "../src/types.js";
import {
  parseResearchRequest,
  runLLMWithResearch,
  RESEARCH_PROMPT_BLOCK,
  type ResearchEvent,
} from "../src/agents/researchDelegate.js";

/**
 * Phase 17 Slice A regression coverage.
 *
 * The helper sits between any LLM call site and the actual `llm.complete`,
 * letting the LLM optionally emit a `<request_research>` block to
 * delegate fact-finding to a sub-agent. Tests pin:
 *   - happy path: LLM answers without research → exactly one llm.complete call
 *   - one research cycle → llm called twice, delegate called once
 *   - multi-cycle research → cycles stop on maxRequests
 *   - delegate failure does not crash the run; LLM gets a "failed" message
 *   - undefined delegate disables the feature; no prompt block leak
 *   - abort signal propagates
 */

class ScriptedLlm implements Pick<LlmClient, "complete"> {
  public calls: Message[][] = [];
  constructor(private readonly script: (call: { index: number; messages: Message[] }) => string) {}
  async complete(
    messages: Message[],
    options?: { signal?: AbortSignal; model?: string; modelTier?: string },
  ): Promise<string> {
    if (options?.signal?.aborted) throw new Error("aborted");
    const index = this.calls.length;
    this.calls.push(messages);
    return this.script({ index, messages });
  }
}

test("parseResearchRequest returns inner text when block present", () => {
  const out = parseResearchRequest("some prose\n<request_research>What is X?</request_research>\nmore prose");
  assert.equal(out, "What is X?");
});

test("parseResearchRequest tolerates uppercase + leading/trailing whitespace", () => {
  const out = parseResearchRequest("<REQUEST_RESEARCH>\n  multi-line\n  question\n</REQUEST_RESEARCH>");
  assert.equal(out, "multi-line\n  question");
});

test("parseResearchRequest returns undefined for plain text", () => {
  assert.equal(parseResearchRequest("just an answer, no block"), undefined);
});

test("parseResearchRequest returns undefined for empty block", () => {
  assert.equal(parseResearchRequest("<request_research>   </request_research>"), undefined);
});

test("happy path: LLM answers immediately, no delegate calls, no research block in conversation", async () => {
  const llm = new ScriptedLlm(() => "final answer, no research needed");
  let delegateCalls = 0;
  const result = await runLLMWithResearch(
    llm,
    [{ role: "user", content: "task" }],
    async () => {
      delegateCalls += 1;
      return "should-not-be-called";
    },
  );
  assert.equal(result, "final answer, no research needed");
  assert.equal(llm.calls.length, 1, "single LLM call when no research request");
  assert.equal(delegateCalls, 0);
  // RESEARCH_PROMPT_BLOCK SHOULD be appended (the LLM CAN ask)
  const lastMessage = llm.calls[0]!.at(-1);
  assert.equal(lastMessage?.content, RESEARCH_PROMPT_BLOCK);
});

test("one research cycle: LLM asks, delegate runs, LLM answers next", async () => {
  const llm = new ScriptedLlm(({ index }) => {
    if (index === 0) return "<request_research>What is the current thum.io PNG endpoint?</request_research>";
    if (index === 1) return "Final answer using research findings.";
    throw new Error("unexpected extra LLM call");
  });
  const events: ResearchEvent[] = [];
  let delegateCalls: string[] = [];
  const result = await runLLMWithResearch(
    llm,
    [{ role: "user", content: "build screenshot tool" }],
    async (q) => {
      delegateCalls.push(q);
      return "thum.io endpoint: https://image.thum.io/get/png/<url>";
    },
    { onResearch: (e) => events.push(e) },
  );
  assert.equal(result, "Final answer using research findings.");
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(delegateCalls, ["What is the current thum.io PNG endpoint?"]);
  // Second LLM call must contain the research_result block
  const secondLast = llm.calls[1]!.at(-1);
  assert.match(secondLast?.content ?? "", /research_result/);
  assert.match(secondLast?.content ?? "", /https:\/\/image\.thum\.io\/get\/png\/<url>/);
  // Events: request + result
  assert.equal(events.length, 2);
  assert.equal(events[0]!.kind, "request");
  assert.equal(events[1]!.kind, "result");
});

test("maxRequests cap: after N cycles the LLM is forced into a final answer", async () => {
  // LLM emits research forever; we cap at 2 cycles.
  const llm = new ScriptedLlm(({ index }) => {
    if (index < 2) return `<request_research>question ${index}</request_research>`;
    // Third call (forced final): the prompt should ask for final answer.
    return "Forced final answer.";
  });
  let delegateCalls = 0;
  const result = await runLLMWithResearch(
    llm,
    [{ role: "user", content: "task" }],
    async () => {
      delegateCalls += 1;
      return `findings ${delegateCalls}`;
    },
    { maxRequests: 2 },
  );
  assert.equal(result, "Forced final answer.");
  assert.equal(llm.calls.length, 3, "two research cycles + one final");
  assert.equal(delegateCalls, 2);
  // Last LLM call must have the "no more research" instruction
  const lastMessage = llm.calls[2]!.at(-1);
  assert.match(lastMessage?.content ?? "", /No more research/i);
});

test("delegate failure surfaces to the LLM but does not throw", async () => {
  const llm = new ScriptedLlm(({ index }) => {
    if (index === 0) return "<request_research>find X</request_research>";
    if (index === 1) return "Best-effort answer despite missing facts.";
    throw new Error("unexpected extra call");
  });
  const events: ResearchEvent[] = [];
  const result = await runLLMWithResearch(
    llm,
    [{ role: "user", content: "task" }],
    async () => {
      throw new Error("network down");
    },
    { onResearch: (e) => events.push(e) },
  );
  assert.equal(result, "Best-effort answer despite missing facts.");
  const found = events.find((e) => e.kind === "delegate-failed");
  assert.ok(found, "delegate-failed event emitted");
  // The LLM must see the failure note (not silently get nothing).
  const secondLast = llm.calls[1]!.at(-1)?.content ?? "";
  assert.match(secondLast, /Research delegate failed: network down/);
});

test("undefined delegate disables feature: no prompt block, single llm.complete call", async () => {
  const llm = new ScriptedLlm(() => "<request_research>X</request_research>");
  const result = await runLLMWithResearch(
    llm,
    [{ role: "user", content: "task" }],
    undefined, // no delegate
  );
  // Returns the response verbatim — the research block stays as text.
  assert.match(result, /<request_research>/);
  assert.equal(llm.calls.length, 1);
  // The conversation passed to llm MUST NOT include the research prompt block.
  for (const msg of llm.calls[0]!) {
    assert.ok(
      !msg.content?.includes("<request_research>your question in plain English"),
      "prompt block must not leak when delegate is undefined",
    );
  }
});

test("aborted signal propagates: throws before further LLM calls", async () => {
  const controller = new AbortController();
  const llm = new ScriptedLlm(({ index }) => {
    if (index === 0) {
      // Abort BEFORE returning — simulates user-cancel mid-flight.
      controller.abort();
      return "<request_research>X</request_research>";
    }
    throw new Error("should not be reached");
  });
  await assert.rejects(
    runLLMWithResearch(
      llm,
      [{ role: "user", content: "task" }],
      async () => "findings",
      { signal: controller.signal },
    ),
    /cancel/i,
  );
});
