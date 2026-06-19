# P0 Simple Current/Web Runs

## BA View

### Problem

Simple factual tasks are still too expensive for the user experience. A request such as
"what is the Bitcoin price now?" should not feel like a broad research project. The agent
should get a current source, answer quickly, and attach proportional proof when useful.

### Desired Behavior

For narrow current/factual questions:

- use the smallest reliable tool path;
- avoid council, broad research, external action, builder, and long ReAct loops;
- return a concise answer with source, timestamp, and evidence;
- attach a screenshot only when the user asks for visual proof or the answer is based on
  a visual web page;
- finish even if the preferred screenshot fails, as long as structured source evidence is
  sufficient;
- expose every decision in Trace Lab.

### User Stories

- As a user, I can ask "какая цена биткоина сейчас?" and get an answer with source in a
  few seconds to tens of seconds, not a long research trace.
- As a user, I can ask "дай скриншот-пруф" and receive a focused screenshot if possible.
- As an operator, I can see why the run used `web.search`, `web.read`, or
  `browser.screenshot`, and why it stopped.

### Non-Goals

- Do not make a Bitcoin-specific pipeline.
- Do not hardcode specific crypto sites.
- Do not skip proof for tasks that explicitly ask for it.
- Do not make broad recommendation research shallow; this task is for narrow facts.

## Architect / Tech Lead View

### Proposed Solution

Add a narrow-current-fact execution lane before the general ReAct loop, similar in spirit
to the local utility fast path but using web/current-data tools.

Recommended shape:

- `taskFrame.mode` remains the classifier source of truth.
- Add a small helper such as `baseAgentCurrentFact.ts`.
- It activates only for narrow current facts, prices, status checks, or direct URL/source
  reads where the answer can be grounded by one or two sources.
- It never activates for broad recommendations, purchases, travel planning, medical/legal
  advice, or external actions.

Execution policy:

1. If the task explicitly names an API/JSON endpoint, prefer `http.request`.
2. If the task is a narrow current web fact, call `web.search`.
3. If search returns a concrete source URL and snippets are insufficient, call `web.read`.
4. If visual proof is requested or required by the task frame, call
   `browser.screenshot` once on the best source URL.
5. Return a concise answer with source URL, timestamp, and artifact metadata when present.

Proof policy:

- Structured API response is proof for API-only tasks.
- Search/read source text is proof for text-current tasks.
- Screenshot is preferred but not mandatory when structured evidence is strong and
  screenshot QA fails.
- Failed screenshots stay in UI for diagnostics but should not block the final answer
  unless the user explicitly required a screenshot as the primary deliverable.

Trace / Ledger:

- Emit `current-fact-fast-path-selected`.
- Record Work/Evidence Ledger items for every tool call.
- Emit `proof-skipped` or `proof-degraded` when screenshot proof fails but answer
  proceeds with source evidence.

### Likely Files

- `src/agents/taskFrame.ts`
- `src/agents/baseAgent.ts`
- new `src/agents/baseAgentCurrentFact.ts`
- `src/agents/baseAgentFinalization.ts`
- `src/agents/baseAgentArtifacts.ts`
- `tests/baseAgent.p0.test.ts` or new focused test file
- `docs/current-architecture.md`
- `docs/agent-handoff.md`

## QA View

### Acceptance Criteria

- Narrow current price/fact task completes without entering broad research mode.
- The run uses no more than the necessary web/API tools for the scenario.
- The final answer contains:
  - direct answer;
  - source name or URL;
  - current runtime date/time or source timestamp when available;
  - proof artifact or explanation why visual proof was not captured.
- If screenshot QA fails but source evidence is valid, the run completes with a clear
  proof limitation instead of failing or returning empty output.
- Trace Lab shows input/output for each tool.
- Work/Evidence Ledger shows passed evidence for the source/tool result.
- No generated tool builder path is invoked.

### Automated Tests

- Unit test: current fact with mocked `web.search` returns answer without LLM loop
  explosion.
- Unit test: screenshot requested and succeeds, artifact is attached.
- Unit test: screenshot fails QA, final answer still completes with source evidence and
  limitation note.
- Unit test: broad recommendation request does not enter this fast path.
- Regression test: API-only HTTP task still uses `http.request`, not web/browser.

### Manual Verification

Run through `npm run web` with the normal UI:

1. "Какая сейчас цена биткоина? Дай краткий ответ."
2. "Какая сейчас цена биткоина? Дай скриншот-пруф."
3. "Какая сейчас погода в Марбелье?" if search/read is available.
4. A broad laptop recommendation task to confirm it does not use this path.

For each run inspect:

- Run Workspace final answer and artifacts.
- Trace Lab timeline and graph.
- Ledger page scoped to the run.
- API response from `GET /api/runs/:id`.

## PM / Feature Owner View

### Delivery Plan

1. Audit current task-frame modes for narrow current facts.
2. Add or refine task-frame signal for `current_fact_narrow`.
3. Implement the current fact helper behind a conservative activation guard.
4. Wire it before the general ReAct loop and after API/local fast paths.
5. Implement proportional proof decision and degraded-proof completion.
6. Add trace events and ledger evidence checks.
7. Add automated tests.
8. Run UI/API manual smoke.
9. Update docs and remove or revise this task file.

### Rollout

- Keep the path conservative at first.
- If activation is uncertain, fall back to the existing bounded ReAct loop.
- Do not change broad research behavior in this task.

### Done When

- Simple current web runs are visibly shorter and still grounded.
- The BTC smoke run completes with source and optional proof.
- The old failure mode "screenshot failed, so answer disappeared" is gone.
