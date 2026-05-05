# AGENTS.md

Project context and working notes for AI coding agents.

This file is the first place to read before changing the project. Keep it current when
architecture, commands, conventions, or collaboration rules change.

## Project

Agentic Universal Agent is a TypeScript prototype of a coordinator agent.

The coordinator accepts one concrete user task, decides whether to answer directly or
delegate, creates focused subtasks for worker agents, reviews their results, synthesizes
the final answer, and stores reusable lessons in shared skill memory.
Delegated subtasks form a dependency-aware DAG: workers with no dependencies can run in
parallel, while workers with `dependsOn` wait for reviewed upstream outputs.

The product direction is a deployable assistant platform for exactly one family,
household, company, or team per running instance. Future work must preserve
instance/user/channel provenance so the assistant can maintain group memory, personal
memory, whitelisted channel identities, tools, credentials, outbound messages, and
policies without leaking context.

## User Collaboration Notes

- The user wants the project in TypeScript.
- The user expects code changes to be covered by tests.
- Before reporting completion, run automated checks and a relevant manual test.
- Manual checks must include the actual user-visible surface, API responses, trace logs,
  and database records when persistence is involved.
- Return only working code with the expected execution result.
- Keep this file updated with important project notes, links, commands, and decisions.
- The user prefers a universal agent that delegates narrow, context-heavy work to
  separate agents, then accumulates the results centrally.
- The user does not want private hardcoded solutions such as a special market/chart
  pipeline or a special Telegram branch. Build generic reusable capabilities through the
  tool registry, Tool Builds, versioned replacements, QA, and documentation.
- The user expects requests to accept files and responses to return files when the task
  calls for artifacts such as charts, screenshots, reports, datasets, or source bundles.
- The user wants the system to eventually run for a family or enterprise, with separate
  memory for the whole group and for each member.
- External channels such as Telegram should be ordinary generated tool modules with a
  startup mode such as `always-on`, not special runtime branches. They use the same
  registry/versioning/QA/secret-handle flow as other capabilities, expose health/lifecycle
  status, and translate provider events into normal runs.
- Built-in, generated, and always-on tool changes should converge on one versioned
  lifecycle: change request -> new version -> code review -> behavior/QA review ->
  promotion -> reload/restart. Direct edits to reference tool source are temporary
  operator hotfixes while the lifecycle is incomplete.
- Tools should evolve into out-of-tree portable modules or services, not permanent
  Agentic app source. The core should know a tool's manifest, schemas, docs, versions,
  settings, secret handles, QA evidence, storage migrations, health, and runner/container
  location, while the implementation stays independent of Agentic internals.
- Telegram identities can be mapped by numeric Telegram id or by username handle
  (`username`/`@username`) when Telegram exposes `from.username`; the bot forwards both
  aliases through `sourceUserAliases`.
- Telegram outbound answers must be split into multiple messages when needed instead of
  appending `[truncated]`; the final linked response includes a continuation button that
  makes the next message from that chat/user continue the same thread.
- Channel and web requests need conversation-thread continuity: the system must
  distinguish a new task from a clarification, correction, or follow-up to a previous run.
- Continuation runs should receive compact prior artifact metadata in thread context and
  reuse those artifacts when they satisfy the follow-up instead of reacquiring identical
  data by default.
- Agents will eventually send auditable outbound messages/reminders to a group or
  individual when policy allows.
- Tools should be easy to onboard from API documentation and access credentials, but
  credentials must be stored through secret handles, not prompts, memory, source, or
  artifacts.
- Model tier settings must support local OpenAI-compatible endpoints and remote providers
  such as the OpenAI API, with remote API keys stored through secret handles.

## Local Model

Default OpenAI-compatible endpoint:

- Base URL: `http://127.0.0.1:1234/v1`
- Model: `google/gemma-4-26b-a4b`

Environment overrides:

- `LLM_BASE_URL`
- `LLM_MODEL`
- `LLM_TEMPERATURE`
- `LLM_MODEL_TIER_S`
- `LLM_MODEL_TIER_M`
- `LLM_MODEL_TIER_L`
- `LLM_MODEL_TIER_XL`

Memory embedding overrides:

- `EMBEDDING_PROVIDER=deterministic` forces the portable local embedding provider.
- `EMBEDDING_MODEL` enables OpenAI-compatible `/embeddings` calls.
- `EMBEDDING_BASE_URL` defaults to `LLM_BASE_URL` when omitted.
- `EMBEDDING_API_KEY` or `OPENAI_API_KEY` provides the bearer token.
- `MEMORY_EMBEDDING_DIMENSIONS` defaults to `128`, matching the current pgvector column.

Tier variables can contain one model or a comma-separated fallback list. In the web app,
the editable tier policy is stored in Postgres and exposed through the System Inventory
panel.

Embedding is a separate memory-retrieval capability, not a chat tier. The Models page
reads `/api/models/catalog` and `/api/model-providers` to show discovered local chat
models, the active embedding provider, and durable local/remote provider registry entries.
Future runtime routing should resolve tier model ids through this provider registry, and
future DB-backed embedding selection should trigger memory re-embedding.

Durable artifact storage in Docker uses:

- `MINIO_ENDPOINT`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `MINIO_BUCKET`
- optional `S3_REGION`

When those variables and `DATABASE_URL` are present, new artifact metadata is stored in
Postgres and payloads are stored in MinIO/S3. Local artifact files under `ARTIFACT_ROOT`
remain a fallback.

## Commands

Install dependencies:

```bash
npm install
```

Run full verification:

