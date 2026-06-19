# Active Task Specs

Status date: 2026-06-19.

This directory is the execution queue for the active Agentic roadmap. Each file is a
feature/task contract with four views:

- BA: what product behavior should exist and why it matters.
- Architect / tech lead: the proposed system design.
- QA: acceptance criteria and verification strategy.
- PM / feature owner: decomposed delivery plan.

When a task is completed, verified, documented, and merged, remove its file from this
directory and update this index plus `docs/roadmap-core-toolbelt.md`.

## Execution Order

Work from top to bottom unless a production blocker requires reordering:

1. [P1 Memory Continuity Model](03-p1-memory-continuity-model.md)
2. [P1 Tool Catalog Cleanup](04-p1-tool-catalog-cleanup.md)
3. [P2 External Action UX](05-p2-external-action-ux.md)
4. [P2 Model Routing](06-p2-model-routing.md)
5. [P3 Tool Builder Redesign](07-p3-tool-builder-redesign.md)

Cross-cutting gates apply to every task:

- [Code Hygiene And Documentation Discipline](08-cross-cutting-code-hygiene.md)

## Recently Completed

- 2026-06-19: P0 Ledger Recovery And Reuse was completed and its task file was removed.
  Implementation: `src/work-ledger/priorWorkResolver.ts`,
  `src/work-ledger/runtimePriorWork.ts`, `src/agents/baseAgentPriorWork.ts`, and
  BaseAgent wiring. Focused tests cover reuse, refresh, retry exclusions, and zero-tool
  source follow-ups. Manual durable smoke: `run_1781869705670_93qohg1o` created
  persisted `http.request` evidence in `thread_1781869705669_bj426305`; after backend
  restart, `run_1781870036522_1to9slex` answered the source follow-up from Ledger with
  zero new tool calls and visible `work-ledger-prior-context-*` events.
- 2026-06-19: P0 Simple Current Web Runs was completed and its task file was removed.
  Implementation: `src/agents/baseAgentCurrentFact.ts` plus BaseAgent wiring. Verification:
  `npm run verify` passed with 528 tests. Manual smokes:
  `run_1781863897402_6ntzkgym` for current fact without screenshot and
  `run_1781864151384_z8b9fzb9` for explicit screenshot proof.

## Current Owner Rule

The current agent working on the repo owns the next unfinished file in the queue. Before
starting implementation, read the relevant task file, `docs/agent-handoff.md`,
`docs/current-architecture.md`, and `AGENTS.md`.

## Completion Rule

A task is done only when:

- implementation is merged;
- `npm run verify` passes;
- at least one relevant manual run is executed through the user-visible UI/API surface;
- docs are updated;
- the task file is removed or replaced by follow-up task files with explicit ordering.
