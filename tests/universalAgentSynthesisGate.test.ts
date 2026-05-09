import test from "node:test";
import assert from "node:assert/strict";
import { __testing__ } from "../src/agents/universalAgent.js";
import type { LlmClient } from "../src/llm/client.js";
import type { Message } from "../src/types.js";

const { findUngroundedSpecificsInText, buildSynthesisEvidenceCorpus, enforceUngroundedSpecificsOnSynthesis } = __testing__;

function fakeLlm(responses: string[]): LlmClient {
  let i = 0;
  return {
    complete: async (_messages: Message[]) => {
      const response = responses[i] ?? responses[responses.length - 1];
      i += 1;
      return response;
    },
  } as unknown as LlmClient;
}

test("findUngroundedSpecificsInText flags GPU/chip tokens absent from evidence", () => {
  const output = "I recommend a laptop with an RTX 4080 and an Apple M3 Pro chip.";
  const evidence = "Laptop reviews: prefer NVIDIA RTX 50 series and Apple M5 chips.";
  const ungrounded = findUngroundedSpecificsInText(output, evidence);
  assert.ok(ungrounded.some((t) => /RTX 4080/i.test(t)), `expected RTX 4080 to be flagged, got ${ungrounded.join(", ")}`);
  assert.ok(ungrounded.some((t) => /M3/i.test(t)), `expected M3 to be flagged, got ${ungrounded.join(", ")}`);
});

test("findUngroundedSpecificsInText accepts tokens that ARE in evidence", () => {
  const output = "I recommend a laptop with an RTX 5080 and an Apple M5 chip.";
  const evidence = "Live page mentions RTX 5080 and the new Apple M5 Pro.";
  const ungrounded = findUngroundedSpecificsInText(output, evidence);
  assert.deepEqual(ungrounded, []);
});

test("findUngroundedSpecificsInText flags ungrounded laptop-line tokens (Lenovo Legion, HP Omen, MSI Raider, Razer Blade, ROG Zephyrus)", () => {
  const output = "Top picks: Lenovo Legion Slim 5, HP Omen Transcend, MSI Raider GE78, Razer Blade 16, ROG Zephyrus G14.";
  const evidence = "Tool returned a generic page about gaming laptops with no model lines mentioned.";
  const ungrounded = findUngroundedSpecificsInText(output, evidence);
  assert.ok(ungrounded.some((t) => /Lenovo Legion/i.test(t)), `expected Lenovo Legion to be flagged, got ${ungrounded.join(", ")}`);
  assert.ok(ungrounded.some((t) => /HP Omen/i.test(t)), `expected HP Omen to be flagged, got ${ungrounded.join(", ")}`);
  assert.ok(ungrounded.some((t) => /MSI Raider/i.test(t)), `expected MSI Raider to be flagged, got ${ungrounded.join(", ")}`);
  assert.ok(ungrounded.some((t) => /Razer Blade/i.test(t)), `expected Razer Blade to be flagged, got ${ungrounded.join(", ")}`);
  assert.ok(ungrounded.some((t) => /Zephyrus/i.test(t)), `expected Zephyrus to be flagged, got ${ungrounded.join(", ")}`);
});

test("findUngroundedSpecificsInText pair-with-gap fallback: 'MacBook Pro M3 Max' grounded by 'MacBook Pro with M3 Max'", () => {
  // Iter 7 regression: hardware-corner.net article said "MacBook Pro with M3 Max (96GB)".
  // Worker correctly extracted "MacBook Pro M3 Max". Substring fails because of the
  // inserted "with"; pair-with-gap fallback should accept all pairs:
  //   (macbook, pro) → "macbook pro" in evidence
  //   (pro, m3) → "pro with m3" in evidence (gap = "with")
  //   (m3, max) → "m3 max" in evidence
  const output = "Top pick: MacBook Pro M3 Max with 96GB unified memory.";
  const evidence =
    "We've updated our top pick: the MacBook Pro with M3 Max (96GB) is now our recommended laptop for running large language models.";
  const ungrounded = findUngroundedSpecificsInText(output, evidence);
  for (const token of ungrounded) {
    assert.ok(
      !/MacBook|M3/i.test(token),
      `Token "${token}" should have passed pair-with-gap fallback`,
    );
  }
});

test("findUngroundedSpecificsInText pair-with-gap fallback rejects token whose digit-bearing pair is not anchored (Bug 8 regression)", () => {
  // Iter 8 regression: word-set let "MacBook Pro M4" through when evidence
  // mentioned "M4" in an unrelated place. Pair-anchor (any digit-bearing pair
  // in evidence) requires (pro, m4) or (macbook, m4) to be anchored — neither
  // is present here.
  const output = "Recommendation: MacBook Pro M4 with 36GB memory.";
  const evidence =
    "Best pick: the MacBook Pro with M3 Max (96GB). Some unrelated mention of M4 elsewhere in a different context that does not connect to MacBook Pro at all.";
  const ungrounded = findUngroundedSpecificsInText(output, evidence);
  const macbookM4Tokens = ungrounded.filter((t) => /macbook\s*pro\s*m4/i.test(t));
  assert.ok(macbookM4Tokens.length > 0, `MacBook Pro M4 should remain ungrounded, got: ${ungrounded.join(", ")}`);
});

