# Web Console Module

## Purpose

The web console gives the user a browser UI for submitting tasks and watching the agent run.
Long-term, it is also the admin console for a family/company assistant deployment:
group profile, users, Telegram identities, scoped memory, tools, credentials, model tiers,
policies, artifacts, and outbound messages.

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
  "instanceId": "instance-local",
  "requesterUserId": "user-admin",
  "channel": "web",
  "sourceUserId": "telegram_user_id_or_other_channel_identity",
  "sourceChatId": "channel_chat_or_room_id",
  "sourceThreadId": "channel_thread_id",
  "sourceMessageId": "channel_message_id",
  "threadId": "thread_optional_existing",
  "parentRunId": "run_optional_previous",
  "attachments": [
    {
      "filename": "input.txt",
      "mimeType": "text/plain",
      "contentBase64": "..."
    }
  ]
}
```

The API accepts the single-user shape and context-aware metadata. The local development
path backfills a default instance profile, admin user, and `web` channel for backwards
compatibility.

Requester resolution happens before the server creates a conversation thread or run:

- explicit `requesterUserId` must exist in the configured user store, otherwise the API
  returns `400`;
- channel-originated requests can omit `requesterUserId` and pass `channel` plus
  `sourceUserId`; the pair must map to an allowed `channel_identities` row, otherwise the
  API returns `403`;
- requests without explicit requester or source user fall back to the local
  `user-admin` development identity.

When `threadId` or `parentRunId` is provided, the server should create a continuation run
inside that conversation thread. When neither is provided, the server runs deterministic
thread resolution over the resolved `requesterUserId`, `channel`, `sourceChatId`,
`sourceThreadId`, and message text. Same-source follow-ups, corrections, and
clarifications reuse the latest matching active thread; explicit `/new` and independent
requests create a new thread.
The JSON response includes `threadResolution` with `decision`, `reason`, and resolved
`threadId` when available, and the run-created audit event stores the same compact reason.

Implemented local defaults:

- `instanceId=instance-local`
- `requesterUserId=user-admin`
- `channel=web`
- new `POST /api/runs` requests create a conversation thread automatically;
- channel-originated follow-ups can omit `threadId` when `sourceChatId`/`sourceThreadId`
  identifies the previous conversation;
- continuation requests can pass `threadId` or use
  `POST /api/conversation-threads/:id/runs`.

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

Cancel an active run:

```http
POST /api/runs/:id/cancel
content-type: application/json

