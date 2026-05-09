# API Rework Plan

Status: complete cutover. The hand-rolled legacy API has been removed and the
NestJS API is the only supported web server path.

This document is the durable record of migrating the Agentic web API off the
hand-rolled router onto NestJS. It also records the follow-up hardening items
left after cutover.

## 1. Why

The removed hand-rolled router was a single file of ~5400 lines that:

- routes ~75 endpoints with manual `if (request.method === ... && url.pathname === ...)`
  chains and ~30 ad-hoc regex matchers,
- hand-parses request bodies with ~50 bespoke `parseXxxInput` helpers,
- inlines cross-cutting concerns (audit recording, error → JSON conversion,
  SSE heartbeats, secret redaction) inside each handler,
- composes ~25 stores/services through a single `WebAppOptions` bag wired in
  the old server bootstrap,
- mixes orchestration (`createAndStartRun`, `executeRun`, tool builder
  callbacks, auto-retry-after-promotion) with HTTP plumbing.

This is functional but resists evolution: every new route triggers another
parser, another audit-record block, another SSE wrapper, another option in
`WebAppOptions`. Tests cover the domain layer well but not the HTTP wiring.
The rework moves the wiring onto a framework and shrinks the per-route cost.

## 2. Framework Choice: NestJS (Express adapter)

Decision: **NestJS** with the default Express HTTP adapter.

Why NestJS:

- decorator-based controllers + DTOs replace ~75 if-chains and ~50 parsers
  with `class-validator` schemas;
- DI container replaces the `WebAppOptions` bag — every store becomes a
  provider with a Postgres/InMemory factory;
- lifecycle hooks (`OnModuleInit`, `OnApplicationShutdown`) match the
  existing `server.on('close')` cleanup for `ToolBuildWorker` and
  `ToolServiceSupervisor`;
- first-class SSE via `@Sse` returning `Observable<MessageEvent>`;
- optional `@nestjs/swagger` gives auto-generated OpenAPI for free, which
  the React UI and external consumers benefit from;
- the user explicitly asked for NestJS or "what's most popular now" — NestJS
  fits both criteria.

Why Express adapter rather than Fastify adapter:

- the project is `"type": "module"`; Express adapter has fewer ESM/decorator
  edge cases;
- performance is not the bottleneck (LLM latency dominates), so Fastify's
  throughput edge does not matter here;
- if it does later, swap is one file change.

Rejected alternatives:

- **Fastify directly** — fast and ESM-clean, but no DI; we'd reinvent half
  of NestJS by hand for ~25 stores;
- **Hono** — minimalist, fits edge but underwhelming for stateful background
  workers and the SSE/lifecycle complexity we have;
- **tRPC** — type-safe RPC is great but does not replace the public REST
  surface that the React UI, CLI examples, and the Telegram bot's webhook
  intent all consume.

## 3. Target Layout

The whole `src/server/` tree is rewritten. Domain modules
(`src/agents`, `src/tools/*`, `src/memory/*`, `src/runs`, `src/conversations`,
`src/instance`, `src/audit`, `src/secrets`, `src/settings`, `src/artifacts`,
`src/db`, `src/llm`, `src/utils`) stay where they are — controllers/services
in the new `src/server/` wrap them, they do not move.

```text
src/server/
  main.nest.ts                     # bootstrap: NestFactory.create(AppModule).listen(port)
  app.module.ts                    # root composition
  config/
    env.ts                         # typed env, replaces scattered process.env reads
    config.module.ts
  common/
    filters/
      api-exception.filter.ts      # global: maps RunContextError → 400, parse errors → 400, NotFound → 404
    interceptors/
      audit.interceptor.ts         # replaces inline recordAudit() blocks
      sanitize-secrets.interceptor.ts
    pipes/
    validation.pipe.ts           # class-validator-based request validation
    decorators/
      @CurrentInstance(), @CurrentUser(), @SseHeartbeat()
    guards/
      whitelist.guard.ts           # placeholder for future channel/identity auth
  persistence/
    persistence.module.ts          # exports every Store token via factory (Postgres-or-InMemory)
    pool.provider.ts               # provides pg.Pool when DATABASE_URL is set
    tokens.ts                      # injection tokens: RUN_STORE, TOOL_METADATA_STORE, ...
  workers/
    tool-build.worker.provider.ts  # @Injectable wrapping ToolBuildWorker
    tool-service.supervisor.provider.ts
  modules/
    health/                        # GET /api/health, /api/instance, /api/group-profile (PATCH too)
    users/                         # /api/users, /api/channel-identities
    runs/                          # POST /runs, GET /runs/:id, /events (SSE), /cancel, /artifacts/:id
    conversations/                 # /api/conversation-threads
    audit/                         # /api/audit-events
    memory/                        # /api/memories + /reembed + /evaluate-retrieval + /review-queue
    secrets/                       # /api/secret-handles
    models/                        # /api/settings/model-tiers, /api/models/catalog, /api/model-providers
    tools/                         # /api/tools, /api/tool-settings, /api/tools/health, /api/tools/reload-generated, /api/tools/generated-modules/...
    tool-builds/                   # /api/tool-build-requests
    tool-services/                 # /api/tool-services, /api/tool-service-events, logs (SSE)
    tool-investigations/           # /api/tool-investigations
    tool-rework-waits/             # /api/tool-rework-waits + /api/runs/:id/tool-rework-waits
    tool-migrations/               # /api/tool-migrations, /api/tool-promotions
    static/                        # serves public/ fallback for the browser console
```