```bash
npm run verify
```

The verification command runs:

- `npm run typecheck`
- `npm run test:types`
- `npm test`
- `npm run build`

Manual CLI smoke test:

```bash
node dist/cli.js "Скажи одним предложением, что такое универсальный агент"
```

Run the full container stack:

```bash
docker compose up --build
```

The `npm run dev` command uses `tsx`; in some sandboxes it can fail on IPC pipe
permissions. If that happens, use `npm run build` and then `node dist/cli.js ...`.

## Important Files

- [README.md](README.md) - quick start and request execution summary.
- [docs/architecture.md](docs/architecture.md) - detailed architecture and delegation model.
- [docs/modules/instance-context.md](docs/modules/instance-context.md) - target
  instance/user/channel memory, Telegram, outbound action, model provider, and tool
  onboarding model.
- [src/agents/universalAgent.ts](src/agents/universalAgent.ts) - main coordinator runtime.
- [src/agents/callFrame.ts](src/agents/callFrame.ts) - durable agent call-frame and
  return self-check helpers for worker/reviewer spans and future recursive agents.
- [src/agents/modelTier.ts](src/agents/modelTier.ts) - model tier selection policy.
- [src/settings/modelProviderStore.ts](src/settings/modelProviderStore.ts) - durable
  model provider registry contract for chat and embedding endpoints.
- [src/settings/postgresModelProviderStore.ts](src/settings/postgresModelProviderStore.ts)
  - Postgres-backed `model_providers` adapter.
- [docs/modules/model-providers.md](docs/modules/model-providers.md) - provider registry,
  embedding-provider, and future runtime resolver notes.
- [src/agents/prompts.ts](src/agents/prompts.ts) - prompts for classification, planning,
  workers, reviewers, synthesis, and learning.
- [src/instance/userStore.ts](src/instance/userStore.ts) - user and channel identity
  resolution contract with local in-memory defaults.
- [src/instance/postgresUserStore.ts](src/instance/postgresUserStore.ts) - Postgres-backed
  user, role, and channel identity resolver.
- [src/conversations/inMemoryConversationThreadStore.ts](src/conversations/inMemoryConversationThreadStore.ts)
  and [src/conversations/postgresConversationThreadStore.ts](src/conversations/postgresConversationThreadStore.ts)
  - conversation thread stores for new-task versus continuation flow.
- [src/conversations/threadResolution.ts](src/conversations/threadResolution.ts) - channel
  message resolver that decides whether an inbound message starts a new task or continues,
  clarifies, or corrects an existing thread.
- [src/audit/inMemoryAuditEventStore.ts](src/audit/inMemoryAuditEventStore.ts)
  and [src/audit/postgresAuditEventStore.ts](src/audit/postgresAuditEventStore.ts)
  - normalized audit log stores for run lifecycle, artifacts, tool use, and future
  approvals/outbound actions.
- [src/artifacts/artifactStore.ts](src/artifacts/artifactStore.ts) - artifact store
  contracts, local fallback store, durable metadata/object-store composition, and
  in-memory test stores.
- [src/artifacts/artifactQualityMetadata.ts](src/artifacts/artifactQualityMetadata.ts)
  - compact artifact QA metadata helpers persisted with artifact records.
- [src/artifacts/postgresArtifactMetadataStore.ts](src/artifacts/postgresArtifactMetadataStore.ts)
  - Postgres-backed artifact metadata table adapter.
- [src/artifacts/s3ObjectStore.ts](src/artifacts/s3ObjectStore.ts) - minimal
  S3-compatible object store used by MinIO for durable artifact payloads.
- [src/artifacts/chartArtifact.ts](src/artifacts/chartArtifact.ts) - deterministic SVG
  chart parsing/rendering helpers.
- [src/artifacts/visualArtifactQuality.ts](src/artifacts/visualArtifactQuality.ts) -
  deterministic PNG screenshot QA for near-empty/loader-like visual evidence.
- [src/artifacts/semanticArtifactQuality.ts](src/artifacts/semanticArtifactQuality.ts) -
  browser screenshot evidence QA that combines visual checks with URL/title/text/link
  context to reject loader/blocker or task-mismatched artifacts before storage.
- [src/tools/chartGenerateTool.ts](src/tools/chartGenerateTool.ts) - `chart.generate`
  TypeScript tool module for data-agnostic SVG chart artifacts.
- [src/tools/marketTimeseriesTool.ts](src/tools/marketTimeseriesTool.ts) -
  `market.timeseries` TypeScript tool module for structured CoinGecko-backed
  crypto time-series and CSV data artifacts.
- [docs/modules/market-timeseries.md](docs/modules/market-timeseries.md) - module
  contract and portability notes for `market.timeseries`.
- [src/tools/browserOperateTool.ts](src/tools/browserOperateTool.ts) - reusable
  `browser.operate` Playwright command executor for navigation, clicks, form fills,
  selectors/options/checkboxes, waits, assertions, DOM text/link extraction, screenshots,
  and returned storage state.
- [docs/modules/browser-operate.md](docs/modules/browser-operate.md) - module contract
  and portability notes for `browser.operate`.
- [src/llm/client.ts](src/llm/client.ts) - OpenAI-compatible LLM client.
- [src/memory/skillMemory.ts](src/memory/skillMemory.ts) - shared file-based skill memory.
- [src/memory/memoryPolicy.ts](src/memory/memoryPolicy.ts) - deterministic memory access
  policy evaluator used to simulate accepted/status, exact-scope, private requester, and
  sensitive grant decisions in the Memory page and before runtime prompt injection.
