# Tool-build council architecture (Phase 14)

This document describes how tool creation, rework, and bug-fix
requests are processed end-to-end. It replaces the legacy "build
provider chain + background worker + build queue" pipeline.

## Principles

1. Only three primary entities exist in the system: `Agent`, `Tool`,
   and `LLM`. Everything else is a workflow composed of these three.
2. There is no separate "ToolBuildCoordinator" class. Tool building
   is a **mode of `UniversalAgent.run`** activated by a special
   strategy + system prompt.
3. The coding council is a set of LLMs read directly from
   `model_tier_settings.<tier>.models`. Operator selects only **which
   tier** acts as the council and how aggressive the loops are.

## End-to-end flow

```
USER (Tool builds page)
  fields: name · description · secretHandle? · qaCriteria[]
  kind:   "create" | "rework" | "bugfix"
  optional: existingToolName, bugContext
  ↓
POST /api/tool-build-runs
  body wraps the form as structured `toolBuildContext`.
  Creates a Run row with kind="tool_build" and stashes the context
  in the run metadata.
  ↓
RunsService.execute(run, options={ toolBuildContext, ... })
  ↓
UniversalAgent.run(task, options)
  ↓
decideAgentStrategy(input):
  if options.toolBuildContext present:
    primary = "tool_build_council"
    council = await codingCouncilStore.get(instanceId) → resolve models
              from model_tier_settings.<tier>.models
  ↓
UniversalAgent.runToolBuildCouncil(context, council):
  ┌── 1. brainstorm
  │     parallel  llm.complete(model=m, brainstormPrompt) for each m in council
  │     event:    tool-build-brainstorm-proposal per model
  ├── 2. vote
  │     parallel  llm.complete(model=m, votePrompt(allProposals))
  │     aggregate Borda scores → winner (tie-break: most-concrete
  │     proposal as judged by coordinator deterministic heuristic)
  │     event:    tool-build-vote-cast per model, tool-build-council-winner-selected
  ├── 3. implement
  │     llm.complete(model=winner.model, implementPrompt(winner.proposal,
  │                                                       userTask, qaCriteria))
  │     write module to tools/<name>/<version>/{src/server.ts, package.json,
  │                                              Dockerfile, README.md}
  │     event:    tool-build-code-drafted
  ├── 4. register (inactive)
  │     MetadataToolRegistrar.register({source:'generated', active:false, ...})
  ├── 5. review
  │     parallel  llm.complete(model=m, reviewPrompt(code, proposal, userTask))
  │              for each m in council \ winner
  │     event:    tool-build-code-review-cast per model
  ├── 6. revise  (skip if all reviews unanimously pass)
  │     llm.complete(model=winner.model, revisePrompt(code, reviews))
  │     repeat ≤ maxRevisionAttempts
  │     event:    tool-build-code-revised
  ├── 7. qa
  │     synthesize a small input matching qaCriteria
  │     ToolsService.runToolManually(name, syntheticInput)
  │     llm.complete(modelTier=M, qaOraclePrompt(output, qaCriteria))
  │     event:    tool-build-qa-attempt (status: passed|failed, output, oracleVerdict)
  ├── 8. repair  (if qa failed)
  │     llm.complete(model=winner.model, repairPrompt(code, qaFailure))
  │     ↩ back to step 7. repeat ≤ maxQaRepairAttempts
  └── 9. finalize
        - winner generates 2-3 example payloads
        - MetadataToolRegistrar.activateVersion(name, version)
        - run.complete with {registeredToolName, version}
        event:   tool-build-registered
```

## Settings

Table `coding_council_config` (single row per instance):

| column | default | range |
|---|---|---|
| tier | `L` | S/M/L/XL |
| max_revision_attempts | 3 | 1–10 |
| max_qa_repair_attempts | 5 | 1–10 |
| qa_timeout_ms | 30000 | 1000–600000 |
| brainstorm_system_prompt | null | optional override |

Council members = `model_tier_settings.<tier>.models` (already an
array — operator adds models via existing /api/model-tier-settings).

API:
```
GET  /api/settings/coding-council          → returns config
PUT  /api/settings/coding-council          → updates with clamping
```

UI: new "Coding Council" section on the Settings/Modules page.

## Voting (Borda count)

Each council voter ranks proposals 1..N. Top-1 = (N-1) points, top-2
= (N-2) points, … bottom = 0 points. Winner = highest aggregate.

Tie-break: deterministic coordinator heuristic
1. Proposal with fewer external dependencies listed wins.
2. Proposal with shorter package list wins.
3. Lexicographic by proposal id (stable, reproducible).

