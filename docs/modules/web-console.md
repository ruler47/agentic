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

{
  "task": "one concrete task",
  "attachments": [
    {
      "filename": "input.txt",
      "mimeType": "text/plain",
      "contentBase64": "..."
    }
  ]
}
```

Get run:

```http
GET /api/runs/:id
```

Stream run updates:

```http
GET /api/runs/:id/events
accept: text/event-stream
```

The SSE stream emits `run` events whose payload is `{ "run": ... }`. The endpoint is
additive: existing JSON polling endpoints remain supported, and the browser UI falls back
to polling if `EventSource` is unavailable or interrupted.

Download artifact:

```http
GET /api/runs/:id/artifacts/:artifactId
```

List runs:

```http
GET /api/runs
```

List tools:

```http
GET /api/tools
POST /api/tools/generated-modules
GET /api/tools/health
GET /api/tool-build-requests
POST /api/tool-build-requests
GET /api/tool-build-requests/:id
PATCH /api/tool-build-requests/:id
POST /api/tool-build-requests/:id/run
```

`GET /api/tools` returns persistent registry metadata when configured: name, version,
description, capabilities, startup mode, schemas, source, status, health summary, and
updated timestamp.

`POST /api/tools/generated-modules` registers QA-passed generated tool metadata in the
durable catalog with name/version conflict checks. Generated modules are stored as
`disabled` until executable loading and final health checks promote them. The loader only
imports compiled project-local modules whose exported Tool contract matches the registered
metadata.

`GET /api/tool-build-requests` returns missing capability requests with builder and QA
contracts. The System Inventory panel shows the latest build queue items next to tools and
memories.

`POST /api/tool-build-requests` accepts a missing capability payload (`capability`,
`reason`, optional inputs/outputs/QA criteria) and creates the same durable contract the
runtime uses after `tool-missing`.

`GET /api/tool-build-requests/:id` and `PATCH /api/tool-build-requests/:id` provide the
builder lifecycle handoff. Builder, QA, and Registrar agents can mark a request as
`building`, `qa_failed`, `qa_passed`, `registered`, or `blocked`, attach status detail,
persist a structured QA report, and record the generated tool name that was registered.

`POST /api/tool-build-requests/:id/run` executes the configured self-service build
workflow. The current workflow writes provider-generated TypeScript source and tests,
runs isolated generated-tool tests plus isolated build, performs promotion tests/build in
the real project after isolated QA passes, registers QA-passed metadata, and reloads
generated tools into the active registry. Failed QA reports can be returned to the builder
for bounded retry attempts before a request becomes `qa_failed`.

Model tier settings:

```http
GET /api/settings/model-tiers
PUT /api/settings/model-tiers
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

`result.artifacts` contains input and output artifacts with downloadable `url` values.

The UI uses `GET /api/runs/:id/events` for live run snapshots and keeps a client-side
clock for active run/card durations, so long-running LLM/tool calls continue ticking even
between persisted events. If SSE is unavailable, it falls back to polling
`GET /api/runs/:id`.

On page load it calls `GET /api/runs`, renders the latest persisted runs, and opens the
newest run automatically so the trace survives browser refreshes and container restarts.
The left rail also exposes model tier settings so operators can assign multiple local
models to `S`, `M`, `L`, and `XL` tiers.

Trace events are rendered as a horizontal execution map with one column per call depth:

- `spanId`
- `parentSpanId`
- `actor`
- `activity`
- `status`
- `durationMs`
- `payload.modelTier`
- `payload.dependencySpanIds`

This makes it visible which agent called which worker/reviewer and how long each step took.
When a subtask depends on reviewed upstream work, the UI draws arrows from each dependency
span and shows a dependency badge on the waiting card.
The current runtime emits `memory`, `planning`, `worker`, `review`, `synthesis`, `tool`,
`coordination`, and `llm` activities. `web.search`, `chart.generate`, generated
artifacts, and missing tool capabilities appear as trace cards. Future adapters for file
reads/writes, screenshots, and database operations should use the same event contract.

## Attachments And Artifacts

The task form includes a multiple-file attachment control. Files are encoded in the
browser as base64, sent with the run request, saved by the server-side artifact store, and
passed to the agent as input artifacts.

The Answer panel renders links for `result.artifacts`, including generated output files
such as SVG charts.

## Extension Points

- Add optional WebSocket transport only if bidirectional browser actions need it; run
  viewing is currently covered by additive SSE.
- Continue expanding `PostgresRunStore` as the default persistent run history.
- Add authentication and per-user workspaces.
- Promote local artifacts to MinIO/S3-backed durable storage.
- Add richer previews for images, PDFs, screenshots, datasets, and source bundles.

## Tests

- `tests/webServer.test.ts`