Rule: every legacy URL is preserved with the **same method and JSON shape**.
The rework is structural, not behavioural. Behavioural changes (Swagger,
auth, OpenAPI client gen) are tracked as separate follow-ups in section 8.

## 4. Phases

Each phase is an independent slice the user can review/test in isolation.
Phase boundaries were commit boundaries during the migration.

### Phase 0 — Lock the contract

- Create `docs/api-surface.md` listing every URL+method+request shape+
  response shape harvested from the previous API. This remains the public
  contract document after cutover.
- The full snapshot suite was deferred; `tests/nestApi.test.ts` now covers
  the high-risk Nest API paths directly.

### Phase 1 — Skeleton without breaking legacy

- Add deps to root `package.json`: `@nestjs/common`, `@nestjs/core`,
  `@nestjs/platform-express`, `class-validator`, `class-transformer`,
  `reflect-metadata`, `@nestjs/serve-static`. Optional: `@nestjs/swagger`,
  `zod`, `nestjs-zod`.
- Update `tsconfig.json`: `experimentalDecorators`, `emitDecoratorMetadata`.
  Verify ESM + decorators path with `tsx` (or switch to `ts-node` for the
  Nest dev server if needed).
- Create the new tree under `src/server/` per section 3. The entry point is
  `src/server/main.nest.ts`.
- Add scripts:
  - `web:api` → `node dist/server/main.nest.js`
  - `web:api:dev` / `web:legacy:dev` → `tsx src/server/main.nest.ts`
  - `web` / `web:dev` → React console launcher (`scripts/web-react-dev.mjs`)
- AppModule imports `ConfigModule`, `PersistenceModule`, `HealthModule`.
- HealthModule ships first: `/api/health`, `/api/instance`, GET/PATCH
  `/api/group-profile`. Smallest possible vertical slice to validate the
  pipeline end-to-end.
- `npm run verify` now targets the Nest server only.

### Phase 2 — Port flat read/write modules

In rough order of risk (low → medium):

1. UsersModule (`/api/users`, `/api/users/:id/channel-identities`,
   `/api/channel-identities/:id`).
2. ConversationsModule, AuditModule.
3. MemoryModule (skip `/review-queue` heuristics initially — port them
   verbatim from `reviewMemoryProposals` calls).
4. SecretsModule.
5. ModelsModule + SettingsModule (`/api/settings/model-tiers`,
   `/api/models/catalog`, `/api/model-providers`).
6. ToolsModule basics (`/api/tools`, `/api/tool-settings*`,
   `/api/tools/health`, `/api/tools/reload-generated`).
7. ToolBuildRequestsModule, ToolInvestigationsModule, ToolReworkWaitsModule
   (REST only — execution paths come in phase 3).
8. ToolMigrationsModule + ToolPromotionsModule.
9. ArtifactsModule (file download `/api/runs/:id/artifacts/:id` with proper
   `content-disposition` headers).

Per-module rules:

- one controller per resource, one service per resource;
- DTOs replace the matching `parseXxxInput` helper;
- the helper is **deleted** once the DTO ships and tests pass — no parallel
  parsers;
- audit events move into an `AuditInterceptor` (URL/method/result-keyed) +
  explicit `auditService.record(...)` calls inside services where the audit
  needs run-derived fields;
- existing `tests/*.test.ts` are lifted to use `Test.createTestingModule` —
  they keep their assertions, change only the construction.

### Phase 3 — Run lifecycle and SSE

