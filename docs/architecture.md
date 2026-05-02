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
- Dispatch workers as a dependency-aware DAG.
- Dispatch reviewers after each worker finishes, so independent reviews can run while
  other branches continue.
- Synthesize final answer.
- Preserve generated artifacts and cite their exact URLs.
- Store reusable lessons in skill memory.

### Planner

Creates machine-readable subtasks for delegated mode.

Each subtask can declare:

- `id`, role, title, prompt, expected output, and review criteria.
- `dependsOn` for upstream worker dependencies.
- `requiredTools` such as `web-search`, `browser-operate`, `file-read`, or
  `browser-screenshot`.
- `toolInputs` for explicit tool calls.
- `requiredArtifacts` for real output files such as screenshots, charts, images,
  reports, datasets, or source bundles.

Independent subtasks run in parallel. Dependent subtasks wait until their upstream worker
outputs are reviewed.

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
- Dependency outputs and artifact URLs, when the worker depends on earlier work.
- Tool evidence, if runtime tools were executed before the worker writes its result.

### Reviewer Agent

Checks one worker result.

Review focus:

- Unsupported claims.
- Missing evidence.
- Incorrect assumptions.
- Incomplete code or tests.
- Contradictions with original task.
- Missing required artifacts or placeholder proof links.
- Whether screenshot/chart/file artifacts actually satisfy the subtask contract.

If a review fails, the worker gets one bounded revision pass before synthesis.

### Tool Registry

Tools are TypeScript modules with:

- name and version;
- capabilities;
- input/output schemas;
- optional healthcheck;
- a `run(input)` implementation.

The runtime asks for capabilities through the registry instead of embedding one-off
logic in the agent. Built-in tools are synced into `tool_modules` when Postgres is
configured.

Initial tools include:

- `web.search` through SearXNG.
- `file.read` and `file.write` inside the workspace sandbox.
- `chart.generate` for data-agnostic SVG chart artifacts.
- `browser.operate` for reusable Playwright browser automation.

### Browser Operation

`browser.operate` is domain-neutral. It executes typed commands such as navigate, click,
fill, select, wait, extract text/links, assert text/URL, dismiss dialogs, and screenshot.

It also accepts screenshot-style `{ url, label?, filename?, fullPage? }` input and expands
that into navigate/extract/screenshot commands. If a command fails after the page opens,
it attempts to return a diagnostic screenshot so the final answer can prove blockers such
as CAPTCHA or login walls.

Higher-level agents should prefer direct source/result URLs over brittle homepage form
automation when search evidence already provides a stable URL.

### Artifacts

Artifacts are first-class run outputs. The web server stores input and output files under
the configured artifact root and exposes them through:

```text
GET /api/runs/:runId/artifacts/:artifactId
```

The final answer should cite exact artifact URLs from `result.artifacts`. The UI renders
preview cards for image artifacts.

### Tool Builder Flow

When a required capability is missing, the runtime can create a Tool Build Request.

The current provider-backed flow:

```text
missing capability
  -> create Tool Build Request with TypeScript module contract
  -> builder writes source and tests
  -> QA runs targeted tests and build checks in an isolated workspace
  -> registrar validates metadata and registers the generated module
  -> runtime reloads generated tools
  -> original run can use the new tool
```

This is not yet a fully general LLM-authored tool creator for arbitrary capability
families, but the durable lifecycle and QA/registration boundaries are in place.

### Model Tiers

Each LLM step receives a selected model tier based on task risk and activity type.
Settings are stored in Postgres when configured and can be edited from the web console.

Typical routing:

- cheaper tiers for classification, planning, and low-risk synthesis;
- stronger tiers for reviews, high-risk reasoning, and complex work;
- escalation when a configured model fails or returns unusable output.

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
                      Independent workers run in parallel
                        |
                        v
                      Reviewers start as each worker finishes
                        |
                        v
                      Dependent workers receive reviewed upstream context
                        |
                        v
                      Coordinator synthesizes
                        |
                        v
                      Store reusable lesson
```

Tool and artifact flow can happen inside worker execution:

```text
Worker needs current facts or proof
  -> registry finds web/browser/file/chart tool
  -> runtime executes tool
  -> trace records tool evidence
  -> artifact store persists any returned files
  -> worker answers from evidence and artifact URLs
  -> reviewer checks evidence and artifacts
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
- The task needs current web evidence, screenshots, files, charts, PDFs, code changes, or
  manual-style browser verification.

Use tool creation when:

- A required capability is missing from the registry.
- The need is reusable beyond a single prompt.
- A typed TypeScript module with tests can satisfy the capability safely.

Do not create one-off hardcoded tools for a single data value or single website outcome.
Prefer reusable modules with schemas and capability metadata.

## Web Console

The web console is the operator surface for runs.

It provides:

- task submission with file attachments;
- live run status through SSE with polling fallback;
- an execution map with parent/dependency arrows;
- collapsible trace cards with actor, status, activity, duration, and tool evidence;
- answer and artifact panels;
- system inventory for tools, memory, build requests, and model tiers.

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

## Example: Flight Search With Proof

Task:

> Find Istanbul to Malaga tickets for May 2026 and attach proof screenshots.

Delegated plan:

- Worker A: search current web sources and identify stable flight route URLs.
- Runtime: use `web.search`, then `browser.operate` on direct source/result URLs.
- Runtime: save screenshot artifacts from the source page or blocker page.
- Reviewer A: verify prices, dates, airlines, and screenshot relevance.
- Worker B: synthesize the Russian answer from reviewed evidence and artifacts.
- Reviewer B: check that the final answer cites real artifact URLs.
