# Target Infrastructure

## Current Container Runtime

The project is intended to run through Docker Compose:

- `app`: Node.js web/API process.
- `postgres`: primary run/event store using `pgvector/pgvector:pg16`.
- `redis`: future queue and event stream.
- `minio`: S3-compatible durable artifact payload storage.
- `searxng`: local metasearch service for `web.search`.
- local OpenAI-compatible LLM endpoint exposed to the app as `host.docker.internal`, or a
  remote OpenAI-compatible provider such as the OpenAI API.

Run:

```bash
docker compose up --build
```

### Rebuilds During Active Runs

`docker compose up --build -d app` recreates the app container. Any active in-process
LLM, browser, or tool call in that container is interrupted. Persistent stores keep the
run, events, artifacts, memories, and audit records written before shutdown; on startup
the app calls `recoverInterrupted` and marks `queued`/`running` runs as failed with a
restart interruption reason. The UI can refresh/reconnect to see the failed run and
partial trace, but execution does not resume automatically.

When the app is still online, prefer the Run Workspace cancel action or
`POST /api/runs/:id/cancel`. That records an explicit `cancelled` terminal state and
audit event before any late LLM/tool result can overwrite the run. A container rebuild is
harder: it interrupts the process and the next boot can only recover the run as failed
from durable state.

Future production deployment should add a drain mode and queue-backed workers so the web
process can stop accepting new runs, wait for active jobs, or resume idempotent jobs after
replacement.

## Recommended Production Direction

### Database

PostgreSQL is the primary database.

Why:

- Reliable relational model for one assistant instance, its users, runs, events, artifacts, and
  audit logs.
- Mature migrations and backup story.
- Works well with JSONB for flexible agent payloads.
- Can add `pgvector` for semantic skill memory and retrieval.

Current tables:

- `runs`
- `run_events`
- `instance_settings`
- `group_profile`
- `users`
- `user_roles`
- `channel_identities`
- `conversation_threads`
- `thread_messages`
- `skill_memories`
- `model_tier_settings`
- `tool_modules`
- `tool_build_requests`
- `tool_migrations`
- `tool_service_statuses`
- `tool_service_logs`
- `tool_service_events`
- `secret_handles`

Current filesystem-backed stores:

- `workspace/artifacts`: local fallback for older artifacts and non-Docker development.

On app startup, stale `queued` or `running` runs from a previous process are marked as
`failed` with an interruption message. This keeps the UI honest after container restarts.

Future or partially implemented tables:

- `telegram_messages`
- `outbound_actions`
- `policies`
- `audit_events` records normalized action history for runs, artifacts, tool usage,
  tool builds, and future policy/outbound decisions.
- `tool_credentials`
- `tool_installations`
- `agent_tasks`
- scoped `skill_memories`
- `artifacts`

Important future relationships:

- Runs belong to the current instance and have a requester user/source channel.
- Runs may belong to a conversation thread through `threadId` and may point to a previous
  run with `parentRunId` for continuations.
- Conversation threads store compact summaries, accepted facts, rejected attempts, open
  questions, and source channel/message references.
- Memories have a scope: global, group, user, or run.
- Tools can be globally registered but installed/enabled for this instance, roles, or
  individual users.
- Tool credentials are secret handles scoped to this instance/tool/user policy, not raw values in
  prompt text or memory.
- Channel identities map provider IDs, such as Telegram user IDs, to internal users.
- Outbound actions store requester, target, body, policy decision, delivery status, and
  provider response.

### Memory Search

The current memory store is Postgres-backed and uses full-text search plus lexical
rescoring. `pgvector` remains the next upgrade for semantic retrieval.

Why:

- Keeps transactional metadata and embeddings together.
- Fewer moving parts than a separate vector database.
- Easy to move to Qdrant, Weaviate, or Pinecone later if scale requires it.

### Message Broker

Redis is already part of Docker Compose. Use Redis Streams for the near-term queue and
event stream when the runtime moves from in-process async execution to background workers.

Why:

- Simple operational footprint.
- Good enough for run queues, retries, and UI event fanout.
- Easy local Docker setup.

Use NATS JetStream later if the system grows into many services with higher throughput,
stronger pub/sub semantics, and service-to-service messaging.

### Object Storage

The Docker runtime stores new request/response artifact metadata in Postgres and payloads
in MinIO through an S3-compatible object store. The app still keeps a local filesystem
fallback so old `workspace/artifacts` manifests and simple non-Docker development remain
readable through the same artifact download API.

The durable store is used for:

- code bundles;
- screenshots;
- charts/images;
- reports;
- datasets;
- exported documents.

Relevant environment variables:

- `MINIO_ENDPOINT`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `MINIO_BUCKET`
- optional `S3_REGION`

When those variables and `DATABASE_URL` are present, `src/server/main.ts` wires
`DurableArtifactStore(PostgresArtifactMetadataStore, S3ObjectStore)` with a local
fallback. Without them, the app uses `LocalArtifactStore`.

### Secrets

API/tool onboarding uses a secret-handle registry. Credentials provided by an admin are
referenced by handle and resolved by provider at runtime; raw values do not enter prompts,
traces, memories, generated source, or artifacts. The current implementation supports:

- `env` handles that point to environment variable names such as `TELEGRAM_BOT_TOKEN`;
- `external` handles that point to an external secret-manager path;
- Postgres-backed `secret_handles` metadata plus in-memory test storage;
- `GET/POST/DELETE /api/secret-handles` with raw token/password/apiKey/value payload
  rejection and audit events for create/delete.