{ "reason": "Operator stopped the run." }
```

Cancellation is a best-effort terminal state. It marks `queued` or `running` runs as
`cancelled`, writes `run.cancelled` to the audit log, closes live streams, and prevents
late LLM/tool results from replacing the terminal status. It does not yet kill an
already in-flight model request at the transport level.

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

`POST /api/tools/generated-modules/:name/promote-replacement` promotes a QA-passed
replacement version for an existing generated tool. The request body must include
`replacesVersion`; the catalog rejects stale promotions, builtin replacement attempts, and
same-version overwrites so a tool rework cannot silently replace the active contract.

`GET /api/tool-build-requests` returns missing capability requests with builder and QA
contracts. The System Inventory panel shows the latest build queue items next to tools and
memories.

`POST /api/tool-build-requests` accepts a missing capability payload (`capability`,
`reason`, optional source run/span IDs, task summary, inputs/outputs/QA criteria) and
creates the same durable contract the runtime uses after `tool-missing`. Trace Lab's span
inspector uses this endpoint for contextual "Create tool request / bug" forms, preserving
the selected run/span context in the build request.

`GET /api/tool-build-requests/:id` and `PATCH /api/tool-build-requests/:id` provide the
builder lifecycle handoff. Builder, QA, and Registrar agents can mark a request as
`building`, `qa_failed`, `qa_passed`, `registered`, or `blocked`, attach status detail,
persist a structured QA report, and record the generated tool name that was registered.

`POST /api/tool-build-requests/:id/rework` creates a new durable `requested` build from an
existing card with operator feedback attached. This is the UI/API path for "the generated
tool is close, but change these details" without losing the original QA evidence.

`POST /api/tool-build-requests/:id/stop` marks a request `blocked` with a human status
detail. `DELETE /api/tool-build-requests/:id` removes a queue card. Both operations write
audit events. Installed tools that are marked `failed` expose a Tools-page "Rework tool"
form that creates a fresh durable build request with the failure details prefilled.

`POST /api/tool-build-requests/:id/run` executes the configured self-service build
workflow. The current workflow writes provider-generated TypeScript source and tests,
runs isolated generated-tool tests plus isolated build, performs promotion tests/build in
the real project after isolated QA passes, registers QA-passed metadata, and reloads
generated tools into the active registry. Failed QA reports can be returned to the builder
for bounded retry attempts before a request becomes `qa_failed`.

The server also runs a background Tool Builder worker by default. It claims the oldest
`requested` card atomically, moves it to `building`, executes the same workflow used by
the manual run endpoint, and reloads generated tools after registration. Operators can
disable the worker with `TOOL_BUILD_WORKER=disabled`; the UI keeps the manual run button
as a fallback.

Model tier settings:

```http
GET /api/settings/model-tiers
PUT /api/settings/model-tiers
```

Memory operations:

```http
GET /api/memories
POST /api/memories
PATCH /api/memories/:id
POST /api/memories/reembed
POST /api/memories/evaluate-retrieval
```

`POST /api/memories/reembed` rebuilds every stored memory vector for the active embedding
provider and records a `memory.embeddings_rebuilt` audit event.

`POST /api/memories/evaluate-retrieval` accepts retrieval quality cases:

```json
{
  "cases": [
    {
      "id": "spanish-pharmacy",
      "query": "Spanish pharmacy AEMPS sources",
      "expectedMemoryIds": ["memory-id"],
      "visibleScopes": [{ "scope": "global" }, { "scope": "group", "scopeId": "group-local" }],
      "limit": 5,
      "minRecall": 1
    }
  ]
}
```

The response reports `passed`, `averageRecall`, `topHitMatched`, retrieved IDs, and
missing IDs per case. Use it to keep semantic memory retrieval measurable when changing
embedding providers, tags, or stored memory summaries.

Audit events:

```http
GET /api/audit-events?limit=100
```

The Audit Log page consumes this endpoint. The current server records normalized audit
events for run creation/start/completion/failure/cancellation, uploaded and generated
artifacts, learned memory proposals, tool trace events, and tool build
request/registration lifecycle steps. Audit metadata is intended for operational evidence
and must not contain raw secrets.

Implemented context and conversation endpoints:

```http
GET /api/instance
GET /api/group-profile
GET /api/conversation-threads
GET /api/conversation-threads/:id
POST /api/conversation-threads/:id/runs
DELETE /api/conversation-threads/:id
```

`DELETE /api/conversation-threads/:id` removes the user-visible thread and deletes every
run attached through `runs.thread_id`. Run events and durable artifact metadata cascade
from the deleted runs, so Trace Lab no longer exposes those executions. The operation
writes `conversation_thread.deleted` to the audit log with counts for removed runs,
messages, and artifact references.

Future context/admin endpoints:

```http
PATCH /api/instance
PATCH /api/group-profile
GET /api/users
POST /api/users
GET /api/users/:id
PATCH /api/users/:id
GET /api/channels
GET /api/channels/telegram/identities
POST /api/channels/telegram/identities
PATCH /api/channels/telegram/identities/:id
GET /api/conversation-threads
GET /api/conversation-threads/:id
POST /api/conversation-threads/:id/runs
PATCH /api/conversation-threads/:id/summary
GET /api/memories?scope=global|group|user|thread|run&status=proposed|accepted|rejected|archived
POST /api/memories
PATCH /api/memories/:id
POST /api/outbound-actions
GET /api/outbound-actions
PATCH /api/outbound-actions/:id
GET /api/policies
PUT /api/policies
```

## Run Record

Each run contains:

- `id`
- `task`
- `status` (`queued`, `running`, `completed`, `failed`, or `cancelled`)
- `createdAt`
- `updatedAt`
- `events`
- `result`
- `error`

Run context fields:

- `instanceId`
- `requesterUserId`
- `channel`
- `threadId`
- `parentRunId`
- `sourceMessageId`
- `sourceChatId`
- `sourceThreadId`
- `permissionScope` (planned policy projection)

`result.artifacts` contains input and output artifacts with downloadable `url` values.

## Conversation Threads

A conversation thread is the user-visible continuity layer above runs. It lets a user ask
for a correction, clarify a requirement, or continue from a previous answer without
forcing the agent to infer the whole history from raw logs.

Thread records should store:

- `id`;
- `status`;
- requester and channel;
- source chat/thread IDs when available;
- latest run ID;
- compact summary;
- accepted facts;
- rejected or failed attempts;
- open questions;
- artifact references;
- created/updated timestamps.

Continuation run creation should pass compact thread context to the agent:

```text
previous requests
previous final answers
what was accepted
what was corrected or rejected
important artifacts
open questions
```

The full message log remains available for inspection, but the runtime should receive a
bounded summary by default.

The UI uses `GET /api/runs/:id/events` for live run snapshots and keeps a client-side
clock for active run/card durations, so long-running LLM/tool calls continue ticking even
between persisted events. If SSE is unavailable, it falls back to polling
`GET /api/runs/:id`. Run Workspace exposes a cancel action for `queued`/`running` runs;
cancelled runs render as terminal and show the recorded cancellation reason instead of a
placeholder final answer.

On page load it calls the instance, group profile, runs, conversation, memory, tool,
tool-build, and model-tier endpoints, then renders a hash-routed browser workspace. The
console is intentionally split by user intent:

- Dashboard is the work surface: task composer, context preview, active runs, recent
  activity, insights, and compact system health.
- Run Workspace is the human result view: prompt, final answer, artifacts, follow-up
  composer, and a compact execution timeline.
- Trace Lab is the deep inspector with live Timeline, Graph, and Logs modes, a selected
  span inspector, a return link to the originating Run Workspace, and client-side filters
  for actor, activity, status, tool, and model tier.
- The Trace Lab inspector surfaces compact memory-hit, tool-evidence, and artifact blocks
  from the selected span payload instead of requiring operators to read raw JSON first.
- Opening Trace Lab without a run ID shows a run directory instead of silently selecting
  the newest run. Graph nodes show explicit caller/callee labels so parent-child
  relationships remain readable even when visual edges are dense.
- Conversations keep continuation context visible without exposing raw traces by default.
- Memory, Artifacts, Tools, Tool Builds, Models, Group Profile, Control, and System pages
  are separate operational surfaces.

The left sidebar is grouped as Work, Analysis, Build, Control, and System. Debug details
stay out of Dashboard and Run Workspace unless the operator explicitly opens Trace Lab or
Diagnostics.

Trace events expose these fields to the UI:

- `spanId`
- `parentSpanId`
- `actor`
- `activity`
- `status`
- `durationMs`
- `payload.modelTier`
- `payload.dependencySpanIds`

This makes it visible which agent called which worker/reviewer and how long each step took.
Trace Lab Graph mode draws solid SVG arrows from direct parent spans to child spans and
dashed SVG arrows from dependency spans to work that waited for reviewed upstream output.
A compact legend explains both edge types. Hovering a node highlights incoming/outgoing
arrows, matching arrowheads, and the directly connected cards.
The current runtime emits `memory`, `planning`, `worker`, `review`, `synthesis`, `tool`,
`coordination`, and `llm` activities. `web.search`, `chart.generate`, generated
artifacts, and missing tool capabilities appear as trace cards. Future adapters for file
reads/writes, screenshots, and database operations should use the same event contract.

## Attachments And Artifacts

The task form includes a multiple-file attachment control. Files are encoded in the
browser as base64, sent with the run request, saved by the server-side artifact store, and
passed to the agent as input artifacts.

In the Docker stack, the artifact store writes metadata to Postgres and payloads to MinIO.
The same download endpoint serves both durable objects and older local filesystem
fallback artifacts.

The Answer panel renders links for `result.artifacts`, including generated output files
such as SVG charts. Text-like input and generated output artifacts store a short
`contentPreview`; the UI renders text/source snippets and compact CSV/TSV table previews
instead of showing only filenames and storage paths.
Artifacts can also include durable `quality` metadata with compact QA checks, decisions,
reasons, warnings, and matched signals. The UI renders this as a small QA badge on
artifact cards so operators can see why an output file was accepted.

Reviewer hard-gates also validate typed artifact contracts before accepting worker
results. A required dataset must look like data, a required source bundle must look like
source/markup, and document/image/chart/screenshot requirements must match their expected
MIME/extension class. Inspectable data/source artifacts with empty previews are treated
as weak evidence and must be regenerated or explicitly reported as impossible.

Market and crypto chart workflows can now collect structured numeric evidence through
the `market.timeseries` tool before rendering charts. The tool returns normalized
CoinGecko-backed points plus a CSV data artifact, so final answers can link both the
chart and the underlying dataset.

## Information Architecture

The browser UI is a page-based product shell, not a single debug dashboard. Future work
should keep separating daily work from admin/operator control.

Top-level navigation:

```text
Dashboard
Runs
Conversations
Memory
Artifacts
Tools
Tool Builds
Models
Group Profile
Users
Channels
Policies
Approvals
Scheduler
Audit Log
Settings
Diagnostics
```

Dashboard:

- task composer with requester/channel context and visible group profile;
- new-task only; continuations live inside Run Workspace and Conversation Detail so a
  thread cannot be changed accidentally; IMPLEMENTED
- active run card and recent runs;
- system health for app, database, Redis, MinIO, SearXNG, Telegram, and LLM;
- pending approvals for outbound actions;
- high-level stats for runs, artifacts, tools, memory, and channels.

Run Workspace:

- run header with status, duration, group profile, requester, channel, thread, and source
  message;
- final answer;
- files/artifacts with previews and download links;
- outbound actions and delivery status;
- follow-up composer that starts a continuation run with inherited thread context; IMPLEMENTED
- thread summary showing what the assistant believes is accepted, failed, or still open; IMPLEMENTED
- compact live execution summary;
- important events;
- link to Trace Lab.

Trace Lab:

- graph, timeline, tree, and log modes;
- filters by actor, activity, status, model tier, tool, user, and channel;
- event inspector drawer for prompts, outputs, tool evidence, memory hits, and artifacts.
- `/trace` is a run directory; `/trace/:runId` is a specific execution inspector.
- Graph edges use solid lines for direct parent calls and dashed lines for dependency
  waits. Edges pointing into failed spans stay red, including their arrow heads, so failed
  branches are visible without hover.
- The future "Create tool request / bug" inspector action should carry selected-span
  context into a bug/rework form: run/span ids, actor/activity, tool name/capability,
  input/output summaries, artifacts, QA evidence, reviewer notes, and operator feedback.
  A classifier should decide whether this becomes a tool rework, prompt/planning issue,
  credential/policy issue, external site limitation, or memory note.
- Tool Builds shows the durable build queue by lifecycle state. `requested` means a real
  request exists and is waiting for the background worker to claim it; operators can also
  trigger the workflow from the card, stop/delete the card, inspect a contract preview, or
  create a rework request with feedback when a generated module needs revision.
- Conversation Detail renders input and output artifacts inline next to the message/run
  that produced them, while the context panel keeps linked artifact references visible.
- Run Workspace and Conversation Detail render sanitized Markdown for final answers and
  messages. Bold text, Markdown links, and application-local artifact URLs are clickable;
  image artifacts get compact previews where space allows. Text-like artifacts show a
  short content preview when `contentPreview` is available, while binary/PDF/source
  artifacts show typed preview tiles instead of only a path and filename. Artifact QA
  badges are shown when `quality` metadata exists.
- PNG browser screenshots are visually and semantically QA-checked before storage.
  Near-empty screenshots, loader/blocker browser evidence, and task-mismatched browser
  context are emitted as failed artifact trace events instead of being presented as useful
  proof.

Group Profile:

- group profile;
- members and roles;
- shared memory;
- enabled tools and credentials;
- channel mappings;
- recent runs;
- scheduled/outbound messages;
- audit log.

Users:

- profile and contact preferences;
- Telegram/web/API identities;
- role and permissions;
- personal memory;
- allowed tools;
- recent requests;
- private artifacts;
- audit log.

Channels:

- installed channel adapter health;
- whitelist and mapped users for adapters that support them;
- incoming/outgoing message history;
- denied inbound attempts;
- future channel adapters created through Tool Builds.

Conversations:

- all active and archived threads;
- per-thread run list;
- compact summary and open questions;
- source Telegram/web message links;
- continuation composer;
- controls to split a message into a new thread or merge it into an existing thread.

Memory:

- global, group, user, thread, and run scopes;
- proposed/accepted/rejected/archive lifecycle;
- match reasons and confidence;
- source run/evidence links;
- review queue actions that accept/reject proposed facts and write audit events.

Tools:

- registry catalog;
- capabilities;
- schemas;
- examples;
- health;
- instance/user/role enablement;
- credential requirements.

Models:

- tier policies for `S`, `M`, `L`, and `XL`;
- local OpenAI-compatible endpoints;
- remote OpenAI API or other hosted OpenAI-compatible providers;
- model candidates per tier;
- API-key secret handles;
- attempts and escalation policy.

Tool Builds:

- missing capability requests;
- API-docs onboarding and channel-adapter requests;
- builder/QA/registrar lifecycle;
- generated source/test artifacts;
- QA reports and retry history.

Policies:

- memory access;
- tool permissions;
- outbound messaging;
- approval requirements;
- Telegram whitelist rules;
- inter-instance federation policies.

## Telegram Channel UX

The Telegram integration should be visible from the admin console, not hidden in logs.

Admin needs:

- add/remove whitelisted Telegram users;
- map Telegram user IDs to known users;
- view denied requests from unknown users;
- inspect Telegram-originated runs;
- inspect Telegram conversation threads and message-to-thread decisions;
- override a wrong thread decision by splitting or merging threads;
- see final answer delivery status;
- review outbound direct messages, group broadcasts, and scheduled reminders.

Run pages should show whether a run came from Telegram, which user sent it, which chat it
came from, and whether any response or outbound action was delivered.

Telegram adapter behavior:

- replies to the bot's previous answer should continue that thread by default;
- explicit commands such as `/new` should force a new thread;
- explicit commands such as `/continue <thread>` should force an existing thread when
  authorized;
- ambiguous messages should be classified with compact recent thread summaries;
- low-confidence decisions should be visible in the admin UI and may ask the user a short
  clarification instead of executing the wrong task.

## Extension Points

- Add optional WebSocket transport only if bidirectional browser actions need it; run
  viewing is currently covered by additive SSE.
- Continue expanding `PostgresRunStore` as the default persistent run history.
- Add authentication, instance isolation, and per-user workspaces.
- Add conversation threads and continuation run creation.
- Add Telegram bot adapter, channel identity management, and thread resolution.
- Add outbound action approval and delivery tracking.
- Add richer previews for images, PDFs, screenshots, datasets, and source bundles.

## Tests

- `tests/webServer.test.ts`
