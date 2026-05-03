# Agentic Universal Agent

TypeScript prototype of a coordinator agent that accepts one concrete user task, decomposes it, delegates focused subtasks to worker agents, reviews their outputs, and stores reusable lessons in shared long-term skill memory.

Project instructions and long-term collaboration notes for AI agents live in [AGENTS.md](AGENTS.md).

## Product Direction

The long-term target is a deployable assistant platform for a family, household, company,
or team. The system should adapt to the group over time while keeping context scoped:

- shared group/company/family memory for this instance;
- personal memory for each member;
- channel identities such as Telegram users;
- conversation threads so Telegram and web can distinguish new tasks from follow-up
  questions, clarifications, and corrections;
- whitelisted requesters;
- auditable outbound messages and reminders;
- instance-scoped tools and credentials;
- simplified API onboarding where an admin provides documentation and access, then the
  system creates a reusable TypeScript tool module with tests and QA.

The current runtime is still a single-user coordinator-led prototype, but the roadmap and
docs now describe the one-group-per-instance user/channel model that future work should
follow.

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
It also mounts `./workspace` into the app container for the sandboxed `file.read` /
`file.write` tools and for fallback access to older local artifacts. New Docker-stack
artifacts use Postgres metadata plus MinIO object payloads.

If a run needs to be stopped while the app is still online, use the Run Workspace
`Cancel Run` action or `POST /api/runs/:id/cancel`. Rebuilding the app container while a
run is active interrupts in-process work; on the next boot the app recovers unfinished
runs as failed instead of resuming them.

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
Model providers can be local OpenAI-compatible endpoints or remote providers such as the
OpenAI API. Remote API keys should be stored through secret handles/settings rather than
prompts or memory.

Optional memory embedding provider:

```bash
EMBEDDING_MODEL=text-embedding-3-small \
EMBEDDING_BASE_URL=https://api.openai.com/v1 \
EMBEDDING_API_KEY=secret-handle-or-runtime-secret \
docker compose up --build
```

Without `EMBEDDING_MODEL`, memory retrieval uses the portable deterministic local
embedding provider. Remote embedding vectors are projected into the current 128-dimensional
pgvector column and fall back locally if the endpoint fails.

Memory operators can rebuild and evaluate retrieval through the web API:

```bash
curl -X POST http://127.0.0.1:3000/api/memories/reembed
curl -X POST http://127.0.0.1:3000/api/memories/evaluate-retrieval \
  -H 'content-type: application/json' \
  -d '{"cases":[{"id":"example","query":"Spanish pharmacy sources","expectedMemoryIds":["memory-id"]}]}'
```

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
   - Memories can be scoped to global/group/user/thread/run, carry confidence/evidence,
     and move through proposed -> accepted/rejected review before retrieval.

## Artifacts

The web console accepts multiple file attachments with a task. In the Docker stack, new
artifact metadata is stored in Postgres and binary payloads are stored in MinIO through an
S3-compatible object store. The server keeps a local filesystem fallback so older
workspace artifacts and non-Docker development still download through the same
`/api/runs/:id/artifacts/:artifactId` links.

When an answer produces files, the final response can include artifact links. The first
implemented output artifact tool is `chart.generate`: if the user asks for a graph/chart
and the task context or workers return parsable time-series arrays, the runtime invokes
this registered TypeScript tool, saves an SVG chart, and shows it in the Answer panel.
The chart tool is data-agnostic: series names come from the input keys, and values can be
read from common numeric fields or the first numeric field in each point.
Text-like input and generated output artifacts also store a short content preview, so the
UI can show source/text snippets and compact CSV/TSV table previews before download.
Accepted artifacts can include compact `quality` metadata from deterministic or tool-level
QA; the UI shows this as a QA badge with the underlying reason available on hover.
Market/crypto time-series requests can use the registered `market.timeseries` tool,
which fetches structured CoinGecko data, returns normalized points, and saves a CSV
artifact that downstream chart generation can consume.

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
workflow for a queued request. The web server also starts a background Tool Builder worker
by default: it claims the oldest `requested` item, marks it `building`, runs the same QA
workflow, registers only after QA passes, and reloads generated tools. Set
`TOOL_BUILD_WORKER=disabled` to keep the queue manual, or tune polling with
`TOOL_BUILD_WORKER_INTERVAL_MS` and `TOOL_BUILD_WORKER_BATCH_SIZE`.

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

- [Architecture](docs/architecture.md)
- [Agent runtime](docs/modules/agent-runtime.md)
- [Web console](docs/modules/web-console.md)
- [Instance context and personalized assistant model](docs/modules/instance-context.md)
- [Target infrastructure](docs/modules/infrastructure.md)
- [Browser operate tool](docs/modules/browser-operate.md)
- [Roadmap](docs/roadmap.md)
