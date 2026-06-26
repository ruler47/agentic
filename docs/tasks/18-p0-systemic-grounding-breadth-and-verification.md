# P0 Systemic Grounding: Frame Detector + Universal Verification + Breadth/Replan

## Status

- Owner: Claude (collaborating with Codex via this queue).
- Status: spec ready (decisions locked), implementation not started.
- Date: 2026-06-26.
- Branch: integrates to `main`, shipped in independently-verifiable steps.
- Source: live failures `run_1782420661004_uw40pnu2`, `run_1782421416298_2kkuuok3`,
  `run_1782459979372_pnyn3pje`, and the user directive **"делай системные решения, а не
  под конкретный кейс"** + **"он всегда действует в лоб; хочу чтобы перебирал десятки
  ссылок по разным площадкам и, поняв что в лоб не найти, придумывал стратегию"**.
- Supersedes the case-specific parts of task 17 (FR-1/FR-3/FR-4 commerce patch, commit
  `07b258e`): that work is folded into general mechanisms here and its bespoke code is
  removed (see §10).

## 1. Idea And Measurable Increment

### Problem (four compounding, all systemic)

Four live failures share one root cause: behavior is driven by **hand-written keyword
allowlists** and by **answer-contract prose the runtime never enforces**, instead of by
general mechanisms over evidence the runtime already tracks.

1. **Regex framing zoo.** `src/agents/taskFrame.ts` routes tasks through ~10 closed
   RU/EN keyword/regex predicates — `taskNeedsCurrentExternalData` (bitcoin/price/weather/
   news, `taskFrame.ts:96`), `taskNeedsCommerceLookup` (buy/where-to-buy, `taskFrame.ts:111`),
   the intent cascade `selectionIntent`/`budgetOrTradeoff`/`broadResearchIntent`/
   `localServiceSelection`/`currentNeed` incl. a literal `202\d` year token
   (`taskFrame.ts:230-241`), plus file-utility proximity regexes (`taskFrame.ts:811`).
   Each new failure → another regex. This is the anti-pattern the project forbids
   (domain-specific keyword pipelines, `AGENTS.md`).
2. **Memory-based existence denial.** A real shipping product was declared "не существует"
   from training memory with zero search (`run_1782420661004`). The zero-research existence
   guard only exists implicitly via the keyword predicate.
3. **Unverified / dead links.** FR-4 ("OPEN every link before presenting it") lives ONLY as
   answer-contract prose (`taskFrame.ts:567-587`) that the model may ignore.
   `determineFailure` (`baseAgentEvidence.ts:274`) has **no** check that a presented URL was
   actually opened/passed this run, so dead/sold/403 links were presented as buyable
   (`run_1782459979372`).
4. **Head-on, shallow research (the biggest one).** The agent does one shallow pass and
   stops: on a grounding-hard run it emitted 30 `source-discovered` events but opened only
   9 pages (`web.read`) + 1 `browser.operate`, recorded 7 reads, `metrics.toolCalls=16`. It
   never goes broad across platforms and never re-plans strategy when the direct approach is
   blocked/low-yield. The one-shot repair (`baseAgentSourcePlanRepair.ts`) only fires on a
   mixed-language heuristic, not on generic low yield.

### Measurable Increment

- **Observability:** every run exposes `researchCoverage {discovered, opened, verified,
  blocked, duplicate, distinctDomains, sourceClassesCovered, replans}` as first-class run
  metrics — the "found 30 / opened 9 / verified 7" split is read off a number, not
  reconstructed from raw events.
- **Verification is enforced, not advised:** a final answer that presents a URL the run did
  not open/pass is dropped or flagged by a deterministic guard (with a blocked-source
  honesty escape hatch so shop 403s do not fail useful runs).
- **No memory denials:** existence/price/availability assertions with zero successful
  research are blocked by a deterministic guard, independent of any keyword list.
