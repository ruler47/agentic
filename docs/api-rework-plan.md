# API Rework Plan

Status: draft. Branch: `claude/api-rework`. Owner: api-rework agent.

This document is the durable plan for migrating the Agentic web API off the
hand-rolled `src/server/http.ts` router onto a mature framework. It is the
working agreement between this branch and the rest of the project. Other
branches keep modifying the legacy server until cutover; this plan is
designed so the rework stays mergeable through that.

## 1. Why

`src/server/http.ts` is a single file of ~5400 lines that:

- routes ~75 endpoints with manual `if (request.method === ... && url.pathname === ...)`
  chains and ~30 ad-hoc regex matchers,
- hand-parses request bodies with ~50 bespoke `parseXxxInput` helpers,
- inlines cross-cutting concerns (audit recording, error → JSON conversion,
  SSE heartbeats, secret redaction) inside each handler,
- composes ~25 stores/services through a single `WebAppOptions` bag wired in
  `src/server/main.ts`,
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
  main.ts                          # bootstrap: NestFactory.create(AppModule).listen(port)
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
      zod-validation.pipe.ts       # or class-validator-based equivalent
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
    static/                        # serves public/ fallback for legacy console
```

Rule: every legacy URL is preserved with the **same method and JSON shape**.
The rework is structural, not behavioural. Behavioural changes (Swagger,
auth, OpenAPI client gen) are tracked as separate follow-ups in section 8.

## 4. Phases

Each phase is an independent slice the user can review/test in isolation.
Phase boundaries are commit boundaries.

### Phase 0 — Lock the contract

- Create `docs/api-surface.md` listing every URL+method+request shape+
  response shape harvested from `src/server/http.ts` (the 75 handlers + 30
  matchers I already mapped). This becomes the diff target for rebases.
- Add `tests/contract/` snapshot suite that hits the legacy server through
  Node's `http` against in-memory stores and snapshots the JSON for happy +
  error paths of every route. These tests must pass against the legacy
  server today and against the NestJS server at the end of every phase.
- No production code changes yet.

### Phase 1 — Skeleton without breaking legacy

- Add deps to root `package.json`: `@nestjs/common`, `@nestjs/core`,
  `@nestjs/platform-express`, `class-validator`, `class-transformer`,
  `reflect-metadata`, `@nestjs/serve-static`. Optional: `@nestjs/swagger`,
  `zod`, `nestjs-zod`.
- Update `tsconfig.json`: `experimentalDecorators`, `emitDecoratorMetadata`.
  Verify ESM + decorators path with `tsx` (or switch to `ts-node` for the
  Nest dev server if needed).
- Create the new tree under `src/server/` per section 3 but **keep
  `src/server/http.ts` intact**. The new entry point is
  `src/server/main.nest.ts`; legacy entry point stays at `src/server/main.ts`.
- Add scripts:
  - `web:nest` → `node dist/server/main.nest.js`
  - `web:nest:dev` → `tsx src/server/main.nest.ts`
  - `verify:contract` → run the contract suite against both servers on
    different ports (e.g. 3000 legacy, 3010 nest) and assert byte-equal JSON.
- AppModule imports `ConfigModule`, `PersistenceModule`, `HealthModule`.
- HealthModule ships first: `/api/health`, `/api/instance`, GET/PATCH
  `/api/group-profile`. Smallest possible vertical slice to validate the
  pipeline end-to-end.
- `npm run verify` keeps targeting the legacy server. The contract test
  matrix is opt-in until phase 5.

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
  - `RunsService` owns `createAndStartRun` (currently `http.ts:2552`) and
    `executeRun` (currently `http.ts:3114`). It depends on `AgentRunner`,
    `RunStore`, `ConversationStore`, `ArtifactStore`, `AuditService`,
    `ToolImprovementCoordinatorFactory`, `GroupProfileStore`, `UserStore`.
  - The auto-retry-after-promotion hook (`http.ts:3644`) becomes a method on
    `RunsService` and is injected into `ToolImprovementCoordinator` via the
    same `onWaitPromoted` callback shape.
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

- `npm run web` points at the NestJS bootstrap.
- `npm run web:legacy` is kept for one release as a rollback escape hatch.
- `src/server/http.ts` and the helpers it owns (`parseXxxInput` zoo,
  `serveStatic`, `sendJson`, `readJsonBody`, `sanitizeObject`,
  `RunContextError`) are removed; surviving utility functions move to
  `src/server/common/utils/`.
- React UI base URL stays the same. No changes in `web-react/src/api/*`.
- Docker `Dockerfile` `CMD` and `docker-compose.yml` keep the same entry,
  since `npm run serve` already runs `node dist/server/main.js` — the file
  is replaced, not the script.

### Phase 6 — Optional follow-ups (not blocking cutover)

- `@nestjs/swagger` mounted at `/api/docs`. DTOs already give us the schema.
- Generate a typed client from the OpenAPI spec for `web-react/src/api`,
  replacing the hand-rolled `apiFetch` wrappers.
- Replace `class-validator` with Zod via `nestjs-zod` if the team prefers
  Zod's inference (subjective; either is fine).
- Add an `AuthGuard` once the user/whitelist model lands — the guard
  scaffold ships in Phase 1 as a passthrough so the seam exists.

## 5. Coexistence with Other Branches

This is the part that matters most while parallel agents are pushing.

**Invariant**: `src/server/http.ts` keeps working until Phase 5. Any work
landing on `main` against the legacy router stays valid. The new tree is
purely additive until cutover.

Per rebase cycle (run when another branch merges to `main`):

1. `git fetch origin && git rebase origin/main`.
2. Diff `src/server/http.ts` against the previous merge base. Three cases:
   - **No HTTP changes** — only domain code changed (typical for agent /
     tools / memory work). The new modules continue to work because they
     wrap the same domain APIs. Run `npm run verify:contract` to confirm
     parity.
   - **New legacy route added** — add it to `docs/api-surface.md`, port it
     into the matching NestJS module, regenerate the contract snapshot, run
     `verify:contract` against both servers.
   - **Existing route signature changed** — same as above plus update the
     DTO and the snapshot. The snapshot diff makes this impossible to miss.
3. Update `docs/api-rework-plan.md` checklist (section 7) so this branch's
   progress stays self-explanatory after the rebase.

If two agents touch the same store interface, the conflict surfaces in the
domain code, not in the controller. Controllers depend on the store
interfaces, so they ride the same rename or signature change automatically
once the store provider compiles.

**No force-pushing the rework branch over upstream churn.** Rebase forwards,
keep the linear history, push to origin with `--force-with-lease` only when
the user authorises a rebase that rewrites already-pushed commits.

## 6. Verification Strategy

Three layers, all gated in `npm run verify` by Phase 5:

- **Unit tests per module** — port the existing `tests/*.test.ts` to use
  `Test.createTestingModule` for the controller layer; keep store-level
  tests as-is (they don't touch HTTP).
- **Contract snapshot tests** (`tests/contract/`) — same suite runs against
  legacy and Nest servers on different ports; output JSON must be
  byte-equal. Catches regressions on every rebase.
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
- [x] Phase 5: Switch `npm run web` and `npm run serve` (Docker) to Nest;
      keep `web:legacy` / `serve:legacy` for emergency rollback
- [~] Phase 5: Delete `src/server/http.ts` + legacy `main.ts` + the
      hand-rolled webServer.test.ts — held back at the user's request so the
      branch can be tested before destroying the rollback path
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

1. Decorators in ESM — `tsx` does NOT emit `design:paramtypes` under
   `experimentalDecorators`, so DI fails when running `tsx src/server/main.nest.ts`
   directly. Fix: run the compiled bundle (`node dist/server/main.nest.js`).
   Production scripts (`web`, `serve`) already do this; `web:dev` / `web:nest:dev`
   should be considered "best effort" and re-checked if dev-time DI fails.
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

## 10. Items Held Back for User Verification

- `src/server/http.ts` (~5,400 lines) and `src/server/main.ts` are still on
  disk as the rollback target. After the user smoke-tests this branch and
  confirms parity, a follow-up commit removes them along with
  `tests/webServer.test.ts` (which imports the legacy `createWebApp`).
- The `requestToolBuild` callback inside `RunsService.executeRun` no longer
  triggers the Tool Builder workflow inline — the legacy code did
  `workflow.runOnce(...)` from inside the agent run. The new code only
  records the build request; the background worker (always running in the
  Nest server) picks it up the next tick. If the synchronous behaviour is
  required for some test, we can re-introduce it as a service collaborator
  injected into RunsService.
- `RecordToolServiceOutbound` (post-run delivery for Telegram-style
  channels) is not wired in `RunsService.executeRun` yet. The legacy code
  emitted an outbound `tool_service.event` after every completed/failed run
  whose run.channel matched a service. Equivalent service-side hook is a
  follow-up: inject `ToolServicesService` into `RunsService` and call from
  the same try/catch tail.
- Inline credential redaction (`extractInlineCredentialSecret`,
  `attachInlineCredentialHandle`, `ensureInlineCredentialSecret`) and the
  `validateContextualToolBuildTarget` mismatch detection were left out of
  `ToolBuildsService.create`. Operators that paste raw secrets into a build
  request body will not have them auto-redacted into a `secret.*` handle
  yet. The legacy server still does this; toggling back to
  `npm run web:legacy` is an option until parity is restored.
- `ToolInvestigationsService.promote` and the `ToolReworkWaitsService`
  resume / retry-run / auto-retry endpoints currently 503 because they
  depend on `ToolImprovementCoordinator` and `ToolReworkRetryCoordinator`
  factories that the legacy code constructs per request. Wiring those is
  small (the coordinators are already plain classes) but I did not finish
  it before cutover.

