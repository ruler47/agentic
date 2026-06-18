# API Surface

This is the public HTTP contract served by the NestJS API. It was originally
harvested from the legacy router during the rework, but the hand-rolled router
has now been removed. Update this document when a route is added or changed on
`main`.

## Health & Instance

| Method | Path | Purpose | Body | Query | Response | Status |
|--------|------|---------|------|-------|----------|--------|
| GET | `/api/health` | Liveness | — | — | `{ ok: true }` | 200 |
| GET | `/api/instance` | Instance metadata | — | — | `{ instance: { id, name, defaultLanguage, timeZone, locale } }` | 200 |
| GET | `/api/group-profile` | Get group profile (default fallback) | — | — | `{ groupProfile: GroupProfileRecord }` | 200 |
| PATCH | `/api/group-profile` | Update group profile | `parseGroupProfileUpdate` | — | `{ groupProfile }` | 200, 400, 503 |

## Users & Channel Identities

| Method | Path | Body | Response | Status |
|--------|------|------|----------|--------|
| GET | `/api/users` | — | `{ users: UserRecord[] }` (with `recentRequests`) | 200 |
| POST | `/api/users` | `parseUserCreateInput` | `{ user }` | 201, 400 |
| PATCH | `/api/users/:id` | `parseUserUpdateInput` | `{ user }` | 200, 400, 404 |
| DELETE | `/api/users/:id` | — | `{ deleted: true, userId }` | 200, 400, 404 |
| POST | `/api/users/:id/channel-identities` | `parseChannelIdentityCreateInput` | `{ identity }` | 201, 400 |
| PATCH | `/api/channel-identities/:id` | `parseChannelIdentityUpdateInput` | `{ identity }` | 200, 400, 404 |
| DELETE | `/api/channel-identities/:id` | — | `{ deleted: true, identityId }` | 200, 404 |

## Runs

| Method | Path | Body | Response | Status |
|--------|------|------|----------|--------|
| GET | `/api/runs` | — | `{ runs: AgentRunRecord[] }` | 200 |
| POST | `/api/runs` | `RunCreateContext` (task, instanceId, requesterUserId, channel, threadId, parentRunId, sourceMessageId, attachments) | `{ run, thread?, threadResolution? }` | 202, 400, 403 |
| GET | `/api/runs/:id` | — | `{ run }` | 200, 404 |
| GET | `/api/runs/:id/events` | — | SSE: `event: run\ndata: { run }`, `event: error`, `: heartbeat` | 200, 404 |
| POST | `/api/runs/:id/cancel` | `{ reason? }` | `{ run }` | 200, 404, 409 |
| GET | `/api/runs/:id/artifacts/:artifactId` | — | binary; `content-disposition: inline; filename="..."` | 200, 404, 503 |
| POST | `/api/conversation-threads/:threadId/runs` | `RunCreateContext` (threadId from URL) | `{ run, thread?, threadResolution? }` | 202, 400, 403 |

## Audit Events

| Method | Path | Query | Response | Status |
|--------|------|-------|----------|--------|
| GET | `/api/audit-events` | `limit` (default 100) | `{ events: AuditEventRecord[] }` | 200 |

## Conversation Threads

| Method | Path | Response | Status |
|--------|------|----------|--------|
| GET | `/api/conversation-threads` | `{ threads }` | 200 |
| GET | `/api/conversation-threads/:id` | `{ thread }` | 200, 404, 503 |
| DELETE | `/api/conversation-threads/:id` | `{ deleted, thread, deletedRuns, deletedMessages, deletedArtifactReferences }` | 200, 404, 503 |

## Memories

| Method | Path | Body | Query | Response | Status |
|--------|------|------|-------|----------|--------|
| GET | `/api/memories` | — | `status, scope, scopeId, includeArchived, offset, limit` | `{ memories }` | 200 |
| POST | `/api/memories` | `parseMemoryCreateInput` | — | `{ memory }` | 201, 400, 503 |
| PATCH | `/api/memories/:id` | `parseMemoryUpdateInput` | — | `{ memory }` | 200, 400, 404, 503 |
| POST | `/api/memories/reembed` | — | — | `{ updated }` | 200, 500, 503 |
| POST | `/api/memories/evaluate-retrieval` | `parseMemoryRetrievalEvaluationCases` | — | `{ report }` | 200, 400, 503 |
| GET | `/api/memories/review-queue` | — | — | `{ memories, reviews, summary }` | 200, 503 |

