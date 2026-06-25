# P0 Commerce / "Where To Buy" Framing + Stale-Existence Grounding

## Status

- Owner: Claude (collaborating with Codex via this queue).
- Status: spec ready, implementation in progress.
- Date: 2026-06-25.
- Branch: integrates to `main`.
- Source: live failure `run_1782420661004_uw40pnu2`.

## 1. Idea And Measurable Increment

### Problem (concrete failure)

`run_1782420661004_uw40pnu2`, task **"найди мне где можно купить apple studio m3 ultra
512 gb"**, was framed as `mode: direct_fact`, `researchDepth: none`, answered in ONE step
with **zero tool calls**, and **confidently asserted from training memory that "Mac Studio
с чипом M3 Ultra не существует"**. The Apple Mac Studio M3 Ultra is a real shipping product
(released March 2025); the model's training cutoff makes it deny a real current product.
Two compounding defects:

1. **Framing gap.** A "where to buy / find a place to buy [specific product]" task is an
   inherently current/commerce lookup (does the product exist? who sells it? at what
   price/availability?). It must require search. Today `current_lookup` is only triggered
   by `taskNeedsCurrentExternalData` (`src/agents/taskFrame.ts:92`), a narrow regex
   covering bitcoin/price/weather/news — purchase/commerce intent is not in it, so the task
   fell through to the `direct_fact` fallback (`taskFrame.ts:542`) with
   `researchContract.minResearchToolCalls: 0`.