## Persistence model

- No new run "type" column. Runs already store arbitrary task text;
  the toolBuildContext lives in `metadata` and is rehydrated by
  `RunsService` on resume.
- All council events are normal run events with structured payloads,
  so the run timeline and trace lab work without changes.
- The legacy `tool_build_requests` table stays as a **read-only**
  history surface for "what got built and when". Build operations
  no longer use it; the runtime writes a row alongside the run for
  list/search purposes.

## Code map

### Adds (Phase A → F)

| file | role |
|---|---|
| `src/db/migrate.ts` (table) | new `coding_council_config` |
| `src/settings/codingCouncilStore.ts` | CRUD + defaults + clamping |
| `tests/codingCouncilStore.test.ts` | store unit |
| `src/server/modules/settings/coding-council.controller.ts` + `.module.ts` | GET/PUT API |
| `src/agents/toolBuildCouncil.ts` | Borda + prompt builders (pure functions) |
| `tests/toolBuildCouncilBorda.test.ts` + `tests/toolBuildCouncilPrompts.test.ts` | helper units |
| `src/agents/universalAgent.ts` (extend) | `runToolBuildCouncil` method + strategy hook |
| `tests/universalAgentToolBuildCouncil.test.ts` | end-to-end with FakeLlm |
| `src/server/modules/tool-build-runs/*` | POST/GET endpoints |
| `web-react/src/routes/ToolBuilds.tsx` (rewrite) | form + list of tool-build runs |
| `web-react/src/routes/ToolBuildRun.tsx` (new) | run detail timeline |
| `web-react/src/routes/Settings.tsx` (extend) | Coding Council section |

### Deletes (Phase G — only after F passes live smoke)

| file | reason |
|---|---|
| `src/tools/toolBuildProviders.ts` | replaced by council LLM calls |
| `src/tools/messagingServiceToolBuildProvider.ts` | same |
| `src/tools/llmToolBuildProvider.ts` | same |
| `src/tools/toolBuildReviewers.ts` | replaced by council review step |
| `src/tools/toolBuildWorkflow.ts` | replaced by UniversalAgent inline flow |
| `src/tools/toolBuildWorker.ts` | each build is a normal run; no background queue |
| `src/tools/toolPackageWorkspaceQa.ts`, `toolPackageWorkspaceStore.ts` | workspace flow no longer needed |
| `tests/toolBuildProviders.test.ts`, `toolBuildReviewers.test.ts`, `toolBuildWorkflow.test.ts`, `toolBuildProviderSelection.test.ts`, `toolBuildOutputCoverage.test.ts`, `toolBuildInputFinalizer.test.ts` | cover deleted code |
| `src/server/modules/tool-builds/` (queue-style endpoints) | replaced by `/api/tool-build-runs` |

### Keeps

- `src/tools/toolBuildRequestStore.ts` — read-only history table.
- `src/tools/toolMetadataStore.ts`, `MetadataToolRegistrar` — final register/activate.
- `src/tools/toolPackageRunner.ts`, `OciImageToolPackageRunner` — runs the registered tool.

## Test strategy

Unit:
* `tests/codingCouncilStore.test.ts` — defaults, clamping, tier validation, prompt overrides.
* `tests/toolBuildCouncilBorda.test.ts` — vote math, tie-break, single-voter edge case.
* `tests/toolBuildCouncilPrompts.test.ts` — brainstorm/vote/implement/review/revise/repair prompt strings include the required slots.

Integration (FakeLlm fixture):
* `tests/universalAgentToolBuildCouncil.test.ts` — 2-model council, canned brainstorm proposals (different shapes), canned votes (one wins), canned implement → mock saveFile → review (one passes, one finds issues) → revise → QA pass → finalize. Asserts the full event sequence and the final registered tool record.

Live smoke (Phase F, after deploy):
1. Settings → set tier=L (both models from `model_tier_settings.L.models` become council).
2. POST a tool-build run with `name=demo.echo, description="echo input as content"`.
3. Watch run events: ≥2 brainstorm proposals, ≥2 vote casts, 1 winner, code drafted, ≥1 review, optional revise, qa pass, registered.
4. Open `/tools/demo.echo` → Manual Run → returns expected output.
5. Submit a rework request via the same endpoint with `existingToolName=demo.echo, bugContext="returns wrong field"`. Watch the same loop produce a new version.

Final delete (Phase G): run full `npm run verify` to confirm nothing else depended on the legacy build chain.
