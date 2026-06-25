import test from "node:test";
import assert from "node:assert/strict";

import { containsRawToolCallSyntax } from "../src/agents/baseAgentTrace.js";

// Leaked tool-call syntax must be detected so the return gate fails the run
// (or the in-loop repair fires) instead of shipping raw syntax as the answer.
const LEAK_CASES: Array<[string, string]> = [
  [
    "gemma pipe-delimited <|tool_call> with <|\"|> quote markers (live broad-research regression)",
    '<|tool_call>call:browser.screenshot{focusText:<|"|>M4 Pro<|"|>,url:<|"|>https://www.macprices.net/14-macbook-pro/<|"|>}<tool_call|>',
  ],
  ["xml tool_call", "<tool_call>web.search{query: btc}</tool_call>"],
  ["function= xml", "<function=web_search>{}</function>"],
  ["prose call:tool.name{...}", "call:web.search{query: bitcoin price}"],
  ["json tool_calls", '{"tool_calls": [{"name": "web.search"}]}'],
  ["finish(answer:", 'finish({answer: "done"})'],
  ["pipe special token only", "<|assistant|> here is the answer"],
];

const CLEAN_CASES: Array<[string, string]> = [
  [
    "normal recommendation prose with a URL",
    "Рекомендую MacBook Pro 14 (M4 Pro), 24 ГБ unified memory. Источник: https://www.apple.com/macbook-pro/. Для локальных LLM этого хватит на модели до 14B.",
  ],
  ["markdown table", "| Город | Население |\n|---|---|\n| Madrid | 3.3M |"],
  ["english prose mentioning a call", "Please call me later to confirm the booking time."],
  ["price answer", "Цена биткоина составляет 60 741 USD. Источник: https://ru.tradingview.com/symbols/BTCUSD/"],
];

for (const [name, value] of LEAK_CASES) {
  test(`detects leaked tool-call syntax: ${name}`, () => {
    assert.equal(containsRawToolCallSyntax(value), true, `should flag: ${value}`);
  });
}

for (const [name, value] of CLEAN_CASES) {
  test(`does not flag clean prose: ${name}`, () => {
    assert.equal(containsRawToolCallSyntax(value), false, `should NOT flag: ${value}`);
  });
}
