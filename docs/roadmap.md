# Roadmap

## Current Runtime

The current system is a coordinator-led DAG:

```text
coordinator
  -> memory search
  -> classification
  -> planner
       -> worker
            -> reviewer
            -> revision worker, only if reviewer requests changes
                 -> reviewer
       -> worker
            -> reviewer
  -> synthesizer
  -> memory learning
```

Planner subtasks can declare `dependsOn`, so independent branches run in parallel while
dependent branches wait for reviewed upstream outputs. Workers request their own review
immediately after finishing, so reviews can run while other workers are still active. The
coordinator waits for reviewed worker results before calling the synthesizer. A failed
review triggers one bounded revision pass before synthesis.

This is not yet a fully autonomous recursive agent society. It is still centrally
orchestrated, but the trace contract is ready for nested agent calls.

## Product Direction: Group Assistant Platform

The project is evolving from a single local agent console into a deployable assistant
platform for one family, household, company, team, or other bounded group per running
instance.

Target capabilities:

- one shared group profile per instance;
- separate context for the group and individual users;
- scoped memories for the group and each member;
- Telegram bot intake with a whitelist of allowed users;
- admin visibility into Telegram-originated requests and conversations;
- conversation threads that distinguish new tasks from follow-up questions,
  clarifications, and corrections;
- outbound messages, reminders, and broadcasts to a person or group;
- agents that can communicate with agents from other instances/companies/families through
  explicit permissions;
- simplified capability onboarding through Tool Builds: an admin provides API/channel
  docs, desired behavior, and credential secret handles, and the system builds a reusable
  TypeScript module with tests and QA;
- instance-scoped tool credentials and user/role policies.

See [Instance Context And Personalized Assistant Model](modules/instance-context.md).

## Product Principle: Capability Platform, Not Case Patches

The system must not grow by hardcoding private solutions such as a special "market/chart
pipeline" or a special "Telegram integration" into the core agent. The product goal is a
universal agent runtime with reusable building blocks:

- agents receive one local task and decide whether they can solve it directly;
- agents can delegate to child agents without knowing whether their caller is a human or
  another agent;
- every agent self-checks its output against the local task contract before returning it
  upward;
- missing abilities are expressed as abstract capabilities, not as one-off fixes for the
  current user prompt;
- capabilities are implemented as TypeScript tool modules with schemas, tests, QA
  evidence, documentation, version history, and runtime telemetry;
- a tool can be upgraded by creating a new version with a changelog and QA report, then
  promoting that version after review;
- built-in, generated, and always-on tools must eventually use the same versioned
  lifecycle: change request -> new version -> code review -> behavior/QA review ->
  promotion -> reload/restart. Direct source edits are allowed only as temporary
  operator hotfixes while the lifecycle is incomplete;
- tools should evolve toward out-of-tree, independently packaged modules rather than
  permanent source files inside the Agentic application repository. The core should know
  their contracts, versions, settings, credentials, health, and endpoint/container
  locations, but the tool implementation should not import Agentic internals;
- a portable tool should be importable/exportable with its manifest, source or image
  reference, schemas, docs, tests, QA evidence, version history, settings schema, secret
  requirements, and optional storage migrations;
- credentials, environment variables, provider URLs, and tunable tool settings are stored
  as registry metadata and secret handles, so operators can configure tools without
  editing prompts or source code;
- domain tools such as charts, browser automation, API clients, long-running bots,
  webhook receivers, file processors, or data fetchers are examples of reusable capability
  families. They are not special runtime branches.

Whenever a concrete run fails, the fix should be classified as one of:

- a prompt/planning issue in the universal agent loop;
- a missing generic capability;
- a too-weak existing capability that needs a new version;
- a tool configuration/credential/policy issue;
- external site/provider limitation that should become evidence or memory, not a fake
  success.

## Recent Systemic Findings

### Capability failure example: `run_1777798218331_linj0nh2`

The Bitcoin six-month analysis run completed with a failure-style final answer instead
of a useful chart. The important fixes are generic capability/runtime improvements, not a
hardcoded Bitcoin or market-analysis path:

- Query hygiene: a source-discovery tool or planner must not mix stale terms from an
  unrelated domain into a new task. Search planning needs domain isolation,
  stale-context guards, and source-specific query templates.
- Structured data first: if a requested artifact requires numeric data, the agent should
  search the registry for a reusable structured-data acquisition capability before trying
  brittle browser scraping. Browser screenshots are proof artifacts, not primary numeric
  data sources.
- Query context preservation: search/tool planning must carry geographic, language, and
  source constraints from the original user task into each subtask query, so a European
  directory task does not drift into US/global default sources.
- Provider fallback chain: data-acquisition tools should support configurable providers
  and fallback attempts through registry settings and secret handles.
- Tool output QA: a browser tool result that lands on a blocker page such as "Just a
  moment" or "Verifying you are human" must be marked as blocked/useless evidence, not
  successful extraction.
- Capability aliases: artifact requirements like `file-write` should resolve to the
  existing `file.write` tool or the artifact store instead of creating a blocked tool
  build request for an already available capability.
- Artifact preconditions: an artifact-rendering tool should run only after required input
  artifacts are validated. If the data artifact is missing, the system should repair the
  upstream acquisition capability rather than repeatedly invoking the renderer with
  unparsable text.
- Failure-directed tool requests: when a tool fails because an upstream dependency is
  missing, the generated bug/tool request should target the upstream capability, not the
  downstream renderer.
- Memory learning hygiene: failed-run lessons should enter the memory review queue with
  conservative scope and wording. They should not become accepted global advice about
  "bypassing" site protection.

## Progress Snapshot

This is a product/architecture estimate, not a ticket counter.

- Overall target platform: about 57-62% complete. The core run orchestration, traces,
  artifacts, memory lifecycle, tool registry, and model tier plumbing exist; autonomous
  recursive agents, broad generated tool families, always-on tool supervision, and policy
  enforcement still remain.
- Current coordinator prototype: about 74% complete. It can delegate, review, synthesize,
  call tools, create artifacts, and persist runs, but it is still centrally planned rather
  than a fully recursive society of agents.
- Operator UI: about 61% complete. The shell, Dashboard, Runs, Conversations, Trace Lab,
  Memory, Artifacts, Tools, Tool Builds, Models, Group Profile, Settings, and Diagnostics
  have useful surfaces; several pages still need deeper interactions and tighter
  analytics.

## Phase 0: Instance Foundation

Status: partially implemented.

Goal: introduce the data model that lets every future feature know "which assistant
instance is running, who is asking, through which channel, with which permissions."

Target entities:

- `instance_settings`
- `group_profile`
- `users`
- `user_roles`
- `channel_identities`
- `conversation_threads`
- `thread_messages`
- `run_context`
- `memory_scopes`
- `policies`
- `audit_events` DONE for the base table/store/API and run/artifact/tool/tool-build
  events; future outbound/policy/memory events will reuse the same contract.

Implementation tasks:

- Add migrations for instance settings, group profile, users, roles, and channel identities. DONE
- Add a default local instance profile and admin user so the current single-user experience keeps
  working. DONE
- Attach `instanceId`, `requesterUserId`, and `channel` metadata to every run. DONE
- Add `threadId`, `parentRunId`, source message/thread IDs, and compact thread summaries. DONE
- Show group profile/requester/channel in run headers and trace metadata. PARTIAL:
  run headers include requester/channel/thread; group profile is editable through the UI/API.
- Add a thread-resolution service that classifies inbound messages as new task,
  continuation, clarification, or correction. DONE for deterministic channel-aware
  routing: explicit `threadId` always wins, `/new` and independent tasks create a new
  thread, and same-source chat/thread follow-ups, clarifications, and corrections reuse
  the latest matching active thread.
- Add tests proving run creation requires a resolvable requester context. DONE:
  `UserStore` now resolves explicit users and allowed channel identities before any run or
  thread is created; unknown requesters return 400 and unmapped/blocked channel users
  return 403.
- Add tests proving continuations inherit compact thread context without replaying full
  transcripts. DONE for explicit web continuation and channel-originated follow-up
  resolution without a supplied `threadId`.
