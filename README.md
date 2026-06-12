# Agentic Universal Agent

TypeScript prototype of a coordinator agent that accepts one concrete user task, decomposes it, delegates focused subtasks to worker agents, reviews their outputs, and stores reusable lessons in shared long-term skill memory.

Project instructions and long-term collaboration notes for AI agents live in
[AGENTS.md](AGENTS.md). A compact handoff for new AI coding agents lives in
[docs/agent-handoff.md](docs/agent-handoff.md).

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
- future capability onboarding where an admin provides documentation, files, URLs,
  credentials, desired behavior, and QA expectations, then a redesigned builder creates a
  portable out-of-tree tool package/service that is registered into the same tool
  registry as the preinstalled tools.

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
npm run web:dev
```

This starts the Nest API on `http://127.0.0.1:3000` and the React console on
`http://127.0.0.1:3001`. The legacy console is still available with
`npm run web:legacy:dev`.

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
7. **Agents use reusable capabilities.**
   - The runtime accepts user attachments and invokes registered tools through schemas.
   - The active reset branch does not silently create Tool Build Requests.
   - Missing abilities are reported as unsupported/missing until the new out-of-tree
     builder lifecycle is redesigned.
   - Weak existing abilities should become generic tool/prompt/runtime follow-ups, not
     one-off patches for a single task.
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

The current reset branch intentionally disables the old Tool Builder / rework queue. Core
capabilities are preinstalled through `createCoreToolbelt()` and registered as normal
versioned tools:

- `web.search` for discovery.
- `web.read` for page/resource reading.
- `browser.operate` for browser navigation, visible-element observation/clicks across
  pages and embedded frames, form fills, DOM extraction, and proof capture primitives.
- `browser.screenshot` for focused proof screenshots on top of `browser.operate`.
- `http.request` for generic API calls.
- `file.read` and `file.write` for local workspace files/artifacts.
- `document.extract` for text/PDF/DOCX/HTML/JSON extraction.
- `data.transform` for deterministic JSON/CSV/text transforms.
- `external.action.prepare` for auditable external-action drafts without submit.
- `external.action.commit` for final approved commit through an attached executor
  (fixture mode is available for tests; without an executor it fails closed).
- `channel.telegram` as the always-on Telegram channel adapter.

Agents receive only the available registry catalog; missing capabilities are reported as
missing/unsupported instead of silently spawning a generated-tool build request.

Future tool creation should be rebuilt on this same contract, not as a parallel platform:
the builder should produce out-of-tree portable tool packages, register their manifests
and metadata, run QA, then promote/reload them through the same registry surface used by
the preinstalled tools. The old `/api/tool-build-*`, `/api/tool-investigations`, and
`/api/tool-rework-waits` APIs are removed from the active server.

Tool contracts are also persisted in Postgres when the Docker stack is running. The
`tool_modules` catalog stores version, capabilities, schemas, source, status, required
configuration keys, secret handles, storage contracts, docs/examples, success/failure
counters, and latest health details for the active preinstalled tools. The old public
generated-module and package-manifest mutation endpoints are intentionally removed from
the active API. Future tool creation should come back as a separate builder layer that
produces portable out-of-tree package manifests and promotes them through the same
registry boundary after QA. Pre-built source-bundle/package execution support remains in
`ToolPackageRunner` for that future path, but the current product surface starts from the
core toolbelt only. The active
application no longer writes generated package source itself; future builder work must
write portable packages outside the main app source and then register them through tool
metadata.
Generated package folders also include a small HTTP runtime server and Dockerfile
entrypoint: `GET /health`, `POST /run`, and optional service lifecycle routes map to the
same tool contract, which is the handoff toward independently hosted tools.
The web server prefers the package-local HTTP process runner for source-bundles unless
`TOOL_SOURCE_BUNDLE_HTTP_RUNNER=disabled` or `TOOL_SOURCE_BUNDLE_RUNNER=in-process`. The
generic loader remains opt-in through `TOOL_SOURCE_BUNDLE_HTTP_RUNNER=enabled` or
`TOOL_SOURCE_BUNDLE_RUNNER=http-process`. The runner starts
`dist/runtime/server.js` as a separate local Node HTTP process for each on-demand call, or
as a service lifecycle process for always-on tools. `TOOL_SOURCE_BUNDLE_STARTUP_TIMEOUT_MS` and
`TOOL_SOURCE_BUNDLE_POLL_INTERVAL_MS` tune readiness waits, and
`TOOL_SOURCE_BUNDLE_CALL_TIMEOUT_MS` bounds `/run` and service lifecycle calls so a
broken runtime cannot hang a job indefinitely. This is the local-process bridge before
full external supervisor/OCI execution.
`external-package` manifests whose `package.ref` is an HTTP(S) URL load through the
external HTTP package runner. That runtime must expose `GET /health`, `POST /run`, and
optional `POST /service/start` / `POST /service/stop` for always-on tools. `oci-image`
manifests can use the same HTTP runtime contract when `TOOL_OCI_RUNNER=enabled`; the
Docker runner starts the image, publishes internal port `TOOL_OCI_INTERNAL_PORT` (default
`8080`), waits for `/health`, and then proxies `/run` and optional service lifecycle
calls. External HTTP/OCI runtimes receive only the secret handles declared by their tool
metadata and configuration values declared by `requiredConfigurationKeys`, resolved as
scoped runtime envelopes. Runner diagnostics are exposed through
`GET /api/tool-package-runners` and the Diagnostics page.
Operators can call `POST /api/tools/reload-generated` or use the Diagnostics action to
reload generated/source-bundle packages without restarting the app.
Tool runtime settings are separate from secrets. Non-secret values such as provider URLs,
feature flags, and rate-limit hints are stored per tool in `tool_runtime_settings`,
managed through the Tools detail UI and `/api/tool-settings`, audited on save/delete, and
resolved before falling back to process environment variables. API keys, bot tokens, and
passwords still belong in `secret_handles`. `POST /api/tool-settings/validate` previews
required/missing values and validates string/number/integer/boolean/enum/URL constraints
from the tool's `settingsSchema` before operators save changes.
Always-on tools are supervised through the same provider-neutral lifecycle API. The
supervisor tracks desired state, heartbeat health, restart count, consecutive failures,
last failure, next scheduled restart, pending approval, and last restart reason. A failed
heartbeat can trigger a bounded auto-restart policy
(`TOOL_SERVICE_AUTO_RESTART_ON_FAILED_HEARTBEAT`, disabled only when set to `disabled`;
`TOOL_SERVICE_MAX_AUTO_RESTARTS`, default `3`) before the service is left failed for
operator review. Operators can override that policy per service through
`PATCH /api/tool-services/:name/restart-policy` or the Channels/Tool Detail UI,
including `restartBackoffMs` for delayed recovery and `restartRequiresApproval` for
sensitive services that must wait for a manual restart/approval. `restartBackoffMultiplier`
and `restartBackoffMaxMs` let a flapping service back off progressively without exceeding
an operator-defined cap. Pending service restart approvals also appear in the Approvals
page, where approve/reject routes through the same generic service lifecycle API.
Source-bundle HTTP process runtimes forward child `stdout`/`stderr` into the same
lifecycle log stream, so isolated tools can be debugged without shelling into their
process.

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