## Tools

| Method | Path | Body | Query | Response | Status |
|--------|------|------|-------|----------|--------|
| GET | `/api/tools` | — | — | `{ tools: ToolModuleMetadata[] }` | 200 |
| GET | `/api/tools/health` | — | — | `{ tools: ToolHealth[] }` | 200 |
| POST | `/api/tools/reload-generated` | — | — | `{ tools }` | 200, 500, 503 |
| POST | `/api/tools/create-package` | `{ name?, version?, description?, request, capabilities?, dependencies?, discoveryMode?, discoveryQuery?, authoringMode?, behaviorExamples? }` | — | `{ tool, creation, runId, package, qa }` | 201, 400, 503 |
| POST | `/api/tools/generated-modules/:name/versions` | `{ version?, request \| changeRequest, description?, kind?, capabilities?, dependencies?, discoveryMode?, discoveryQuery?, authoringMode?, behaviorExamples? }` | — | `{ tool, creation, runId, package, qa }` | 201, 400, 404, 503 |
| POST | `/api/action-proposals/:proposalId/build-executor` | `{ mode?: "create" \| "plan" }` | — | `{ proposal }` | 200, 404, 409 |
| POST | `/api/tools/:name/run` | `{ input }` or raw input object | — | `{ tool, result, durationMs }` | 200, 404, 503 |
| POST | `/api/tools/generated-modules/:name/versions/:version/run` | `{ input }` or raw input object | — | `{ tool, result, durationMs, loadDetail }` | 200, 400, 404, 503 |
| PATCH | `/api/tools/:name/status` | `{ status: "available" \| "disabled" }` | — | `{ tool }` | 200, 400, 404, 503 |
| GET | `/api/tool-creations` | — | `toolName, status, limit` | `{ creations }` | 200, 400 |
| GET | `/api/tool-creations/:id` | — | — | `{ creation }` | 200, 404 |

Tool status is operator policy, not deletion. Only `available` tools may be offered to
`BaseAgent`, and even `available` tools are omitted when computed runtime readiness is
blocked by missing settings or unresolved secret handles. `loaded`, `disabled`, and
`failed` tools remain in the catalog for manual inspection but are omitted from agent
tool schemas.

`POST /api/tools/create-package` is the first rebuild-era Tool Creation endpoint. It now
runs through a small `ToolBuilderAgent` strategy planner before writing a package. The
planner records whether the build is currently using a custom TypeScript shell, HTTP/API
shell, npm-package adapter, compatibility template, or imported source bundle, plus
candidates/rejected options and implementation notes in the durable `tool_creations`
record. The endpoint writes a portable source-bundle package under
`TOOL_PACKAGE_WORKSPACE_ROOT` (default `tools/<name>/<version>`), runs package-local
build/test QA, registers the package manifest, reloads generated tools, and leaves the
new tool `disabled` so the operator can manually run it before enabling it for agent use.
It also creates a normal run for the creation attempt; the response `runId` and
`creation.runId` point to the Run Workspace trace, where discovery, strategy selection,
authoring, package QA, registration, and completion/failure are visible as
`tool-creation-*` events.