2. **Stale-existence grounding gap.** Even in `direct_fact`, the agent shipped an
   unverifiable negative claim about current reality ("product X does not exist / was not
   released") from memory. The return gate passed it. The runtime must not let a named
   product/entity be declared non-existent without a search.

### Measurable Increment

- A "where to buy / find / purchase / availability / price of [thing]" task is framed as a
  current lookup (or stronger) that requires at least one search/read before answering.
- The agent never ships a "doesn't exist / not released / no such product" claim about a
  named product/entity without having run a search; if a draft says so with zero research,
  the runtime forces a search-and-recheck instead of completing.
- Re-running the failing task returns actual purchase options (retailers/Apple Store/price)
  grounded in live search, not a memory-based denial.

### Non-Goals

- No hardcoded product/brand lists (the project forbids domain-specific keyword pipelines).
  The trigger is generic PURCHASE/COMMERCE/AVAILABILITY intent, not specific products.
- Not the current-fact answer-signal fallback (that is task 02, a different stage).
- Not full LLM-based task framing (the systemic cure for regex routing; noted as follow-up).

### Roadmap Fit

This is a P0 reliability defect on the user's core "find/buy things" use case for the
family assistant. It belongs with the current-fact P0 work (task 02) but is a distinct
framing + grounding gap.

## 2. Use Cases, Weak Spots, Edge Cases

### Happy path

"найди где купить [product]" / "where can I buy [product]" / "сколько стоит [product]" ->
current lookup -> web.search (+ read) -> answer with retailers/price/availability and a
source, or an honest "could not find it for sale, here is what I found" with evidence.

### Alternate paths

- Product genuinely does not exist: after a real search, the agent may say "I could not
  find this product; the closest current options are ..." — grounded in search, not memory.
- "is there a [product]" / "did [product] come out" / "когда вышел [product]" -> current
  lookup; never answered from memory as "no".
- Price/availability questions ("в наличии", "in stock", "for sale").

### Weak spots / failure modes

- Over-triggering: a generic "buy milk" or "should I buy a house" must not force pointless
  web research. The trigger should fire on commerce intent toward a specific findable
  product/service, but a false positive that adds one search is far cheaper than a
  confident memory-based denial; bias toward searching.
- Bilingual coverage (RU/EN, and transliterated).

### Edge cases

- "найди" alone is too broad (find anything) — require a commerce/availability/existence
  signal, not just "find".
- The negative-existence guard must match RU + EN phrasings of "does not exist / not
  released / no such / не существует / не выпускал / не вышел / нет такого".

### Observability

- The frame mode is visible in `agent-task-framed`. When the existence guard fires, emit a
  repair trace event (reuse an existing repair-event type) so Trace Lab shows the forced
  re-search.

## 3. Spec

### Functional requirements

1. **FR-1 Commerce framing.** `taskNeedsCurrentExternalData` (or a sibling predicate feeding
   the `current_lookup` decision) returns true for generic purchase/commerce/availability/
   existence intent: buy / where to buy / for sale / in stock / availability / price of /
   cost of / order / shop for; купить / где купить / где можно купить / в наличии / заказать
   / сколько стоит / стоимость / цена на / прайс / продаётся. Such tasks frame as
   `current_lookup` (researchContract.minResearchToolCalls >= 1, mustAvoid "answering from
   model memory").
2. **FR-2 Existence grounding guard.** Before the return gate passes a `direct_fact` (or any
   zero-research) answer, if the draft asserts a named product/entity does not exist / was
   not released / has no such version, and the run made zero successful research tool calls,
   block the finish once and instruct the model to search before claiming non-existence.
   After a search, the claim may stand if still unsupported, but it must be grounded.

### Acceptance criteria

- `frameTask("найди мне где можно купить apple studio m3 ultra 512 gb")` returns a mode that
  requires search (not `direct_fact`/`researchDepth: none`).
- `frameTask("where can I buy an RTX 5090")` likewise requires search.
- `frameTask("сколько будет 2+2")` stays `direct_fact` (no false trigger).
- A live re-run of the failing task performs >=1 web.search and returns retailers/price or a
  grounded "not found", never a memory-based "doesn't exist".

### Out of scope

- LLM-based framing; product-specific knowledge.

## 4. Architecture

- Framing stays in `src/agents/taskFrame.ts` (one predicate change feeding the existing
  `current_lookup` branch). No new mode.
- The existence guard lives at the return-gate/finalization boundary in the BaseAgent loop
  (where other answer repairs — proof, raw-syntax, candidate-use — already live), reusing
  the existing "block finish + one repair turn" pattern.

## 5. Low-Level Technical Plan

- `src/agents/taskFrame.ts`: extend `taskNeedsCurrentExternalData` (or add
  `taskNeedsCommerceLookup`) with the bilingual commerce/availability/existence intent;
  keep it generic (intent verbs, not product names).
- BaseAgent finalization/return-gate module: add a `deniesExistenceWithoutResearch(draft,
  successfulResearchToolCalls)` check; on hit, push a corrective instruction and re-loop
  once (bounded, like the existing repair attempts). Emit an existing repair trace event.
- Tests: `tests/taskFrame*.test.ts` for the framing cases; a focused unit for the
  existence-guard predicate.

## 6. Test Plan

Automated:
- frameTask commerce/where-to-buy/price -> requires search; "2+2" and "should I buy a
  house" sanity (no pointless research where truly not needed — accept a search for safety
  but assert the mode is at least current_lookup for product purchase intent).
- existence-guard predicate: "Mac Studio M3 Ultra не существует" + 0 research -> blocks;
  with >=1 research -> allowed.

Manual:
- Re-run `найди где купить apple studio m3 ultra 512 gb` on the durable stack; confirm
  >=1 web.search, a grounded answer with retailers/price/source, and no memory-based denial.

## 7. Decomposition

1. FR-1 commerce framing predicate + frameTask tests. Validate: verify green.
2. FR-2 existence-grounding guard in the loop + unit test.
3. Live re-run of the failing task; record the new run id.
4. Update handoff/this file Completion Notes; remove from queue when merged.

## 8. Completion Notes

**FR-1 (commerce framing) — done and verified live (2026-06-25).**
`taskNeedsCommerceLookup` added to `src/agents/taskFrame.ts`; purchase/availability/
"where to buy" intent (bilingual, generic verbs only) now routes to `current_lookup`
(`minResearchToolCalls: 1`, answer contract forbids "answering from model memory"). The
existing research-contract enforcement in the BaseAgent loop then prevents finishing such a
run with zero research calls. Tests: `tests/commerceFraming.test.ts` (9 cases incl. the
exact failing task and no-false-trigger sanity). `npm run verify` green at 653 tests.

Live proof — re-ran the exact failing task "найди мне где можно купить apple studio m3
ultra 512 gb" as `run_1782421416298_2kkuuok3`: framed `current_lookup`, **15 tool calls**
(was 0), and the answer is grounded in live sources (MacRumors / Tom's Hardware) — it
correctly knows the M3 Ultra Mac Studio exists and explains that Apple pulled the 512 GB
config due to a DRAM shortage (max 256 GB now), with a real Apple Store purchase link. No
memory-based "doesn't exist" denial. This fully resolves the reported failure
(`run_1782420661004_uw40pnu2`).

**FR-2 (existence-denial grounding guard) — deferred follow-up.** FR-1 + the existing
research-contract enforcement cover the reported commerce class. FR-2 (block a memory-based
"product/entity does not exist / not released" claim when the run made zero research calls,
for tasks that are NOT framed as a current lookup, e.g. "did the iPhone 17 come out?") is a
residual robustness backstop. It belongs in the BaseAgent repair ladder
(`src/agents/baseAgent.ts`, alongside the proof/raw-syntax/candidate-use repairs) and should
be implemented with the same care as those guards; left as the next step of this task.