- [src/memory/retrievalEvaluation.ts](src/memory/retrievalEvaluation.ts) - reusable
  memory retrieval quality harness for query fixtures, expected memory IDs, recall, and
  top-hit checks.
- [src/memory/textEmbedding.ts](src/memory/textEmbedding.ts) - deterministic local
  embedding provider, OpenAI-compatible embedding adapter, fallback wrapper, projection
  to the current pgvector width, and pgvector payload formatter for memory retrieval
  plumbing.
- [src/tools/registry.ts](src/tools/registry.ts) - tool registry skeleton.
- [src/tools/tool.ts](src/tools/tool.ts) - versioned tool module contract.
- [src/tools/toolPackage.ts](src/tools/toolPackage.ts) - portable out-of-tree tool
  package manifest contract for source bundles, OCI images, external packages, and
  local-path development tools.
- [src/tools/toolIntegrationSpec.ts](src/tools/toolIntegrationSpec.ts) - provider-neutral
  Tool Build integration spec inferred from requests for API clients, bots, listeners,
  webhooks, inbound/outbound services, credentials, settings, lifecycle, and QA.
- [src/tools/toolMetadataStore.ts](src/tools/toolMetadataStore.ts) - persistent tool
  metadata store contract and in-memory implementation.
- [src/tools/postgresToolMetadataStore.ts](src/tools/postgresToolMetadataStore.ts) -
  Postgres-backed `tool_modules` catalog.
- [src/tools/toolMigrationStore.ts](src/tools/toolMigrationStore.ts) - tool-owned
  migration metadata contract and in-memory implementation.
- [src/tools/postgresToolMigrationStore.ts](src/tools/postgresToolMigrationStore.ts) -
  Postgres-backed `tool_migrations` catalog for versioned tool storage changes.
- [src/tools/toolBuildRequestStore.ts](src/tools/toolBuildRequestStore.ts) - Tool Builder
  request/contract/lifecycle/QA criteria model.
- [src/tools/postgresToolBuildRequestStore.ts](src/tools/postgresToolBuildRequestStore.ts)
  - Postgres-backed `tool_build_requests` queue.
- [src/tools/toolBuildWorkflow.ts](src/tools/toolBuildWorkflow.ts) - reusable Builder/QA/
  review/Registrar orchestration flow for missing tool capabilities.
- [src/tools/toolBuildReviewers.ts](src/tools/toolBuildReviewers.ts) - deterministic and
  optional LLM generated-tool code/behavior review gates that run after QA and before
  registration.
- [src/tools/toolBuildWorker.ts](src/tools/toolBuildWorker.ts) - background worker that
  claims `requested` Tool Build Queue items and runs the Builder/QA/Registrar workflow.
- [src/tools/toolServiceSupervisor.ts](src/tools/toolServiceSupervisor.ts) - generic
  lifecycle supervisor for `always-on` tools with start/stop/restart/heartbeat status.
- [src/tools/toolServiceStatusStore.ts](src/tools/toolServiceStatusStore.ts) - service
  status store contract and in-memory lifecycle state.
- [src/tools/postgresToolServiceStatusStore.ts](src/tools/postgresToolServiceStatusStore.ts)
  - Postgres-backed `tool_service_statuses` lifecycle state.
- [src/tools/toolServiceLogStore.ts](src/tools/toolServiceLogStore.ts) - service
  lifecycle log store contract and in-memory implementation.
- [src/tools/postgresToolServiceLogStore.ts](src/tools/postgresToolServiceLogStore.ts) -
  Postgres-backed `tool_service_logs` lifecycle log store.
- [src/tools/toolServiceEventStore.ts](src/tools/toolServiceEventStore.ts) - provider-
  neutral always-on runtime event contract and in-memory store.
- [src/tools/postgresToolServiceEventStore.ts](src/tools/postgresToolServiceEventStore.ts)
  - Postgres-backed `tool_service_events` runtime event store.
- [src/tools/telegramBotServiceTool.ts](src/tools/telegramBotServiceTool.ts) - reference
  provider module for the generic always-on runtime: polls Telegram, forwards normalized
  inbound events, delivers neutral outbox events, and acknowledges provider delivery.
- [src/tools/toolBuildProviders.ts](src/tools/toolBuildProviders.ts) - provider-backed
  generated tool source writer, including browser screenshot, document/PDF artifact, and
  generic HTTP API and always-on service providers, plus isolated command QA runner and
  metadata registrar.
- [src/tools/llmToolBuildProvider.ts](src/tools/llmToolBuildProvider.ts) - guarded
  LLM-backed Tool Build provider for unknown/custom capability families. It asks the
  configured XL-tier model for a TypeScript module/test pair, rejects unsafe paths and
  raw-looking secrets, then hands output to the same isolated QA and registrar lifecycle.
- [src/tools/fileTools.ts](src/tools/fileTools.ts) - sandboxed workspace file tools.
- [src/settings/modelTierSettings.ts](src/settings/modelTierSettings.ts) - model tier
  policy contract and in-memory implementation.
- [src/settings/postgresModelTierSettings.ts](src/settings/postgresModelTierSettings.ts)
  - Postgres-backed model tier policy.
- [src/secrets/secretHandleStore.ts](src/secrets/secretHandleStore.ts) - secret-handle
  metadata contract, validation, raw-secret rejection, and in-memory resolver for env refs.
- [src/secrets/postgresSecretHandleStore.ts](src/secrets/postgresSecretHandleStore.ts) -
  Postgres-backed `secret_handles` metadata store.
