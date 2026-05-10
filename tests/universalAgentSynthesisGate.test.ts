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

test("findUngroundedSpecificsInText: generic extractor flags any branded specific containing a digit (no brand allow-list)", () => {
  // Phase 12 follow-up: the previous brand-allow-list approach forced
  // every new product line to be added by hand. The generic rule now
  // catches ANY capitalized phrase that contains a digit — works for
  // laptop lines (Lenovo Legion 5, MSI Raider GE78), for entirely new
  // brands not in any list (Acme TurboBook 5000), and for non-laptop
  // products (Galaxy S25, Boeing 737, Tesla Model 3) all the same.
  const output =
    "Top picks: Lenovo Legion Slim 5, MSI Raider GE78, Razer Blade 16, ROG Zephyrus G14, Acme TurboBook 5000, Galaxy S25 Ultra, Boeing 737 MAX.";
  const evidence = "Tool returned a generic page about gaming laptops with no model lines mentioned.";
  const ungrounded = findUngroundedSpecificsInText(output, evidence);
  assert.ok(ungrounded.some((t) => /Lenovo Legion/i.test(t)), `expected Lenovo Legion to be flagged, got ${ungrounded.join(", ")}`);
  assert.ok(ungrounded.some((t) => /MSI Raider/i.test(t)), `expected MSI Raider to be flagged, got ${ungrounded.join(", ")}`);
  assert.ok(ungrounded.some((t) => /Razer Blade/i.test(t)), `expected Razer Blade to be flagged, got ${ungrounded.join(", ")}`);
  assert.ok(ungrounded.some((t) => /Zephyrus/i.test(t)), `expected Zephyrus to be flagged, got ${ungrounded.join(", ")}`);
  // Brand never seen by the runtime: works without any patch.
  assert.ok(ungrounded.some((t) => /TurboBook/i.test(t)), `expected new brand TurboBook 5000 to be flagged, got ${ungrounded.join(", ")}`);
  // Non-laptop product line: same generic rule.
  assert.ok(ungrounded.some((t) => /S25/i.test(t)), `expected Galaxy S25 to be flagged, got ${ungrounded.join(", ")}`);
  assert.ok(ungrounded.some((t) => /737/.test(t)), `expected Boeing 737 to be flagged, got ${ungrounded.join(", ")}`);
});

test("findUngroundedSpecificsInText: capitalized phrases without a digit are NOT flagged (proper nouns / series alone)", () => {
  // The digit requirement is what marks "specific". A series name
  // alone ("MacBook Pro", "HP Omen", "ROG Zephyrus") refers to a
  // product LINE, not a particular SKU; flagging would over-block.
  // Person names, hospital names, organizations, and city names are
  // also intentionally left alone because they are not the kind of
  // fact this gate is supposed to police.
  const output = "Recommendation: HP Omen series. The team at Hospital Universitario La Paz suggested ZenBook variants. Niko Matsakis would approve.";
  const evidence = "Generic context with none of these terms.";
  const ungrounded = findUngroundedSpecificsInText(output, evidence);
  for (const token of ungrounded) {
    assert.ok(
      !/HP Omen|Hospital Universitario|ZenBook|Niko Matsakis/i.test(token),
      `Token "${token}" should NOT be flagged (no digit -> not specific)`,
    );
  }
});

test("findUngroundedSpecificsInText: bare digits and numeric specs are NOT flagged (V1 regression)", () => {
  // V1 validation regression: the previous implementation extracted
  // bare numbers ("300") and unit-bearing specs ("12 ГБ VRAM",
  // "32 GB RAM") as candidate "specifics" because the candidate
  // phrase could start with a digit. That over-flagged any worker
  // that mentioned a memory/storage requirement and forced the
  // synthesizer into a useless disclaimer. The fixed extractor now
  // requires a phrase to BEGIN at a word with an uppercase letter,
  // which structurally rules out both bare numbers and numeric
  // specs without losing branded-token coverage.
  const output =
    "Worker recommends 32 GB RAM, 12 ГБ VRAM, and weights below 300 grams. The MacBook Pro M5 satisfies all three.";
  const evidence = "Evidence: MacBook Pro M5 has 32GB unified memory.";
  const ungrounded = findUngroundedSpecificsInText(output, evidence);
  for (const token of ungrounded) {
    assert.ok(
      !/^(?:32|12|300|GB|ГБ|VRAM|RAM)\b|^\d+$/i.test(token),
      `Token "${token}" should NOT be flagged (bare digit or numeric spec)`,
    );
  }
});

test("findUngroundedSpecificsInText: catches 'iPhone 15 Pro' even when surrounded by lowercase prose (camelCase brand)", () => {
  // The brand 'iPhone' starts with a lowercase letter but contains
  // an uppercase 'P' — sliding-window word extraction starts the
  // candidate at 'iPhone' (uppercase letter present), not at the
  // preceding 'the'. Without this, the phrase would be missed.
  const output = "the iPhone 15 Pro user is happy";
  const evidence = "no Apple devices mentioned";
  const ungrounded = findUngroundedSpecificsInText(output, evidence);
  assert.ok(
    ungrounded.some((t) => /iPhone\s+15/i.test(t)),
    `expected iPhone 15 to be flagged, got ${ungrounded.join(", ")}`,
  );
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

test("findUngroundedSpecificsInText rejects branded specifics whose digit-bearing word is absent from evidence (Bug 8 regression)", () => {
  // Iter 8 regression: word-set fallback let "MacBook Pro M4" through
  // even when evidence had only M3 mentioned. The fixed gate requires
  // the digit-bearing identifier to actually appear in evidence; if
  // M4 is nowhere in the evidence, the claim is ungrounded regardless
  // of how the brand prefix is spelled.
  const output = "Recommendation: MacBook Pro M4 with 36GB memory.";
  const evidence =
    "Best pick: the MacBook Pro with M3 Max (96GB). Reviewers compared it to the M3 Pro and M3 Max only; no other Apple chip was tested.";
  const ungrounded = findUngroundedSpecificsInText(output, evidence);
  const m4Tokens = ungrounded.filter((t) => /\bM4\b/i.test(t));
  assert.ok(m4Tokens.length > 0, `M4 should remain ungrounded (not in evidence at all), got: ${ungrounded.join(", ")}`);
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
