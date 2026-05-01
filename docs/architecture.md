# Universal Agent Architecture

## Goal

The universal agent is not a giant agent that tries to keep every detail in one context.
It is a coordinator that owns the original user task, delegates narrow work to specialist
agents, reviews their outputs, and produces one final answer.

## Core Rule

One user request equals one concrete task.

If the request contains many unrelated goals, the coordinator should ask the user to choose
one task or split it into separate runs.

## Components

### Coordinator

Owns the user-facing result.

Responsibilities:

- Understand the task.
- Decide direct vs delegated mode.
- Select relevant skill-memory entries.
- Create a subtask plan.
- Dispatch workers.
- Dispatch reviewers for risky outputs.
- Synthesize final answer.
- Store reusable lessons in skill memory.

### Worker Agent

Owns exactly one subtask.

Examples:

- Research population of Spanish cities.
- Research airport access and Ukrainian community signals.
- Implement chess variant move logic.
- Build UI for a crypto-themed chess game.
- Review generated code for correctness.

Worker context should be small:

- Original task summary.
- The worker's subtask.
- Relevant memory entries.
- Expected output format.
- Review criteria.

### Reviewer Agent

Checks one worker result.

Review focus:

- Unsupported claims.
- Missing evidence.
- Incorrect assumptions.
- Incomplete code or tests.
- Contradictions with original task.

### Skill Memory

Long-term shared memory for reusable operational knowledge.

Stores:

- Title.
- Tags.
- Short summary.
- Reusable procedure.
- Creation date.

It should not store whole task transcripts. It stores compressed lessons that future agents
can scan before starting.

## Execution Flow

```text
User gives one task
  |
  v
Coordinator searches skill memory
  |
  v
Coordinator classifies complexity
  |
  +-- direct mode -----> Coordinator answers -> store lesson
  |
  +-- delegated mode --> Planner creates subtasks
                        |
                        v
                      Workers run in parallel
                        |
                        v
                      Reviewers run in parallel
                        |
                        v
                      Coordinator synthesizes
                        |
                        v
                      Store reusable lesson
```

## Delegation Heuristics

Use direct mode when:

- The task is narrow.
- No current facts are required.
- No codebase inspection is required.
- The answer can be produced with high confidence in one context.

Use delegated mode when:

- The task has multiple domains.
- Research and implementation are both needed.
- The task may consume a large amount of context.
- Independent checks would materially improve quality.
- The task requires both creation and review.

## Example: Spanish Cities

Task:

> Top 5 Spanish cities by population, sorted by distance to sea.

Likely direct or small delegated task.

Task:

> Find Spanish cities considering population, developed IT sector, Ukrainian community,
> airport access, and distance to sea.

Delegated plan:

- Worker A: population and geography.
- Worker B: IT sector signals.
- Worker C: Ukrainian community and immigration signals.
- Worker D: airport connectivity.
- Reviewer: check comparability and missing evidence.
- Coordinator: rank cities with assumptions.

## Example: Crypto Chess

Task:

> Build a chess variant where piece importance maps to top crypto coins by market cap.

Delegated plan:

- Worker A: crypto ranking data policy and mapping.
- Worker B: chess rules and engine choice.
- Worker C: TypeScript implementation.
- Worker D: UI/game design.
- Reviewer A: code review.
- Reviewer B: gameplay consistency review.
- Coordinator: integrate and explain.