- RunsModule:
  - REST: `POST /api/runs`, `GET /api/runs`, `GET /api/runs/:id`,
    `POST /api/runs/:id/cancel`.
  - SSE: `GET /api/runs/:id/events` via `@Sse` returning
    `Observable<MessageEvent>`. Reuse the 650 ms poll + 15 s heartbeat
    cadence from `streamRunEvents`.
  - `RunsService` owns run creation and `executeRun`. It depends on `AgentRunner`,
    `RunStore`, `ConversationStore`, `ArtifactStore`, `AuditService`,
    `ToolImprovementCoordinatorFactory`, `GroupProfileStore`, `UserStore`.
  - The auto-retry-after-promotion hook lives in the Nest runtime wiring and
    is injected into `ToolImprovementCoordinator` via the same
    `onWaitPromoted` callback shape.
- ToolServicesModule:
  - REST: `/api/tool-services` collection + per-service routes
    (`/start`, `/stop`, `/restart`, `/heartbeat`, `/outbox`,
    `/outbox/:id/ack`, `/inbound`, `/restart-policy`).
  - SSE: `/api/tool-services/logs/events` with optional `?toolName` filter.

### Phase 4 — Workers and lifecycle

- `ToolBuildWorker` becomes `@Injectable()` with `OnModuleInit` →
  `worker.start()` (gated on `TOOL_BUILD_WORKER !== "disabled"`) and
  `OnApplicationShutdown` → `worker.stop()`.
- The `setOnAfterCompleted` callback becomes a service collaborator
  (`AuditService` + `ToolImprovementCoordinator`) injected into the worker.
- `ToolServiceSupervisor` mirrors that lifecycle and exposes its log
  emitter to the SSE controller.
- `reconcileDesiredServices()` runs in `OnApplicationBootstrap`.

### Phase 5 — Cutover

- `npm run web:api` points at the NestJS bootstrap. `npm run web` and
  `npm run web:dev` now launch the React console plus Nest API for local
  operator work.
- The legacy router, legacy bootstrap, and legacy `webServer.test.ts` are
  removed. Surviving request parsing lives in `src/server/common/parsers.ts`
  and module-local parser files.
- React UI base URL stays the same. No changes in `web-react/src/api/*`.
- Docker `Dockerfile` `CMD` and `docker-compose.yml` keep the same script
  entry; `npm run serve` now migrates and starts `dist/server/main.nest.js`.

### Phase 6 — Optional follow-ups (not blocking cutover)

- `@nestjs/swagger` mounted at `/api/docs`. DTOs already give us the schema.
- Generate a typed client from the OpenAPI spec for `web-react/src/api`,
  replacing the hand-rolled `apiFetch` wrappers.
- Replace `class-validator` with Zod via `nestjs-zod` if the team prefers
  Zod's inference (subjective; either is fine).
- Add an `AuthGuard` once the user/whitelist model lands — the guard
  scaffold ships in Phase 1 as a passthrough so the seam exists.

## 5. Coexistence with Other Branches

After cutover, branches must add or change HTTP behaviour in the Nest module
tree only. If a branch still references the deleted legacy router, rebase it
and port the change into the matching controller/service pair before merging.

Per rebase cycle:

1. `git fetch origin && git rebase origin/main`.
2. If a new route is added, add it to `docs/api-surface.md`, implement it in
   the matching Nest module, and add a Nest e2e assertion when the route is
   user-visible or cross-module.
3. Run `npm run verify`.

## 6. Verification Strategy

Three layers, all gated in `npm run verify`:

