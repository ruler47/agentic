# API Surface (Legacy Reference)

This is the frozen reference of the legacy router at `src/server/http.ts`. It
exists so the rework branch can detect drift on every rebase, and so the new
NestJS modules can be checked for shape parity. Update this document only
when a route is added or changed on `main`.

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
| GET | `/api/tools/generated-modules/:name/versions` | — | `{ versions }` | 200, 400, 503 |
| GET | `/api/tools/generated-modules/:name/package-manifest` | — | `{ manifest }` | 200, 404, 503 |
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
| POST | `/api/tool-services/:toolName/outbox/:eventId/ack` | `parseToolServiceOutboxAckInput` | — | `{ event }` | 201, 400, 404, 503 |
| POST | `/api/tool-services/:toolName/inbound` | `parseToolServiceInboundInput` | — | `{ event, queuedEvent, run?, thread?, threadResolution? }` | 202, 400, 503 |
| PATCH | `/api/tool-services/:toolName/restart-policy` | `parseToolServiceRestartPolicyInput` | — | `{ service }` | 200, 400, 404, 503 |
| POST | `/api/tool-services/:toolName/(start\|stop\|restart\|heartbeat)` | — | — | `{ service }` | 200, 400, 404, 503 |

### Tool Service Events & Logs

| Method | Path | Body | Query | Response | Status |
|--------|------|------|-------|----------|--------|
| GET | `/api/tool-service-events` | — | `toolName, direction, limit` (default 100) | `{ events }` | 200 |
| POST | `/api/tool-service-events` | `parseToolServiceEventInput` | — | `{ event }` | 201, 400, 503 |
| GET | `/api/tool-services/logs` | — | `toolName, limit` (default 100) | `{ logs }` | 200 |
| GET | `/api/tool-services/logs/events` | — | `toolName` | SSE: `event: service-log\ndata: { log }`, `: heartbeat` | 200, 503 |

## Tool Migrations

| Method | Path | Body | Query | Response | Status |
|--------|------|------|-------|----------|--------|
| GET | `/api/tool-migrations` | — | `toolName, status` | `{ migrations }` | 200 |
| POST | `/api/tool-migrations` | `parseToolMigrationCreateInput` | — | `{ migration }` | 201, 400, 503 |

## Tool Promotions

| Method | Path | Query | Response | Status |
|--------|------|-------|----------|--------|
| GET | `/api/tool-promotions` | `toolName, buildRequestId` | `{ promotions }` | 200 |

## Tool Build Requests

| Method | Path | Body | Response | Status |
|--------|------|------|----------|--------|
| GET | `/api/tool-build-requests` | — | `{ requests }` | 200 |
| POST | `/api/tool-build-requests` | `parseToolBuildRequestInput` | `{ request }` | 201, 400, 503 |
| GET | `/api/tool-build-requests/:id` | — | `{ request }` | 200, 404, 503 |
| PATCH | `/api/tool-build-requests/:id` | `parseToolBuildRequestStatusUpdate` | `{ request }` | 200, 400, 404, 503 |
| DELETE | `/api/tool-build-requests/:id` | — | `{ deleted: true, request }` | 200, 404, 503 |
| POST | `/api/tool-build-requests/:id/stop` | `{ reason? }` | `{ request }` | 200, 400, 404, 503 |
| POST | `/api/tool-build-requests/:id/rework` | `parseToolBuildReworkInput` | `{ request, original }` | 201, 400, 503 |
| POST | `/api/tool-build-requests/:id/run` | — | `{ request, status, registeredToolName? }` | 200, 503 |

## Tool Investigations

| Method | Path | Body | Response | Status |
|--------|------|------|----------|--------|
| GET | `/api/tool-investigations` | — | `{ investigations }` | 200, 503 |
| POST | `/api/tool-investigations` | `parseToolInvestigationCreateInput` | `{ investigation }` | 201, 400, 503 |
| GET | `/api/tool-investigations/:id` | — | `{ investigation }` | 200, 404, 503 |
| PATCH | `/api/tool-investigations/:id` | `parseToolInvestigationUpdateInput` | `{ investigation }` | 200, 400, 404, 503 |
| POST | `/api/tool-investigations/:id/promote` | `{ operatorComment?, capability?, desiredToolName? }` | `{ investigation, request?, wait? }` | 201, 400, 404, 503 |

## Tool Rework Waits

| Method | Path | Body | Response | Status |
|--------|------|------|----------|--------|
| GET | `/api/tool-rework-waits` | — | `{ waits }` | 200, 503 |
| POST | `/api/tool-rework-waits` | `parseToolReworkWaitCreateInput` | `{ wait }` | 201, 400, 503 |
| GET | `/api/tool-rework-waits/:id` | — | `{ wait }` | 200, 404, 503 |
| PATCH | `/api/tool-rework-waits/:id` | `parseToolReworkWaitUpdateInput` | `{ wait }` | 200, 400, 404, 503 |
| POST | `/api/tool-rework-waits/:id/resume` | `{ reason?, retryRunId?, retrySpanId? }` | `{ wait }` | 200, 400, 404, 503 |
| POST | `/api/tool-rework-waits/:id/retry-run` | `{ reason? }` | `{ wait, retryRun, alreadyExists? }` | 201, 200, 400, 404, 409, 503 |
| POST | `/api/tool-rework-waits/:id/auto-retry` | — | `{ status, wait, retryRun?, policy?, retryDepth?, reason? }` | 201, 200, 400, 404, 409, 503 |
| GET | `/api/runs/:runId/tool-rework-waits` | — | `{ waits }` | 200, 503 |

## Secret Handles

| Method | Path | Body | Response | Status |
|--------|------|------|----------|--------|
| GET | `/api/secret-handles` | — | `{ secretHandles }` | 200 |
| POST | `/api/secret-handles` | `parseSecretHandleInput` (rejects raw secrets) | `{ secretHandle }` | 201, 400, 503 |
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
