# AGENTS.md

Project context and working notes for AI coding agents.

This file is the first place to read before changing the project. Keep it current when
architecture, commands, conventions, or collaboration rules change.

## Project

Agentic Universal Agent is a TypeScript prototype of a coordinator agent.

The coordinator accepts one concrete user task, decides whether to answer directly or
delegate, creates focused subtasks for worker agents, reviews their results, synthesizes
the final answer, and stores reusable lessons in shared skill memory.
Delegated subtasks form a dependency-aware DAG: workers with no dependencies can run in
parallel, while workers with `dependsOn` wait for reviewed upstream outputs.

## User Collaboration Notes

- The user wants the project in TypeScript.
- The user expects code changes to be covered by tests.
- Before reporting completion, run automated checks and a relevant manual test.
- Manual checks must include the actual user-visible surface, API responses, trace logs,
  and database records when persistence is involved.
- Return only working code with the expected execution result.
- Keep this file updated with important project notes, links, commands, and decisions.
- The user prefers a universal agent that delegates narrow, context-heavy work to
  separate agents, then accumulates the results centrally.
- The user expects requests to accept files and responses to return files when the task
  calls for artifacts such as charts, screenshots, reports, datasets, or source bundles.

## Local Model

Default OpenAI-compatible endpoint:

- Base URL: `http://127.0.0.1:1234/v1`
- Model: `google/gemma-4-26b-a4b`

Environment overrides:

- `LLM_BASE_URL`
- `LLM_MODEL`
- `LLM_TEMPERATURE`
- `LLM_MODEL_TIER_S`
- `LLM_MODEL_TIER_M`
- `LLM_MODEL_TIER_L`
- `LLM_MODEL_TIER_XL`

Tier variables can contain one model or a comma-separated fallback list. In the web app,
the editable tier policy is stored in Postgres and exposed through the System Inventory
panel.

## Commands

Install dependencies:

```bash
npm install
```

Run full verification:

```bash
npm run verify
```

The verification command runs:

- `npm run typecheck`
- `npm run test:types`
- `npm test`
- `npm run build`

Manual CLI smoke test:

```bash
node dist/cli.js "Скажи одним предложением, что такое универсальный агент"
```

Run the full container stack:

```bash
docker compose up --build
```

The `npm run dev` command uses `tsx`; in some sandboxes it can fail on IPC pipe
permissions. If that happens, use `npm run build` and then `node dist/cli.js ...`.

## Important Files

- [README.md](README.md) - quick start and request execution summary.
- [docs/architecture.md](docs/architecture.md) - detailed architecture and delegation model.
- [src/agents/universalAgent.ts](src/agents/universalAgent.ts) - main coordinator runtime.
- [src/agents/modelTier.ts](src/agents/modelTier.ts) - model tier selection policy.
- [src/agents/prompts.ts](src/agents/prompts.ts) - prompts for classification, planning,
  workers, reviewers, synthesis, and learning.
- [src/artifacts/artifactStore.ts](src/artifacts/artifactStore.ts) - local input/output
  artifact store and download metadata.
- [src/artifacts/chartArtifact.ts](src/artifacts/chartArtifact.ts) - deterministic SVG
  chart parsing/rendering helpers.
- [src/tools/chartGenerateTool.ts](src/tools/chartGenerateTool.ts) - `chart.generate`
  TypeScript tool module for data-agnostic SVG chart artifacts.
- [src/tools/browserOperateTool.ts](src/tools/browserOperateTool.ts) - reusable
  `browser.operate` Playwright command executor for navigation, clicks, form fills,
  selectors/options/checkboxes, waits, assertions, DOM text/link extraction, screenshots,
  and returned storage state.
- [docs/modules/browser-operate.md](docs/modules/browser-operate.md) - module contract
  and portability notes for `browser.operate`.
- [src/llm/client.ts](src/llm/client.ts) - OpenAI-compatible LLM client.
- [src/memory/skillMemory.ts](src/memory/skillMemory.ts) - shared file-based skill memory.
- [src/tools/registry.ts](src/tools/registry.ts) - tool registry skeleton.
- [src/tools/tool.ts](src/tools/tool.ts) - versioned tool module contract.
- [src/tools/toolMetadataStore.ts](src/tools/toolMetadataStore.ts) - persistent tool
  metadata store contract and in-memory implementation.
- [src/tools/postgresToolMetadataStore.ts](src/tools/postgresToolMetadataStore.ts) -
  Postgres-backed `tool_modules` catalog.
- [src/tools/toolBuildRequestStore.ts](src/tools/toolBuildRequestStore.ts) - Tool Builder
  request/contract/lifecycle/QA criteria model.
- [src/tools/postgresToolBuildRequestStore.ts](src/tools/postgresToolBuildRequestStore.ts)
  - Postgres-backed `tool_build_requests` queue.
- [src/tools/toolBuildWorkflow.ts](src/tools/toolBuildWorkflow.ts) - reusable Builder/QA/
  Registrar orchestration flow for missing tool capabilities.
- [src/tools/toolBuildProviders.ts](src/tools/toolBuildProviders.ts) - provider-backed
  generated tool source writer, isolated command QA runner, and metadata registrar.
- [src/tools/fileTools.ts](src/tools/fileTools.ts) - sandboxed workspace file tools.
- [src/settings/modelTierSettings.ts](src/settings/modelTierSettings.ts) - model tier
  policy contract and in-memory implementation.
- [src/settings/postgresModelTierSettings.ts](src/settings/postgresModelTierSettings.ts)
  - Postgres-backed model tier policy.
- [src/server/http.ts](src/server/http.ts) - web API and static UI server.
- [docs/modules/web-console.md](docs/modules/web-console.md) - web console API,
  realtime SSE stream, dashboard behavior, attachments, artifacts, and trace rendering.
