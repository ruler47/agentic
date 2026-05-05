# Universal Agent Architecture

## Goal

The universal agent is not a giant agent that tries to keep every detail in one context.
It is a coordinator that owns the original user task, delegates narrow work to specialist
agents, reviews their outputs, and produces one final answer.

The broader product goal is a deployable assistant platform for exactly one family,
household, company, or team per running instance. Each instance should adapt to that one
group's needs over time while keeping shared group memory, user memory, tools,
credentials, channels, and permissions scoped correctly.

## Core Rule

One user request equals one concrete task.

If the request contains many unrelated goals, the coordinator should ask the user to choose
one task or split it into separate runs.

Every request also has provenance:

- instance: the family/company/team deployment;
- group profile: the one shared group context configured for this instance;
- requester: the human user;
- channel: web console, Telegram, future API/chat integrations;
- conversation thread: whether this is a new task or a follow-up/correction to a previous
  answer;
- permission scope: which memories, tools, and outbound actions are allowed.

The current implementation is still single-user in code, but future changes should keep
this one-instance/one-group provenance model in mind.

Continuation runs receive compact thread context, not the full transcript. That context
includes summary, accepted facts, rejected attempts, open questions, and recent artifact
metadata such as filename, MIME type, URL, content preview, and QA status. Agents should
reuse these prior artifacts when they satisfy a follow-up request. They should reacquire
data only when the prior artifact is stale, missing, insufficient, or explicitly rejected.

## Capability Principle

The system should grow through reusable capabilities, not private case patches. A run may
need a chart, a PDF, a browser proof, an API client, or an always-on bot/webhook/listener,
but the core runtime should not hardcode a special pipeline for that domain. Instead:

- agents inspect the tool registry for existing capability contracts;
- agents call a tool through its schema when the capability exists;
- agents request a new generic TypeScript tool when the capability is missing;
- agents request a new version when an existing tool is close but insufficient;
- every new or revised tool must include tests, documentation, QA evidence, and review;
- raw credentials and provider-specific secrets are stored only as secret handles and
  tool settings, never in prompts, memory, source, artifacts, or traces.

A universal agent should be able to sit anywhere in the call chain. It receives a local
task, decides whether to answer or delegate, optionally requests tools, self-checks its
result against the task contract, and returns upward without needing to know whether its
caller is a human or another agent.

The first runtime slice of that model is event-backed call frames. Worker and reviewer
spans persist a structured `callFrame` payload with local task, output contract, caller
span, dependencies, model tier, status, and output summary. Before either span completes,
the runtime emits `agent-self-check-completed` so the trace records whether that agent
believed its own return value was ready, which artifacts/evidence were checked, and which
limitations remained.

## Product Domain Model

See [Instance Context And Personalized Assistant Model](modules/instance-context.md) for the
target one-group-per-instance product model.

High-level entities:

- `Instance`: isolated deployment boundary for one family/company/team.
- `GroupProfile`: the single shared group context configured for the instance.
- `User`: person with roles, preferences, private memory, and channel identities.
- `ChannelIdentity`: Telegram/web/API identity mapped to a user.
- `ConversationThread`: continuity wrapper around one initial task and follow-up runs.
- `Memory`: scoped as global, group, user, or run.
- `Tool`: typed TypeScript capability with scope, credentials, health, and audit policy.
- `Run`: one concrete task with requester/channel/instance provenance.
- `OutboundAction`: auditable action such as sending a Telegram message or group alert.

## Components

### Coordinator

Owns the user-facing result.

Responsibilities:

- Understand the task.
- Decide direct vs delegated mode.
- Select relevant skill-memory entries.
- Create a subtask plan.
- Dispatch workers as a dependency-aware DAG.
- Dispatch reviewers after each worker finishes, so independent reviews can run while
  other branches continue.
- Synthesize final answer.
- Preserve generated artifacts and cite their exact URLs.
- Store reusable lessons in skill memory.
- Respect instance/user/channel context and permission scope.
- Separate personal answers from outbound group/user notifications.

### Planner

Creates machine-readable subtasks for delegated mode.

Each subtask can declare:

- `id`, role, title, prompt, expected output, and review criteria.
- `dependsOn` for upstream worker dependencies.
- `requiredTools` such as `web-search`, `browser-operate`, `file-read`, or
  `browser-screenshot`.
