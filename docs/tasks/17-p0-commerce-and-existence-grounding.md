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


**FR-3 (concrete buy links, not advice) — done and verified live (2026-06-26).**
User clarified the deliverable: no purchase/external action — just concrete product
links where to buy. `taskNeedsCommerceLookup` tasks now get a SHOPPING answer contract
inside `current_lookup` (`src/agents/taskFrame.ts`): mustDo = list direct product/listing
URLs with seller/price/stock, rank official > retailer > marketplace, give the closest
buyable alternative link if the exact config is unavailable; mustAvoid = naming a platform
without a real URL, telling the user to search elsewhere, generic advice, memory-based
existence claims. The research contract is kept satisfiable by search alone
(minResearchToolCalls 1, minSourceReadToolCalls 0) because modern shop pages often block
scraping — a product URL from a search result is a valid buy link. Tests:
`tests/commerceFraming.test.ts`. verify 653 green.

Live proof `run_1782424835825_vm28cybv` (same task): returned 3 concrete buy links — a
specific eBay listing for the exact M3 Ultra 512GB config
(https://www.ebay.com/itm/306182855808), a B&H Photo product page, and the Apple Store —
with the verdict that Apple limited the official config to 256GB but the 512GB is available
from those retailers/marketplaces. No "check eBay yourself" advice.

Infra note: the buy-link runs failed twice mid-implementation because a stray host process
`python3 -m http.server 8080 --bind 127.0.0.1` had grabbed 127.0.0.1:8080 (where
`SEARXNG_BASE_URL` points), so every `web.search` hit a dead file server. Killing the
squatter restored search; not a code issue.

**FR-4 (verify links before presenting; be honest) — done and verified live (2026-06-26).**
Follow-up to FR-3: the agent was returning product URLs taken from search snippets WITHOUT
opening them, so it presented dead/sold/blocked listings as buyable (live complaint: all 3
links — an ended eBay item, a bot-blocked B&H page, and a discontinued Apple config — were
unavailable). The commerce answer contract (`src/agents/taskFrame.ts`) now requires the
agent to OPEN every candidate link (web.read, then browser.operate if blocked) and confirm
it loaded as a live product page for the item with a price + buy/in-stock signal; present
ONLY verified-live links; DROP error/404/sold/ended/blocked pages; and if NONE verify as
buyable, say so honestly and give the closest alternative it verified is available. The
commerce step budget was raised to 16 (search + open several candidates + synthesis); the
research contract stays lenient (minSourceReadToolCalls 0) so the run does not fail when
shops block scraping. Tests: `tests/commerceFraming.test.ts`.

Live proof `run_1782459979372_pnyn3pje`: the agent opened 9 pages (Apple, Amazon, BestBuy,
Ozon, eBay, B&H, CDW, ...) and returned an HONEST answer — "the 512 GB config is currently
not buyable (Apple discontinued it in March 2026 due to a DRAM shortage); here is the
closest VERIFIED-available configuration (M3 Ultra / 256 GB) with prices and links at Apple
($7,299) and Amazon" — and explicitly noted the eBay listings were removed/unverifiable
instead of presenting them as buyable. This is the correct outcome for a genuinely
discontinued config: verify + be honest, never present dead links.

Known intermittent reliability bug (separate follow-up): a heavy commerce run that opens
many pages can crash with `TypeError: Cannot read properties of undefined (reading 'slice')`
while processing a web.read result (observed on a 15-read run; the same 9-read task
completed fine). It is nondeterministic (depends on a page's response shape). Added a stack
trace log on run crash in `runs.service.ts` so the next occurrence is diagnosable; the fix
is to guard the read-result processing path. Track as its own task.