- Pass compact prior artifact metadata into continuation runs. DONE: thread context now
  includes recent artifact filenames, MIME types, URLs, previews, kind, and QA status, so
  a follow-up can reuse a prior CSV/screenshot/report instead of reacquiring the same
  evidence when it is still fresh and sufficient.
- Add audit events for run creation, tool use, artifact creation, memory writes, and
  future outbound actions. PARTIAL: run created/started/completed/failed, input/output
  artifacts, tool trace events, run cancellation, learned-memory writes, and tool build
  requests/registrations are implemented. Approvals, outbound actions, Telegram
  delivery, and policy decisions remain.
- Add operator cancellation for active runs. DONE: `queued`/`running` runs can be marked
  `cancelled` through API/UI, SSE streams close on that terminal status, and late model or
  tool results are ignored instead of overwriting the cancellation.

UI tasks:

- Add top-level navigation for Dashboard, Runs, Conversations, Memory, Artifacts, Tools,
  Tool Builds, Models, Group Profile, Users, Channels, Policies, Approvals, Scheduler,
  Audit Log, Settings, and Diagnostics. DONE for the product shell; several backend
  surfaces still use structured placeholders.
- Add requester/channel context visibility in the web console. PARTIAL
- Add a new-task composer on Dashboard and keep continuation composer only inside a run
  or conversation thread. DONE
- Add a Conversations page with thread summaries, run history, and split/merge controls. PARTIAL
- Add destructive conversation deletion with associated runs and traces. DONE: the
  Conversations UI and API can delete a thread, all runs attached through `threadId`, and
  run event/artifact metadata cascades from those runs; the audit log records the action.
- Add Group Profile and Users pages with read-only cards first, then editing. PARTIAL:
  Group Profile has editable API/UI persistence. Users now have API/UI CRUD for members
  and channel identities, including allow/block identity status and audit events. Role
  policy editing, per-user tool permissions, and notification preferences remain.

## Phase 1: Reliable Memory

Status: partially implemented.

The runtime now uses Postgres-backed memory when `DATABASE_URL` is present. Memory entries
carry scope (`global`, `group`, `user`, `thread`, `run`), status (`proposed`, `accepted`,
`rejected`, `archived`), confidence, sensitivity, source run/thread IDs, and evidence.
Agent retrieval only uses accepted memory; proposed facts stay in a review queue until an
operator accepts them. Runtime calls now pass visible scopes for the active group,
requester user, thread, and run, so scoped entries outside that context are not injected
into agent prompts. Search now uses Postgres full-text search, lexical rescoring, and a
pgvector-compatible embedding column when the database supports the `vector` extension.
The embedding layer is provider-based: the default deterministic local provider keeps the
system portable, while `EMBEDDING_MODEL` enables an OpenAI-compatible `/embeddings`
provider with local fallback and projection into the current 128-dimensional pgvector
column. The next retrieval step is evaluating real embedding quality on production-like
queries and adding richer tags/policy filters.

Tasks:

- Store skill memories in Postgres. DONE
- Store source run IDs and evidence. DONE for the base fields/API.
- Add memory scopes: global, group, user, thread, run. DONE for storage/API/UI metadata
  and runtime visible-scope retrieval.
- Add memory write review so personal facts are classified before storage. PARTIAL:
  `proposed`/`accepted`/`rejected` lifecycle, UI review queue, API updates, and audit
  events exist. The run learning step now asks the model to classify each reusable memory
  as global/group/user/thread/run with confidence, sensitivity, evidence, and status;
  non-global or sensitive/private learned memories are forced into `proposed` review
  state before they can be retrieved. Proposed memories now also have deterministic
  pre-review guardrails (`GET /api/memories/review-queue`) that flag missing scope IDs,
  missing evidence/source links, low confidence, and private/sensitive policy risks
  before an operator accepts them.
- Add embeddings with `pgvector`. DONE for the current schema: `skill_memories.memory_embedding
  vector(128)` and an HNSW cosine index are created when pgvector is available; memory
  writes use a configurable embedding provider with deterministic fallback.
- Search by semantic similarity plus tags. PARTIAL: Postgres search now merges lexical
  and vector candidates before visibility/status filtering. A reusable retrieval
  evaluation harness plus `POST /api/memories/evaluate-retrieval` can score representative
  query fixtures by expected memory ids, recall, top-hit match, visible scopes, and
  limits. Real semantic quality still depends on configuring `EMBEDDING_MODEL` and
  maintaining production-like evaluation cases.
- Add a re-embedding/backfill job for provider changes. DONE for the operator path:
  `POST /api/memories/reembed` rebuilds stored vectors for the active provider and the
  Memory page exposes a "Rebuild embeddings" action with audit coverage.
- Show memory hits in UI with confidence and why they matched. PARTIAL: search results now
  carry match reason/matched tokens for prompt context; richer UI drilldown remains.
- Add tests proving repeated similar tasks retrieve prior memories. DONE: the universal
  agent test suite now seeds accepted group memory, runs a similar task with visible
  scopes, and asserts the retrieved memory reaches classification/direct-answer prompts
  while out-of-scope memory is excluded.
- Add permissions so agents cannot read another user's private memory unless policy and
  task context allow it. PARTIAL: runtime visible-scope retrieval now requires exact
  `scopeId` matches for user/group/thread/run memories, so broad `scope=user` queries no
  longer expose every user's accepted/private memory. A deterministic memory policy
  evaluator now simulates accepted/status, exact-scope, private-requester, and sensitive
  grant decisions for the operator UI. The same evaluator is also applied before
  memories are injected into agent prompts: sensitive memories need an explicit runtime
  grant, and private memories are limited to the same requester user unless an override
  is supplied. Editable role/policy records are still pending.
- Add UI for browsing and editing group/user memory separately. DONE for the current
  operator workflow: the Memory page
  now separates entries by status and exact scope (`global`, `group`, `user`, `thread`,
  `run`), shows retrieval impact for accepted/proposed/rejected/archived entries, keeps
  the review queue visible, links source runs/threads, and lets operators edit title,
  summary, reusable procedure, tags, scope, status, confidence, sensitivity, and evidence.
  The inspector also simulates whether the currently selected run context would retrieve
  the selected memory, including private user memory and sensitive-memory review flags.

Remaining memory gaps:

- Real semantic retrieval still needs a configured embedding model and a growing set of
  production-like retrieval evaluation fixtures.
- The agent only stores a memory when the LLM returns `shouldStore: true`.
- Stored lessons are generic, so specific repeated requests may not match well.
- Runtime memory retrieval enforces accepted-only, exact visible-scope filtering, and the
  deterministic sensitive/private memory policy before prompt injection. It is not yet
  connected to editable role/policy records or persistent policy decisions.
- Memory proposals from completed runs are classified into group/user/thread/run scope by
  the learning model, audited as `memory.created`, and checked by deterministic
  memory-specialist guardrails before storage. Low-confidence or policy-risky learned
  memories stay `proposed` even if the model requested `accepted`. A separate LLM
  memory-specialist reviewer remains a future upgrade for semantic duplication,
  privacy-risk explanation, and evidence grading.
- Memory policy simulation currently uses the selected run context and deterministic
  rules. It is not yet connected to editable role/policy records or audit decisions.

## Phase 2: Tool Registry

Status: partially implemented.

The runtime has a first-class tool registry. Built-in tool contracts are synced into a
persistent `tool_modules` table when Postgres is configured, so future generated tools
can be versioned, health-checked, and promoted without being only in process memory.

The registry is the agent's catalog of bricks and cement. Agents should inspect it before
inventing a plan, choose existing tools by capability, request a new generic tool when a
capability is missing, and request a new version when an existing tool is too weak.

Tool contract:

- name;
- version; DONE
- version changelog and replacement relationship;
- input schema; DONE
- output schema; DONE
- capabilities; DONE
- startup mode; DONE
- healthcheck; DONE
- required configuration keys and secret handles; DONE for registry/API/UI metadata.
- operator-editable settings, provider URLs, limits, and feature flags; PARTIAL:
  settings schemas are persisted and shown, but concrete editable per-tool setting values
  are still pending.