- `toolInputs` for explicit tool calls.
- `requiredArtifacts` for real output files such as screenshots, charts, images,
  reports, datasets, or source bundles.

Independent subtasks run in parallel. Dependent subtasks wait until their upstream worker
outputs are reviewed.

### Worker Agent

Owns exactly one subtask.

Examples:

- Research population of Spanish cities.
- Research airport access and Ukrainian community signals.
- Implement chess variant move logic.
- Build UI for a crypto-themed chess game.
- Review generated code for correctness.

Worker context should be small:

- Original task summary.
- The worker's subtask.
- Relevant memory entries.
- Expected output format.
- Review criteria.
- Dependency outputs and artifact URLs, when the worker depends on earlier work.
- Tool evidence, if runtime tools were executed before the worker writes its result.
- Allowed memory/tool/action scope for the requester and configured group.

Declared tool inputs are treated as proposed execution hints, not trusted execution facts.
For browser tools, the runtime rejects placeholder navigation such as
`URL_FROM_PREVIOUS_STEP`; when upstream dependency outputs or prior tool evidence contain
concrete source URLs, it rewrites the browser command plan to those URLs, otherwise it
records the declared input as not runnable instead of wasting the run on an `Invalid URL`
tool call.

### Reviewer Agent

Checks one worker result.

Review focus:

- Unsupported claims.
- Missing evidence.
- Empty discovery results that are presented as success when the subtask expected
  candidates, source lookup, comparison, or recommendations.
- Incorrect assumptions.
- Incomplete code or tests.
- Contradictions with original task.
- Missing required artifacts or placeholder proof links.
- Whether screenshot/chart/file artifacts actually satisfy the subtask contract.
- Whether memory use, tool use, and outbound actions respect scope and permissions.

If a review fails, the worker gets one bounded revision pass before synthesis.

### Tool Registry

Tools are TypeScript modules with:

- name and version;
- changelog and replacement relationship between versions;
- capabilities;
- input/output schemas;
- optional healthcheck;
- a `run(input)` implementation;
- declared storage requirements and tool-owned migrations, when persistent data is
  needed;
- required configuration keys, provider URLs, limits, and feature flags;
- required secret handles for credentials;
- success/failure telemetry;
- linked issues/rework tickets and QA reports.

The runtime asks for capabilities through the registry instead of embedding one-off
logic in the agent. Built-in tools are synced into `tool_modules` when Postgres is
configured.

The target architecture is out-of-tree tools. A mature tool should be a portable module
or service with a manifest, schemas, docs, tests, QA evidence, version history, settings
schema, secret-handle requirements, and optional storage migrations. The Agentic core
should not need to import private tool internals. It should load or call tools through a
generic runner by manifest reference, source bundle, package reference, or OCI/container
image. On-demand tools run as bounded jobs; always-on tools run as supervised services;
high-load tools can scale to several worker processes or containers behind the same
abstract input/output contract.

The first code-level slice of this target is `ToolPackageManifest`, a portable
import/export contract for source bundles, OCI images, external packages, and local-path
development tools. Future registry entries should be able to point at these manifests
instead of only compiled files under `src/tools/generated`. Generated service providers
now emit a local-path manifest with schemas, docs, examples, settings, secret handles,
storage, and startup mode. The active generated module and each version row now persist
that manifest in Postgres, so registry metadata survives restart and can later be
exported/imported. Executing manifests through an external runner is still roadmap work.

The second code-level slice is a provider-neutral always-on service generator. Tool
Builder can now create TypeScript modules with `startupMode=always-on`, `startService`,
lifecycle health, normalized event recording, and focused tests. The build contract now
also includes a neutral `ToolIntegrationSpec` for API/service-like requests: mode,
provider hint, inbound/outbound event shape, secret handles, settings schema, storage
contract, examples, docs, and QA requirements are derived before the provider writes
source. These generated service modules are still in-process today, but their contract is
intentionally portable to a future external runner or container.

This means built-in reference tools are temporary conveniences, not the final integration
shape. A fix to a generated, built-in, or always-on tool should eventually follow one
lifecycle: change request, new version, code review, behavior QA, promotion, and
reload/restart. Direct source edits are operator hotfixes while that lifecycle is still
incomplete, and should be treated as technical debt rather than the product model.

Initial tools include:

- `web.search` through SearXNG.
- `file.read` and `file.write` inside the workspace sandbox.
- `chart.generate` for data-agnostic SVG chart artifacts.
- `browser.operate` for reusable Playwright browser automation.

Future tools should be instance/user scope-aware. A tool can be globally available while
its credentials, settings, provider choices, and usage policy are specific to this
instance or to allowed user roles. Operators should be able to open a tool, inspect every
version, see what changed, see success/failure counts, and create a rework ticket that
passes the relevant run/span/artifact context to a Tool Builder agent.

### Tool-Owned Storage And Migrations

Tools now have the start of a first-class runtime/storage contract. The application has
Postgres-backed stores, central migrations, persistent tool metadata/build requests, a
`ToolExecutionContext` injected into registry calls, and a `tool_migrations` catalog for
versioned migration evidence. Generated tools still must not create ad hoc database pools
or run arbitrary SQL from `DATABASE_URL`.

The target contract is:

- a tool version can declare storage needs: schema namespace, tables, indexes,
  constraints, retention policy, backup/export expectations, and required database
  permissions. Generated service tools use the same `tool-db:read` / `tool-db:write`
  permission names that the scoped runtime DB client enforces;
- migrations are generated as TypeScript/SQL assets linked to the tool version, not hidden
  inside `run(input)`;
- Tool QA runs those migrations in an isolated database, proves they are idempotent, and
  tests rollback/repair behavior where practical;
- the Tool Registrar applies migrations only after QA/review passes and records the
  applied migration version in `tool_migrations`; DONE for the metadata/API/audit
  contract, and generated registrations now record pending migration manifests with
  checksum plus QA evidence using an idempotent `(tool, version, migration)` key; pending
  for isolated execution and transactional promotion;
- tool runtime receives a constrained `ToolExecutionContext` with secret resolver, audit
  writer, logger, provenance, cancellation signal, and a portable
  `artifacts.saveGenerated(...)` writer for output files. When Postgres is configured,
  tools with a storage contract receive a scoped runtime DB client. The client requires
  explicit read/write permissions, accepts only a single runtime statement, and rejects
  DDL, transactions, session changes, deletes, and maintenance operations;
- destructive database operations are explicit capabilities, such as `data.delete`,
  `records.purge`, or `tool-data.compact`, with preview/dry-run output, policy checks,
  approval when risk is high, and audit records;
- a Trace Lab or Tool Detail "create bug/rework request" can include database symptoms or
  maintenance requests, but the builder must turn them into an auditable admin operation
  or versioned migration, not a one-off SQL command.

This keeps tool data portable and reviewable: a future Telegram adapter, CRM API adapter,
or domain-specific data tool can own storage while still being testable, versioned, and
safe to promote.

### Browser Operation

`browser.operate` is domain-neutral. It executes typed commands such as navigate, click,
fill, select, wait, extract text/links, assert text/URL, dismiss dialogs, and screenshot.

It also accepts screenshot-style `{ url, label?, filename?, fullPage? }` input and expands
that into navigate/extract/screenshot commands. If a command fails after the page opens,
it attempts to return a diagnostic screenshot so the final answer can prove blockers such
as CAPTCHA or login walls.

Higher-level agents should prefer direct source/result URLs over brittle homepage form
automation when search evidence already provides a stable URL.

### Artifacts

Artifacts are first-class run outputs. The web server stores input and output files under
the configured artifact root and exposes them through:

```text
GET /api/runs/:runId/artifacts/:artifactId
```

The final answer should cite exact artifact URLs from `result.artifacts`. The UI renders
preview cards for image artifacts.

### Tool Builder Flow

When a required capability is missing, the runtime can create a Tool Build Request.
When an existing capability is insufficient, the runtime can create a Tool Rework Request
for a new version of the same tool. Rework must not silently overwrite the old version:
the new module version needs its own changelog, tests, QA report, and promotion decision.

The current provider-backed flow:

```text
missing capability
  -> create Tool Build Request with TypeScript module contract
  -> builder writes source and tests
  -> QA runs targeted tests and build checks in an isolated workspace
  -> code and behavior review gates inspect contract safety and QA evidence
  -> optional LLM code/behavior reviewers inspect source previews and behavior evidence
  -> registrar validates metadata and registers the generated module
  -> runtime reloads generated tools
  -> original run can use the new tool
```

