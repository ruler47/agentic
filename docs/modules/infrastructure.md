# Target Infrastructure

## Current Container Runtime

The project is intended to run through Docker Compose:

- `app`: Node.js web/API process.
- `postgres`: primary run/event store using `pgvector/pgvector:pg16`.
- `redis`: future queue and event stream.
- `minio`: future artifact storage.
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

Future tables:

- `projects`
- `agent_tasks`
- `skill_memories`
- `artifacts`

### Vector Memory

Use `pgvector` first.

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

Use S3-compatible storage for generated artifacts:

- code bundles;
- screenshots;
- reports;
- datasets;
- exported documents.

MinIO is already part of Docker Compose for local S3-compatible artifact storage.

## Module Boundaries

The project should keep these boundaries:

- Agent runtime: no HTTP/database assumptions.
- Memory: interface-first, storage-specific implementations underneath.
- Run store: interface-first, can move from in-memory to Postgres.
- Web console: consumes API only.
- Tool execution: isolated tools with explicit inputs and outputs.

Do not let worker logic depend directly on Docker services. Workers should depend on
interfaces so the runtime remains reusable.