- **Unit tests per module** — port the existing `tests/*.test.ts` to use
  `Test.createTestingModule` for the controller layer; keep store-level
  tests as-is (they don't touch HTTP).
- **Nest API e2e tests** (`tests/nestApi.test.ts`) — boots the real Nest
  `AppModule` and validates health/static/docs, runs, tool investigations,
  tool rework waits, inline secret redaction, work/evidence ledgers, run
  retrospectives, and audit canary redaction.
- **Manual smoke** — after Phase 3 lands, run `docker compose up --build`
  and exercise each React route (Runs, Tools, Memory, Tool Builds,
  Channels, Approvals, Diagnostics, Models, Settings, Audit Log,
  Conversations) against the Nest server. Confirm SSE for run events and
  tool service logs.

## 7. Progress Checklist

- [x] Phase 0: api-surface.md — listed every legacy route (`docs/api-surface.md`)
- [~] Phase 0: contract snapshot suite — deferred; per-phase curl smoke tests
      catch parity drift instead, full snapshot suite is an open follow-up
- [x] Phase 1: NestJS skeleton (AppModule, ConfigModule, PersistenceModule, CommonModule)
- [x] Phase 1: HealthModule + Instance + GroupProfile
- [x] Phase 2: UsersModule
- [x] Phase 2: ConversationsModule + AuditModule
- [x] Phase 2: MemoryModule
- [x] Phase 2: SecretsModule
- [x] Phase 2: ModelsModule + SettingsModule
- [x] Phase 2: ToolsModule (basics + settings + generated-modules + package runners)
- [x] Phase 2: ToolBuildRequestsModule + ToolInvestigationsModule + ToolReworkWaitsModule
- [x] Phase 2: ToolMigrationsModule + ToolPromotionsModule
- [x] Phase 2: ArtifactsModule (folded into RunsModule — single artifact route)
- [x] Phase 3: RunsModule (REST + SSE + executeRun)
- [x] Phase 3: ToolServicesModule (REST + SSE logs)
- [x] Phase 4: ToolBuildWorker provider + lifecycle (RuntimeWorkersModule)
- [x] Phase 4: ToolServiceSupervisor provider + lifecycle
- [x] Phase 4: ServeStaticModule for legacy public/
- [x] Phase 5: Switch `npm run web` and `npm run serve` (Docker) to Nest
- [x] Phase 5: Delete the legacy router/bootstrap/tests and replace the HTTP
      regression coverage with `tests/nestApi.test.ts`
- [x] Phase 6: Swagger at /api/docs (+ /api/docs-json + /api/docs-yaml)
- [~] Phase 6: Generated typed client for web-react — deferred behind the
      end-to-end test pass; `/api/docs-json` is the input when this lands

## 8. Out of Scope

- React UI changes. The contract is preserved; web-react/src/api keeps
  working unmodified.
- Database schema changes. Stores stay where they are.
- Authentication/whitelist enforcement. Scaffolded in Phase 1 as a passthrough
  guard; real policy is a separate ticket.
- Telegram bot adapter, generated tool runners, supervisor internals — all
  domain-side, untouched.
- Performance tuning. Express adapter is the baseline; revisit only if a
  benchmark says otherwise.

## 9. Resolved Notes

1. Decorators in ESM — `tsx` does not reliably emit `design:paramtypes`, so
   Nest providers/controllers use explicit `@Inject(...)` for constructor
   dependencies. `web:dev` and the compiled bundle use the same Nest module graph.
2. `class-validator` chosen — produces field-level error messages through
   the `ValidationPipe.exceptionFactory` and integrates cleanly with the
   existing controllers.
3. Audit recording stays inside services rather than a global interceptor —
   most audit events need post-execution context (the `RunRecord`,
   `BuildRequestRecord`, `IdentityRecord` returned by the store) that an
   interceptor would have to re-read from the response body.
4. SSE poll vs event subscription — kept poll-based to match legacy
   `streamRunEvents` exactly. When `RunStore` grows a real event emitter,
   the SSE controller becomes push-based with no public API change.

## 10. Items Held Back

- The generated typed client for `web-react` remains deferred. `/api/docs-json`
  and `/api/docs-yaml` are available as the source of truth for that later
  client generation pass.

## 11. Codex Review Fixes After Cutover

The first Nest cutover smoke found several parity gaps that looked green under
the old legacy test suite because it still instantiated the old router.
These are now restored in the Nest path:

- `RunsService.executeRun` passes Work Ledger, Evidence Ledger, Run
  Retrospective, secret/config resolvers, `requestToolBuild`, and
  `ToolImprovementCoordinator` into `UniversalAgent.run()`.
- `requestToolBuild` now finalizes operator input, stores/audits the request,
  runs `ToolBuildWorkflow.runOnce(...)`, reloads generated tools after
  registration, and notifies rework waits so promoted waits can auto-retry.
- `RunsService` records neutral outbound `tool_service_events` for completed or
  failed runs whose `channel` maps to an always-on service provider.
- `ToolBuildsService.create()` and `rework()` now share
  `ToolBuildInputFinalizerService`: inline credentials are extracted into
  `secret.*` handles, queued text is redacted, generated tool names avoid
  installed/queued collisions, and clearly wrong `replacesToolName` choices
  return `400` instead of silently retargeting.
- `ToolInvestigationsService.promote()` is backed by
  `ToolReworkCoordinatorService` and creates the build request plus linked wait
  in one deterministic handoff.
- `ToolReworkWaitsService` implements create/resume/retry-run/auto-retry
  through the same domain coordinators and validates referenced runs/builds.
- `RuntimeWorkersModule` wires Tool Builder completion into
  `notifyBuildRegistered(...)`, emits the `tool_build.registered` audit event,
  and lets promoted waits invoke the auto-retry orchestrator.
- Public secret-handle API responses redact inline `secretRef` values while
  keeping env/external references visible. Runtime resolvers still read the raw
  inline secret from the store.

Manual Nest smoke on port `3407` covered health/static/docs, inline credential
redaction, wrong-target `400`, missing-run wait `400`, investigation promote →
wait → registered → retry-run, Work/Evidence/Retrospective endpoints, and audit
canary checks for all secret-shaped values.
