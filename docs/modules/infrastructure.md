# Target Infrastructure

## Current Container Runtime

The project is intended to run through Docker Compose:

- `app`: Node.js web/API process.
- `postgres`: primary run/event store using `pgvector/pgvector:pg16`.
- `redis`: future queue and event stream.
- `minio`: future S3-compatible durable artifact storage.
- `searxng`: local metasearch service for `web.search`.
- local OpenAI-compatible LLM endpoint exposed to the app as `host.docker.internal`.

Run:

```bash
docker compose up --build
```

## Recommended Production Direction

### Database

PostgreSQL is the primary database.

Why:

- Reliable relational model for users, projects, runs, events, artifacts, and audit logs.
- Mature migrations and backup story.
- Works well with JSONB for flexible agent payloads.
- Can add `pgvector` for semantic skill memory and retrieval.

Current tables:

- `runs`
- `run_events`
- `skill_memories`
- `model_tier_settings`
- `tool_modules`
- `tool_build_requests`

Current filesystem-backed stores:

- `workspace/artifacts`: local request and response artifacts, with per-run manifests.

On app startup, stale `queued` or `running` runs from a previous process are marked as
`failed` with an interruption message. This keeps the UI honest after container restarts.

Future tables:

- `projects`
- `agent_tasks`
- `skill_memories`
- `artifacts`

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

The current app stores request/response artifacts on the mounted workspace filesystem.
Use S3-compatible storage for the durable production version:

- code bundles;
- screenshots;
- charts/images;
- reports;
- datasets;
- exported documents.

MinIO is already part of Docker Compose for local S3-compatible artifact storage.
The next infrastructure step is promoting the local artifact manifest/store to a
Postgres metadata table plus MinIO object payloads.

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
startup. This table is the durable catalog for future generated tools: it stores version,
capabilities, schemas, source, status, and the latest health result.

Missing tool capabilities can be persisted into `tool_build_requests`. These records are
the durable handoff from runtime failure detection to the future Tool Builder/Tool QA/Tool
Registrar flow. The queue stores lifecycle state, status detail, structured QA reports,
and the registered generated tool name so separate workers can coordinate through the
database without sharing full conversational context.

Generated executable tools are loaded from compiled project-local modules after metadata
registration. Runtime promotion requires matching name/version/capabilities and a passing
healthcheck.

The app image includes Chromium, TypeScript source, tests, and `tsconfig` files in the
runtime layer so self-service generated tools can be written, tested, built, registered,
and loaded inside Docker. `CHROMIUM_PATH=/usr/bin/chromium` is configured for generated
browser screenshot tools. Docker Compose bind-mounts `./src/tools/generated` and
`./tests/generated` into the app container so generated TypeScript modules and their tests
survive container recreation.

## Module Boundaries

The project should keep these boundaries:

- Agent runtime: no HTTP/database assumptions.
- Memory: interface-first, storage-specific implementations underneath.
- Run store: interface-first, can move from in-memory to Postgres.
- Web console: consumes API only.
- Tool execution: isolated tools with explicit inputs and outputs.

Do not let worker logic depend directly on Docker services. Workers should depend on
interfaces so the runtime remains reusable.
