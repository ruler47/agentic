import test from "node:test";
import assert from "node:assert/strict";
import { extractUserToolMentions } from "../src/agents/agentStrategy.js";
import type { Tool } from "../src/tools/tool.js";

const stubTool = (name: string): Tool =>
  ({
    name,
    version: "1.0.0",
    description: name,
    capabilities: [name.split(".")[0]!],
    startupMode: "on-demand",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {} },
    healthcheck: async () => ({ ok: true, detail: "stub" }),
    run: async () => ({ ok: true, content: "stub" }),
  }) as unknown as Tool;

const tools = [stubTool("web.search"), stubTool("web.duckduckgo"), stubTool("chart.generate")];

test("extractUserToolMentions deny: English 'don't use X'", () => {
  const result = extractUserToolMentions("Don't use web.search for this task.", "deny", tools);
  assert.deepEqual(result, ["web.search"]);
});

test("extractUserToolMentions deny: Russian 'не используй X'", () => {
  const result = extractUserToolMentions("Не используй web.search.", "deny", tools);
  assert.deepEqual(result, ["web.search"]);
});

test("extractUserToolMentions prefer: English 'use X'", () => {
  const result = extractUserToolMentions("Use web.duckduckgo to find the answer.", "prefer", tools);
  assert.deepEqual(result, ["web.duckduckgo"]);
});

test("extractUserToolMentions prefer: English 'using X' / 'via X'", () => {
  const r1 = extractUserToolMentions("Find the answer using web.duckduckgo.", "prefer", tools);
  assert.deepEqual(r1, ["web.duckduckgo"]);
  const r2 = extractUserToolMentions("Look it up via web.duckduckgo today.", "prefer", tools);
  assert.deepEqual(r2, ["web.duckduckgo"]);
});

test("extractUserToolMentions prefer: Russian 'используй X'", () => {
  const result = extractUserToolMentions("Используй web.duckduckgo чтобы найти ответ.", "prefer", tools);
  assert.deepEqual(result, ["web.duckduckgo"]);
});

test("extractUserToolMentions handles 'Use X to Y. Don't use Z.' in same task", () => {
  const denied = extractUserToolMentions(
    "Use web.duckduckgo to find the answer. Don't use web.search.",
    "deny",
    tools,
  );
  const preferred = extractUserToolMentions(
    "Use web.duckduckgo to find the answer. Don't use web.search.",
    "prefer",
    tools,
  );
  assert.deepEqual(denied, ["web.search"]);
  assert.deepEqual(preferred, ["web.duckduckgo"]);
});

test("extractUserToolMentions ignores tools not in registry", () => {
  const result = extractUserToolMentions("Use web.bing.", "prefer", tools);
  assert.deepEqual(result, []);
});

test("extractUserToolMentions returns [] when verbs don't appear", () => {
  const result = extractUserToolMentions("Find the bitcoin price.", "deny", tools);
  assert.deepEqual(result, []);
});
