# Agent Handoff

Status date: 2026-06-18.

## Active Base

Continue from the split rebuild branch, not from legacy monolithic branches.

- Current working branch: `codex/split-mainline`.
- Base branch: `codex/rewrite-from-agentic-main-next`.
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

`npm run verify` passed on 2026-06-18 from `codex/split-mainline` after the P0 fixes:
lint, typecheck, test typecheck, 493 unit tests, and build. After that checkpoint, the
preinstalled core toolbelt from `main` was ported onto the split BaseAgent branch and wired
into bootstrap through `createCoreToolbelt()`.

Recent P0 fixes:

- Explicit API/HTTP/JSON tasks that say not to screenshot no longer trigger visual proof
  repair. They can still save structured/source proof artifacts.
- Follow-up questions about prior answers can frame as `thread_context_answer` and answer
  from thread summary/facts/open questions instead of doing a fresh lookup.
- `src/agents/baseAgent.ts` is below the 800-line limit again; thread-context framing moved
  into `src/agents/baseAgentThreadContext.ts`.
- Preinstalled tools now exist on the split branch: `web.search`, `web.read`,
  `browser.operate`, `browser.screenshot`, `http.request`, `file.read`, `file.write`,
  `document.extract`, `data.transform`, `external.action.prepare`,
  `external.action.commit`, and `channel.telegram`.

## Current Priorities

P0:

- Make simple runs fast and correct.
- Keep proof policy proportional: screenshot proof for visual/current web tasks, structured
  proof for API/local utility tasks, and no visual proof when the user explicitly forbids it.
- Keep follow-ups from redoing work when thread context already contains the answer.

P1:

- Verify the full core toolbelt through the running API/UI and confirm all intended tools
  are offered to agents through metadata/readiness, not only present in code.
- Wire Work/Evidence Ledger records for BaseAgent tool calls, or fix the UI if records are
  being written but not shown.

P2:

- Simplify external-action approval/preparation so a user can ask for a booking/action and
  get one clear proposal, proof, one approval boundary, submit/commit, and final report.

P3:

- Reintroduce Tool Builder only after the core tool contract is stable. Generated tools
  must be out-of-tree portable packages/services, not app-specific code branches.

## Known Gaps

- Core toolbelt wiring has type/unit coverage, but still needs a running API/UI smoke to
  confirm metadata availability and agent catalog exposure.
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