- **Breadth + strategy:** grounding-hard runs open **many** sources across **several source
  classes** (official / retailer / marketplace / used / regional / forum, as generic tags —
  never named sites), and when yield is low or coverage short with budget remaining, the run
  **re-plans** (reformulate, switch source-class, switch language) instead of finishing.
- **Regex zoo shrinks:** the freshness/commerce/intent predicates are replaced by one
  `assessExternalGrounding` detector + one contract composer; the task-17 commerce patch is
  deleted.

### Non-Goals

- No hardcoded product/brand/site lists; source classes stay a small generic tag set.
- Not the full retirement of every regex in `taskFrame.ts` in one change — the tool-lifecycle
  (`isToolLifecycleOnlyTask`), local-utility (`looksLikeLocalUtilityTask`), and per-mode
  budget table are explicitly deferred (§10) to bound blast radius to the four failures.
- Not LLM-based **enforcement**: every pass/fail gate stays a deterministic counter.

## 2. Decisions (locked with the user)

- **Framing depth: Hybrid (deterministic-first + bounded LLM fallback).**
  `assessExternalGrounding` resolves the clear majority structurally (entity + present-state
  assertion; year tokens resolved against injected `currentDate`); a bounded, cached,
  typed-schema LLM classification fires **only** on low-confidence cases to close the
  unbounded-phrasing/-language gap (e.g. "Is the Foobar X1 out yet?" with no keywords). The
  LLM is **advisory** to the frame; it can at worst mis-size a contract and can never
  authorize finishing without verification, because the enforcement guards fire regardless.
- **Breadth default: Moderate.** Coverage target is **derived**, never a magic constant:
  open ≥ N distinct sources across ≥ K source-classes, with `N ≈ half the remaining read
  budget`, `K ≈ 3`, scaled by `breadthNeed`/`researchDepth` and bounded by `maxToolCalls`
  (`baseAgent.ts:64`). Stop early on saturation (new-distinct-source rate ≈ 0). Tune upward
  from the new observability rather than guessing high. The target counts verification
  **attempts** (incl. blocked reads) + search-confirmed sources, **not only** successful
  page reads — otherwise it recreates the exact 403-fail regression the commerce
  `minSourceReadToolCalls:0` relaxation was created to avoid (`taskFrame.ts:589-598`).

## 3. Use Cases, Weak Spots, Edge Cases

### Happy paths
- "найди где купить [product]" → grounding-hard, actionable-links deliverable → broad search
  across source classes → opens many candidates → presents only verified-live buy links →
  honest fallback if none verify.
- "Is the Foobar X1 out yet?" (keyword-free, ambiguous) → structural signal low-confidence →
  bounded LLM fallback flags freshness → search before answering existence.
- "сравни X и Y без интернета" → no-external-grounding → stays local, no pointless web.

### Weak spots / failure modes
- Detector under-inclusive → reopens failure 2; over-inclusive → needless lookups on
  stable/historical facts (cost). Year handling must be relative to `currentDate`, not a
  decade regex.
- Breadth too aggressive → cost/latency blowup; too timid → failure 4 unfixed. Mitigated by
  derived (not constant) target + saturation stop + the moderate default.
- Presented-URL guard depends on extracting URLs from free-form answers and normalizing them
  (`normalizeSourceUrl`, `sourceRegistry.ts:45`) — tracking params/redirects/trailing
  punctuation risk false fail/pass.
- Over-strict verify gate re-introduces the 403 regression — the blocked-status escape hatch
  + counting attempts (not only passed reads) + replan-to-different-source-class are
  load-bearing and must key off `readStatusFromToolResult` blocked-vs-failed.

### Observability
- One `research-coverage-summary` event at finalization + the metrics projection. Each
  replan emits `agent-source-search-plan-repair-requested` with the trigger reason.

## 4. Spec