This also covers remote model provider credentials such as OpenAI API keys.

Do not store secrets in:

- skill memories;
- run prompts or LLM messages;
- generated tool source;
- artifacts;
- trace event details.

Local development should prefer environment-backed handles. Production should use a
dedicated secret manager such as Vault, cloud KMS/Secret Manager, or another
deployment-appropriate backend.

### Workspace Files

The app container mounts `./workspace` to `/app/workspace`. The `file.read` and
`file.write` tools are restricted to that workspace root so generated reports, code
prototypes, and intermediate text artifacts do not escape into the project tree unless
explicitly copied or promoted.

### Web Search

SearXNG is part of Docker Compose and powers the `web.search` tool. Worker agents can use
it when a subtask looks research-oriented. Search calls are visible as tool cards in the
execution map.

`web.search` and `chart.generate` are registered as versioned TypeScript tool modules with
input/output schemas, startup mode, capabilities, and healthchecks exposed through
`GET /api/tools/health`.

Built-in tool contracts are also synced into the Postgres `tool_modules` table on app
startup. This table is the durable catalog for future generated tools: it stores stable
system name, optional human display name, version, capabilities, schemas, source, status,
configuration/secret requirements, storage contracts, docs/examples, usage counters, and
the latest health result. Generated tools can be deleted from the catalog; built-in tools
are protected.

Tools with `startupMode=always-on` are exposed through a generic service supervisor. The
current supervisor persists lifecycle state in `tool_service_statuses` when Postgres is
configured, calls each tool's healthcheck, and exposes start/stop/restart/heartbeat
controls through `/api/tool-services`. On app startup it reconciles services whose
desired state is `running` by refreshing their health status. This is enough for UI and
lifecycle state across app restarts. Lifecycle events are stored in `tool_service_logs`
for starts, stops, restarts, heartbeats, and startup reconciliation, and new lifecycle
records are streamed through an in-process SSE channel. This is not a durable process
manager yet. The next infrastructure step is to move long-running generated modules to
queue-backed or process-backed workers that can survive app restarts and attach their own
runtime log streams.

Provider-neutral service activity is stored in `tool_service_events`. Generated
always-on tools should write inbound, outbound, and system events there with source
identity, thread, and run links instead of creating provider-specific tables in the core.
The generic `POST /api/tool-services/:name/inbound` endpoint is the first intake runner
contract: a provider-specific module receives a message, forwards a normalized event to
the core, and the core records the event, resolves channel identity, applies thread
resolution, and creates a regular run.
The matching response contract is an `outbound/queued` `tool_service_events` record
written by the server after that run completes or fails. Generated provider runners can
deliver from this neutral outbox and then append provider evidence with `sent` or
`failed` events.

Missing tool capabilities can be persisted into `tool_build_requests`. These records are
the durable handoff from runtime failure detection to the Tool Builder/Tool QA/Tool
Registrar flow. The queue stores lifecycle state, human display name, generated system
name, status detail, structured QA reports, credential handles, and the registered
generated tool name so separate workers can coordinate through the database without
sharing full conversational context.

Generated executable tools are loaded from compiled project-local modules after metadata
registration. Runtime promotion requires matching name/version/capabilities and a passing
healthcheck.

Tool-owned storage changes are tracked in `tool_migrations`. A migration record stores
tool name/version, migration id, checksum, status, applied actor/time, QA report, and
rollback notes. This is intentionally metadata-first: generated tools should declare and
promote migrations through Tool Builder/Registrar flow instead of opening their own DB
connections or hiding SQL inside tool runtime calls.

The app image includes Chromium, TypeScript source, tests, and `tsconfig` files in the
runtime layer so self-service generated tools can be written, tested, built, registered,
and loaded inside Docker. `CHROMIUM_PATH=/usr/bin/chromium` is configured for generated
browser screenshot tools. Docker Compose bind-mounts `./src/tools/generated` and
`./tests/generated` into the app container so generated TypeScript modules and their tests
survive container recreation.

### Telegram

Telegram is the first planned external user channel.

Infrastructure needs:

- bot token stored as a secret;
- webhook endpoint or polling worker;
- channel identity mapping from Telegram user ID to internal user;
- whitelist enforcement before run creation;
- inbound message persistence;
- outbound message and reminder delivery records;
- retry/error handling for provider failures;
- admin-visible audit log.

Telegram-originated runs should use the same run/event/artifact system as web-originated
runs, with extra provenance fields such as chat ID and message ID.

### Instance Isolation

The system should treat instance isolation as a first-class design constraint. One running
instance serves one group profile, but separate deployments must not share private data by
default.

Minimum requirements:

- every persistent record that contains user/group data has an instance boundary;
- database queries include instance filtering when multiple instances share infrastructure;
- artifacts are stored under instance-aware prefixes;
- tool credentials are instance/user/policy scoped;
- audit events include instance, actor, target, action, and result;
- cross-instance agent communication is explicit and logged.

## Module Boundaries

The project should keep these boundaries:

- Agent runtime: no HTTP/database assumptions.
- Memory: interface-first, storage-specific implementations underneath.
- Run store: interface-first, can move from in-memory to Postgres.
- Web console: consumes API only.
- Tool execution: isolated tools with explicit inputs and outputs.
- Channel adapters: translate provider events into run requests and outbound action
  deliveries without embedding agent logic.
- Policy/permissions: evaluated before memory access, tool use, outbound messages, and
  inter-instance communication.

Do not let worker logic depend directly on Docker services. Workers should depend on
interfaces so the runtime remains reusable.