- [src/instance/groupProfileStore.ts](src/instance/groupProfileStore.ts) - editable
  single-instance group profile contract.
- [src/instance/postgresGroupProfileStore.ts](src/instance/postgresGroupProfileStore.ts)
  - Postgres-backed group profile context.
- [src/instance/userStore.ts](src/instance/userStore.ts) - user and channel identity
  contract, local admin defaults, requester resolution, and CRUD operations.
- [src/instance/postgresUserStore.ts](src/instance/postgresUserStore.ts) -
  Postgres-backed users and channel identities.
- [src/server/http.ts](src/server/http.ts) - web API and static UI server.
- [docs/modules/web-console.md](docs/modules/web-console.md) - web console API,
  realtime SSE stream, dashboard behavior, conversation continuation, attachments,
  artifacts, and trace rendering.
- [src/runs/inMemoryRunStore.ts](src/runs/inMemoryRunStore.ts) - replaceable run store.
- [src/runs/postgresRunStore.ts](src/runs/postgresRunStore.ts) - Postgres-backed run store.
- [src/db/migrate.ts](src/db/migrate.ts) - database migrations.
- [public/](public/) - browser console UI.
- [memory/skills.json](memory/skills.json) - current long-term skill memory store.
- [tests/](tests/) - automated tests.
- [docs/modules/](docs/modules/) - module-level documentation.
- [docs/roadmap.md](docs/roadmap.md) - planned memory, tools, recursive agents, and model tiers.

## Architecture Notes

Request flow:

```text
User task
  -> Coordinator
  -> Resolve instance/user/channel context (defaulted locally today)
  -> Resolve conversation thread or create a new one
  -> SkillMemory.search()
  -> Complexity classification
  -> Direct answer or delegated plan
  -> Dependency-aware worker DAG
  -> Reviewer agents, with one bounded worker revision if review returns `needs_revision`
  -> Artifact generation for supported file-output requests
  -> Final synthesis
  -> SkillMemory.add()
```

Delegation is preferred when the task:

- crosses multiple domains;
- needs research and implementation;
- can consume too much context in one thread;
- benefits from independent review;
- requires both creation and verification.

Direct mode is acceptable when the task is narrow, stable, low risk, and does not require
fresh research or codebase inspection.

Future product flow:

```text
Web/Telegram/API request
  -> verify channel identity and whitelist
  -> classify new task versus continuation/correction/clarification
  -> resolve or create conversation thread
  -> resolve instance, requester, and permissions
  -> attach compact thread summary when continuing
  -> create one run
  -> retrieve scoped global/group/user memory
  -> execute agent DAG and tools
  -> return answer or create auditable outbound action
```

## Testing Policy

For code changes:

- Add or update automated tests.
- Run `npm run verify`.
- Run a manual test that exercises the user-visible path.
- Mention any untested risk explicitly if full verification is impossible.

For documentation-only changes:

- Automated tests are not required unless docs include generated or validated examples.
- Run a lightweight manual check by reading the changed file and confirming links/commands
  still make sense.

## Current Test Coverage

- `tests/json.test.ts` covers JSON extraction from model output.
- `tests/skillMemory.test.ts` covers file-backed skill memory.
- `tests/memoryRetrievalEvaluation.test.ts` covers retrieval quality fixture scoring.
- `tests/toolRegistry.test.ts` covers tool registration and lookup.
- `tests/universalAgent.test.ts` covers direct and delegated orchestration with a fake
  LLM, including accepted scoped memory retrieval, runtime sensitive/private memory
  policy filtering, repeated similar tasks, call-frame payloads, and return self-check
  events.
- `tests/artifactStore.test.ts` covers local artifact persistence, durable
  metadata/object payload separation, and download metadata.
- `tests/auditEventStore.test.ts` covers normalized in-memory audit events.
- `tests/chartArtifact.test.ts` covers SVG chart helpers and the `chart.generate` tool.
- `tests/conversationThreadStore.test.ts` covers compact conversation-thread context.
- `tests/browserOperateTool.test.ts` covers the generic Playwright command executor.
- `tests/generatedToolLoader.test.ts` covers compiled generated tool loading and contract
  rejection.
- `tests/toolMetadataStore.test.ts` covers tool metadata and Tool Build Queue lifecycle.
- `tests/toolServiceSupervisor.test.ts` covers generic always-on tool lifecycle state,
  status-store persistence across supervisor instances, reconciliation, and lifecycle
  logs.
- `tests/webServer.test.ts` covers provider-neutral always-on tool service event
  recording, API listing, payload redaction, and audit emission.
- `tests/toolMigrationStore.test.ts` covers tool-owned migration metadata lifecycle.
- `tests/toolBuildWorkflow.test.ts` covers Builder/QA/Registrar orchestration and failed
  QA registration blocking.
- `tests/toolBuildProviders.test.ts` covers provider-backed TypeScript generation and
  generated metadata registration, including the guarded LLM-backed provider path for
  unknown/custom integrations.
- `tests/modelProviderStore.test.ts` covers model provider defaults, normalization, and
  CRUD lifecycle.
- `tests/userStore.test.ts` covers local user and allowed channel identity resolution.
- `tests/webUiStatic.test.ts` covers the page-based web console information architecture.

## Maintenance Rules

- Keep edits small and consistent with the existing TypeScript style.
- Prefer Node built-ins unless a dependency clearly improves the system.
- Do not store full transcripts in skill memory; store compressed reusable lessons.
- Skill memory entries can be scoped to `global`, `group`, `user`, `thread`, or `run`.
  Retrieval should use accepted memories only; proposed/rejected/archived entries are for
  review and audit surfaces until policy says otherwise.
