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
In the web console, open Models to edit and persist model tier policy in Postgres.
The same page now includes a durable Provider Registry for local endpoints, remote
OpenAI-compatible providers, and memory embedding providers. Remote API keys should be
stored through secret handles/settings rather than prompts or memory.

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

Provider registry API:

```bash
curl http://127.0.0.1:3000/api/model-providers
curl -X POST http://127.0.0.1:3000/api/model-providers \
  -H 'content-type: application/json' \
  -d '{"label":"OpenAI prod","kind":"chat","providerType":"openai-compatible","baseUrl":"https://api.openai.com/v1","modelIds":["gpt-5.2"],"apiKeySecretHandle":"openai-prod-key"}'
```

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
5. **Every agent self-checks before returning.**
   - Worker and reviewer spans carry a durable `callFrame` payload with local task,
     output contract, caller span, dependency spans, and model tier.
   - Workers emit `agent-self-check-completed` before returning output upward.
   - The self-check verifies non-empty output, evidence state, required artifacts, typed
     artifact QA, and stated limitations.
6. **Reviewer agents check each worker result.**
   - Reviewers look for missing evidence, bad assumptions, contradictions, and next actions.
7. **Agents use or request reusable capabilities.**
   - The runtime accepts user attachments and invokes registered tools through schemas.
   - Missing abilities become generic Tool Build Requests.
   - Weak existing abilities become versioned Tool Rework Requests, not one-off patches.
8. **Coordinator synthesizes final answer.**
   - It uses worker outputs, review notes, and its own judgment.
9. **Skill memory is updated.**
   - Reusable patterns, failures, and successful methods are stored for future agents.
   - Memories can be scoped to global/group/user/thread/run, carry confidence/evidence,
     and move through proposed -> accepted/rejected review before retrieval.
   - A memory-specialist guard keeps low-confidence or policy-risky learned facts in the
     review queue even when the learning model asks to accept them immediately.

## Artifacts

The web console accepts multiple file attachments with a task. In the Docker stack, new
artifact metadata is stored in Postgres and binary payloads are stored in MinIO through an
S3-compatible object store. The server keeps a local filesystem fallback so older
workspace artifacts and non-Docker development still download through the same
`/api/runs/:id/artifacts/:artifactId` links.

When an answer produces files, the final response can include artifact links. Artifact
creation is driven by reusable tool capabilities, not case-specific runtime branches. For
example, `chart.generate` is a data-agnostic visualization tool: if the task asks for a
graph/chart and validated context contains parsable time-series arrays, the runtime can
invoke this registered TypeScript tool, save an SVG chart, and show it in the Answer
panel. Series names come from input keys, and values can be read from common numeric
fields or the first numeric field in each point.
Text-like input and generated output artifacts also store a short content preview, so the
UI can show source/text snippets and compact CSV/TSV table previews before download.
Accepted artifacts can include compact `quality` metadata from deterministic or tool-level
QA; the UI shows this as a QA badge with the underlying reason available on hover.
Structured-data requests should use registered data acquisition tools that return
validated dataset artifacts. A narrow current example exists for one crypto time-series
source, but the architectural target is provider-configurable, reusable TypeScript tools
with schemas, secret handles, source QA, and versioned upgrades.

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
Unknown/custom Tool Build requests can also use a guarded LLM-backed builder after the
deterministic providers decline the request. It asks the configured XL-tier
OpenAI-compatible model for a TypeScript module and test file matching the durable request
contract, rejects unsafe file paths and raw-looking secrets, then runs the same isolated
QA, promotion build, registrar, and reload flow. Set
`TOOL_BUILD_LLM_PROVIDER=disabled` to allow only deterministic built-in build providers.
Generated tools also pass separate review gates after QA and before registration. The
current deterministic reviewers check source/manifest contract safety and QA evidence
shape; failed review findings are returned to the next builder attempt before a request
becomes `qa_failed`.
Set `TOOL_BUILD_LLM_REVIEW=enabled` to add strict LLM code and behavior reviewers on top
of the deterministic gates. These reviewers read the request contract, QA report, and
generated module/test previews, and their structured findings are also returned to the
builder for bounded repair.

Tool contracts are also persisted in Postgres when the Docker stack is running. The
`tool_modules` catalog stores version, capabilities, schemas, source, status, required
configuration keys, secret handles, storage contracts, docs/examples, success/failure
counters, and latest health details. Generated tool metadata can be registered with
name/version conflict checks. Executable generated tools are loaded only from compiled
project-local modules, validated against metadata, and promoted after health checks pass.
Portable package manifests can be exported from
`GET /api/tools/generated-modules/:name/package-manifest` and imported through
`POST /api/tools/package-manifests` or the Tools page. Imported non-local packages are
registered as disabled metadata until a runner can execute their package reference.
Generated package execution goes through `ToolPackageRunner`: local-path packages use the
compiled TypeScript runner, and pre-built `source-bundle` packages can be loaded from
`TOOL_PACKAGE_ROOT` (default `tool-packages`) via `dist/index.js` or `index.js`.
External-package and OCI runners can be added without changing the core loader. Runner
diagnostics are exposed through `GET /api/tool-package-runners` and the Diagnostics page.

Tool-owned storage changes are tracked separately in `tool_migrations`: tool name/version,
migration id, checksum, status, applied actor/time, QA report, and rollback notes. This is
the durable handoff for future generated tools that need tables or maintenance actions;
they should declare migrations and receive scoped runtime context instead of opening
their own database connections.

The target registry is an operator-visible capability catalog: tool name, versions,
changelog, schemas, required settings/env keys, required secret handles, examples,
success/failure counters, health, linked run/span issues, generated source/tests, QA
reports, and declared storage contracts. If a tool needs its own persistent data, the
target flow is versioned tool-owned migrations plus an injected scoped execution context,
not arbitrary SQL inside the tool body. Destructive data operations should be exposed as
auditable capabilities with dry-run preview, policy approval, and exact scope.
Channel adapters such as Telegram should be built and managed through this same
tool/version/QA flow rather than as special runtime integrations.

Generated tools can now be changed through the same lifecycle: the Tools page can search
by display name, system name, description, tags/capabilities, docs, schemas, and version;
generated tool detail panels can create a versioned change request; and registered
versions can be selected as active without deleting earlier versions.

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