### Functional requirements
- **FR-1 Grounding detector.** `assessExternalGrounding(task, currentDate) ->
  {needsFreshLookup, deliverableKind: fact|ranked|actionable-links, breadthNeed, confidence}`.
  Deterministic-first; bounded+cached+typed LLM classification only when structural
  confidence is low. Output is advisory input to deterministic gates/contracts. No keyword
  allowlists.
- **FR-2 Contract composer.** A pure `FrameSignals -> TaskFrame` composer assembles
  `answerContract`/`researchContract` from frame dimensions and carries ONE domain-free
  Universal Verification Principle: *"any externally-checkable claim or presented resource
  must be backed by evidence acquired THIS run."* New domains add a dimension value, not a
  branch or a prose block.
- **FR-3 Verify gate (enforced).** In `determineFailure`: any URL the final answer presents
  as a source/buy link that is not in the run's opened/passed evidence set (RunSourceRegistry
  passed reads / `externalEvidenceUrls` / `proofEvidenceByUrl`) is dropped/flagged. Escape
  hatch: URL opened but `readStatus==='blocked'` → keep + disclose "could not verify live
  (blocked)", do NOT hard-fail.
- **FR-4 Existence guard (enforced).** Existence/price/availability asserted with
  `successfulResearchToolCalls === 0` → blocked (generalizes `missingExternalDataEvidence`,
  `baseAgentEvidence.ts:309`, beyond the keyword set).
- **FR-5 Breadth budget.** A derived coverage target on `TaskFrame`, enforced as a
  `ResearchContractGap`-shaped deterministic deficit reusing the `shouldRequireResearchContract`
  pattern (`taskFrame.ts:711`); counts attempts (incl. blocked) + search-confirmed sources;
  bounded by `maxToolCalls`; replaces the fixed `minSourceReadToolCalls=1` reliance.
- **FR-6 Adaptive replan.** Keyed on GENERIC RunSourceRegistry signals: run-level yield
  (blocked+empty+duplicate fraction over a sliding window) and saturation (new-distinct rate
  ≈ 0). On low yield / short coverage with budget remaining: reformulate from observed
  entities, switch SOURCE-CLASS (official→retailer→marketplace→used→regional→forum generic
  tags), switch language. Generalizes `requestSourceSearchPlanRepair`.
- **FR-7 Observability.** Aggregate existing `source-discovered`/`source-read-recorded`/
  `source-rejected` + RunSourceRegistry into run-level `researchCoverage{...}`; expose in the
  run metrics projection and a `research-coverage-summary` finalization event.

### Acceptance criteria
- `assessExternalGrounding` (LLM mocked): commerce/where-to-buy/price/"is X out yet" →
  `needsFreshLookup=true`; "2+2", "сравни X и Y без интернета" → false.
- `determineFailure`: never-opened presented URL → fail; blocked-but-opened URL → pass with
  disclosure; passed URL → pass; existence/price claim + 0 research → blocked.
- A 30-discovered/9-opened registry → coverage-short deficit; low-yield window → replan with
  source-class switch; saturation → stop.
- Run metrics expose `researchCoverage`.
- Live re-run of the four failing tasks shows broad+replan behavior in `researchCoverage` and
  no memory denial / no unverified link.

### Out of scope
- Deferred regexes in §10; full-LLM framing; product-specific knowledge.

## 5. Architecture

- **Decision vs enforcement separation is the invariant.** DECISION (how much to research,
  what answer shape) may be LLM-assisted; ENFORCEMENT (`shouldRequireResearchContract`,
  `determineFailure`) stays pure arithmetic over evidence sets the runtime already tracks. A
  hallucinated frame can at worst mis-size a contract — it can never authorize finishing
  without verification.