The guarded LLM-backed provider can build unknown/custom capability families after
deterministic providers decline the request. It is still not trusted runtime code
execution: the model may only return the requested TypeScript module path and test path,
must keep credentials behind secret handles, and the output still goes through isolated
generated-tool tests, isolated build, promotion tests, promotion build, deterministic
code/behavior review gates, optional LLM review gates, metadata registration, and runtime
reload. Disable this fallback with `TOOL_BUILD_LLM_PROVIDER=disabled` when an instance
should only use deterministic providers. Enable `TOOL_BUILD_LLM_REVIEW=enabled` when the
instance should add LLM code/behavior reviewers before promotion.

The registry also has a portable package-manifest import/export layer. Generated tools
can expose `agentic.tool-package.v1` manifests through the API, and operators can import
the same manifest shape back into the registry. Local-path packages remain compatible
with the current compiled-module loader; source-bundle, OCI-image, and external-package
references are stored as disabled package metadata until the generic out-of-process
runner exists.

The target flow also supports admin-provided API documentation and credentials. The agent
should read the docs, propose a reusable TypeScript module contract, build tests, run QA,
register the tool, and store credentials through secret handles rather than prompt text.
This same flow should be used for API clients, bots, webhooks, artifact renderers,
browser helpers, data acquisition modules, and any other capability family.

### Model Tiers

Each LLM step receives a selected model tier based on task risk and activity type.
Settings are stored in Postgres when configured and can be edited from the web console.
Tier settings must support local OpenAI-compatible endpoints and remote providers such as
the OpenAI API. Remote API keys should be stored as secret handles.

Typical routing:

- cheaper tiers for classification, planning, and low-risk synthesis;
- stronger tiers for reviews, high-risk reasoning, and complex work;
- escalation when a configured model fails or returns unusable output.

### Skill Memory

Long-term shared memory for reusable operational knowledge.

Stores:

- Title.
- Tags.
- Short summary.
- Reusable procedure.
- Creation date.

It should not store whole task transcripts. It stores compressed lessons that future agents
can scan before starting.

Memory must be scoped:

- `global`: reusable product/runtime lessons.
- `group`: shared facts about this instance's family/company/team.
- `user`: personal preferences and history.
- `run`: temporary context for one task.

Agents should retrieve the minimum useful memory for the current requester and configured
group.
They must not read another user's private memory unless the task and policy allow it.

### Long-Running Tool Modules

The web console is the current built-in request surface. External surfaces such as
Telegram, WhatsApp, Slack, email, or custom webhooks should be implemented as ordinary
generated tool modules with a startup mode, not as special runtime branches. Telegram is
the first expected always-on module, but it should use the same Tool Build, registry,
versioning, credential, QA, and policy workflow as any other tool.

Startup modes:

- `on-demand`: the agent invokes the tool only for one call.
- `always-on`: the module is a service/listener/bot/webhook receiver with health status,
  logs, and start/stop/restart lifecycle.
- `ephemeral`: the module runs a short-lived job and shuts down after completion.

Always-on request intake behavior:

- accept requests only from whitelisted provider identities;
- map provider user IDs to instance users;
- decide whether each message starts a new conversation thread or continues an existing
  one;
- create normal runs with source channel metadata;
- show channel-originated runs in the admin console;
- send answers back to the requester;
- support auditable outbound messages to a person or group when permitted.

A user request like "create a Telegram bot with this token, accept only this account, and
keep it running" should become an always-on tool build request. The generated module owns
the provider-specific bot/webhook behavior while the core system only sees normal run
creation, conversation threading, audit events, and tool lifecycle status.

The current implementation includes a generic in-process `ToolServiceSupervisor` for
`startupMode=always-on` tools. It lists service tools, starts/stops/restarts them,
refreshes health through their registered healthcheck, records audit events, persists
lifecycle state in `tool_service_statuses` when Postgres is configured, writes lifecycle
logs to `tool_service_logs`, reconciles services whose desired state is `running` on app
startup, streams new lifecycle records over `/api/tool-services/logs/events`, and exposes
the lifecycle through `/api/tool-services` plus the Channels and Tool Detail pages. It
can also run tools that implement `startService(context)`: the supervisor injects the
internal API base URL, secret resolver, abort signal, and logger, then keeps the returned
service handle for healthchecks and shutdown. Shutdown stops active handles without
clearing the persisted desired running state, so app startup can reconcile services that
should still be running. It does not yet spawn durable background processes or own
webhook routing; those must be added as generic runners behind the same tool contract.