`POST /api/tools/generated-modules/:name/versions` is Tool Editing V1. It accepts an
operator change request for an existing generated tool, builds a new source-bundle
package version under `tools/<name>/<version>`, runs the same package-local QA path,
promotes the generated replacement metadata, reloads the registry, writes a
`tool_creations` record, creates a normal traceable run, and leaves the edited version
as an inactive disabled candidate until manual verification/promotion. The previously
active version remains active and available according to its existing status. Previous
versions remain in the version history and can be activated through the versions
endpoint/UI.
`POST /api/tools/generated-modules/:name/versions/:version/run` manually runs one
registered generated version through its package runner without activating that version
or exposing it to agents. This is the non-disruptive review path for candidate and
rollback versions.
Tool names should be semantic capability names such as `web.fetch`, `browser.screenshot`,
or `text.slugify`. Provenance such as generated/imported/OCI/external is stored in
manifest and creation metadata instead of being encoded in the name.
Optional `dependencies` are package-local npm dependency ranges and are never installed
into Agentic's root app. `discoveryMode` can be `disabled`, `npm`, or `auto`; the
default is controlled by `TOOL_BUILDER_DISCOVERY` and is currently disabled-first for
local reliability. In `npm` mode the builder searches
`TOOL_BUILDER_NPM_REGISTRY_SEARCH_URL` (default `https://registry.npmjs.org`) for
candidate packages, records search evidence, inspects the selected package metadata/
README/entry hints when available, and may select a package dependency for the generated
tool workspace. The first README-driven adapter synthesis is active for npm packages:
when README usage shows a default callable, named export, or namespace member call, the
builder persists an `adapterContract` and the generated package uses that contract at
runtime instead of assuming every package is a default export. README examples with a
single object argument can produce `inputMode: "object"`, a derived object input schema,
and an example payload; generated packages validate required fields and pass the input
object directly to the package function. Operator-supplied `docs`, `documentation`,
`docsMarkdown`, `apiDocs`, `openApiSpec`, `openapi`, `curlExamples`, and docs URL fields
are inspected as generic documentation inputs. JSON OpenAPI specs and cURL snippets can
produce docs-derived `external-api` candidates and behavior fixtures, including
multi-step `POST -> GET` scenarios with placeholders such as `{{created.data.id}}`.
`behaviorExamples` is an optional array of QA examples. A single-call example can use
`{ title?, input, expectedOk?, expectedContent?, expectedContentIncludes?,
expectedDataPath?, expectedDataEquals?, expectedDataIncludes?, expectedArtifactMimeType?,
expectedArtifactVisualOk? }`; a scenario can use `{ title?, steps: [...] }` with the same
checks per step plus `saveAs`. These examples are persisted in the builder strategy and
executed against the built package's `tool.run()` before registration; failure leaves the
creation in `qa_failed`. Some strategy paths can also infer initial behavior examples
from the capability request, README package examples with expected output comments,
OpenAPI docs, and cURL examples. LLM-authored package snapshots may return
`behaviorExamples` too; when the deterministic plan does not already contain examples,
those authored QA criteria are merged into the package QA run.
Generated package manifests may include `integration`
(`agentic.tool-integration.v1`). API/docs/cURL paths use `mode: "run-on-demand"` with
HTTP operations and auth/secret-handle requirements. Bot/listener/webhook requests use
`mode: "always-on-service"` with inbound/outbound event schemas, lifecycle operations,
and callback strategy. `kind: "service-adapter"` writes always-on source bundles and must
preserve inherited integration contracts during version edits. Provider-specific loops are
generated package code, not core API branches. The first deterministic provider loop is
Telegram: long-poll `getUpdates`, normalize messages into
`/api/tool-services/:name/inbound`, poll generic outbox, deliver with `sendMessage`, and
ack delivery through `/api/tool-services/:name/outbox/:eventId/ack`.
For `kind: "http-json"`, generated packages accept `url` or `baseUrl + path`, `method`,
`query`, JSON `body`, and safe non-secret headers. OpenAPI security schemes are registered
as required secret handles; generated HTTP clients apply those credentials from runtime
secret context and do not accept secret-looking operator headers as trusted credentials.
Parsed JSON response fields are available directly under result `data`, with HTTP
metadata under `data.response`, so behavior QA can assert API values and chained scenarios.
When an integration manifest contains operations, callers may pass `operationId` plus
`baseUrl`, `pathParams`, `query`, and `body`; the generated client fills method/path from
the manifest and replaces `{param}` / `:param` path placeholders before the request.
Manual run endpoints (`POST /api/tools/:name/run` and
`POST /api/tools/generated-modules/:name/versions/:version/run`) return an optional
`diagnostic` object with `type: "missing_runtime_requirements"` when package startup is
blocked by absent runtime settings or secret handles. The diagnostic contains the missing
configuration keys, missing secret handles, a human-readable message, and suggested
operator actions; raw secret values are never returned. `GET /api/tools` includes a
computed `runtimeReadiness` object for each tool, and `GET /api/tools/health` reports a
failed health entry when the package healthcheck passes but readiness is blocked. Run
creation uses the same readiness result when composing the `BaseAgent` tool catalog.
`kind: "web-read"` creates a generated known-URL page reader that extracts title,
readable text, and links; it is the portable companion to `web.search` for deeper source
inspection after search.
`authoringMode` can be `scaffold`, `llm`, or `auto`; the default is controlled by
`TOOL_BUILDER_AUTHORING` / `TOOL_BUILDER_LLM_AUTHORING` and is currently scaffold-first.
In `llm` mode the builder asks the XL tier model for a complete JSON source-bundle
snapshot, rejects unsafe paths/raw secrets/Agentic-internal imports, and falls back to
the scaffold writer with durable notes when authoring fails.