- **Build on existing substrate, do not reinvent:** `RunSourceRegistry`
  (`sourceRegistry.ts:41` — records discovered/passed/blocked/failed per URL + `sourceType` +
  `qualityScore` + `readAttempts`), `classifySourceType`/`sourceQualityScore`,
  `source-*` events (`baseAgentSourceEvents.ts`), the run metrics projection, the
  `ResearchContractGap` deficit pattern, and `maxToolCalls` (`baseAgent.ts:64`).
- Framing stays in `taskFrame.ts` (detector + composer replace the predicate ladder). Guards
  live at the finalization/return-gate boundary in `baseAgentEvidence.ts` /
  `baseAgentFinalization.ts`. Breadth/replan is a controller over RunSourceRegistry.

## 6. Low-Level Plan

See §4 FRs for the units. Key files: `src/agents/taskFrame.ts` (detector, composer, breadth
target, delete predicates), `src/agents/baseAgentEvidence.ts` (FR-3/FR-4 guards),
`src/agents/baseAgentFinalization.ts` (wire guards + coverage summary),
`src/agents/sourceRegistry.ts` (yield/saturation/coverage accessors),
`src/agents/baseAgentSourcePlanRepair.ts` (generalize trigger),
`src/agents/baseAgentSourceEvents.ts` (derive the 12-discovery cap from budget), the run
metrics projection (add `researchCoverage`). LLM classifier behind an injectable interface,
mocked in tests.

## 7. Test Plan

Automated (each step ships verify-green):
- `assessExternalGrounding` dimension tests (LLM mocked) — happy + edge phrasings + no-false-fire.
- Verify-gate table tests: never-opened / blocked-but-opened / passed.
- Existence-guard tests: claim + 0 research blocks; with research allowed.
- Coverage/yield/saturation unit tests off synthetic RunSourceRegistry streams.
- Replan trigger tests: low yield → source-class switch; saturation → stop.
- Rewrite `tests/commerceFraming.test.ts` as dimension/guard assertions.

Manual (definition-of-done): `npm run verify` exit 0; POST `/api/runs` on the four failure
tasks incl. "найди где купить apple studio m3 ultra 512gb" and a keyword-free "Is the Foobar
X1 out yet?"; confirm `researchCoverage` reflects broad+replan and no unverified link / no
memory denial; tune N/K from observed data.

## 8. Delivery Steps (observability-first, each independently shippable + verify-green)

1. **Observability.** Aggregate `researchCoverage` over existing `source-*` events +
   RunSourceRegistry; expose in run metrics + a `research-coverage-summary` finalization
   event. No behavior change — gives baseline data to tune later budgets. Unit-test off a
   synthetic event stream.
2. **Verify gate (FR-3)** in `determineFailure` as a pure function over the final answer +
   RunSourceRegistry passed reads, with the blocked-source escape hatch. Closes failure 3
   generally; lets the task-17 FR-4 prose contract start to be deleted.
3. **Existence guard (FR-4)** generalizing `missingExternalDataEvidence`, still keyed off the
   existing keyword predicate for now so it ships green (de-risks step 4 by separating gate
   from detector).
4. **Detector + composer (FR-1/FR-2)**; route `frameTaskCore` through them; delete
   `taskNeedsCommerceLookup`, the commerce contract branch, `taskNeedsCurrentExternalData`,
   `currentNeed`/`202\d`, the intent cascade, the `.test(reason)` budget hack; rewrite
   `tests/commerceFraming.test.ts`. Guards a/b re-key off the detector. Verify green with LLM
   mocked.
5. **Breadth budget (FR-5)** as a `ResearchContractGap` deficit; remove the fixed
   `minSourceReadToolCalls=1` reliance; bound by `maxToolCalls`; count attempts +
   search-confirmed. Ship behind the moderate default.
6. **Adaptive replan (FR-6)** consuming yield/saturation; derive the 12-per-search discovery
   cap from the coverage budget.
7. **Live smoke + tune** per §7.

## 9. Risks