- [src/runs/inMemoryRunStore.ts](src/runs/inMemoryRunStore.ts) - replaceable run store.
- [src/runs/postgresRunStore.ts](src/runs/postgresRunStore.ts) - Postgres-backed run store.
- [src/db/migrate.ts](src/db/migrate.ts) - database migrations.
- [public/](public/) - browser console UI.
- [memory/skills.json](memory/skills.json) - current long-term skill memory store.
- [tests/](tests/) - automated tests.
- [docs/modules/](docs/modules/) - module-level documentation.
- [docs/roadmap.md](docs/roadmap.md) - planned memory, tools, recursive agents, and model tiers.

## Architecture Notes

Request flow:

```text
User task
  -> Coordinator
  -> SkillMemory.search()
  -> Complexity classification
  -> Direct answer or delegated plan
  -> Dependency-aware worker DAG
  -> Reviewer agents, with one bounded worker revision if review returns `needs_revision`
  -> Artifact generation for supported file-output requests
  -> Final synthesis
  -> SkillMemory.add()
```

Delegation is preferred when the task:

- crosses multiple domains;
- needs research and implementation;
- can consume too much context in one thread;
- benefits from independent review;
- requires both creation and verification.

Direct mode is acceptable when the task is narrow, stable, low risk, and does not require
fresh research or codebase inspection.

## Testing Policy

For code changes:

- Add or update automated tests.
- Run `npm run verify`.
- Run a manual test that exercises the user-visible path.
- Mention any untested risk explicitly if full verification is impossible.

For documentation-only changes:

- Automated tests are not required unless docs include generated or validated examples.
- Run a lightweight manual check by reading the changed file and confirming links/commands
  still make sense.

## Current Test Coverage

- `tests/json.test.ts` covers JSON extraction from model output.
- `tests/skillMemory.test.ts` covers file-backed skill memory.
- `tests/toolRegistry.test.ts` covers tool registration and lookup.
- `tests/universalAgent.test.ts` covers direct and delegated orchestration with a fake LLM.
- `tests/artifactStore.test.ts` covers local artifact persistence and download metadata.
- `tests/chartArtifact.test.ts` covers SVG chart helpers and the `chart.generate` tool.
- `tests/browserOperateTool.test.ts` covers the generic Playwright command executor.
- `tests/generatedToolLoader.test.ts` covers compiled generated tool loading and contract
  rejection.
- `tests/toolMetadataStore.test.ts` covers tool metadata and Tool Build Queue lifecycle.
- `tests/toolBuildWorkflow.test.ts` covers Builder/QA/Registrar orchestration and failed
  QA registration blocking.
- `tests/toolBuildProviders.test.ts` covers provider-backed TypeScript generation and
  generated metadata registration.

## Maintenance Rules

- Keep edits small and consistent with the existing TypeScript style.
- Prefer Node built-ins unless a dependency clearly improves the system.
- Do not store full transcripts in skill memory; store compressed reusable lessons.
- Keep worker context narrow: original task summary, one subtask, relevant memory, output
  expectations, and review criteria.
- Preserve trace parent links when adding orchestration steps; the UI depends on
  `parentSpanId` to draw direct arrows.
- For DAG dependencies, also preserve `payload.dependencySpanIds` so the UI can draw
  additional upstream arrows.
- Add links here when introducing new core docs, modules, commands, or workflows.
- UI changes must be checked through the HTTP server, not only by reading static files.
- The web console uses `GET /api/runs/:id/events` as an additive SSE stream for live run
  snapshots and falls back to polling; keep `GET /api/runs` and `GET /api/runs/:id`
  backwards compatible.
- Prefer Docker Compose for project runtime and manual verification.
- File tools must stay inside the configured workspace root (`FILE_TOOL_ROOT`, default
  `workspace`).
- Artifact payloads currently live under `ARTIFACT_ROOT`, default `/app/workspace/artifacts`.
  Keep generated links in `result.artifacts` and trace artifact creation with parent
  spans.
- New capabilities must be implemented as TypeScript tool modules with schemas,
  capabilities, healthchecks, tests, and registry wiring. Runtime code should request a
  capability from `ToolRegistry` rather than embedding one-off tool logic.
- Built-in and future generated tool contracts should be synced into `tool_modules` so
  source/status/health/version metadata survives restarts.
- Missing capabilities should create `tool_build_requests` with TypeScript module paths,
  schemas, acceptance criteria, and QA criteria before any generated code is promoted.
- Tool Build Queue consumers should update durable lifecycle state through the store/API:
  `requested`, `building`, `qa_failed`, `qa_passed`, `registered`, or `blocked`, with QA
  evidence attached before registration.
- `ToolBuildWorkflow` supports bounded retries. Builders receive the previous generated
  output and failed QA report on retry attempts; registrars must only run after a passing
  QA report.
- Generated tool metadata registration must reject builtin name collisions and version
  conflicts. Generated modules are loaded only from compiled project-local paths, after
  exported name/version/capabilities match metadata and healthcheck passes.
- The first self-service generated capability is `browser-screenshot`. The Docker runtime
  includes Chromium and project source/tests so the Builder workflow can write generated
  TypeScript, run targeted tests, rebuild `dist`, register metadata, reload the generated
  tool, and let the original run save a PNG artifact.
- `browser.operate` must remain domain-neutral and portable. It executes typed browser
  commands and returns structured evidence plus Playwright storage state; agents decide
  the scenario and reviewers decide whether the resulting artifact proves the task.
- `browser.operate` also accepts screenshot-style `{ url, label?, filename?, fullPage? }`
  input and expands it into navigate/extract/screenshot commands. On command failure it
  should return any diagnostic screenshot payloads so the runtime can attach proof of
  blockers instead of losing evidence.
