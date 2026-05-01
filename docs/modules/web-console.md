# Web Console Module

## Purpose

The web console gives the user a browser UI for submitting tasks and watching the agent run.

Main files:

- `src/server/http.ts`
- `src/server/main.ts`
- `src/runs/inMemoryRunStore.ts`
- `public/index.html`
- `public/styles.css`
- `public/app.js`

## API

Health:

```http
GET /api/health
```

Create run:

```http
POST /api/runs
content-type: application/json

{ "task": "one concrete task" }
```

Get run:

```http
GET /api/runs/:id
```

List runs:

```http
GET /api/runs
```

List tools:

```http
GET /api/tools
GET /api/tools/health
```

## Run Record

Each run contains:

- `id`
- `task`
- `status`
- `createdAt`
- `updatedAt`
- `events`
- `result`
- `error`

The UI polls `GET /api/runs/:id` once per second while a run is active.
On page load it also calls `GET /api/runs`, renders the latest persisted runs, and opens
the newest run automatically so the trace survives browser refreshes and container
restarts.

Trace events are rendered as a horizontal execution map with one column per call depth:

- `spanId`
- `parentSpanId`
- `actor`
- `activity`
- `status`
- `durationMs`
- `payload.modelTier`

This makes it visible which agent called which worker/reviewer and how long each step took.
The current runtime emits `memory`, `planning`, `worker`, `review`, `synthesis`, `tool`,
and `llm` activities. `web.search` calls appear as tool cards. Future adapters for file
reads/writes, screenshots, and database operations should use the same event contract.

## Extension Points

- Replace polling with Server-Sent Events or WebSocket streaming.
- Continue expanding `PostgresRunStore` as the default persistent run history.
- Add authentication and per-user workspaces.
- Add downloadable artifacts for coding tasks.

## Tests

- `tests/webServer.test.ts`
