import test from "node:test";
import assert from "node:assert/strict";
import { __testing__ } from "../src/agents/universalAgent.js";

const { userExplicitlyAskedForUrl, improveDeclaredToolInput } = __testing__;

function subtask(prompt: string): never {
  return {
    id: "s1",
    title: "test",
    role: "researcher",
    prompt,
    expectedOutput: "",
    reviewCriteria: [],
    requiredTools: [],
    dependencies: [],
  } as never;
}

test("userExplicitlyAskedForUrl: matches verbatim URL in subtask prompt", () => {
  assert.equal(
    userExplicitlyAskedForUrl(
      "https://example.com",
      subtask("Navigate to https://example.com and capture a screenshot."),
    ),
    true,
  );
});

test("userExplicitlyAskedForUrl: matches URL when subtask uses trailing slash", () => {
  assert.equal(
    userExplicitlyAskedForUrl(
      "https://example.com",
      subtask("Open https://example.com/ for analysis."),
    ),
    true,
  );
});

test("userExplicitlyAskedForUrl: matches when subtask only mentions bare host", () => {
  assert.equal(
    userExplicitlyAskedForUrl(
      "https://example.com",
      subtask("Сделай скриншот сайта example.com и опиши его."),
    ),
    true,
  );
});

test("userExplicitlyAskedForUrl: returns false when subtask does not mention URL/host at all", () => {
  assert.equal(
    userExplicitlyAskedForUrl(
      "https://random-site.test",
      subtask("Find the cheapest laptop and screenshot the result."),
    ),
    false,
  );
});

test("improveDeclaredToolInput: keeps user-explicit URL even when shallow (Phase 13 regression)", () => {
  const input = {
    commands: [
      { type: "navigate", url: "https://example.com" },
      { type: "screenshot", label: "page_view" },
      { type: "extractText" },
    ],
  };
  const priorEvidence = [
    "Search results: https://chromewebstore.google.com/detail/gofullpage/abc 'Full Page Screen Capture'",
  ];
  const result = improveDeclaredToolInput(
    "browser.operate",
    input,
    subtask("Сделай скриншот страницы https://example.com и опиши коротко что на ней"),
    priorEvidence,
    [],
    ["product-comparison"],
  ) as typeof input;
  // Should NOT be rewritten — user explicitly asked for example.com.
  assert.equal((result.commands[0] as { url: string }).url, "https://example.com");
});

test("improveDeclaredToolInput: still rewrites shallow URL when user did NOT name it", () => {
  const input = {
    commands: [
      { type: "navigate", url: "https://www.amazon.com" },
      { type: "extractText" },
    ],
  };
  const priorEvidence = [
    "Search results: https://www.tomshardware.com/laptops/best-laptops 'Best Laptops 2026'",
  ];
  const result = improveDeclaredToolInput(
    "browser.operate",
    input,
    subtask("Find me the best laptop for LLM development"),
    priorEvidence,
    [],
    ["product-comparison"],
  ) as typeof input;
  const navigates = result.commands.filter((c) => (c as { type: string }).type === "navigate");
  assert.notEqual((navigates[0] as { url: string }).url, "https://www.amazon.com");
  assert.match((navigates[0] as { url: string }).url, /tomshardware/);
});