`GenericServiceToolBuildProvider` is the first generated-tool builder for this shape. It
creates a reusable service bridge rather than a provider-specific hack: generated modules
record neutral inbound/outbound/system events, expose health through `startService`, and
publish their integration spec through docs, settings, examples, storage metadata, and
runtime status. Provider-specific generated tools can build on this contract by
translating provider APIs into the neutral event model.

Always-on tools can record provider-neutral runtime events in `tool_service_events`.
Those events cover inbound messages, outbound deliveries, ignored/denied events, and
system notices with optional source identity, thread, run, and sanitized payload metadata.
This keeps Telegram, Slack, WhatsApp, email, queue listeners, and custom webhooks on the
same event model.

The generic service intake endpoint, `POST /api/tool-services/:name/inbound`, lets an
always-on module hand a normalized inbound event to the core. The core redacts payload
metadata, records the inbound event, resolves the requester through `channel_identities`,
uses the normal conversation-thread resolver, creates a standard run, and records a
linked queued event. This is the provider-neutral bridge for future Telegram/Slack/webhook
tools.

The response path is provider-neutral as well. When a run that originated from an
always-on tool reaches a terminal success or failure, the server records an
`outbound/queued` `tool_service_events` record containing the final answer or error
payload plus source identity links. Provider-specific generated services own the actual
delivery step: they poll `GET /api/tool-services/:name/outbox`, send the response through
their provider, then call `POST /api/tool-services/:name/outbox/:eventId/ack` to append a
`sent` or `failed` evidence event and keep the queued outbox from being delivered again.

`channel.telegram.bot` is the first built-in reference implementation of this contract.
It is still an ordinary tool: it resolves a token through the secret-handle registry,
polls Telegram, forwards source user/chat/message ids to the generic inbound endpoint,
delivers neutral outbox events back through Telegram, and records sent/failed
acknowledgements. A generated Telegram replacement should follow the same contract rather
than adding Telegram-specific branches to the core runtime.

Thread resolution should prefer provider metadata such as reply-to messages, chat/thread
IDs, forum topics, or webhook thread IDs, then use a bounded classifier over recent
compact thread summaries. The
classifier should return `new_task`, `continuation`, `clarification`, or `correction`
with confidence and reason. Low-confidence cases can ask the user a short clarification
instead of executing against the wrong context.

### Outbound Actions

Future agents should be able to act, not only answer.

Examples:

- notify a family group;
- send one person a message;
- schedule a reminder;
- ask another instance's agent for information.

Outbound actions require explicit tool contracts, permission checks, audit records, and
delivery status. Sensitive outbound actions should support preview/approval before send.

### Inter-Instance Agents

Agents from different families, companies, or teams may eventually communicate. Treat this
as an external integration with provenance and policy, not as shared memory. Cross-instance
requests should carry minimal context and be auditable on both sides.

## Execution Flow

```text
User gives one task
  |
  v
Resolve instance/user/channel context
  |
  v
Resolve conversation thread or create a new one
  |
  v
Load compact thread context when this is a continuation
  |
  v
Coordinator searches skill memory
  |
  v
Coordinator classifies complexity
  |
  +-- direct mode -----> Coordinator answers -> store lesson
  |
  +-- delegated mode --> Planner creates subtasks
                        |
                        v
                      Independent workers run in parallel
                        |
                        v
                      Reviewers start as each worker finishes
                        |
                        v
                      Dependent workers receive reviewed upstream context
                        |
                        v
                      Coordinator synthesizes
                        |
                        v
                      Store reusable lesson
```

Tool and artifact flow can happen inside worker execution:

```text
Worker needs current facts or proof
  -> registry finds web/browser/file/chart tool
  -> runtime executes tool
  -> trace records tool evidence
  -> artifact store persists any returned files
  -> worker answers from evidence and artifact URLs
  -> reviewer checks evidence and artifacts
```

Channel and outbound flow:

```text
Telegram/Web/API request
  -> verify channel identity and whitelist
  -> resolve new task versus continuation thread
  -> resolve instance, requester, permissions
  -> attach threadId/parentRunId and compact thread context
  -> create run
  -> agent completes task
  -> if answer only: respond to requester
  -> if outbound action: check policy, audit, optionally request approval, send
```