- declared storage contract: schema namespace, table ownership, migrations, retention,
  backup/export notes, and required database permissions; DONE for registry/API/UI
  metadata.
- destructive data capabilities, if any, with dry-run/preview, approval policy, and audit
  requirements;
- usage counters: successful runs, failed runs, last success, last failure; DONE for
  registry-executed tool calls.
- QA evidence and reviewer decisions per version;
- issue/rework tickets linked to runs/spans/artifacts;
- trace event mapping.

Initial tools:

- `web.search` DONE
- `web.open`
- `file.read` DONE
- `file.write` DONE
- `chart.generate` DONE
- `browser.operate` DONE as a reusable Playwright command executor with navigation,
  dialog dismissal, click/fill/select/check, waits, assertions, DOM extraction, link
  extraction, screenshots, and returned storage state
- `browser.screenshot` self-service provider DONE for first-generation Playwright module
- `db.query`

Implemented registry persistence:

- `tool_modules` Postgres table.
- Built-in tool metadata sync on server startup.
- Tool health status persisted after `/api/tools/health`.
- API/UI expose source, status, schemas, startup mode, capabilities, health detail, and a
  registry healthcheck action that updates persistent metadata.

Remaining registry persistence:

- Persist per-version changelogs and replacement links as first-class UI/API fields.
- Persist tool settings and required env/secret metadata in DB so operators can see which
  parameters and credentials each tool needs. PARTIAL: contract metadata is persisted and
  displayed; editable runtime setting values remain.
- Persist tool-owned storage contracts and migration metadata so operators can see which
  tool version owns which tables, indexes, retention rules, and database permissions.
  PARTIAL: storage contracts and `tool_migrations` records are persisted/displayed;
  isolated migration execution and transactional promotion remain.
- Track success/failure counters and recent failure classes per tool version from trace
  and audit events. PARTIAL: success/failure counters and last timestamps are recorded
  for `ToolRegistry.execute`; failure-class rollups remain.
- Add a tool issue/rework inbox: from any tool, version, run span, or artifact QA failure,
  create a context-rich request for an agent to analyze and produce a new version.
- Add agent-readable tool docs/examples so agents know how to call a tool without reading
  source code.
- Add an out-of-tree tool package model. The registry should support module references
  that are not committed to the main Agentic repo: object-store source bundles,
  uncommitted generated-tool workspaces, OCI/container images, or external package
  references. Agentic stores the manifest, contracts, docs, QA evidence, active version,
  settings, credentials, and lifecycle metadata, while a generic runner executes the tool.
  PARTIAL: `ToolPackageManifest` now defines and validates the portable import/export
  shape for source bundles, OCI images, external packages, and local-path development
  tools. `GenericServiceToolBuildProvider` now emits a local-path package manifest in its
  build output, and the registry persists package manifests through the active Postgres
  row plus version history. `ToolPackageRunner` now gives the loader a pluggable execution
  boundary: local-path packages load through the first runner, and pre-built
  source-bundle packages can load from the out-of-tree package workspace
  `TOOL_PACKAGE_WORKSPACE_ROOT` (default `tools`, gitignored), explicit
  `TOOL_PACKAGE_ROOT`, or the legacy `tool-packages` directory without living in the main
  committed generated-tools directory. `ToolPackageWorkspaceStore` can now write
  portable package folders with `tool.package.json`, README, Dockerfile, package metadata,
  TypeScript build config, source, and tests under that workspace while rejecting path
  traversal and non-source-bundle manifests. External-package manifests whose
  `package.ref` is
  an HTTP(S) runtime URL now load through a proxy runner that calls `/health`, `/run`, and
  optional service lifecycle routes. OCI-image manifests can now be executed by an
  explicitly enabled Docker runner (`TOOL_OCI_RUNNER=enabled`) when the container exposes
  the same HTTP runtime contract. Tests also prove custom non-local manifests can be
  loaded by adding a runner, unhealthy OCI runtimes are stopped instead of promoted, and
  HTTP/OCI runtimes receive only their declared `requiredConfigurationKeys` and
  `requiredSecretHandles` as scoped runtime envelopes. Missing required runtime values now
  fail before the external runtime is called.
  Runner inventory is visible through the API and Diagnostics page, and operators can
  explicitly reload generated tools after updating a source-bundle on disk. Remaining
  work is building package folders into OCI/external HTTP runtimes, npm/external package
  install/sandboxing, production resource/log supervision for containers, redacted runtime
  logging, container-level config/secret injection policies, and richer runner UI
  controls. DONE for API/UI package import/export, package workspace writing,
  package-local build/test QA, active source-bundle promotion, and first OCI HTTP proxy
  runner.
  The API/UI can now import portable `agentic.tool-package.v1` manifests into the
  registry and export existing generated package manifests. Non-local package references
  are intentionally registered as disabled metadata until the runner/supervisor layer can
  execute them.

Every tool call must emit trace events with:

- caller span;
- tool name;
- input summary;
- output summary;
- duration;
- status.

## Phase 3: Self-Service Tool Modules

Allow agents to create or activate tools when the registry lacks a needed capability.

Tool Builds are not domain-specific feature work. They are a generic factory for
versioned TypeScript capabilities. If a user asks for a chart, the agent asks for a
generic data-visualization/artifact-rendering capability. If a user asks to use a channel
such as Telegram, the agent asks for a generic inbound/outbound always-on tool capability
configured with a secret handle and startup mode. If a user provides API docs and credentials,
the agent asks for a generic API-client tool generated from the contract.

Flow:

```text
agent needs capability
  -> searches tool registry
  -> activates existing tool if available
  -> if existing tool is close but insufficient, creates a rework request for a new version
  -> otherwise delegates tool creation to a Tool Builder agent
  -> Tool Builder agent scaffolds the module
  -> Tool Builder agent delegates verification to a Tool QA agent
  -> Tool QA agent writes/runs tests and performs a manual smoke check when applicable
  -> Tool Code Reviewer checks source, schema, security, and portability
  -> Tool Behavior Reviewer checks actual outputs against QA criteria and artifact evidence
  -> Tool Registrar agent registers the verified tool contract
  -> operator/agent promotes the version when QA and review pass
  -> original agent delegates usage to a Tool User agent
  -> Tool User agent invokes the new tool and returns evidence
  -> original agent finishes the user task with that evidence
  -> shut down if ephemeral
```

Example:

```text
agent needs browser screenshot
  -> registry has no browser.screenshot
  -> create child agent: build browser.screenshot tool
       -> create child agent: QA browser.screenshot tool
       -> create child agent: register browser.screenshot tool
  -> create child agent: use browser.screenshot tool on target page
  -> parent agent uses screenshot evidence in final answer
```

Target agent roles:

- `Capability Detector`: decides which capability is missing.
- `Tool Builder`: creates a module that satisfies the tool contract.
- `Tool QA`: tests the module with automated and manual checks.
- `Tool Registrar`: records the verified tool in the registry.
- `Tool User`: uses the tool for the original task and reports evidence.

Guardrails:

- Generated tools must be sandboxed.
- Generated tools must include tests.
- Generated tools must be TypeScript and independently reusable outside the current
  prompt.
- Generated tools must not open arbitrary database connections or execute hidden SQL.
  Database access must go through an injected, scoped tool execution context.
- Generated tools that need durable storage must declare migrations and database
  permissions as part of the tool version contract.
- Generated tools must document input/output contracts, configuration, credential
  handles, examples, limitations, and portability notes.
- Tool activation must have resource limits.
- Tools must be reviewed before becoming reusable.
- Tool code review and behavior QA must both pass before promotion.
- Tool storage migrations must pass isolated database QA before promotion.
- A failed QA step must prevent registration.
- A failed promoted tool version must remain inspectable and can be superseded, but not
  silently overwritten.
- Ephemeral tools must be cleaned up after the run unless explicitly promoted.
- Tools must not store raw credentials in source, prompts, memory, artifacts, or traces.
- Tool Builders should prefer capability names and schemas that are abstract enough to
  reuse across tasks.

Next implementation tasks:

- Add a tool registry persistence table. DONE for metadata; remaining work is loading
  generated executable modules from persisted registry records.
- Add `tool-missing` trace events. DONE
- Add a Tool Builder agent contract. PARTIAL: persistent build request contracts,
  deterministic provider-based generated source writers, and a guarded LLM-backed
  fallback provider for unknown/custom capability families exist. Deterministic providers
  run first; the LLM path can write only the requested TypeScript module/test pair,
  rejects unsafe paths/raw-looking secrets, and still requires isolated QA plus promotion
  checks before registration. Remaining work is richer docs ingestion, separate
  code/behavior reviewers, and out-of-process build sandboxes.
- Add a Tool QA/review agent contract. PARTIAL: generated QA criteria, isolated
  generated-tool test execution, TypeScript build verification, promotion checks, and
  deterministic code/behavior review gates now exist. Optional LLM code/behavior
  reviewers can be enabled with `TOOL_BUILD_LLM_REVIEW=enabled`; they inspect the durable
  request contract, QA report, and generated module/test previews, then store structured
  decisions in `qaReport.reviews`. Failed review findings are returned to the builder for
  bounded repair attempts. Remaining work is making LLM review a managed model-tier
  policy instead of an env flag, richer behavior reviewers with real smoke evidence,
  visual/artifact QA, and separate worker pools.
- Add a persistent Tool Build Queue. DONE via `tool_build_requests` and
  `/api/tool-build-requests`.
- Add Tool Build Queue lifecycle APIs. DONE via `GET/PATCH
  /api/tool-build-requests/:id`, `POST /api/tool-build-requests/:id/stop`,
  `DELETE /api/tool-build-requests/:id`, builder status details, QA reports, and
  registered tool references.
- Add a Tool Registrar service with version conflict checks. DONE.
- Load executable generated modules after QA/registration. DONE for compiled project-local
  modules with contract validation and health promotion.
- Enforce TypeScript-only generated tool modules. DONE through provider output paths,
  targeted tests, and `npm run build` in QA.
- Add a Tool Builder worker that consumes queued requests, writes TypeScript source,
  creates focused tests, delegates QA, and registers only after QA passes. DONE for
  provider-backed builds through both manual `POST /api/tool-build-requests/:id/run` and
  the background `ToolBuildWorker`, which atomically claims the oldest `requested` card and
  reloads generated tools after registration.
- Keep Tool Build and rework request forms stable during live UI refresh. DONE: soft
  background refresh defers rendering while an operator has an open tool-build, span bug,
  or tool rework form, and universal QA/change prompts are placeholders rather than
  silently submitted defaults.
- Add a reusable Tool Builder workflow. DONE as `ToolBuildWorkflow`, with pluggable
  Builder, QA Runner, Review, and Registrar interfaces plus tests proving failed QA or
  review blocks registration and failed QA/review reports can be returned to the builder
  for a bounded retry.
- Add a Tool QA runner that executes targeted tests plus capability-specific smoke checks
  in an isolated container/process and writes a structured QA report back to the queue.
  DONE for temporary workspace isolation, command timeouts, targeted tests, isolated build,
  and promotion build verification.
- Implement `browser.screenshot` as the first self-service tool target. DONE with a
  Playwright provider that writes module and smoke-test files.
- Implement a reusable document/PDF artifact provider for missing document-generation
  capabilities. DONE for a provider-authored `DocumentArtifactToolBuildProvider` that can
  unblock abstract `pdf-generation`, `document-generation`, and `report-generation`
  requests by writing a TypeScript module/test pair returning an `application/pdf`
  artifact payload. Remaining work is richer template/layout engines and LLM-authored
  document modules from arbitrary docs.
- Prove the full loop with a test task that requires a missing screenshot capability.
  DONE in automated runtime tests; remaining work is repeated manual browser/UI evidence
  after Docker rebuilds.

Remaining Phase 3 gaps:

- Replace provider-authored source with a higher-level Tool Builder agent that can create
  new providers/modules for unknown capability families. PARTIAL: `LlmToolBuildProvider`
  now acts as the guarded unknown-capability fallback after deterministic providers using
  the configured XL-tier model and the same QA/registrar pipeline. Remaining work is real
  provider-doc chunking, iterative repair from richer QA failures, semantic code review,
  behavior review with live smoke evidence, and execution outside the main app process.
- Fold API-docs onboarding into Tool Builds: admin uploads/pastes documentation, desired
  use cases, and credential setup notes; the builder creates a scoped TypeScript tool
  contract, tests, QA report, and registry metadata. PARTIAL: the UI/API can create
  human tool requests without asking the operator for internal capability ids, infer
  capability/system names automatically, persist human `displayName`, store optional
  credential notes as sensitive setup context, attach structured `credentialHandles` when
  low-level callers provide them, register secret handles that point to env vars,
  external secret-manager refs, or Tool-Build-scoped inline material, and provider-build
  generic HTTPS JSON API adapters such as `api.aml.score`. Generated API adapters return
  structured HTTP status/url/json/text plus extracted nested score evidence when provider
  JSON exposes `score` fields, so successful calls are useful to downstream agents rather
  than only saying "HTTP 200". The Global Ledger AML adapter has exercised versioned
  rework in practice: v1.1.0 switched final score extraction to root `totalFunds` and
  source evidence to `sources[].funds.name`/`sources[].share`, and v1.2.0 added Unified
  search by forcing `token=supported` for address and transaction report URLs. Remaining
  work is autonomous docs parsing into endpoint
  presets, encrypted/secret-manager-backed material storage for pasted credentials, richer
  provider-specific schemas, and policy-aware runtime credential resolution for all
  generated tools.
- Make generated tools manageable from the registry. DONE for human display names,
  generated-system-name handoff, persistent `display_name` columns, Tools-page delete
  buttons, full-text-ish Tools-page search across labels/system ids/descriptions/tags/docs
  and schemas, `DELETE /api/tools/generated-modules/:name`, built-in protection,
  versioned rework requests from the Tools page, generated replacement promotion, and
  active-version selection through `POST /api/tools/generated-modules/:name/activate-version`,
  `GET /api/tools/generated-modules/:name/versions`, and Tools-page version-history
  changelog cards with paths, health detail, required secret handles, and usage counters.
  Remaining work is visual diffs between replacement versions and approval gates for
  sensitive promotions.
- Treat external channels as regular generated tools with `startupMode`, not special
  one-off screens: Telegram, WhatsApp, Slack, email, webhooks, and custom inbound/outbound
  listeners should be built through Tool Builds, registered in the tool registry, and then
  monitored through generic tool lifecycle/status UI. `on-demand` tools are invoked by an
  agent only when needed; `always-on` tools act as services/listeners and must expose
  health, start/stop/restart controls, logs, and event-to-run routing; `ephemeral` tools
  run as short-lived jobs and shut down after completion. PARTIAL: Tool Build requests now
  preserve `startupMode` in the generated contract and the UI lets operators choose it.
  `GenericServiceToolBuildProvider` can now generate provider-neutral always-on TypeScript
  service modules with `startService`, lifecycle health, neutral event recording, tests,
  and registry metadata. Remaining work is provider-specific generated adapters that
  translate real APIs into that neutral service contract, plus process/container runners
  outside the web app.
- Infer and persist a neutral Tool Integration contract from Tool Build requests. DONE:
  `ToolIntegrationSpec` now classifies API/service/webhook/polling/bot-like requests,
  captures provider hints, inbound/outbound event shapes, secret handles, settings,
  lifecycle expectations, and QA requirements inside the durable build contract.
  `GenericServiceToolBuildProvider` propagates that spec into generated source, docs,
  settings schema, storage contract, examples, required secret handles, and tests.
  PARTIAL for provider-adapter generation: the guarded LLM provider can now attempt
  unknown/custom integrations behind the same neutral contract. Remaining work is robust
  docs parsing, provider-specific smoke fixtures, service/webhook runner QA, and
  promotion policies for long-running integrations.
