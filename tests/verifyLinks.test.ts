import test from "node:test";
import assert from "node:assert/strict";

import { RunSourceRegistry } from "../src/agents/sourceRegistry.js";
import { presentedLinkProblems, presentedLinkVerifyInstruction } from "../src/agents/baseAgentVerifyLinks.js";
import type { TaskFrame } from "../src/agents/taskFrame.js";
import type { ToolResult } from "../src/tools/tool.js";

const APPLE = "https://www.apple.com/shop/buy-mac/mac-studio";
const EBAY = "https://www.ebay.de/itm/389288258857";
const OOS = "https://www.refurbmac.co.uk/mac-studio.html";
const BLOCKED = "https://www.bhphotovideo.com/c/product/1884033";

function readResult(availability?: string): ToolResult {
  return { ok: true, content: "ok", data: { availability: availability ? { status: availability } : undefined } } as ToolResult;
}

function registryFixture(): RunSourceRegistry {
  const reg = new RunSourceRegistry();
  // EBAY: surfaced by search but never opened.
  reg.recordDiscovery({ urls: [EBAY], toolName: "web.search", eventId: "s1" });
  // APPLE: opened, in stock.
  reg.recordRead({ url: APPLE, toolName: "web.read", eventId: "r1", status: "passed", result: readResult("in_stock") });
  // OOS: opened, out of stock.
  reg.recordRead({ url: OOS, toolName: "web.read", eventId: "r2", status: "passed", result: readResult("out_of_stock") });
  // BLOCKED: opened but bot-blocked (escape hatch).
  reg.recordRead({ url: BLOCKED, toolName: "web.read", eventId: "r3", status: "blocked", result: { ok: false, content: "403" } as ToolResult });
  return reg;
}

const frame = (minResearchToolCalls: number): TaskFrame =>
  ({ researchContract: { minResearchToolCalls } }) as unknown as TaskFrame;

test("flags links never opened and opened-but-out-of-stock; passes verified and blocked", () => {
  const answer = `Buy here: ${APPLE}\nAlso ${EBAY}\nor ${OOS}\nor ${BLOCKED}.`;
  const problems = presentedLinkProblems(answer, registryFixture());
  const urls = problems.map((problem) => problem.url);
  assert.ok(urls.includes(EBAY), "ebay (never opened) must be flagged");
  assert.ok(urls.includes(OOS), "out-of-stock must be flagged");
  assert.ok(!urls.includes(APPLE), "verified in-stock must pass");
  assert.ok(!urls.includes(BLOCKED), "blocked-but-opened is allowed via escape hatch");
});

test("verify instruction lists the problem links for a grounding-hard task", () => {
  const instruction = presentedLinkVerifyInstruction({
    taskFrame: frame(1),
    finalAnswer: `Buy: ${EBAY}`,
    registry: registryFixture(),
  });
  assert.ok(instruction);
  assert.match(instruction!, /UNVERIFIED LINKS/);
  assert.match(instruction!, /ebay\.de\/itm\/389288258857/);
  assert.match(instruction!, /not verified/i);
});

test("no instruction when the task does not require research", () => {
  assert.equal(
    presentedLinkVerifyInstruction({ taskFrame: frame(0), finalAnswer: `Buy: ${EBAY}`, registry: registryFixture() }),
    undefined,
  );
});

test("no instruction when every presented link is verified", () => {
  assert.equal(
    presentedLinkVerifyInstruction({ taskFrame: frame(1), finalAnswer: `Buy: ${APPLE}`, registry: registryFixture() }),
    undefined,
  );
});

test("trailing punctuation in the answer does not break URL matching", () => {
  const problems = presentedLinkProblems(`See (${EBAY}).`, registryFixture());
  assert.deepEqual(problems.map((problem) => problem.url), [EBAY]);
});