### Tool Settings

| Method | Path | Body | Query | Response | Status |
|--------|------|------|-------|----------|--------|
| GET | `/api/tool-settings` | — | `toolName` | `{ settings }` | 200 |
| PUT | `/api/tool-settings` | `{ toolName, key, value }` (`normalizeToolRuntimeSettingInput`) | — | `{ setting }` | 200, 400, 503 |
| POST | `/api/tool-settings/validate` | settings payload | — | `{ valid, errors? }` | 200, 400, 503 |
| DELETE | `/api/tool-settings/:toolName/:key` | — | — | `{ deleted: true, toolName, key }` | 200, 400, 404, 503 |

### Generated Tools

| Method | Path | Body | Response | Status |
|--------|------|------|----------|--------|
| POST | `/api/tools/generated-modules` | `parseGeneratedToolModuleInput` | `{ tool }` | 201, 400, 503 |
| POST | `/api/tools/package-manifests` | `parseToolPackageManifestImport` | `{ tool }` | 201, 400, 503 |
| POST | `/api/tools/source-bundles` | `{ manifest, files: [{ path, content }] }` | `{ tool, creation, package, qa }` | 201, 400, 503 |
| GET | `/api/tools/generated-modules/:name/versions` | — | `{ versions }` | 200, 400, 503 |
| POST | `/api/tools/generated-modules/:name/versions/:version/run` | `{ input }` or raw input object | `{ tool, result, durationMs, loadDetail }` | 200, 400, 404, 503 |
| GET | `/api/tools/generated-modules/:name/package-manifest` | — | `{ manifest }` | 200, 404, 503 |
| GET | `/api/tools/:name/source-bundle` | — | `{ manifest, package, files }` | 200, 400, 404 |
| DELETE | `/api/tools/generated-modules/:name` | — | `{ deleted: true, name }` | 200, 400, 404, 503 |
| POST | `/api/tools/generated-modules/:name/activate-version` | `{ version }` | `{ tool }` | 200, 400, 503 |
| POST | `/api/tools/generated-modules/:name/promote-replacement` | `parseGeneratedToolReplacementInput` | `{ tool }` | 200, 400, 503 |

### Tool Package Runners

| Method | Path | Response | Status |
|--------|------|----------|--------|
| GET | `/api/tool-package-runners` | `{ runners: ToolPackageRunnerDescription[] }` | 200 |

## Tool Services

| Method | Path | Body | Query | Response | Status |
|--------|------|------|-------|----------|--------|
| GET | `/api/tool-services` | — | — | `{ services }` | 200 |
| GET | `/api/tool-services/:toolName/outbox` | — | `limit` (default 50) | `{ events }` | 200, 404, 503 |
| POST | `/api/tool-services/:toolName/outbox/:eventId/ack` | `parseToolServiceOutboxAckInput` | — | `{ event }`; provider details are secret-redacted | 201, 400, 404, 503 |
| POST | `/api/tool-services/:toolName/inbound` | `parseToolServiceInboundInput` | — | `{ event, queuedEvent, run?, thread?, threadResolution? }`; failed run creation records `system/failed` event | 202, 400, 403, 503 |
| PATCH | `/api/tool-services/:toolName/restart-policy` | `parseToolServiceRestartPolicyInput` | — | `{ service }` | 200, 400, 404, 503 |
| POST | `/api/tool-services/:toolName/(start\|stop\|restart\|heartbeat)` | — | — | `{ service }` | 200, 400, 404, 503 |

### Tool Service Events & Logs