- Store credentials as secret handles, never in prompts, memory, artifacts, or source.
  DONE for the metadata/API/UI layer: `secret_handles` stores provider, label, scopes, and
  `secretRef`, rejects raw token/password/apiKey/value payloads, and audits create/delete.
  DONE for Tool Build forms that extract inline key-like values into scoped secret handles
  and redact raw credential notes before queueing. Remaining work is encrypted or external
  secret-manager-backed storage for inline material and policy-aware runtime resolution
  for every generated tool/model/always-on module.
- Add instance/user tool policy so a tool can be installed globally but enabled only for
  this instance, specific roles, or specific users.
- Move generated-tool QA from temporary workspace isolation to a stricter worker service
  or container pool with CPU/memory/network limits.
- Add LLM/provider repair implementations that consume failed QA reports; the workflow
  already supports bounded retry attempts.
- Persist generated source bundles and QA artifacts in object storage.
- Add first-class replacement/version promotion for installed failed tools after a
  tool-level rework request is built and QA-approved. DONE for the main lifecycle:
  Tools-page rework creates a versioned Tool Build request, the Builder emits a new
  TypeScript module/test path, QA runs in isolation, the Registrar promotes the new
  `replacesVersion`, `tool_module_versions` keeps old/new versions, and operators can
  switch the active version. Remaining work is richer changelog/diff display and
  policy/approval gates before promotion in sensitive environments.
- Add version diff/changelog UI for tool replacement requests, showing what the new
  version adds compared with the previous version and why the previous version failed.
- Add tool-level settings UI for required env variables, secret handles, provider URLs,
  rate limits, and feature flags declared by each tool contract.
- Represent operator-created Tool Build/Rework requests as root runs. DONE for direct
  Tool Build requests: when a request is created without an existing `sourceRunId`, the
  server creates a completed root run with `tool-build-requested` trace context and links
  the request through `sourceRunId`. Remaining work is to stream Builder/QA/Registrar
  progress back into that same run instead of only showing lifecycle status on Tool
  Builds.
- Route built-in and always-on fixes through the same versioned change-request path.
  PARTIAL: generated tools can already be reworked into a new version and promoted, and
  always-on tools have lifecycle metadata. Contextual span/tool bug requests now guard
  against wrong-card submissions: when the selected tool clearly does not match the
  operator feedback and another installed tool does, the server rejects the request with a
  clarification instead of silently retargeting it. Remaining work is to stop treating
  reference providers such as `channel.telegram.bot` as direct app
  source for operator changes: a bug or change request should create a replacement
  version, run service-specific QA, promote the new version, and restart/reload the
  service. Until this exists, direct code hotfixes are temporary technical debt and must
  be documented as such.
- Split tool execution out of the web application process. Target architecture:
  `Tool Manifest` + `Tool Runner` + `Tool Service Supervisor`. On-demand tools run as
  bounded jobs; always-on tools run as supervised services; high-load tools can scale to
  multiple workers/containers. The first implementation can use a local runner process and
  generated bundle directory, but the contract must also support OCI/container execution.
  PARTIAL: the app can now write source-bundle package workspaces outside the main repo
  under gitignored `tools/<name>/<version>` folders, mirror Tool Builder output into that
  workspace by default, include a package-local minimal Tool contract for generated
  TypeScript modules, include the sidecar package manifest in QA evidence, run structural
  package-workspace QA plus package-local build/test during command QA, persist verified
  package workspaces as the active `source-bundle` manifest, reload pre-built
  source-bundles from that workspace, proxy external HTTP packages, and optionally run OCI
  HTTP packages. The next step is to package/run those source-bundles as supervised
  external services or OCI runtimes instead of in-process imports.
- Add a `ToolExecutionContext` injected into every tool call with scoped DB client,
  secret resolver, artifact store, audit writer, logger, and cancellation signal. PARTIAL:
  registry calls now inject provenance, secret resolver, audit writer, logger, caller,
  span ids, and cancellation-compatible context shape. Scoped DB client and artifact-store
  injection remain.
- Add a `tool_migrations` or `tool_schema_migrations` table that records tool name,
  version, migration id, checksum, applied time, applied-by actor, QA report, and
  rollback/repair notes. DONE for the metadata table/store/API/audit/UI visibility.
- Extend Tool Builder contracts so a request can ask for persistent storage or a database
  maintenance capability. The builder must generate versioned migrations, tests,
  documentation, and operator-visible permission metadata.
- Run generated tool migrations in an isolated Postgres database during QA, including
  idempotency checks and fixture-based behavior tests.
- Promote tool versions transactionally: migration metadata, tool metadata, generated
  source bundle, QA evidence, and registry activation should move together.
- Add safe database maintenance actions from Trace Lab/Tool Detail/Tool Builds: the agent
  can create an auditable request to delete, repair, backfill, or compact records related
  to a source run/thread/tool, but execution must support dry-run preview, policy
  approval, audit logging, and exact scope constraints.
- Add success/failure telemetry rollups per tool and per tool version, fed by trace and
  audit events.
- Add "Analyze/rework this tool" actions from the Tool Detail page, Trace Lab spans,
  failed artifact QA panels, and generated tool health reports. The request should carry
  source run/span id, tool name/version, input summary, output summary, artifacts, QA
  failures, and the operator comment.
- Add span-context bug/rework creation from Trace Lab. PARTIAL: the selected span inspector
  now opens a prefilled Tool Build request form with run id, span id, task summary, actor,
  activity, status, caller, output/error context, and the exact installed tool/version when
  the span actor maps to a registered tool. The server now rejects obvious wrong-card
  contextual requests when the operator feedback names a different installed tool, so a
  Telegram change request accidentally submitted from a `browser.operate` span asks the
  operator to open the correct tool/span instead of creating a misleading browser request.
  Remaining work: classify the issue with a local LLM before build creation, include
  rejected artifact QA evidence automatically, and route site limitations to failure
  memory instead of tool rebuilds.
- Let agents request a versioned tool improvement, wait for the QA-approved promoted
  replacement, reload the registry, and retry the tool call once when a current tool is
  close but insufficient. PARTIAL: prompts now require workers to identify reusable tool
  improvement needs with tool name/current behavior/desired behavior/acceptance test; the
  runtime already does this for missing capabilities. Remaining work is automatic
  insufficient-tool rework execution and bounded retry.
- Next roadmap focus after the background worker: scoped semantic memory with group,
  user, and thread facts; review queue; confidence; accepted/rejected fact lifecycle.

## Phase 4: Recursive Universal Agents

Status: partially implemented.

Move from coordinator-only orchestration to recursive agents.

This is the center of the product. The goal is one universal agent implementation that can
sit at any point in the call chain. It receives a local task, decides whether to answer
or delegate, optionally asks for missing tools or tool versions, self-checks its output,
and returns a reviewed result upward. It does not need to know whether its caller is a
human, the top-level coordinator, or another child agent.

Desired behavior:

```text
agent receives one task
  -> reads scoped memory and available tool/capability registry
  -> decides if it can solve directly
  -> if not, creates child agents
  -> gives each child only local context
  -> child agents can recursively delegate
  -> child agents can request missing capabilities or improved tool versions
  -> each child self-checks result, artifacts, evidence, and contract coverage
  -> child returns reviewed result to parent
  -> parent self-checks accumulated result
  -> parent accumulates and returns upward
```

Each agent should know:

- its local task;
- its caller;
- instance, requester, and channel provenance;
- allowed budget;
- available tools;
- relevant memories;
- output contract.

Each agent should not need to know:

- the whole global task graph;
- unrelated sibling context;
- final UI structure.

Additional target behavior:

- child agents can request new child agents without central planner knowing the whole
  future graph;
- child agents can create Tool Build Requests when they detect missing capabilities;
- child agents can create Tool Rework Requests when an existing tool is insufficient;
- child agents can choose model tier and review strictness based on local task risk;
- every agent performs a local "ready to return" check before returning, independent of
  whether a separate reviewer exists;
- each child receives only scoped memory and tool permissions;
- agents can ask another instance/company/family agent for information through a federated
  request tool;
- inter-instance answers must include provenance and audit records.

Remaining recursive-agent gaps:

- Replace the central one-shot planner with an agent runtime that can recursively spawn
  workers, reviewers, tool builders, tool QA agents, and tool users.
