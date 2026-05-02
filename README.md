# Agentic Universal Agent

TypeScript prototype of a coordinator agent that accepts one concrete user task, decomposes it, delegates focused subtasks to worker agents, reviews their outputs, and stores reusable lessons in shared long-term skill memory.

Project instructions and long-term collaboration notes for AI agents live in [AGENTS.md](AGENTS.md).

Default local model endpoint:

- Base URL: `http://127.0.0.1:1234/v1`
- Model: `google/gemma-4-26b-a4b`

## Run

```bash
npm install
npm run dev -- "top 5 cities in Spain by population, sorted by distance to the sea"
```

Run the browser console in Docker:

```bash
docker compose up --build
```

Then open `http://127.0.0.1:3000`.

The compose stack includes the app, Postgres, Redis, MinIO, and SearXNG-powered web search.
It also mounts `./workspace` into the app container for local artifacts and the sandboxed
`file.read` / `file.write` tools.

Run the browser console directly on the host:

```bash
npm run build
npm run web
```

Override model settings:

```bash
LLM_BASE_URL=http://127.0.0.1:1234/v1 LLM_MODEL=google/gemma-4-26b-a4b npm run dev -- "your task"
```

Optional tier-specific model overrides:

```bash
LLM_MODEL_TIER_S=cheap-model,cheap-backup \
LLM_MODEL_TIER_M=balanced-model,balanced-backup \
LLM_MODEL_TIER_L=strong-review-model \
LLM_MODEL_TIER_XL=deep-review-model \
docker compose up --build
```

If a tier override is not set, the app falls back to `LLM_MODEL`.
In the web console, open System Inventory to edit and persist model tier policy in
Postgres.

## Verify

```bash
npm run verify
```

For manual smoke testing after a build:

```bash
node dist/cli.js "Скажи одним предложением, что такое универсальный агент"
```

## Request Execution Structure

1. **Coordinator receives exactly one concrete user task.**
2. **Task classifier estimates complexity.**
   - Simple tasks can be answered directly.
   - Multi-domain or uncertain tasks are decomposed.
3. **Planner creates focused subtasks.**
   - Each subtask has a role, expected output, tools, and review criteria.
4. **Worker agents execute a dependency-aware DAG.**
   - Independent workers run in parallel.
   - Workers with `dependsOn` wait for reviewed upstream outputs and receive those outputs as compact dependency context.
5. **Reviewer agents check each worker result.**
   - Reviewers look for missing evidence, bad assumptions, contradictions, and next actions.
6. **Artifact tools run when the task requires files.**
   - The runtime accepts user attachments and invokes registered tools such as `chart.generate` for downloadable SVG charts.
7. **Coordinator synthesizes final answer.**
   - It uses worker outputs, review notes, and its own judgment.
8. **Skill memory is updated.**
   - Reusable patterns, failures, and successful methods are stored for future agents.

## Artifacts

The web console accepts multiple file attachments with a task. Files are stored under the
configured artifact root and exposed to the agent as input artifacts.

When an answer produces files, the final response can include artifact links. The first
implemented output artifact tool is `chart.generate`: if the user asks for a graph/chart
and the task context or workers return parsable time-series arrays, the runtime invokes
this registered TypeScript tool, saves an SVG chart, and shows it in the Answer panel.
The chart tool is data-agnostic: series names come from the input keys, and values can be
read from common numeric fields or the first numeric field in each point.

Screenshot requests use the same artifact path. If `browser-screenshot` is missing, the
runtime can create a Tool Build Request, run the provider-backed Tool Builder workflow,
write a Playwright TypeScript module plus tests, run QA/build checks, register the module,
reload generated tools, and then save the PNG artifact in the original run.
Generated-tool QA first runs in a temporary isolated workspace and only performs promotion
tests/build in the real project after isolated checks pass. If QA fails, the workflow can
return the QA report to the builder for a bounded retry before final `qa_failed`.

If a required capability is not registered, the runtime emits a `tool-missing` trace event.
When a build request store is configured, that event also creates a Tool Build Request with
a TypeScript module contract, test path, acceptance criteria, and QA criteria. The roadmap
turns those queued requests into a Tool Builder flow that creates, tests, and registers a
new TypeScript tool module before the original task continues.
Build requests have a durable lifecycle API: builder/QA/registrar agents can read a
request by id, update status, attach QA evidence, and record the registered generated tool
name.
`POST /api/tool-build-requests/:id/run` executes the configured Builder -> QA -> Registrar
workflow for a queued request.

Tool contracts are also persisted in Postgres when the Docker stack is running. The
`tool_modules` catalog stores version, capabilities, schemas, source, status, and latest
health details. Generated tool metadata can be registered with name/version conflict
checks. Executable generated tools are loaded only from compiled project-local modules,
validated against metadata, and promoted after health checks pass.

## Shape

```text
User Task
  -> Coordinator
      -> SkillMemory.search()
      -> Planner
          -> WorkerAgent(research)
          -> WorkerAgent(coding, dependsOn: research)
          -> WorkerAgent(review, dependsOn: coding)
      -> ReviewerAgent for risky outputs
      -> Synthesizer
      -> SkillMemory.add()
  -> Final Answer
```

The current implementation is still coordinator-led, but it now includes persistent
runs, dependency-aware subtask execution, web search, sandboxed workspace file tools,
model-tier routing, and a first request/response artifact path.

## Modules

- [Agent runtime](docs/modules/agent-runtime.md)
- [Web console](docs/modules/web-console.md)
- [Target infrastructure](docs/modules/infrastructure.md)
- [Roadmap](docs/roadmap.md)