Carried verbatim from the design synthesis: classifier reliability on the ambiguous tail
(mitigated — determinism lives in the gates); defining "entity + present-state assertion"
without sliding back into a keyword list; N/K and yield/saturation thresholds drifting into
new magic constants (must be formula-derived); URL normalization mismatches in the verify
gate; over-strict gate re-introducing the 403 regression (escape hatch + count-attempts +
replan are load-bearing); `classifySourceType` taxonomy coarseness weakening the class-cover
proxy; breadth controller raising per-run latency/cost by design (needs a visible budget +
saturation stop).

## 10. What This Removes / Defers

Removed (folded into general mechanisms):
- `taskNeedsCommerceLookup` (`taskFrame.ts:111`) + the ~70-line commerce answer contract
  branch (`taskFrame.ts:527-599`, commit `07b258e`) + the `/where to buy a product/.test(
  taskFrame.reason) => 16` budget hack (`taskFrame.ts:85`) + `tests/commerceFraming.test.ts`.
- `taskNeedsCurrentExternalData` bitcoin/weather/news regex (`taskFrame.ts:96`).
- `currentNeed` temporal list incl. `202\d` (`taskFrame.ts:232`); the intent cascade
  `selectionIntent`/`budgetOrTradeoff`/`broadResearchIntent`/`localServiceSelection`
  (`taskFrame.ts:230-241`).
- The one-shot mixed-language-only `requestSourceSearchPlanRepair` trigger
  (`baseAgentSourcePlanRepair.ts`); the fixed 12-per-search discovery cap
  (`baseAgentSourceEvents.ts:112`).

Deferred (next wave, NOT this change): `isToolLifecycleOnlyTask` (`taskFrame.ts:91`),
`looksLikeLocalUtilityTask` (`taskFrame.ts:811`), the per-mode budget table
(`taskFrame.ts:80-88`), `baseAgentToolScope.ts` regex scoping.

## Progress

- **Step 1 (observability) — done, pushed (b577374).** `researchCoverage{discovered, opened,
  verified, unavailable, blocked, failed, duplicate, distinctDomains, sourceClassesCovered,
  replans}` on `run.metrics`, projected from the source-* event stream.
- **Step 2a (availability signal) — done, pushed (4395f47).** `src/tools/pageAvailability.ts`
  `extractPageAvailability(html)` → in_stock | out_of_stock | unknown from web standards
  (schema.org Offer.availability, disabled add-to-cart) + a small EN/RU stock-status phrase
  fallback; `web.read` attaches `data.availability`; the agent injects an explicit AVAILABILITY
  verdict into the model's tool message; `researchCoverage.unavailable` counts opened
  out-of-stock pages.
- **Live end-to-end verification (2026-06-26).** Re-ran "найди где купить apple studio m3
  ultra 512 gb" on the durable stack (after restarting it onto the fixed code AND killing a
  recurring `python -m http.server 8080` squatter that was shadowing searxng on host IPv4 and
  making `web.search` 404 — see project memory). Result `run_1782479898453_wrggxf37`:
  completed (no `.slice` crash), discovered 28 / opened 15 / 23 domains; returned FIVE concrete
  512GB buy links at third-party retailers (Apple discontinued the 512GB config). Independent
  re-fetch of all five: 2 genuinely in_stock + 512GB (upgadget.ru, my-apple-store.ru), 1 live
  (asbis.ua), 1 out_of_stock that the agent honestly labelled "coming soon" (rifastore.ru), 1
  unreachable from the test host (store-apple.msk.ru — possible over-claim of "in stock"). A
  large improvement over the earlier "all 3 links dead" failure.
- **Still open (steps 3–6):** the deterministic block-the-run verify gate (existence +
  presented-URL + out-of-stock), the frame detector/composer that deletes the regex zoo, and
  the breadth budget + adaptive replan controller. Live coverage still shows
  `sourceClassesCovered: 2` and `replans: 0` — breadth/strategy is not yet systemically forced.