- Persist agent call frames so a child agent has a local task/caller/output contract
  without needing full global context. PARTIAL: worker and reviewer spans now carry a
  structured `callFrame` payload with local task, output contract, caller span,
  dependency spans, model tier, status, and output summary. These frames are durable
  because they are stored in `run_events`.
- Add self-check traces for every agent return, including required artifacts, evidence
  sufficiency, tool QA status, and known limitations. PARTIAL: workers and reviewers now
  emit `agent-self-check-completed` events before their completed span is returned
  upward. Worker checks verify non-empty output, evidence state, required artifact
  presence, and typed artifact QA. Reviewer checks verify verdict shape, notes, and
  subtask binding.
- Add budget/deadline propagation and cancellation through recursive call trees.
- Add policies for which agents may request new tools, promote versions, use credentials,
  send outbound actions, or contact external instances.
- Add UI affordances that expose call-frame contracts separately from raw payloads.

## Phase 5: Model Tier Selection

Status: partially implemented.

Agents choose model tier by risk and complexity. The current implementation selects a
tier for each LLM call, sends it through `LlmClient`, and shows the tier in trace cards.
Tier model lists are configurable and persisted in Postgres so the user can run several
local OpenAI-compatible LLMs, remote OpenAI API models, or other OpenAI-compatible hosted
providers and assign multiple candidates to each tier.

Example tiers:

- `Tier S`: cheap/fast check, formatting, simple extraction.
- `Tier M`: normal reasoning and synthesis.
- `Tier L`: complex review, high-risk reasoning, architecture decisions.
- `Tier XL`: adversarial review or high-stakes synthesis.

Reviewers should be able to select a stronger model than the worker when the content is
complex or risky.

Implemented:

- Tier labels: `S`, `M`, `L`, `XL`.
- Heuristic tier selection for classification, planning, worker, review, synthesis, and
  learning.
- Environment model overrides per tier.
- Multiple comma-separated model candidates per tier.
- Local and remote OpenAI-compatible providers are supported by the LLM client contract.
- Postgres-backed model tier settings.
- API/UI for viewing and updating model tier policy.
- API/UI model catalog for the configured local OpenAI-compatible `/models` endpoint and
  the active embedding provider. Embedding is treated as a separate memory capability,
  not as a chat tier.
- Durable `model_providers` registry with in-memory/Postgres stores, API/UI CRUD, local
  and remote OpenAI-compatible chat providers, deterministic/OpenAI-compatible embedding
  providers, secret-handle references, model id catalogs, and embedding dimensions.
- `LlmClient` reads current tier settings for each request.
- `LlmClient` retries failed model requests inside the same tier, then escalates to the
  next tier when policy allows.
- UI trace tier badges.

Remaining:

- Retry/escalation when a model produces review-rejected output, not only transport or
  empty-response failures.
- Reviewer-generated failure reasons attached to model attempts.
- Persist model-attempt telemetry per run event.
- Per-agent budget accounting.
- LLM-driven tier choice with hard runtime caps.
- Metrics comparing worker tier vs reviewer tier quality.
- Store per-tier provider/base URL/API key secret handles in the settings UI.
- Provider-aware runtime resolver so tier entries can point at explicit provider/model
  references instead of the current single `LLM_BASE_URL`.
- Provider healthcheck actions and health history.
- Selectable provider/model dropdowns in tier cards.
- Persist embedding provider settings (`EMBEDDING_MODEL`, base URL, dimensions, secret
  handle) in the database and trigger memory re-embedding when the embedding model
  changes. This should be a dedicated "Memory embedding model" setting rather than Tier S/M/L/XL.

## Phase 6: Better UI Observability

Improve the execution map:

- direct arrows between parent and child spans;
- collapsible cards;
- tool-call cards inside agent cards;
- timeline mode by actual wall-clock time;
- filters by actor/activity/status;
- run comparison view;
- memory hit panel;
- artifact panel.

Implemented:

- Direct SVG arrows between parent and child spans.
- Additional dependency arrows from `payload.dependencySpanIds`.
- Collapsible trace cards with stable incremental rendering.
- Status, actor, activity, duration, parent-child metadata, and dependency badges.
- Live Trace Lab refresh from the run SSE stream, plus a return path back to Run Workspace.
- Client-side Trace Lab filters for actor, activity, status, tool, and model tier across
  Timeline, Graph, Logs, and the selected span inspector.
- Compact Trace Lab inspector evidence blocks for memory hits, tool payload summaries,
  and artifacts carried by selected span payloads.
- Trace Lab inspector renders durable agent call frames and return self-check results as
  first-class operator sections: caller span, local task, output contract, returned
  summary, readiness, checks, warnings, evidence count, and artifact count.
- Trace Lab inspector artifact evidence now renders the same preview cards as the main
  artifact panels instead of only filename/path text.
- Trace Lab run directory for `/trace`, so opening the section lists runs instead of
  implicitly jumping to the latest execution.
- Explicit SVG caller/callee arrows on graph nodes, with hover highlighting for incoming
  and outgoing connected cards.
- Graph edges use solid lines for direct parent/child calls, dashed lines for dependency
  waits, red arrows for failed targets, and wider horizontal spacing so arrowheads remain
  readable between columns.
- Graph mode separates worker/reviewer spans from tool/artifact spans so agent work and
  tool execution are easier to scan.
- Graph mode can switch between category columns and call-depth columns. Call-depth mode
  lays spans out by parent-child level while showing the category on each card.
- Conversation Detail shows request/response artifacts inline when the linked run has
  input or output files.
- Tool Build cards expose lifecycle previews, stop/delete actions, and revision requests.
  Failed installed tools expose a tool-level rework form on the Tools page that creates a
  durable `requested` rebuild card with the failure details prefilled.
- Final answers and conversation messages render sanitized Markdown, including bold text,
  italic text, nested bullet lists, common inline TeX arrows/symbols, clickable links,
  and clickable application-local artifact URLs.

Remaining:

- Timeline mode by wall-clock time.
- User/channel filters and run comparison.
- Rich artifact previews for PDFs/datasets/source bundles and source/memory-hit drilldowns.

## Phase 6A: Product UX Redesign

Status: partially implemented.

Goal: split the current all-in-one console into a daily-use assistant workspace and an
admin/operator control surface.

Top-level navigation:

```text
Dashboard
Runs
Conversations
Group Profile
Users
Channels
Memory
Artifacts
Tools
Tool Builds
Models
Policies
Settings
```

Dashboard:

- new-task composer with requester/source context and visible group profile;
- continuation is available only inside Run Workspace and Conversation Detail so the
  selected thread context is unambiguous;
- compact conversation panel with thread summary and recent threads; DONE
- file attachments;
- active run card;
- recent runs;
- system health;
- quick stats for success/failure, artifacts, tools, memory, and channel messages.

Run Workspace:

- run header: status, duration, group profile, requester, channel, thread, source message;
- answer panel;
- artifacts panel;
- outbound action panel;
- follow-up composer for corrections, clarifications, and next-step requests;
- compact thread context panel showing accepted facts, failed attempts, and open questions;
- live execution summary;
- compact important events;
- link to Trace Lab.

Trace Lab:

- graph, timeline, tree, and log modes;
- filters by actor, activity, status, tool, and model tier are implemented; user and
  channel filters remain;
- event inspector drawer;
- memory/tool/artifact evidence panels.

Admin pages:

- Group Profile: profile, members, shared memory, enabled tools, channels, recent runs,
  audit. PARTIAL: editable profile context is implemented; member/tool/channel summaries
  remain.
- Users: identities, memberships, personal memory, notification preferences, allowed
  tools, recent requests.
- Channels: installed always-on tool health, chat mappings, incoming/outgoing message
  history. New bots/listeners/webhooks are requested and built through Tool Builds.
- Conversations: thread summaries, linked runs, Telegram/web source messages, split/merge
  controls, continuation composer, and destructive delete with associated runs/traces.