- Learned memories should carry scope, confidence, sensitivity, source run/thread IDs,
  and short evidence. Non-global or sensitive/private learned memories must enter the
  `proposed` review state before runtime retrieval can use them. A deterministic
  memory-specialist gate also keeps low-confidence or policy-risky learned memories in
  review even if the learning model requested `accepted`.
- Keep worker context narrow: original task summary, one subtask, relevant memory, output
  expectations, and review criteria.
- Keep instance/user/channel context explicit on future runs, memory records, tool
  credentials, artifacts, and audit events.
- Preserve `threadId`, `parentRunId`, and compact conversation summaries when adding
  continuation support. Do not replay full transcripts into agent prompts by default.
- Scope memory by default. Agents should not read another user's private memory unless the
  task and policy allow it.
- Telegram and other always-on generated tools should translate provider events into run
  requests; they should not embed agent orchestration logic or become special runtime
  branches.
- Generated always-on tools should record inbound, outbound, ignored, and system events
  through `tool_service_events` so Channels, Audit, Runs, and Conversations can link
  provider activity without provider-specific core tables.
- Always-on tools that receive external provider messages should forward normalized
  events to `POST /api/tool-services/:name/inbound`; that path records the inbound event,
  resolves channel identity, creates a normal run, and records the linked queued event.
- Runs created from always-on tool inbound events write an `outbound/queued`
  `tool_service_events` record with final answer/error payload when they finish. Provider
  modules should poll `GET /api/tool-services/:name/outbox`, deliver from that neutral
  outbox, and acknowledge with `POST /api/tool-services/:name/outbox/:eventId/ack`.
- The generic service supervisor persists always-on lifecycle state and reconciles
  desired-running services on app startup. It also writes lifecycle logs for
  start/stop/restart/heartbeat/reconcile events and streams new log records to active UI
  subscribers. Tools can optionally implement `startService(context)` to run an
  in-process service loop under that supervisor; the app injects a base URL and secret
  resolver and stops active service handles on shutdown without clearing the persisted
  desired running state. Durable external process/webhook runners are still a roadmap
  item.
- The built-in `channel.telegram.bot` module is a reference always-on provider tool. It
  resolves `secret.telegram.bot.token` (or `TELEGRAM_BOT_SECRET_HANDLE`), polls Telegram
  updates, forwards text messages to the generic inbound endpoint with provider user/chat
  ids, polls the neutral outbox, sends responses back to Telegram, and records sent/failed
  acknowledgements. Channel identities must use provider `channel.telegram.bot`.
- Operators can add Telegram users either on the Users page by adding a
  `channel.telegram.bot` identity, or on the Channels page by approving an ignored
  inbound event with the `Allow as Admin` shortcut.
- Outbound actions must be auditable and permission-checked before delivery.
- Preserve trace parent links when adding orchestration steps; the UI depends on
  `parentSpanId` to draw direct arrows.
- Active runs can be stopped through `POST /api/runs/:id/cancel`; `cancelled` is terminal
  and late LLM/tool events or results must not overwrite it.
- If a completed run returns `result.learnedSkill`, the web server records a compact
  `memory.created` audit event with scope/status/sensitivity metadata.
- Proposed memories are exposed through `GET /api/memories/review-queue`, which applies
  deterministic guardrails before an operator accepts a memory into retrieval.
- For DAG dependencies, also preserve `payload.dependencySpanIds` so the UI can draw
  additional upstream arrows.
- Worker and reviewer spans should carry `payload.callFrame`, and agent returns should
  emit `agent-self-check-completed` before completion. This is the Phase 4 foundation for
  recursive agents.
- Worker/reviewer LLM failures should emit explicit failed spans before throwing, so a
  failed run still explains which agent failed and why.
- Keep LLM prompt inputs compact. Tool evidence, dependency context, memories, worker
  outputs, synthesis inputs, and learning inputs should be truncated/summarized before
  being sent to local OpenAI-compatible models with limited context.
- Runtime memory retrieval should pass visible scopes for the active group, requester,
  thread, and run so unrelated scoped memory does not enter the prompt.
- Non-global memory visibility requires exact `scopeId` matches. Do not reintroduce
  wildcard user/group/thread/run memory access without a policy-layer check.
- The Memory UI groups entries by status and exact scope, exposes retrieval impact, links
  source runs/threads, and lets operators edit the memory contract fields. Keep it aligned
  with the accepted-only runtime retrieval model when adding richer policy simulation.
  Its current policy simulation mirrors the selected run context and flags blocked,
  private, and sensitive retrieval decisions before those rules are backed by editable
  policy records. The Memory page also exposes `POST /api/memories/reembed` for rebuilding
  Postgres vector embeddings after provider changes.
- Postgres memory search writes `memory_embedding` vectors when pgvector is available.
  The default provider is deterministic text-feature hashing so the contract is portable.
  Configure `EMBEDDING_MODEL` for OpenAI-compatible semantic embeddings; the provider
  projects remote vector widths into the current 128-dimensional pgvector column and
  falls back locally if the remote endpoint fails.
- Add links here when introducing new core docs, modules, commands, or workflows.
- Run creation must resolve a real requester before creating a thread or run. Explicit
  `requesterUserId` values must exist; channel-originated requests with `sourceUserId`
  must map to an allowed `channel_identities` row.