| Method | Path | Body | Query | Response | Status |
|--------|------|------|-------|----------|--------|
| GET | `/api/tool-service-events` | — | `toolName, direction, limit` (default 100) | `{ events }` | 200 |
| POST | `/api/tool-service-events` | `parseToolServiceEventInput` | — | `{ event }` | 201, 400, 503 |
| POST | `/api/tool-service-events/:eventId/allow-identity` | optional `{ userId }` or `{ createUser: { id?, displayName, role?, roles? } }` | — | `{ event, user, identities, run? }`; received inbound events are replayed once after approval | 201, 400, 404, 503 |
| GET | `/api/tool-services/logs` | — | `toolName, limit` (default 100) | `{ logs }` | 200 |
| GET | `/api/tool-services/logs/events` | — | `toolName` | SSE: `event: service-log\ndata: { log }`, `: heartbeat` | 200, 503 |

## Tool Promotions

| Method | Path | Query | Response | Status |
|--------|------|-------|----------|--------|
| GET | `/api/tool-promotions` | `toolName, buildRequestId` | `{ promotions }` | 200 |

## Removed Legacy Tool Build/Rework Endpoints

These routes are no longer active in the rebuild baseline and should return `404` until a
new tool creation/versioning design ships:

- `/api/tool-build-runs`
- `/api/tool-build-requests`
- `/api/tool-investigations`
- `/api/tool-rework-waits`
- `/api/tool-migrations`

## Secret Handles

| Method | Path | Body | Response | Status |
|--------|------|------|----------|--------|
| GET | `/api/secret-handles` | — | `{ secretHandles }` | 200 |
| POST | `/api/secret-handles` | `parseSecretHandleInput` (rejects raw secrets) | `{ secretHandle }` | 201, 400, 503 |
| POST | `/api/secret-handles/status` | `{ handles: string[] }` | `{ handles: [{ handle, registered, resolvable, provider?, secretRef?, scopes?, reason? }] }` | 200, 503 |
| GET | `/api/secret-handles/:handle` | — | `{ secretHandle }` | 200, 404, 503 |
| DELETE | `/api/secret-handles/:handle` | — | `{ deleted: true, secretHandle }` | 200, 404, 503 |

## Models & Settings

| Method | Path | Body | Response | Status |
|--------|------|------|----------|--------|
| GET | `/api/settings/model-tiers` | — | `{ tiers }` | 200 |
| PUT | `/api/settings/model-tiers` | `{ tiers: TierSettingInput[] }` | `{ tiers }` | 200, 400, 503 |
| GET | `/api/models/catalog` | — | `{ chat: { baseUrl, defaultModel, models }, embedding: {...}, providers }` | 200 |
| GET | `/api/model-providers` | — | `{ providers }` | 200 |
| POST | `/api/model-providers` | `parseModelProviderInput` | `{ provider }` | 201, 400, 503 |
| PATCH | `/api/model-providers/:id` | `parseModelProviderUpdate` | `{ provider }` | 200, 400, 503 |
| DELETE | `/api/model-providers/:id` | — | `{ deleted: true }` | 200, 400, 404, 503 |

## Behavioural Notes

- **SSE streams**: `/api/runs/:id/events` and `/api/tool-services/logs/events`
  use `text/event-stream`, `: heartbeat` every 15s, terminate on terminal run
  status.
- **Binary downloads**: `/api/runs/:id/artifacts/:artifactId` returns raw
  bytes with `content-type` from artifact metadata and
  `content-disposition: inline`.
- **Async creation**: `POST /api/runs*` and `POST /api/tool-services/:n/inbound`
  return 202 (run executes asynchronously); follow-up uses GET/SSE.
- **Audit events**: most write endpoints record audit events with action,
  targetType, status, instanceId, runId, threadId, requesterUserId, channel,
  summary, and a sanitised metadata bag (secrets stripped).
- **Error shape**: every non-2xx response body is `{ "error": "..." }`.
  Status codes: 400 invalid input, 403 thread/permission, 404 not found,
  409 terminal/conflicting, 503 store missing, 500 unexpected.
- **Static fallback**: any GET that does not match an `/api/*` route falls
  through to the legacy `public/` directory served by `serveStatic`.