- Memory: global/group/user/run scopes with match reasons and edit controls.
- Tools: registry, credentials, capabilities, health, examples.
- Tool Builds: human tool requests for APIs, browser/file capabilities, bots, webhooks,
  and services; inferred internal capabilities; builder/QA lifecycle; generated
  source/test bundles. Current UI explains requested/building/QA/registered states, shows
  real queue counts, preserves startup mode, and lets operators trigger the builder
  workflow for a queued request.
- Policies: permissions for memory access, tool use, outbound messages, and federation.

## Phase 7: Durable Artifacts

Status: partially implemented.

Implemented:

- User requests can include file attachments through the web UI/API.
- Attachments are persisted as input artifacts.
- Runs can return downloadable artifact links in `result.artifacts`.
- The UI renders image artifact thumbnails in artifact cards and compact conversation
  chips, and turns artifact-link lines in Markdown answers into download links.
- Text-like input and generated output artifacts now store `contentPreview` in metadata;
  the UI renders short previews for text/source artifacts and compact table previews for
  CSV/TSV datasets.
- Artifact metadata can now persist compact QA decisions (`quality`) with check names,
  pass/warning/fail status, reasons, warnings, and matched signals; the UI renders these
  as small QA badges on artifact cards.
- The runtime invokes the registered `chart.generate` TypeScript tool when a task asks
  for a graph/chart and task context or worker output contains a parsable time series.
- Artifact creation emits trace events.
- New Docker-stack artifacts store metadata in Postgres and payloads in MinIO/S3 through
  `DurableArtifactStore`; local filesystem manifests remain as a fallback for older runs
  and non-Docker development.

Remaining:

- Add richer artifact previews in the UI for PDFs and source bundles. PARTIAL: datasets
  now show compact table previews and source/text artifacts show stored content previews;
  PDFs still use typed preview tiles and need richer page/thumb extraction.
- Make reviewers artifact-aware across all file types, not only chart requests. PARTIAL:
  typed artifact contracts now reject obvious mismatches such as PNG proof for a data
  requirement, empty inspectable previews for data/source artifacts, and invalid
  document/image/chart/screenshot MIME classes. Accepted tool-generated artifacts now
  carry durable QA metadata that can feed UI review and future tool-rework requests.
  Remaining work is richer content-specific inspection for PDFs, source bundles, and
  multi-file reports.
- Make planning dependency-aware so a review subtask cannot run before the artifact it is
  supposed to review exists. DONE for subtask-level DAG execution; remaining work is
  explicit typed artifact contracts.

Use MinIO/S3 for generated artifacts:

- screenshots;
- charts/images;
- source files;
- datasets;
- reports;
- exported documents.

Artifacts should be linked from trace cards and final answers.

## Phase 8: Artifact-Aware Autonomous Workflows

Goal: the agent should understand missing artifact capabilities during a task and build or
activate the required module.

Target capability families:

- data acquisition tools: collect structured records from configured providers or source
  documents and return validated dataset artifacts;
- visualization/rendering tools: transform arbitrary structured data into chart/image
  artifacts without domain-specific assumptions;
- browser evidence tools: navigate, extract, screenshot, preserve session state, and
  report blockers as evidence instead of pretending success;
- document assembly tools: combine text, images, screenshots, tables, and citations into
  PDF/report/source-bundle artifacts;
- artifact QA tools: inspect the produced artifact and decide whether it proves the local
  task contract.

Implementation tasks:

- Add explicit artifact contracts to subtasks (`requiredArtifacts`, type, acceptance
  criteria).
- Add DAG dependencies between subtasks so reviewers and synthesizers wait for required
  parent artifacts. DONE for reviewed text outputs; remaining work is typed artifact
  dependencies.
- Add generic structured-data acquisition capability patterns instead of relying on search
  snippets. PARTIAL: one concrete reusable tool exists for a narrow data source, but the
  target is a provider-configurable family of data tools with schemas, credential
  handles, source QA, and artifact preconditions.
- Implement `browser.screenshot` with page-open, cookie/session handling, screenshot
  capture, and visual QA.
- Implement reusable `browser.operate` with generic navigation/click/fill/wait/extract
  and screenshot commands. DONE for command sequences, cookie/dialog dismissal, returned
  Playwright storage state, links/text extraction, and assertions; remaining work is
  durable session storage owned by the caller and richer visual QA.
- Prefer direct source/result URLs over brittle public-site homepage form automation.
  DONE for browser evidence planning: route/result URLs from search evidence can rewrite
  fragile fill/click command plans, collect multiple source pages, save screenshots, and
  preserve diagnostic screenshots when a site blocks automation.
- Preserve original-task search constraints in subtask web queries. PARTIAL: web-search
  now adds detected geography/language hints from the full run context, and
  directory-style doctor/clinic/profile discovery adds neutral source-family hints such as
  professional directories and hospital staff pages. Remaining work is a general
  query-planning agent/tool that can choose source families per domain without static
  heuristics.
- Rewrite or reject placeholder declared browser inputs. DONE: if a plan contains
  placeholder navigation like `URL_FROM_PREVIOUS_STEP`, the runtime rewrites it to real
  http(s) URLs extracted from upstream dependency output and prior tool evidence; if no
  real URL exists, it skips the declared browser call instead of producing a misleading
  `Invalid URL` failure. Remaining work is a typed dependency-output contract so planners
  can reference upstream URLs explicitly instead of using free-text placeholders.
- Add artifact-aware review prompts that fail when a requested file is missing or only
  represented as code/prose. PARTIAL: worker/coordinator/synthesis prompts now require a
  self-check before returning weak, irrelevant, empty, or unsupported outputs; deterministic
  typed artifact QA now covers data/source/document/image/chart/screenshot contract
  compatibility. Deterministic review gates now also reject empty discovery/candidate
  results when the subtask expected source lookup, comparison, candidates, or
  recommendations and the worker did not prove a recovery attempt or external blocker.
  Remaining work is deeper semantic inspection across every artifact type.
- Add weak browser/screenshot evidence gates. PARTIAL: workers, reviewers, and synthesis
  prompts now reject blank/loading/login/blocked/unrelated screenshots, and deterministic
  review gates force a revision when a worker describes such weak evidence. Deterministic
  PNG visual QA now rejects near-empty/loader-like screenshots before storage. Browser
  screenshot semantic QA now also checks URL/title/extracted text/link context for
  loader/blocker signals and task-specific signal mismatch before artifact storage.
  Remaining work is true OCR/vision inspection of image-only artifacts, screenshots that
  lack DOM text, and richer proof-specific scoring.
- Add full semantic artifact QA and source-strategy repair. The runtime should not merely
  check that an artifact is non-empty; it should decide whether the artifact actually
  proves the local task contract. Screenshot/file/report QA should combine OCR or vision,
  DOM/title/URL/text context, expected entities, blocker detection, and artifact-specific
  acceptance criteria. If QA fails, the agent should try an alternative source strategy,
  request an improved tool version, or report the blocker honestly instead of returning
  irrelevant proof.
- Allow the recursive universal-agent flow to delegate missing capability creation to
  Tool Builder, Tool QA, and Tool Registrar agents.

## Phase 9: Always-On Tool Runtime

Status: partially implemented.

Goal: let generated tools run not only as one-off calls, but also as durable services,
listeners, bots, webhooks, and short-lived jobs. Telegram is the first expected
always-on tool, but it must be built through the same registry, Tool Build, versioning,
QA, startup-mode, and secret-handle path as any other integration such as WhatsApp,
Slack, email, or a custom webhook.

Always-on/generated service tools are normal tools with:

- inbound event schema;
- outbound message schema;
- source user/chat/thread identity mapping;
- whitelist/policy hooks;
- conversation-thread resolution hints;
- secret handles for bot tokens/webhook secrets;
- delivery audit events;
- dry-run/test mode;
- usage/failure telemetry.

Implementation tasks:

- Add a generic service/listener tool contract and register all versions in
  `tool_modules` with `startupMode=always-on`. DONE for the core contract:
  `Tool.startService(context)` lets a TypeScript tool become an in-process service with
  lifecycle health, abort handling, internal API access, secret resolution, and logs.
