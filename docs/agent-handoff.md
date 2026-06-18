# Agent Handoff

Status date: 2026-06-18.

## Active Base

Continue from `main`. It has been updated to the split rebuild runtime and should be the
new primary branch.

- Current primary branch: `main`.
- Merge commit: `cac5b9d` (`Merge split BaseAgent mainline with core toolbelt`).
- Preserved source branch: `codex/split-mainline`.
- Split base branch: `codex/rewrite-from-agentic-main-next`.
- Active runtime: `BaseAgent`.
- Active roadmap: `docs/roadmap-core-toolbelt.md`.

Do not use `claude/phase17-research-delegation` as the active base. It was audited on
2026-06-18 and still contains a legacy `src/agents/universalAgent.ts` above 9k lines plus
legacy Tool Builder paths. It may contain ideas or test references, but it should not be
merged wholesale into the split rebuild.

## Product Philosophy

Agentic is being reset around a stable universal agent plus a preinstalled portable
core toolbelt. The tool builder is paused until the base agent can reliably solve real
tasks with stable first-party tools.

Core tools are not hardcoded private pipelines. They should use the same manifest,
schema, version, runner, settings, secret-handle, artifact, health, and trace contracts
that generated tools will use later.

## Current Verified State

`npm run verify` passed on 2026-06-18 from `main` after merging the split runtime:
lint, typecheck, test typecheck, 506 unit tests, and build. The final `main` tree matches
the verified `codex/split-mainline` tree and is pushed to `origin/main`.

Recent P0 fixes:

- Explicit API/HTTP/JSON tasks that say not to screenshot no longer trigger visual proof
  repair. They can still save structured/source proof artifacts.
- Follow-up questions about prior answers can frame as `thread_context_answer` and answer
  from thread summary/facts/open questions instead of doing a fresh lookup.
- `src/agents/baseAgent.ts` is below the 800-line limit again; thread-context framing moved
  into `src/agents/baseAgentThreadContext.ts`.
- Preinstalled tools now exist on the primary branch: `web.search`, `web.read`,
  `browser.operate`, `browser.screenshot`, `http.request`, `file.read`, `file.write`,
  `document.extract`, `data.transform`, `external.action.prepare`,
  `external.action.commit`, and `channel.telegram`.

## Current Priorities

P0:

- Confirm the running API/UI exposes the core toolbelt to agents: metadata, readiness,
  manual run, agent run, trace input/output, and artifact handling.
- Make simple runs fast and correct in practice: API/local utility tasks should use the
  direct core-tool path, avoid browser/search when unnecessary, and finish with structured
  proof instead of screenshots.
- Keep proof policy proportional: screenshot proof for visual/current web tasks,
  structured proof for API/local utility tasks, and no visual proof when the user
  explicitly forbids it.

P1:

- Conversation and memory continuity: follow-ups should reuse thread facts/artifacts;
  run memory should know already completed steps; user/group profile memory should be
  visible to the agent without polluting every prompt.
- Work/Evidence Ledger records for BaseAgent tool calls: either wire missing writes or fix
  the UI if records exist but are not shown.
- Code hygiene: keep active files near the 800-line target, and prune/freeze builder code
  that is not needed for the core-toolbelt phase.

P2:

- Simplify external-action approval/preparation so a user can ask for a booking/action and
  get one clear proposal, proof, one approval boundary, submit/commit, and final report.
- Model routing: resolve from available local/remote providers by tier plus required
  capability flags such as vision, reasoning, coding, tool-calling, context window, and
  operator preferences.

P3:

- Redesign Tool Builder only after the core tool contract is stable. Generated tools must
  be out-of-tree portable packages/services, not app-specific code branches.

## Known Gaps

- Core toolbelt wiring has type/unit coverage, but still needs a running API/UI smoke from
  the updated `main` branch to confirm metadata availability and agent catalog exposure.
- External actions remain too hard to understand from the UI and still stop too early in
  ordinary approval mode.
- Work/Evidence Ledger cards on tested runs showed zero records despite tool activity.
- Four files remain slightly above the preferred 800-line limit:
  `src/server/modules/runs/action-proposal-preparation-runner.ts`,
  `tests/actionProposalPreparationRunner.test.ts`,
  `src/server/modules/runs/runs.service.ts`, and `tests/nestApi.test.ts`.

## Rules For Next Agents

- Do not restore legacy `/api/tool-build-*`, `/api/tool-investigations`, or
  `/api/tool-rework-waits` as ordinary fixes.
- Do not reintroduce `UniversalAgent` as the active runtime.
- Keep generated or imported tool implementations out of Agentic app source unless they are
  deliberately promoted as first-party core packages.
- Update `AGENTS.md`, this handoff, and `docs/roadmap-core-toolbelt.md` whenever architecture,
  command, or roadmap decisions change.
