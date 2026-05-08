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
  "sourceUserAliases": ["telegram_username", "@telegram_username"],
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
  `sourceUserId`; they may also pass `sourceUserAliases` such as a Telegram username and
  `@username`. At least one source id or alias must map to an allowed
  `channel_identities` row, otherwise the API returns `403`;
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
GET /api/tools/generated-modules/:name/package-manifest
DELETE /api/tools/generated-modules/:name
GET /api/tools/health
GET /api/tool-services
GET /api/tool-service-events?toolName=optional&direction=optional&limit=100
POST /api/tool-service-events
GET /api/tool-services/logs?toolName=optional&limit=100
GET /api/tool-services/logs/events?toolName=optional
POST /api/tool-services/:name/inbound
GET /api/tool-services/:name/outbox
POST /api/tool-services/:name/outbox/:eventId/ack
POST /api/tool-services/:name/start
POST /api/tool-services/:name/stop
POST /api/tool-services/:name/restart
POST /api/tool-services/:name/heartbeat
PATCH /api/tool-services/:name/restart-policy
GET /api/tool-migrations
POST /api/tool-migrations
GET /api/tool-build-requests
POST /api/tool-build-requests
GET /api/tool-build-requests/:id
PATCH /api/tool-build-requests/:id
POST /api/tool-build-requests/:id/run
GET /api/tool-investigations
POST /api/tool-investigations
GET /api/tool-investigations/:id
PATCH /api/tool-investigations/:id
POST /api/tool-investigations/:id/promote
GET /api/tool-rework-waits
POST /api/tool-rework-waits
GET /api/tool-rework-waits/:id
PATCH /api/tool-rework-waits/:id
POST /api/tool-rework-waits/:id/resume
GET /api/runs/:id/tool-rework-waits
GET /api/secret-handles
POST /api/secret-handles
GET /api/secret-handles/:handle
DELETE /api/secret-handles/:handle
GET /api/work-ledger?threadId=&runId=&workKey=
POST /api/work-ledger
PATCH /api/work-ledger/:id
POST /api/work-ledger/:id/evidence
POST /api/work-ledger/:id/artifacts
GET /api/evidence-ledger?threadId=&runId=&workItemId=&artifactId=&sourceUrl=
POST /api/evidence-ledger
GET /api/run-retrospectives?threadId=&runId=
POST /api/run-retrospectives
PATCH /api/run-retrospectives/:id
```

`GET /api/tools` returns persistent registry metadata when configured: system name,
optional human `displayName`, version, description, capabilities, startup mode, schemas,
source, status, health summary, required configuration keys, required secret handles,
settings schema, storage contract, agent-readable docs/examples, success/failure
counters, and updated timestamp. The UI shows `displayName` as the primary label and
keeps the stable system name visible as metadata.

`GET /api/tool-services` returns lifecycle state for installed tools whose
`startupMode` is `always-on`. The matching `start`, `stop`, `restart`, and `heartbeat`
actions are provider-neutral: they call the tool healthcheck, update runtime service
state, and write audit events without hardcoding Telegram, Slack, webhooks, or any other
channel type. State persists through `tool_service_statuses` when Postgres is configured;
the app reconciles desired-running services on startup by refreshing their health status.
`PATCH /api/tool-services/:name/restart-policy` stores per-service auto-restart
overrides (`autoRestartEnabled`, `maxAutoRestarts`, `restartBackoffMs`,
`restartBackoffMultiplier`, `restartBackoffMaxMs`, `restartBackoffJitterRatio`,
`restartRequiresApproval`) so one fragile or sensitive integration can be handled
manually, delayed, or staggered without disabling bounded recovery for every other
service. When
approval is required, a failed heartbeat leaves the service in a pending restart approval
state. The Approvals page reads those pending service restart decisions from the same
tool-service state and exposes provider-neutral approve/reject actions: approve calls the
normal restart endpoint, while reject stops the service.
`GET /api/tool-services/logs` returns recent lifecycle log records written by the
supervisor for starts, stops, restarts, heartbeats, and startup reconciliation.
`GET /api/tool-services/logs/events` is an SSE stream that emits `service-log` events for
new lifecycle records, filtered by `toolName` when provided. Source-bundle HTTP process
runtimes also forward child `stdout`/`stderr` into this stream. Tools can implement
`startService(context)` to run an in-process loop under the same lifecycle controls; the
supervisor injects the internal base URL and secret resolver, stores the returned handle,
prefers handle healthchecks, and stops active handles during shutdown without clearing the
persisted desired running state. Durable external process runners and webhook workers
remain on the roadmap.

`GET /api/tool-service-events` returns provider-neutral runtime events written by
always-on generated tools. Events use `direction=inbound|outbound|system` and
`status=received|queued|sent|failed|ignored`, with optional source identity, thread, run,
and sanitized payload metadata. `POST /api/tool-service-events` is the durable handoff
for service tools to record inbound messages, outbound deliveries, ignored/denied
messages, and system events without adding Telegram/Slack/provider branches to the core.
`POST /api/tool-services/:name/inbound` is the generic intake handoff for an always-on
tool that already received a provider event. It accepts `task`, `text`, or `message`,
optional source identity fields including `sourceUserAliases`, writes a redacted inbound
event, resolves the requester through channel identities, creates a normal run, and writes
a linked queued event.
When that run completes or fails, the server also writes an `outbound/queued` service
event with the final answer or error payload. Provider-specific always-on tools can use
that event stream as a neutral outbox, deliver the response externally, and then record a
`sent` or `failed` delivery event.
`GET /api/tool-services/:name/outbox` returns still-undelivered `outbound/queued` events
for a service. `POST /api/tool-services/:name/outbox/:eventId/ack` accepts
`status=sent|failed`, optional provider message evidence, and a sanitized payload; it
records a linked outbound delivery event and removes the queued source event from future
outbox polling.

The built-in reference provider module `channel.telegram.bot` uses this exact contract:
it resolves the `secret.telegram.bot.token` handle, polls Telegram updates, forwards text
messages as normalized inbound events, polls neutral outbox events, sends Telegram
messages, and acknowledges delivery. To accept a real Telegram user, create a channel
identity with `provider=channel.telegram.bot` and either `providerUserId=<telegram user id>`
or `providerUserId=@telegram_username`; the bot forwards both `username` and `@username`
aliases when Telegram exposes them. Operators can do this from the Users page by adding
an identity to the target user, or from the Channels page by clicking the `Allow as Admin`
shortcut on an ignored inbound event.

Telegram answers are chunked into multiple `sendMessage` calls when they exceed Telegram's
message length limit, instead of appending `[truncated]`. The final chunk includes a
`Continue thread` inline button when the outbox event is linked to a conversation thread;
clicking it stores a short-lived continuation intent so the next message from the same
chat/user is sent with the internal Agentic `threadId`. Provider-native
`sourceThreadId` is still reserved for Telegram forum/topic IDs and other external
channel thread identifiers.

The browser UI keeps list-style pages fresh with a soft background refresh. It polls the
same JSON endpoints, fingerprints the returned state, and only re-renders when data
actually changes. If the operator is typing in an input, select, or textarea, or has an
open tool-build/rework request form, the render is deferred so drafts are not closed,
cleared, or jumped back to the top. Live run details still prefer the per-run SSE stream,
and always-on lifecycle logs still prefer the service-log SSE stream.

`POST /api/tools/generated-modules` registers QA-passed generated tool metadata in the
durable catalog with name/version conflict checks. Generated modules are stored as
`disabled` until executable loading and final health checks promote them. The loader only
imports compiled project-local modules whose exported Tool contract matches the registered
metadata. Metadata may include a `changeSummary`/changelog explaining why the version was
created, what changed, and which request or feedback drove it. Generated metadata may
also include a portable `packageManifest` for future import/export and out-of-process
runner execution. Generated metadata may also include `promotionEvidence`, which links
the active version to its Tool Build request, QA summary/checks/reviews, package ref,
promotion timestamp, and storage migration ids.

`GET /api/tools/generated-modules/:name/versions` returns the version history for a
generated tool, including active status, module/test paths, capabilities, required secret
handles, changelog, promotion evidence, health detail, and per-version usage counters.
The Tools inspector uses this to show a compact version history below the active-version
selector.

`GET /api/tools/generated-modules/:name/package-manifest` returns the active generated
tool's portable package manifest when one exists. This is the first API surface for
exporting a self-contained integration package; full import and external runner support
remain roadmap work.

`DELETE /api/tools/generated-modules/:name` removes a generated tool from the durable
catalog and unregisters it from the active runtime when loaded. Built-in tools are
protected and cannot be deleted through this endpoint.

`POST /api/tools/generated-modules/:name/promote-replacement` promotes a QA-passed
replacement version for an existing generated tool. The request body must include
`replacesVersion`; the catalog rejects stale promotions, builtin replacement attempts, and
same-version overwrites so a tool rework cannot silently replace the active contract.

`POST /api/tools/generated-modules/:name/activate-version` switches the active generated
tool version to an already registered version. The response includes the selected tool
metadata and the version list. The Tools UI exposes this as an active-version selector;
newly promoted replacements become the highest active version by default, while older
versions remain inspectable.

`GET /api/tool-build-requests` returns missing capability requests with builder and QA
contracts. The System Inventory panel shows the latest build queue items next to tools and
memories.

`POST /api/tool-build-requests` accepts a human tool request payload (`displayName`,
`reason`, optional `startupMode`, optional credential notes, optional source run/span IDs,
task summary, inputs/outputs/QA criteria, and optional low-level `credentialHandles`) and
creates the same durable contract the runtime uses after `tool-missing`. If `capability`
is omitted,
the server infers a stable internal capability from the name/description, then generates a
system name such as `generated.api.aml.score` while avoiding already-used names where
possible. Trace Lab's span inspector uses this endpoint for contextual "Create tool
request / bug" forms, preserving the selected run/span context in the build request. If
the span belongs to an installed tool, the form also includes the tool name and active
version so the request becomes a versioned rework candidate instead of a disconnected
bug card. Free-form credential notes are converted to a scoped secret handle when
possible; after extraction the queued request keeps only a redacted note pointing to the
handle, and builder instructions forbid leaking raw credential material into source,
tests, prompts, traces, memory, or artifacts. When a direct operator request has no
`sourceRunId`, the server creates a root run and links it back through `sourceRunId` so
the build/change request is visible in Runs and Trace Lab.

The Tool Builds UI intentionally keeps the form simple:

- **Display name**: the human label shown throughout the registry and trace surfaces.
- **Description/docs**: the actual task, API docs, endpoint examples, expected behavior,
  and acceptance notes.
- **Credentials**: optional operator notes such as an API key, bot token, or secret
  reference. The request API extracts the actual key-like value into a scoped secret
  handle when possible, redacts raw operator notes from the durable queue, and the builder
  must not expose raw material in generated outputs.
- **Run mode**: `on-demand` for normal call-time tools, `always-on` for bots/webhooks/
  listeners/services that should stay alive and expose health/lifecycle, or `ephemeral`
  for short-lived jobs.
- **QA criteria**: prefilled universal requirements for TypeScript, tests, manual smoke,
  schemas, and credential non-leakage. Operators can append case-specific checks.

For API/service-like requests the server infers a provider-neutral Tool Integration
contract and stores it inside the build request. The contract describes mode, provider
hint, inbound/outbound event shape, secret handles, settings, storage, and QA
requirements. Generated service modules expose that same contract in docs, examples,
settings schema, storage metadata, and runtime status so future Telegram, Slack,
webhook, or custom integrations can be built without a provider-specific core branch.

The Tools page supports registry search across display name, system name, version,
description, capabilities/tags, source/status, declared settings/secrets, docs/examples,
and schemas. Generated tool detail panels expose delete, active-version selection, and a
"Request change / new version" form. That rework form creates a normal Tool Build request
with `replacesToolName` and `replacesVersion`, so fixes and behavior changes follow the
same Builder → QA → Registrar → promotion path as missing capabilities. The same inspector
shows per-version changelog and promotion-evidence cards so operators can see what
changed, which QA/reviews promoted it, and which package/migrations are linked before
activating or rolling back a generated version. Tool cards also show the matching
always-on service runtime when one exists, including running/stopped state and heartbeat
age, so the operator does not need to open Channels just to see whether a bot/listener is
active. The same service panel exposes start, stop, restart, and heartbeat actions from
the tool detail view so always-on tools do not require a separate provider-specific page
for basic lifecycle operations.

The Models page resolves tier policy from selectable model IDs rather than free-text
comma fields. Each tier can build an ordered fallback list from the discovered local
OpenAI-compatible `/models` catalog plus manually registered local/remote providers; saved
model IDs that are not currently reachable stay visible as removable fallback chips.

`GET /api/tool-build-requests/:id` and `PATCH /api/tool-build-requests/:id` provide the
builder lifecycle handoff. Builder, QA, and Registrar agents can mark a request as
`building`, `qa_failed`, `qa_passed`, `registered`, or `blocked`, attach status detail,
persist a structured QA report, persist code/behavior review gate decisions inside
`qaReport.reviews`, and record the generated tool name that was registered.
When `TOOL_BUILD_LLM_REVIEW=enabled`, LLM code/behavior reviewer decisions are stored in
the same `qaReport.reviews` array. The UI treats them as real promotion gates, not merely
advice, so a non-pass decision remains visible on the card and can drive a repair retry.

`POST /api/tool-build-requests/:id/rework` creates a new durable `requested` build from an
existing card with operator feedback attached. This is the UI/API path for "the generated
tool is close, but change these details" without losing the original QA evidence.

`POST /api/tools/package-manifests` imports a portable
`agentic.tool-package.v1` manifest into the registry. The Tools page exposes the same
collapsed import form. Local-path manifests can later be loaded by the current compiled
module loader; pre-built source-bundle manifests can load from `TOOL_PACKAGE_ROOT` when
they contain `dist/index.js` or `index.js`; external-package manifests whose `package.ref`
is an HTTP(S) URL load through the external HTTP package runner. That external runtime
must expose `GET /health`, `POST /run`, and optional service lifecycle routes. OCI image
manifests can load through the Docker runner when `TOOL_OCI_RUNNER=enabled`; Diagnostics
shows it as disabled otherwise. Importing an OCI manifest does not start Docker. The
registered tool starts a short-lived container on `/run`, and `always-on` OCI tools start
and stop through the same Tool Service lifecycle controls as source-bundle services. The
Docker runner applies Agentic labels, non-secret tool identity env vars, optional
resource/isolation flags, bounded runtime call timeouts, and redacted startup failure
logs. Package references without an installed runner, such as npm package coordinates or
OCI images while the runner is disabled, are stored as disabled metadata until a generic
package runner can execute them. Import triggers a generated-tool reload, so loadable
package manifests can become available immediately after registration.
For HTTP/OCI runtimes, declared `requiredSecretHandles` are resolved at call time and sent
as a scoped runtime envelope. Declared `requiredConfigurationKeys` are handled the same
way for non-secret settings. Undeclared config values and undeclared secrets are never
forwarded by the package runner.

Tool runtime settings:

```text
GET /api/tool-settings
GET /api/tool-settings?toolName=<tool>
POST /api/tool-settings/validate
PUT /api/tool-settings
DELETE /api/tool-settings/:toolName/:key
```

`PUT /api/tool-settings` accepts `{ toolName, key, value }` for non-secret runtime
configuration such as provider URLs, feature flags, and rate-limit hints. Values are
stored in `tool_runtime_settings`, audited on save/delete, shown in the Tools detail
inspector, and resolved for tool execution before falling back to process environment
variables. Secrets remain separate: API keys, bot tokens, and passwords must use
`secret_handles`, not runtime settings. The Tools detail inspector groups saved
configuration values, missing required config, declared secret handles, and
`settingsSchema` hints so operators can configure a tool without reading its generated
source. `POST /api/tool-settings/validate` accepts `{ toolName, settings, deleteKeys }`
and returns `{ ok, issues, warnings, preview }`; it validates required configuration keys
plus string, URL, number, integer, boolean, enum, length, and pattern constraints declared
by the tool's `settingsSchema`.

`GET /api/tool-package-runners` returns installed package runners, their supported package
types, status, and root/configuration hints. The Diagnostics page surfaces the same
inventory so operators can tell whether an imported package is disabled because the tool
is broken or because no runner exists for its package type yet.

`POST /api/tools/reload-generated` reloads generated tools through the installed package
runners and writes an audit event. Diagnostics exposes this as "Reload generated tools",
which is useful after updating a source-bundle package on disk without restarting the app.
For local source-bundle packages, reload can also rebuild the package workspace when the
expected compiled entrypoint is missing (`dist/index.js` for in-process bundles or
`dist/runtime/server.js` for HTTP process bundles). This keeps gitignored generated
packages portable without requiring compiled `dist` output to be committed.

`POST /api/tool-build-requests/:id/stop` marks a request `blocked` with a human status
detail. `DELETE /api/tool-build-requests/:id` removes a queue card. Both operations write
audit events. Installed tools that are marked `failed` expose a Tools-page "Rework tool"
form that creates a fresh durable build request with the failure details prefilled.

`POST /api/tool-build-requests/:id/run` executes the configured self-service build
workflow. The server workflow writes provider-generated TypeScript source and tests into
the gitignored package workspace (`tools/<system-name>/<version>`) by default, runs
package-workspace structural/build/test QA in an isolated copy, registers the QA-passed
source-bundle manifest, and reloads generated tools into the active registry. Legacy
project-file writes to `src/tools/generated` and `tests/generated` happen only when
`TOOL_BUILD_LEGACY_PROJECT_FILES=enabled` is set, or when the package workspace is
disabled for a temporary fallback. Failed QA or review reports can be returned to the
builder for bounded retry attempts before a request becomes `qa_failed`.

`GET /api/secret-handles` and `POST /api/secret-handles` expose the credential reference
registry used by Tool Builds, generated tools, always-on modules, and future remote model
providers. A secret handle stores a provider (`env`, `external`, or UI-created `inline`),
label, scopes, and `secretRef` such as `TELEGRAM_BOT_TOKEN`, a vault path, or the scoped
inline credential material created from a Tool Build form. Raw values (`token`,
`password`, `apiKey`, `value`) are rejected by the public API shape. The simplified Tool
Build form may accept free-form credential notes and convert them into a generated
tool-scoped inline secret handle before QA. Inline credential detection also scans the
operator's high-level request text, task summary, and feedback; detected raw credentials
are redacted from queued Tool Build text before API responses, audit records, or generated
builder prompts can echo them. `DELETE /api/secret-handles/:handle` removes a handle and
writes an audit event; list/get responses do not expose the underlying secret value.

`GET /api/tool-migrations` lists tool-owned migration records. Optional query filters are
`toolName` and `status` (`pending`, `applied`, `failed`, `rolled_back`). `POST
/api/tool-migrations` records a versioned migration with tool name/version, migration id,
checksum, status, applied actor/time, QA report, and rollback notes. This endpoint is the
durable operator/registrar handoff; generated tools should not run hidden ad hoc SQL from
inside `run(input)`.

`GET /api/tool-promotions` lists generated tool promotion journal entries. Optional query
filters are `toolName` and `buildRequestId`. Each entry links the promoted version to the
Tool Build request, QA evidence, package ref, migration ids, and promotion timestamp. The
Tools inspector renders those entries under **Promotion journal** next to active-version
evidence, so operators can distinguish the current active state from the append-only
registrar decision trail.

The server also runs a background Tool Builder worker by default. It claims the oldest
`requested` card atomically, moves it to `building`, executes the same workflow used by
the manual run endpoint, and reloads generated tools after registration. Operators can
disable the worker with `TOOL_BUILD_WORKER=disabled`; the UI keeps the manual run button
as a fallback. Re-running an already registered build request is intended to be
idempotent so a manual fallback click does not turn a background-successful build into a
blocked card.

Model tier settings:

```http
GET /api/settings/model-tiers
PUT /api/settings/model-tiers
```

Memory operations:

```http
GET /api/memories
GET /api/memories/review-queue
POST /api/memories
PATCH /api/memories/:id
POST /api/memories/reembed
POST /api/memories/evaluate-retrieval
```

`GET /api/memories/review-queue` returns proposed memories with deterministic proposal
reviews. The review flags unsafe accepts before an LLM memory specialist exists: missing
non-global `scopeId`, private memory outside user scope, low confidence, missing
evidence/source links, and sensitive/private policy risks.

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
- The Trace Lab inspector surfaces durable agent call frames, return self-checks, compact
  memory-hit, tool-evidence, and artifact blocks from the selected span payload instead
  of requiring operators to read raw JSON first.
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
After task classification, the runtime also emits `agent-strategy-selected` with
`activity: "agent"`. Its payload is the recursive-agent strategy decision: primary mode
(`direct_answer`, `delegated_dag`, `tool_use`, `tool_build_or_rework`,
`ledger_reuse_or_wait`, or `council`), allowed actions, model tier, review strictness,
ledger policy, tool policy, risk signals, and optional council participants. The current
console renders it as a normal trace card; future UI slices should surface this as the
reasoning handoff before child-agent/council execution.
The follow-up event `agent-invocation-created` records the root `AgentInvocation` contract
derived from that strategy: caller, local task, output contract, allowed actions, allowed
tool names, tier, review strictness, and depth budget. When the strategy is `council`,
`agent-council-planned` records one planned invocation per council participant. These
events are intentionally visible as trace cards so operators can see what the recursive
executor is expected to run before the executor itself replaces the current central DAG.
`agent-invocation-return-checked` records the root invocation's generic return gate:
non-empty output, required evidence/artifact counts, warnings, limitations, and whether
the invocation is ready to hand back to its caller.

When the Work / Evidence / Run-Retrospective stores are configured, the runtime adds
five more event types that flow through the same SSE contract:
`work-ledger-claim-created`, `work-ledger-reused`, `work-ledger-waiting-existing`,
`evidence-ledger-recorded`, and `run-retrospective-proposed`. Each event has
`activity: "coordination"` and `actor: "runtime-ledger"`, so existing trace cards
already render them; their payloads expose `workItemId`, `workKey`, `decision`,
`evidenceId`, `kind`, `qaStatus`, and (for the retrospective) the proposed record id.
Trace Lab can be filtered on these activity values to inspect dedupe decisions
inline with normal spans. There is no dedicated console view for the ledgers in this
slice — operators query the HTTP endpoints (`/api/work-ledger`,
`/api/evidence-ledger`, `/api/run-retrospectives`) directly until a UI surface lands
in a later phase.

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
- pending approvals for outbound actions and approval-gated service restarts;
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
- The "Create tool request / bug" inspector action opens a Tool Investigation Ticket
  modal (see "Tool Investigations" below). The modal previews the run/span/tool/artifact
  context that will be attached to the ticket, lets the operator add a comment, and
  creates a durable investigation through `POST /api/tool-investigations`. The modal does
  not silently retarget another tool when the selected span does not match a registered
  tool by exact actor/payload — it warns the operator and stores the ticket as `manual`
  for triage. A future LLM triage classifier should decide whether the resulting build
  request, if any, becomes a tool rework, prompt/planning issue, credential/policy issue,
  external site limitation, or memory note.
- Tool Builds shows the durable build queue by lifecycle state. `requested` means a real
  request exists and is waiting for the background worker to claim it; operators can also
  trigger the workflow from the card, stop/delete the card, inspect a contract preview, or
  create a rework request with feedback when a generated module needs revision.
- Conversation Detail renders input and output artifacts inline next to the message/run
  that produced them, while the context panel keeps linked artifact references visible.
- Run Workspace and Conversation Detail render sanitized Markdown for final answers and
  messages. Bold text, Markdown links, and application-local artifact URLs are clickable;
  image artifacts get compact previews where space allows and open in a lightbox with
  zoom, previous/next navigation, and keyboard close/navigation. Text-like artifacts show
  a short content preview when `contentPreview` is available, while binary/PDF/source
  artifacts show typed preview tiles instead of only a path and filename. Artifact QA
  badges are shown when `quality` metadata exists. Trace Lab inspector also renders
  artifact references from the selected span payload so screenshot/file evidence is not
  hidden in raw JSON.
- Trace Lab graph mode uses explicit arrowheads for parent/dependency edges. Hovering a
  node highlights both incoming and outgoing connected edges, dims unrelated edges/cards,
  and renders the highlighted edges last so they sit visually above the rest. Clicking a
  node pins the same highlight until the operator clicks the graph canvas. Failed-edge
  arrows stay red even without hover. The MiniMap should show all nodes with
  status-colored dots. Trace mode (`Timeline`, `Graph`, `Logs`) and graph layout
  (`category`, `depth`) persist in local storage so refresh/navigation keeps the
  operator's last inspection mode.
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

- installed always-on tool health;
- whitelist and mapped users for integrations that support them;
- incoming/outgoing message history;
- denied inbound attempts;
- future bots/listeners/webhooks created through Tool Builds.

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
- API-docs onboarding and always-on integration requests;
- human tool requests where the server infers stable capability ids such as
  `api.aml.score` from the display name and description;
- docs/endpoints/examples in the request description and optional sensitive credential
  notes for the builder to convert into durable settings/secret handles;
- builder/QA/registrar lifecycle;
- generated source/test artifacts;
- QA reports and retry history.
- a top "Tool Investigations" panel that lists open and linked investigations created
  from Trace Lab/tool/artifact failures. Each card shows status, source, matched
  tool/run/span, operator comment, and a one-click "Promote to Tool Build request" action
  that creates a build request through `POST /api/tool-build-requests` and links the
  resulting build id back to the investigation as `linked_to_build`.

Policies:

- memory access;
- tool permissions;
- outbound messaging;
- approval requirements;
- Telegram whitelist rules;
- inter-instance federation policies.

## Tool Investigations

Tool Investigation Tickets are the durable failure-context layer between Trace Lab/Tools
/Artifacts and the Tool Build queue. They preserve enough context that a future agent or
operator can repair the right tool without losing the original signal.

A ticket has:

- `id`, `status` (`open` | `triaged` | `linked_to_build` | `closed`), `source`
  (`trace_span` | `tool_detail` | `artifact` | `manual`);
- `title` and optional `operatorComment`;
- optional `runId`, `spanId`, `toolName`, `toolVersion`, and `artifactIds`;
- optional `linkedBuildRequestId` once the investigation has been promoted;
- a structured `contextBundle` with task prompt, run title, actor, activity, status,
  caller, input/output summaries, error, artifact QA evidence, sanitized tool settings,
  related artifact references, and triage notes;
- `createdAt`/`updatedAt` timestamps.

Sensitive keys (`secret`, `token`, `password`, `apiKey`, `api_key`, `credential`,
`authorization`) inside the context bundle are replaced with `"[redacted]"` before
storage, both in-memory and in Postgres. Tool Build requests created from an
investigation must continue to use scoped secret handles; the investigation itself never
holds raw credential material.

API:

- `GET /api/tool-investigations` — list recent tickets (descending `createdAt`).
- `POST /api/tool-investigations` — create a ticket. Required fields: `source`, `title`.
  Returns 201 with `{ investigation }`.
- `GET /api/tool-investigations/:id` — fetch a single ticket. 404 when missing.
- `PATCH /api/tool-investigations/:id` — update `status`, `operatorComment`,
  `linkedBuildRequestId`, `artifactIds`, or `contextBundle`. The server rejects a
  `linkedBuildRequestId` that does not correspond to an existing tool build request.
All endpoints return 503 if the investigation store is not configured.

The Trace Lab span inspector replaces the previous inline tool-build form with a modal
that shows what context will be attached, asks for an operator comment, creates the
investigation, and shows the created ticket id on success. When the selected span has no
clear matching registered tool (by exact actor/payload), the modal renders a warning and
saves the ticket as `manual` instead of guessing a target tool. The Tool Builds page
exposes the same tickets as a top "Tool Investigations" panel with a one-click "Promote
to Tool Build request" action.

`POST /api/tool-investigations/:id/promote` is the server-side promotion path: it creates
a tool build request from the investigation context, links it as `linked_to_build`, and,
when the investigation has a `runId`, opens a Tool Rework Wait that parks the run in
`waiting_tool_rework` until the build is registered or the operator closes the wait.

Promotion is **deterministic**, not fuzzy:

- If `investigation.toolName` matches an installed tool in the registry, capability,
  `replacesToolName`, `replacesVersion`, and startup mode come from that tool's
  metadata. No keyword inference can override the matched tool.
- If `investigation.toolName` is set but does not match any installed tool, the API
  returns `400` with `code=investigation_promotion_ambiguous` and asks the operator to
  pass explicit `capability` and `desiredToolName` in the request body.
- If the investigation has no `toolName`, the API returns the same `400` unless the body
  explicitly provides both `capability` and `desiredToolName`.

The investigation's `runId` is also validated against the run store before any wait is
created. A missing run causes a `400` instead of silently leaving an orphan wait.

## Tool Rework Waits And Run Resume

Tool Rework Waits are the durable link between a failing run, the investigation/build
chain that explains the failure, and the eventual resume. They turn `failed` runs that
need a tool upgrade into `waiting_tool_rework` runs without losing operator visibility.

A wait record has:

- `id`, `runId`, optional `spanId`;
- `status` (`waiting` | `build_running` | `promoted` | `resumed` | `failed` |
  `cancelled`);
- `reason`;
- optional `toolName`, `toolVersion`, `investigationId`, `buildRequestId`;
- optional `promotedVersion` once the build registers;
- optional `retryRunId` / `retrySpanId` once the wait is resumed by a manual retry run or
  by the auto-retry orchestrator;
- `createdAt`, `updatedAt`.

API:

- `GET /api/tool-rework-waits` — list recent waits (newest first).
- `GET /api/runs/:id/tool-rework-waits` — list waits scoped to one run.
- `GET /api/tool-rework-waits/:id` — fetch a single wait. 404 when missing.
- `POST /api/tool-rework-waits` — create a wait. Required fields: `runId`, `reason`. The
  server validates that any provided `buildRequestId`/`investigationId` exists, creates
  the wait, marks the run as `waiting_tool_rework`, and audits
  `tool_rework_wait.created`.
- `PATCH /api/tool-rework-waits/:id` — update `status`, `reason`, references, or retry
  pointers. Audits `tool_rework_wait.updated`.
- `POST /api/tool-rework-waits/:id/resume` — only allowed when status is `promoted`.
  This is the **"mark ready for retry / close wait"** handoff: the wait moves to
  `resumed`, the run returns from `waiting_tool_rework` back to `failed` so an operator
  can re-issue the original task with the new tool version, and `tool_rework_wait.resumed`
  is audited. The endpoint does **not** automatically retry the agent — the recursive
  span-level retry engine is Phase 2. Pass `{ "retryRunId": "..." }` to record an existing
  retry run id when one already exists.
- `POST /api/tool-rework-waits/:id/auto-retry` — runs the auto-retry orchestrator's
  decision against the wait. Returns `{ status, wait?, retryRun?, alreadyExists?,
  policy, retryDepth?, reason? }`. Status codes: `201` for newly created retry runs,
  `200` for `already_exists` and `disabled`, `404` for unknown waits, `409` for
  `wait_not_promoted` / `source_run_cancelled` / `max_depth_reached`, and `400` for
  `source_run_not_found` / `failed`. Idempotent: a second call returns the existing
  retry run. Audits `tool_rework_wait.auto_retry_decision` with
  `actorId=auto-retry-orchestrator`, `actorType=agent`, and metadata containing the
  decision string, policy snapshot, retry depth, and linked build/investigation ids.
  This endpoint is the operator surface for the same orchestrator that runs
  automatically inside `notifyBuildRegistered` via `onWaitPromoted`.
- `POST /api/tool-rework-waits/:id/retry-run` — also only allowed when status is
  `promoted`. This is the **"create retry run"** handoff: the server creates a new run
  whose `task` and instance/user/channel/thread provenance come from the original
  run, links it through `parentRunId` and through `wait.retryRunId`, returns the source
  run from `waiting_tool_rework` back to `failed`, and immediately starts the retry
  through the same `executeRun` path used by `POST /api/runs`. Audits
  `tool_rework_wait.retry_run_created` with `sourceRunId`, `retryRunId`, `buildRequestId`,
  `investigationId`, `promotedVersion`, and `toolName`. Idempotent: a second call returns
  `200 { wait, retryRun, alreadyExists: true }` instead of duplicating the run. Returns
  `404` for unknown waits, `409` for non-promoted waits, and `400` when the source run
  has been deleted. Span-level recursive retry of only the failed step is still Phase 2;
  this endpoint creates a full-run retry that executes through the standard agent loop.

All endpoints return 503 when the wait store is not configured.

When a tool build request transitions to `registered` (through PATCH, the workflow
runner, or the background Tool Builder worker), every matching wait is automatically
promoted to `promoted`, the registered tool name is propagated, and a
`tool_rework_wait.updated` audit event is recorded. The background worker uses
`actorId="tool-build-worker"` for its `tool_build.registered` audit and stamps
`metadata.backgroundWorker=true` so operators can tell apart manual and worker-driven
registrations. `ToolImprovementCoordinator` nudges the worker through
`scheduleImmediate()` immediately after creating a build, so promoted investigations
typically reach `promoted` within one tick instead of waiting for the configured
`TOOL_BUILD_WORKER_INTERVAL_MS` interval.

The promote endpoint, the standalone wait creation endpoint, the build-registered
notification, and the resume endpoint all delegate to a single in-process domain helper,
`ToolImprovementCoordinator` (`src/tools/toolImprovementCoordinator.ts`). The same
coordinator is also passed into `UniversalAgent.run` as `toolImprovementCoordinator`, so
an agent that detects a missing or insufficient tool produces the same auditable
investigation + build + wait lifecycle as an operator-triggered promotion. Agent-driven
audits are tagged with `actorType: "agent"` and `metadata.agentDriven: true`, while
operator-triggered audits keep `actorType: "user"` with `actorId: "user-admin"`.

UI surfaces:

- Run Workspace shows a "Waiting for tool upgrade" panel above the answer card whenever
  active waits exist for the selected run, with status, reason, and shortcuts to Tool
  Builds and Trace Lab.
- Trace Lab inspector renders the linked wait/build/investigation card next to the
  selected span when a wait is open.
- Tool Builds investigation cards and build cards show their linked waits with two
  separate actions when the wait is `promoted`:
  - `Create retry run` — calls `POST /api/tool-rework-waits/:id/retry-run` to spawn a
    linked retry run that executes through the standard agent loop. Once a retry run
    exists, the wait card replaces the button with `Open retry run`.
  - `Mark ready for retry` — calls `POST /api/tool-rework-waits/:id/resume` to close the
    wait without spawning a retry run, returning the source run to `failed` so an
    operator can re-issue the task manually with the new tool version.
  Run Workspace and the Trace Lab inspector wait card surface the same two actions.
- The Runs list and dashboard activity surfaces show `waiting_tool_rework` as a separate
  status badge so paused runs are not confused with failures.

## Always-On Tool UX

External intake such as Telegram should be modeled as an always-on generated tool module,
not as a special channel branch. The operator describes the desired bot/listener/webhook
behavior in Tool Builds, selects `startupMode=always-on`, provides credentials through
secret handles, and the Builder creates a reusable TypeScript module with tests, QA, and
registry metadata. The generic lifecycle UI should then show status, heartbeat, logs,
last inbound/outbound events, and start/stop/restart controls.

Telegram is the first reference always-on tool. The built-in `channel.telegram.bot`
module is visible in the same lifecycle UI as any future generated bot/listener, not
hidden in logs.

A second Telegram bot is onboarded as a generated isolated tool through Tool Builder,
not as a fork of the built-in module. Submit a Tool Build request with:

- `displayName`: human-readable bot name (for example, "Family Telegram Assistant Bot");
- `desiredToolName`: stable system name (for example, `generated.telegram.family-assistant-bot`);
- `startupMode`: `always-on`;
- `credentialHandles`: a stored secret handle pointing at the bot token (the request
  body must NOT contain the raw token);
- `reason`: a natural-language description that mentions Telegram, polling
  (`getUpdates`), sending (`sendMessage`), splitting long messages, the inline
  `Continue thread` button, and any allowed-user constraints.

`MessagingServiceToolBuildProvider` claims concrete messaging-provider requests before
the generic service provider. It is intentionally a provider-family builder, not a
special provider path in the run runtime: each supported provider spec must generate a
portable source-bundle package under `tools/<system-name>/<version>` and communicate with
Agentic only through the neutral `/api/tool-services/:name/inbound` and `/outbox`
endpoints. The first provider spec is Telegram Bot API, so requests that name that API produce a real
`getUpdates`/`sendMessage` adapter with long-message splitting and the inline
`Continue thread` button. The service registers as `always-on`, appears in Tools/Channels
lifecycle UI, and stores provider allowlists in the generated tool `settingsSchema`
(operators edit them through the Tools detail UI without rebuilding). The built-in
`channel.telegram.bot` remains only as a reference adapter until generated packages reach
feature parity (artifacts, voice intake, etc.); both can run side by side with separate
secret handles.

The Tool Builder must not promote a provider-neutral bridge as if it were a complete
provider adapter. If a request explicitly asks for provider behavior such as Telegram Bot
API polling (`getUpdates`) and outbound delivery (`sendMessage`), the generated package
must implement and test that provider behavior behind the same portable always-on service
contract. Deterministic behavior review rejects generic service-bridge evidence for those
requests until a provider adapter generator or LLM repair path supplies the missing
implementation.

Screenshot generation now uses the same isolated package path as other generated tools:
`generated.browser.screenshot` is expected to load from a source-bundle package under the
gitignored `tools/` workspace. Older tracked app-source screenshot variants were removed
to avoid presenting three similar screenshot tools in the UI; database migrations also
remove stale legacy rows while preserving the source-bundle package variant.

Contextual tool requests created from Trace Lab spans can be submitted from the wrong
selected span. The server checks operator feedback against installed tool names, display
names, descriptions, and capabilities. If the selected tool clearly does not match the
text and another installed tool does, the request is rejected with a clarification instead
of being silently retargeted. The operator can then open the correct span/tool or rewrite
the request for the selected tool.

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

Telegram bot behavior:

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