- UI changes must be checked through the HTTP server, not only by reading static files.
- The web console uses `GET /api/runs/:id/events` as an additive SSE stream for live run
  snapshots and falls back to polling; keep `GET /api/runs` and `GET /api/runs/:id`
  backwards compatible.
- The web console also runs a soft background refresh for list-style pages. It
  fingerprints fetched data, skips unchanged renders, and defers rendering while the
  operator is editing an input/select/textarea or has an open Tool Build/span bug/tool
  rework form to avoid focus loss, panel collapse, draft clearing, and flicker.
- The web console uses `GET /api/tool-services/logs/events` as an additive SSE stream for
  live always-on tool lifecycle logs; keep `GET /api/tool-services/logs` as the durable
  history/fallback endpoint.
- Inbound channel messages without an explicit `threadId` must pass through
  `resolveConversationThread()`. This keeps Telegram/Slack-style follow-ups in the
  matching source chat/thread while allowing explicit `/new` and independent tasks to
  create new conversation threads.
- Always-on channel continuation buttons should pass the internal Agentic `threadId`.
  Keep `sourceThreadId` for provider-native topics/threads such as Telegram forum topics.
- The web console renders final answers and conversation messages as sanitized Markdown.
  Artifact list lines such as `- file.png: /api/runs/.../artifacts/...` should remain
  clickable download links; nested bullet lists, basic emphasis, and common inline TeX
  symbols such as `$\rightarrow$` should render cleanly.
- Trace Lab graph edges encode direct `parentSpanId` calls and additional
  `payload.dependencySpanIds` dependencies. Edges that target failed spans must stay red
  even without hover so failure paths remain visible.
- Trace Lab graph mode supports both category columns and call-depth columns. Preserve
  `parentSpanId` and dependency payloads so both layouts can draw direct arrows and
  dependency arrows correctly.
- Trace Lab inspector should render `payload.callFrame` and `payload.selfCheck` as
  readable operator sections, not only as raw JSON, because those are the Phase 4/6
  contracts for recursive agent debugging.
- Artifact cards should render a useful preview whenever possible: image thumbnails,
  text/content previews, or a typed placeholder for binary files.
- Text-like artifacts, including generated output files, should keep a bounded
  `contentPreview` so Run Workspace, Conversations, Artifacts, and Trace Lab can render
  useful previews without downloading the file. CSV/TSV previews render as compact tables
  in the UI.
- Typed artifact requirements are checked by `src/artifacts/artifactRequirementQuality.ts`.
  Review gates should reject wrong MIME/extension classes and weak inspectable previews
  before accepting a worker result as satisfying `requiredArtifacts`.
- Artifact records may carry `quality` metadata. When deterministic QA or a tool accepts
  an artifact, persist the compact check names, decisions, reasons, and matched signals so
  UI/API users can understand why the file is usable and future rework requests can inherit
  the evidence.
- Future Trace Lab "Create tool request / bug" actions should carry selected span context
  into Tool Builder: run/span IDs, actor, tool name/version/capability, input/output
  summaries, artifacts, QA evidence, and the operator's comment.
- Conversation deletion is destructive: `DELETE /api/conversation-threads/:id` deletes the
  thread, its messages, all runs with that `threadId`, and their trace events/artifact
  metadata through run cascades. Keep UI copy explicit about the blast radius.
- Prefer Docker Compose for project runtime and manual verification.
- File tools must stay inside the configured workspace root (`FILE_TOOL_ROOT`, default
  `workspace`).
- The Dashboard composer is for new tasks only. Continue-thread flows belong in Run
  Workspace or Conversation Detail, where the selected thread context is explicit.
- Docker artifact payloads live in MinIO/S3 with metadata in Postgres. Local filesystem
  artifacts under `ARTIFACT_ROOT`, default `/app/workspace/artifacts`, remain as fallback
  for older runs and non-Docker development. Keep generated links in `result.artifacts`
  and trace artifact creation with parent spans.
- New capabilities must be implemented as TypeScript tool modules with schemas,
  capabilities, healthchecks, tests, and registry wiring. Runtime code should request a
  capability from `ToolRegistry` rather than embedding one-off tool logic.
- Tool Build requests created directly by an operator are represented as root runs and
  linked through `sourceRunId`; requests created from an existing run/span keep that
  original run context.
- Runtime memory injection must pass through the deterministic memory policy evaluator
  when visible scopes are available: only accepted exact-scope memories are eligible,
  sensitive memories require an explicit runtime grant, and private memories require the
  same requester user or an explicit private-memory grant.
- Built-in and future generated tool contracts should be synced into `tool_modules` so
  source/status/health/version metadata survives restarts.
- Portable generated tool packages use `agentic.tool-package.v1`. The API/UI can import
  package manifests into registry metadata and export generated package manifests.
  Non-local package refs are metadata-only/disabled until a generic runner exists.
- Always-on capabilities should use the generic `Tool.startService(context)` and
  provider-neutral service event contracts. Prefer generated service modules over adding
  new provider branches to the Agentic core.
- Model provider records live in `model_providers`; store remote credentials by secret
  handle name only, keep embeddings separate from chat tiers, and avoid putting raw API
  keys in prompts, memory, trace events, or docs.
- Missing capabilities should create `tool_build_requests` with TypeScript module paths,
  schemas, acceptance criteria, and QA criteria before any generated code is promoted.
- Existing capabilities that are too weak should create a rework request for a new tool
  version. Do not silently overwrite the old version; preserve changelog, QA evidence,
  failure context, and promotion decision.
