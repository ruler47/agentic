# Cross-Cutting Code Hygiene And Documentation Discipline

## BA View

### Problem

The product has moved through several rewrites. Old code, old docs, and oversized files
make every next feature slower and riskier. The user explicitly wants maintainable code
and current documentation.

### Desired Behavior

- Active files stay near the 800-line limit.
- Dead legacy paths are not restored.
- New features are covered by tests and manual UI/API smoke.
- Roadmap and handoff docs remain current.
- Generated tool implementations stay out of tracked app source unless deliberately
  promoted as first-party packages.

### User Stories

- As an owner, I can hand the repo to another AI agent and it can understand the active
  base quickly.
- As a developer, I can modify a feature without opening 2,000-line files.
- As a tester, I can see what was verified and what remains risky.

## Architect / Tech Lead View

### Rules

- Keep TypeScript/TSX files below 800 lines unless there is an explicit temporary reason.
- Split by responsibility, not by arbitrary line count.
- Prefer existing patterns and stores.
- Do not restore legacy Tool Builder endpoints or `UniversalAgent`.
- Do not stage unrelated worktree files such as `.claude/worktrees/`.
- Every architectural change updates:
  - `AGENTS.md`;
  - `docs/agent-handoff.md`;
  - `docs/current-architecture.md`;
  - `docs/roadmap-core-toolbelt.md`;
  - active task file in `docs/tasks`.

### Current Known Oversized Files

- `src/server/modules/runs/action-proposal-preparation-runner.ts`
- `tests/actionProposalPreparationRunner.test.ts`
- `src/server/modules/runs/runs.service.ts`
- `tests/nestApi.test.ts`

These should be split when touched by related work.

## QA View

### Acceptance Criteria

- `npm run verify` passes before completion.
- `git diff --check` passes.
- New/changed behavior has automated tests.
- Relevant user-visible surface is manually smoke-tested.
- Docs accurately describe the implemented behavior.
- No unrelated/untracked files are staged.

### Manual Verification Checklist

For each feature task:

1. Run focused tests.
2. Run `npm run verify`.
3. Start `npm run web`.
4. Execute at least one realistic API/UI run.
5. Inspect Run Workspace, Trace Lab, Ledger, and artifacts when relevant.
6. Stop dev server.
7. Check `git status --short`.

## PM / Feature Owner View

### Delivery Plan

This task is not a separate feature phase. It is a gate on every phase:

1. Before coding, identify touched ownership boundaries.
2. During coding, split files when the touched file is already above the limit or the
   change would push it there.
3. Before final answer, run automated and manual verification.
4. Before merge, update docs and active task file.
5. After merge, remove completed task docs or convert remaining work into follow-up
   task specs.

### Done When

- The repo stays understandable while features ship.
- Documentation remains a reliable handoff surface.
- The active roadmap and task queue do not drift.