## Delegation Heuristics

Use direct mode when:

- The task is narrow.
- No current facts are required.
- No codebase inspection is required.
- The answer can be produced with high confidence in one context.

Use delegated mode when:

- The task has multiple domains.
- Research and implementation are both needed.
- The task may consume a large amount of context.
- Independent checks would materially improve quality.
- The task requires both creation and review.
- The task needs current web evidence, screenshots, files, charts, PDFs, code changes, or
  manual-style browser verification.

Use tool creation when:

- A required capability is missing from the registry.
- The need is reusable beyond a single prompt.
- A typed TypeScript module with tests can satisfy the capability safely.

Do not create one-off hardcoded tools for a single data value or single website outcome.
Prefer reusable modules with schemas and capability metadata.

Use scoped memory when:

- the request depends on family/company preferences;
- a user asks for personalized output;
- a request references another member of the group;
- a repeated task could be improved by prior decisions.

Use outbound actions when:

- the user explicitly asks to notify, remind, forward, schedule, or broadcast;
- the requester has permission for the target recipient/group;
- the message body and recipient are clear enough to audit.

## Web Console

The web console is the operator and admin surface for runs, the group profile, users, tools, and
channels.

It provides:

- task submission with file attachments;
- requester/channel context and group profile visibility;
- thread visibility and continue-after-answer flow;
- live run status through SSE with polling fallback;
- an execution map with parent/dependency arrows;
- collapsible trace cards with actor, status, activity, duration, and tool evidence;
- answer and artifact panels;
- group profile/user/channel administration;
- scoped memory browsing and editing;
- system inventory for tools, memory, build requests, and model tiers;
- outbound action history and future approval queue.

Future top-level navigation:

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

## Example: Spanish Cities

Task:

> Top 5 Spanish cities by population, sorted by distance to sea.

Likely direct or small delegated task.

Task:

> Find Spanish cities considering population, developed IT sector, Ukrainian community,
> airport access, and distance to sea.

Delegated plan:

- Worker A: population and geography.
- Worker B: IT sector signals.
- Worker C: Ukrainian community and immigration signals.
- Worker D: airport connectivity.
- Reviewer: check comparability and missing evidence.
- Coordinator: rank cities with assumptions.

## Example: Crypto Chess

Task:

> Build a chess variant where piece importance maps to top crypto coins by market cap.

Delegated plan:

- Worker A: crypto ranking data policy and mapping.
- Worker B: chess rules and engine choice.
- Worker C: TypeScript implementation.
- Worker D: UI/game design.
- Reviewer A: code review.
- Reviewer B: gameplay consistency review.
- Coordinator: integrate and explain.

## Example: Flight Search With Proof

Task:

> Find Istanbul to Malaga tickets for May 2026 and attach proof screenshots.

Delegated plan:

- Worker A: search current web sources and identify stable flight route URLs.
- Runtime: use `web.search`, then `browser.operate` on direct source/result URLs.
- Runtime: save screenshot artifacts from the source page or blocker page.
- Reviewer A: verify prices, dates, airlines, and screenshot relevance.
- Worker B: synthesize the Russian answer from reviewed evidence and artifacts.
- Reviewer B: check that the final answer cites real artifact URLs.

## Example: Family Telegram Reminder

Task from Telegram:

> Remind everyone in the family chat tomorrow at 18:00 to bring passports.

Delegated plan:

- Runtime: verify Telegram user is whitelisted and has family broadcast permission.
- Runtime: resolve whether the message is a new reminder thread or a follow-up to an
  existing thread.
- Worker A: interpret reminder time using family time zone and channel context.
- Worker B: create an outbound Telegram reminder action with target group and message.
- Reviewer A: check recipient, time, message body, and permission scope.
- Runtime: store audit event and schedule/send through Telegram tool.

## Example: API Tool Onboarding

Task from admin:

> Here is our CRM API documentation and access key. Create a module so agents can look up
> customers by email and create support notes.

Delegated plan:

- Worker A: read docs and propose a reusable TypeScript tool contract.
- Tool Builder: implement the CRM module with schema and secret-handle credentials.
- Tool QA: run tests against mocked docs examples and a safe smoke call if allowed.
- Tool Registrar: register the tool for this instance.
- Reviewer: verify no credentials were stored in prompts, memory, or artifacts.