- Generated tool versions are persisted in `tool_module_versions`. `tool_modules`
  represents the active version, while older registered versions remain available for
  inspection and explicit activation through the Tools UI/API.
- Tool registry metadata should grow toward a complete operator catalog: name, version,
  changelog, capabilities, schemas, required configuration keys, required secret handles,
  provider URLs, limits, tool-owned storage contracts, migrations, examples,
  success/failure counters, health, linked run/span issues, and generated source/test/QA
  artifacts.
- Generated service providers now emit a `ToolPackageManifest` in the build output so the
  same generated integration can later move from in-process source to local-path,
  source-bundle, external-package, or OCI-image execution. Postgres now persists the
  active manifest and version-history manifests; API/UI export/import exists, and
  `ToolPackageRunner` is the loader extension point for local-path plus future
  source-bundle, external-package, and OCI runners.
- Generated tools must not create ad hoc database pools or execute hidden SQL. If a tool
  needs database access, it must declare storage requirements/migrations and receive a
  scoped `ToolExecutionContext` with an approved DB client, audit writer, secret resolver,
  artifact store, logger, and cancellation signal.
- Tool-owned migrations must be versioned, idempotent, QA-tested in an isolated database,
  and promoted only with the tool version they belong to. Record the applied migration,
  checksum, QA evidence, and rollback/repair notes in persistent metadata.
- Destructive database operations requested through a tool bug/rework flow must become
  explicit auditable capabilities with exact scope, dry-run preview, policy/approval
  checks, and audit events. Do not satisfy them by running arbitrary one-off SQL.
- The Tools UI has a registry healthcheck action backed by `GET /api/tools/health`; keep
  tool status and health detail in persistent metadata when changing tool contracts.
- Tool Build Queue consumers should update durable lifecycle state through the store/API:
  `requested`, `building`, `qa_failed`, `qa_passed`, `registered`, or `blocked`, with QA
  evidence attached before registration.
- Contextual tool bug/rework requests may be created from the wrong selected span; server
  validation should compare operator feedback with installed tool metadata. If the
  selected tool clearly does not match and another installed tool does, reject the
  request with a clarification instead of silently retargeting it.
- Tool Build contracts preserve the requested `startupMode`. Use `on-demand` for normal
  call-time tools, `always-on` for bots/webhooks/listeners/services with health and
  start/stop lifecycle, and `ephemeral` for short-lived jobs.
- Operators can stop a Tool Build request from any lifecycle state, which marks it
  `blocked` with a status detail, or delete it from the queue. Rework of an installed
  failed tool should create a new Tool Build request from the Tools page with the failure
  details prefilled.
- `ToolBuildWorkflow` supports bounded retries. Builders receive the previous generated
  output and failed QA/review report on retry attempts; registrars must only run after a
  passing QA report plus all configured review gates.
- Generated-tool promotion now has separate QA and review gates. `ToolBuildQaReport`
  may include `reviews` for code and behavior decisions; any `needs_revision` or `fail`
  review sends findings back into the next builder attempt or ends as `qa_failed` after
  attempts are exhausted.
- `LlmToolBuildProvider` is enabled by default as a guarded fallback for unknown/custom
  Tool Build requests and can be disabled with `TOOL_BUILD_LLM_PROVIDER=disabled`. Its
  output is not trusted: generated files must match the request contract, avoid raw
  secrets, pass isolated generated-tool tests, pass isolated build, pass promotion tests,
  and pass promotion build before registration.
- Optional LLM code/behavior reviewers can be enabled with `TOOL_BUILD_LLM_REVIEW=enabled`.
  They read the durable request contract, QA report, and generated module/test previews,
  then return structured `pass`, `needs_revision`, or `fail` decisions. Treat their output
  as an additional review gate, not as a replacement for deterministic QA.
- The background Tool Build worker claims the oldest `requested` queue item through
  `claimNextRequested`, marks it `building`, runs the same workflow as the manual API, and
  reloads generated tools after registration. Disable it with `TOOL_BUILD_WORKER=disabled`
  or tune it with `TOOL_BUILD_WORKER_INTERVAL_MS` and `TOOL_BUILD_WORKER_BATCH_SIZE`.
- Tool Build requests can be reworked through `POST /api/tool-build-requests/:id/rework`.
  Preserve the original request and create a new requested revision with operator feedback
  instead of overwriting prior QA evidence.
- Tool Build requests can include low-level `credentialHandles` from runtime callers and
  human `credentialNotes` from the UI. Do not display raw credential notes on cards or
  write them into source, tests, prompts, traces, memory, artifacts, or audit metadata.
- Tool Build requests accept a human `displayName`; if the UI omits `capability`, the
  server infers a stable internal capability from the name/description and generates the
  system `desiredToolName`, checking existing registry/build names where possible. The UI
  should ask for a tool name, description/docs/instructions, optional credentials text,
  and QA criteria rather than forcing users to invent internal capability/module names.
- Tool Build contracts infer a neutral `integration` spec for service/API-like requests.
  Generated providers should carry that spec into docs, settings schema, storage
  contract, examples, required secret handles, and QA requirements. Do not add
  provider-specific core branches when a generated tool can map provider APIs to the
  standard integration event contract.
- Generated tool modules can be deleted from the Tools page or
  `DELETE /api/tools/generated-modules/:name`; built-in tools are protected. Deleting a
  generated tool removes registry metadata and unregisters the active runtime copy when
  loaded.