test("findUngroundedSpecificsInText pair-anchor: 'Apple M4 Pro' grounded by 'MacBook Pro M4 Pro' in evidence (Bug 9 regression)", () => {
  // Iter 9 regression: worker wrote shorthand "Apple M4 Pro" while evidence
  // says "Apple's MacBook Pro M4 Pro specs show ...". Strict all-pairs check
  // failed because (apple, m4) is not adjacent in evidence. Pair-anchor
  // accepts the token because at least ONE digit-bearing pair (m4 pro) is
  // anchored in evidence — the digits are real, just the brand prefix
  // differs.
  const output = "Apple M4 Pro starts at 24GB unified memory.";
  const evidence =
    "Apple's 14-inch MacBook Pro M4 Pro specs show a 24GB unified-memory starting point and a 48GB configurable ceiling on M4 Pro.";
  const ungrounded = findUngroundedSpecificsInText(output, evidence);
  for (const token of ungrounded) {
    assert.ok(
      !/M4/i.test(token),
      `Token "${token}" should have passed pair-anchor (m4 pro is in evidence)`,
    );
  }
});

test("findUngroundedSpecificsInText pair-with-gap fallback still rejects brand-only matches", () => {
  // Defensive: "RTX 4080" must not pass just because evidence mentions "RTX 5090".
  // (rtx, 4080) does not appear in evidence (only "rtx 5090") → ungrounded.
  const output = "Buy the RTX 4080 for great gaming.";
  const evidence = "The RTX 5090 is now the recommended GPU.";
  const ungrounded = findUngroundedSpecificsInText(output, evidence);
  assert.ok(ungrounded.some((t) => /RTX 4080/i.test(t)), `RTX 4080 must remain ungrounded, got: ${ungrounded.join(", ")}`);
});

test("findUngroundedSpecificsInText flags ungrounded years and currency", () => {
  const output = "The 2027 model costs $2499 in Spain.";
  const evidence = "Catalog shows current 2026 inventory only.";
  const ungrounded = findUngroundedSpecificsInText(output, evidence);
  assert.ok(ungrounded.some((t) => t === "2027"));
  assert.ok(ungrounded.some((t) => /\$2499/.test(t)));
});

test("buildSynthesisEvidenceCorpus uses ground-truth sources, NOT worker output prose", () => {
  const corpus = buildSynthesisEvidenceCorpus(
    "Original task asking about the best laptop",
    [
      {
        subtask: {
          id: "s1",
          title: "Research",
          role: "researcher",
          prompt: "RTX 5080 evaluation",
          expectedOutput: "",
          reviewCriteria: [],
          requiredTools: [],
          dependencies: [],
        },
        // Worker output is NOT supposed to count as evidence — it's the
        // channel the synthesis gate is meant to police. A worker that
        // hallucinates "RTX 4080" in its prose must NOT thereby ground
        // the same token for the synthesis layer.
        output: "Worker output prose mentions HALLUCINATED_TOKEN_4080",
        toolEvidence: ["Tool evidence text contains 2026 release notes about RTX 5080"],
      } as never,
    ],
    [
      {
        id: "art-1",
        filename: "screenshot-best-laptop.png",
        url: "/artifacts/foo",
        description: "Page about RTX 5080 laptops",
      } as never,
    ],
  );
  // Task text is in.
  assert.ok(corpus.includes("Original task"));
  // Tool-evidence is in.
  assert.ok(corpus.includes("2026"));
  // Subtask metadata is in.
  assert.ok(corpus.includes("RTX 5080"));
  // Artifact metadata is in.
  assert.ok(corpus.includes("screenshot-best-laptop"));
  // Worker output prose is NOT in — that's the whole point.
  assert.ok(!corpus.includes("HALLUCINATED_TOKEN_4080"));
});

test("enforceUngroundedSpecificsOnSynthesis returns answer unchanged when fully grounded", async () => {
  const llm = fakeLlm(["should-not-be-called"]);
  const result = await enforceUngroundedSpecificsOnSynthesis({
    llm,
    modelTier: "L",
    systemPrompt: "system",
    userPrompt: "user",
    rawAnswer: "Stick with current-generation discrete GPUs.",
    evidenceCorpus: "Evidence about discrete GPUs.",
  });
  assert.equal(result.answer, "Stick with current-generation discrete GPUs.");
  assert.deepEqual(result.ungroundedFirstPass, []);
  assert.equal(result.disclaimerApplied, false);
});

test("enforceUngroundedSpecificsOnSynthesis retries with reinforced prompt and accepts grounded retry", async () => {
  const llm = fakeLlm([
    // first retry produces a grounded version (this is the only call)
    "Recommendation: a current-generation discrete-GPU laptop.",
  ]);
  const result = await enforceUngroundedSpecificsOnSynthesis({
    llm,
    modelTier: "L",
    systemPrompt: "system",
    userPrompt: "user",
    rawAnswer: "Recommendation: laptop with RTX 4080 and Apple M3 Pro.",
    evidenceCorpus: "Evidence corpus only mentions current generation laptops.",
  });
  assert.ok(result.ungroundedFirstPass.length > 0);
  assert.deepEqual(result.ungroundedAfterRetry, []);
  assert.equal(result.disclaimerApplied, false);
  assert.match(result.answer, /current-generation/);
});

test("enforceUngroundedSpecificsOnSynthesis falls back to disclaimer when retry still ungrounded", async () => {
  const llm = fakeLlm([
    "Even retry mentions RTX 4080 and Apple M3 Pro.",
  ]);
  const result = await enforceUngroundedSpecificsOnSynthesis({
    llm,
    modelTier: "L",
    systemPrompt: "system",
    userPrompt: "user",
    rawAnswer: "Recommendation: laptop with RTX 4080 and Apple M3 Pro.",
    evidenceCorpus: "Evidence corpus only mentions current generation laptops.",
  });
  assert.equal(result.disclaimerApplied, true);
  assert.ok(result.answer.includes("could not produce a grounded recommendation"));
  assert.ok(result.ungroundedAfterRetry.length > 0);
});