- Add a service supervisor that can start, stop, restart, and healthcheck always-on
  generated modules without hardcoding provider-specific branches. PARTIAL:
  `ToolServiceSupervisor` exposes generic in-process lifecycle state, heartbeat detail,
  restart counts, audit events, Postgres-backed `tool_service_statuses`,
  Postgres-backed lifecycle logs, startup reconciliation for desired-running services,
  `/api/tool-services`, lifecycle-log SSE streaming, Channels/Tool Detail controls, and
  `startService` handle management. Remaining work is durable background process/webhook
  runners for generated modules that should survive app restarts independently of the web
  process.
- Let Tool Builds create a Telegram bot when an operator provides bot-token secret handle,
  desired behavior, whitelist policy, thread routing rules, and provider docs. PARTIAL:
  a built-in reference module `channel.telegram.bot` now demonstrates the exact generic
  service contract. It polls Telegram, forwards normalized inbound messages to the core,
  polls neutral outbox events, sends responses, and acknowledges delivery. Remaining work
  is letting Tool Builder generate/customize this class from a plain operator request,
  including whitelist rules and bot-specific behavior.
- Add `channel_identities` mapping Telegram user IDs to users. PARTIAL: the durable table
  and server-side resolver exist; the Telegram service passes Telegram `from.id` as
  `sourceUserId` and also forwards `username`/`@username` aliases as
  `sourceUserAliases`, so an operator can whitelist by numeric id or handle when Telegram
  provides it. Users can now add identities manually, and Channels can approve an ignored
  inbound event as `user-admin`; remaining work is richer role-aware approval for
  non-admin users and policy simulation.
- Add whitelist management in the admin UI. PARTIAL: Users has create/update/delete for
  members and identities, and Channels has the `Allow as Admin` shortcut for denied
  runtime events.
- Reject unknown Telegram users by default. DONE for the generic path: inbound requests
  from unmapped provider identities return `403`, and the Telegram service passes the
  Telegram user id through `sourceUserId`.
- Create runs with `channel=telegram`, `sourceChatId`, `sourceMessageId`, and requester.
  PARTIAL: HTTP run creation accepts channel/source metadata and resolves requester from
  allowed identities.
- Resolve each Telegram message to a conversation thread or create a new thread.
  PARTIAL through the generic intake path and reference Telegram service:
  `POST /api/tool-services/:name/inbound` accepts normalized always-on events, resolves
  channel identity, runs the normal conversation-thread resolver, creates a run, and
  records linked provider-neutral service events. The reference Telegram service now adds
  a `Continue thread` inline button to linked replies and maps the user's next message
  back to the internal Agentic `threadId` while preserving provider-native
  `sourceThreadId` for external forum/topic IDs. This is a systemic fix in the generic
  always-on intake contract because every provider must distinguish internal Agentic
  continuation context from provider-native chat/topic ids. Remaining work is durable
  continuation intents across restarts, richer reply-to behavior, low-confidence
  clarification UX, and moving future fixes through versioned tool change requests
  instead of direct reference-module edits.
- Support `/new`, `/continue`, reply-to, and low-confidence clarification behavior.
- Store compact thread summaries and update them after each run.
- Send final answers back to the requester through the originating always-on tool.
  PARTIAL through the provider-neutral outbox: when a run created by an always-on tool
  completes or fails, the server records an `outbound/queued` `tool_service_events`
  record linked to the run/thread/source identity with the final answer or error payload.
  `GET /api/tool-services/:name/outbox` now exposes undelivered queued responses, and
  `POST /api/tool-services/:name/outbox/:eventId/ack` records sent/failed delivery
  evidence. The reference Telegram service now uses those APIs automatically and splits
  long answers into multiple Telegram messages instead of truncating them. Remaining work
  is retry/backoff policy, delivery failure UI, artifact/file delivery, and generalized
  generated provider runner templates.
- Accept Telegram files as input artifacts and send generated artifacts back through
  Telegram. TODO as a generic always-on tool capability: download provider files through
  Telegram `getFile`, store them as input artifacts, forward artifact metadata into the
  run, then deliver output artifacts with `sendDocument`/`sendPhoto` while recording
  delivery audit evidence.
- Accept Telegram voice messages. TODO as a generic media-intake capability: download
  voice/audio, store the original audio artifact, call a speech-to-text tool selected from
  the registry, attach the transcript to the run as source text/evidence, and preserve the
  audio/transcript pair in the conversation thread.
- Build the media and artifact path as generic reusable layers, not Telegram-specific
  logic:
  - `Generic media/artifact transport`: provider-neutral contracts for inbound files,
    outbound files, MIME/type metadata, source identity, delivery status, retry/audit
    evidence, and artifact-store links.
  - `Provider adapters over generic transport`: Telegram, Slack, WhatsApp, email, webhooks,
    or future channels only translate provider APIs such as `getFile`, `sendDocument`, or
    `sendPhoto` into the neutral transport contract.
  - `Media intake layer`: normalize documents, images, video, audio, and voice messages
    into original artifacts plus extracted metadata/previews, then attach them to the
    run/thread before agent execution.
  - `Speech-to-text capability`: audio artifact -> registry-selected STT tool/model ->
    transcript artifact + transcript text in run context. This should support local tools
    such as Whisper/faster-whisper/whisper.cpp and remote transcription APIs through the
    same tool registry, secret-handle, QA, and versioning lifecycle.
- Store inbound/outbound messages/events in an auditable table.
  DONE for the provider-neutral foundation: `tool_service_events` stores
  inbound/outbound/system records with source identity, thread/run links, sanitized
  payload metadata, API access, audit events, and Channels visibility. Remaining work is
  generated service runners that write real provider events automatically. The generic
  inbound endpoint now links received events to created runs.
- Add tests for allowed user, denied user, run context mapping, continuation detection,
  and forced new-thread commands.

UI tasks:

- Channels page, or a generic always-on tools page, with installed service versions,
  health, settings, whitelist mappings, inbound/outbound message history, and tool
  telemetry. PARTIAL: Channels now lists installed `startupMode=always-on` tools with
  start/stop/restart controls, heartbeat/status cards, and recent lifecycle logs that
  update through SSE while the page is open. It also shows recent provider-neutral
  runtime events from always-on tools, including a shortcut to allow an ignored inbound
  identity as the local admin.
- Soft-refresh list pages without forcing the operator to reload. PARTIAL: the UI now
  polls the JSON endpoints in the background, fingerprints the data, skips unchanged
  renders, and defers changed renders while an input/select/textarea has focus. Run
  details and service logs still use SSE where available.
- Show always-on runtime state on tool cards. DONE: Tools cards now surface matching
  service status, desired state, and heartbeat age.
- Run Workspace source panel showing the originating channel message.
- Admin-visible conversation log for channel-originated runs.
- Conversation thread inspector with message-to-thread decision confidence and override
  controls.

## Phase 10: Outbound Actions And Notifications

Status: planned.

Goal: agents can notify a group or person when authorized.

Implementation tasks:

- Define outbound action contracts: direct message, group broadcast, scheduled reminder.
- Add `outbound_actions` table with requester, target, body, policy, status, provider
  response, and audit metadata.
- Add outbound messaging tool with dry-run mode first.
- Add permission checks for who can message whom.
- Add optional approval queue for sensitive or broad broadcasts.
- Add delivery status and retry handling.
- Add tests for approval required, permission denied, successful send, and failed send.

UI tasks:

- Outbound Actions panel in Run Workspace.
- Approval queue in Dashboard/Policies.
- Group/User pages showing recent received/sent agent messages.

## Phase 11: Federated Instance Agents

Status: planned.

Goal: agents from separate instances, families, or companies can communicate without
sharing private memory by default.

Implementation tasks:

- Define instance-agent identity and trust policy.
- Add a federated request tool with provenance, purpose, requested data, and response
  contract.
- Add allow/deny policies by remote instance/tool/capability.
- Log cross-instance requests and responses on both sides.
- Add redaction/minimization before sending context outside the group.
- Add reviewer checks for cross-instance data leakage.

UI tasks:

- Policies page for federation allowlists and scopes.
- Trace cards for outgoing and incoming inter-agent requests.
- Audit page filtered by external group/company/family interactions.