- `GenericApiToolBuildProvider` can build reusable HTTPS JSON API adapters for capability
  names like `api.aml.score`. The capability should be a stable machine id; docs URLs,
  endpoint examples, expected behavior, QA criteria, and credential handles belong in the
  request description/structured fields. The generated module must keep credentials behind
  declared secret handles and return structured HTTP status/json/text/score evidence.
  API tools should surface useful nested `score` fields from provider JSON rather than
  reducing a successful call to "HTTP 200" only.
- Secret handles are metadata references, not raw secrets. Use `POST /api/secret-handles`
  with provider `env`, `external`, or UI-created `inline`, a `secretRef`, and scopes. The
  public API rejects raw `token`, `password`, `apiKey`, or `value` payloads; the simplified
  Tool Builds form may accept free-form credential notes and convert them into a scoped
  inline secret handle for the generated tool. Tools and future model/always-on modules
  should refer to handles, then resolve them at runtime through the store/policy layer.
- Generated tool metadata registration must reject builtin name collisions and version
  conflicts. Generated modules are loaded only from compiled project-local paths, after
  exported name/version/capabilities match metadata and healthcheck passes.
- Generated tool replacements must not overwrite the active contract directly. Promote a
  replacement with an explicit `replacesVersion`; the store rejects stale handoffs,
  builtin replacement attempts, and same-version "upgrades".
- The Tools UI supports search across display/system names, versions, descriptions,
  capabilities, status/source, docs/examples, settings/secrets, and schemas. Generated
  tool detail cards expose active-version selection and "Request change / new version",
  which creates a Tool Build request with `replacesToolName` and `replacesVersion`.
  Generated tool versions carry `changeSummary` changelog metadata and are exposed through
  `GET /api/tools/generated-modules/:name/versions`; the Tools UI shows version history
  cards with changelog, paths, required secret handles, health detail, and usage counters.
- Trace Lab contextual "Create tool request / bug" forms should preserve run/span/task
  context. When the selected span actor is an installed tool, include the current tool
  name and active version so the request can become a versioned rework rather than a
  disconnected bug report.
- Tool Build forms may accept free-form credential notes, but after extracting a key-like
  value into a scoped secret handle the durable request must redact the raw note. Do not
  log or document raw keys in generated source, tests, traces, memory, artifacts, or final
  responses.
- Agent prompts now tell workers to identify reusable tool improvement requests when a
  current tool is close but insufficient. Runtime support for automatically waiting on the
  new version and retrying is still roadmap work; missing-capability builds can already be
  run synchronously by the HTTP runtime when a Tool Build workflow is configured.
- The generated Global Ledger AML adapter treats root `totalFunds` as the final AML Score.
  `sources[].funds` is source-level evidence; expose unique source names with
  top-level `sources[].share` percentages instead of using nested `funds.score` as the
  final score. Version 1.2.0 enables Global Ledger Unified search by appending
  `token=supported` to address and tx hash report URLs, so all supported tokens are
  analyzed by default.
- The first self-service generated capability is `browser-screenshot`. The Docker runtime
  includes Chromium and project source/tests so the Builder workflow can write generated
  TypeScript, run targeted tests, rebuild `dist`, register metadata, reload the generated
  tool, and let the original run save a PNG artifact.
- `browser.operate` must remain domain-neutral and portable. It executes typed browser
  commands and returns structured evidence plus Playwright storage state; agents decide
  the scenario and reviewers decide whether the resulting artifact proves the task.
- `browser.operate` also accepts screenshot-style `{ url, label?, filename?, fullPage? }`
  input and expands it into navigate/extract/screenshot commands. On command failure it
  should return any diagnostic screenshot payloads so the runtime can attach proof of
  blockers instead of losing evidence.
- Declared `browser.operate` plans may come from LLM-generated subtask JSON and can
  contain placeholders. Never execute placeholder navigation such as
  `URL_FROM_PREVIOUS_STEP` directly; rewrite it from concrete upstream dependency or
  prior evidence URLs, or skip it as not runnable so traces show the planning problem
  instead of a bogus browser failure.
- Missing document/report/PDF artifact capabilities can be handled by the generic
  `DocumentArtifactToolBuildProvider`, which writes TypeScript generated tools returning
  `application/pdf` artifact payloads. This is intentionally an abstract document
  capability, not a special one-off PDF fix.
- Telegram file attachments and artifact delivery are not complete yet. The roadmap target
  is a generic media/file service capability: provider file download -> input artifact
  storage -> run context attachment, and output artifact -> provider `sendDocument` or
  equivalent with audit evidence.
- Telegram voice recognition is also future generic media intake: download audio, store
  the original, call a registry-selected speech-to-text tool, and attach transcript plus
  audio artifact to the thread/run.
- Media/file/voice work must stay provider-neutral: implement generic transport,
  provider adapters, media intake, and speech-to-text capability layers first, then let
  Telegram/Slack/WhatsApp/email map provider APIs onto those contracts.
- Data-driven chart tasks should prefer a registered structured-data acquisition
  capability before rendering. Web search can still provide narrative context and source
  discovery, but chart data should not be invented from snippets when a structured tool
  can provide validated dataset artifacts.
- Agents must self-check browser and screenshot evidence before returning it. Blank
  pages, endless loaders, login walls, access-denied screens, bot checks, unrelated pages,
  or screenshots without task-relevant content are weak evidence; the agent should retry
  a better source or report the blocker instead of presenting the artifact as proof.
- PNG browser screenshots also pass through deterministic visual and semantic artifact QA
  before storage. Near-empty/mostly single-color screenshots, loader/blocker browser
  evidence, and task-mismatched browser context are rejected with a failed artifact trace
  event instead of being attached as useful proof.
