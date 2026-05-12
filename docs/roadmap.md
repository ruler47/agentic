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

## Approved Direction: Retrospective And Work Ledger

### Foundation slice (DONE)

The domain layer for the Work / Evidence / Run-Retrospective ledgers ships as a
foundation-only slice in `src/work-ledger/`. It defines `WorkLedgerItem`,
`WorkLedgerStore`, `EvidenceRecord`, `EvidenceLedgerStore`,
`RunRetrospectiveRecord`, and `RunRetrospectiveStore`; provides deterministic
work-key builders and a pure `decideWorkReuse` decision function returning
`reuse_completed` / `wait_for_inflight` / `create_revalidation` /
`create_new_attempt` / `blocked_by_recent_failure`; ships in-memory and Postgres
implementations plus durable migrations; recursively redacts secret-shaped metadata;
and exposes narrow operator/runtime HTTP endpoints
(`/api/work-ledger`, `/api/evidence-ledger`, `/api/run-retrospectives`) with audit
events and 503 fall-through when stores are not configured.

### Runtime integration slice — Phase 1 (DONE)

`UniversalAgent` now consults the ledgers when their stores are wired through
`agent.run()` options or, equivalently, through the web server's executeRun. A
per-run `RuntimeLedgerCoordinator`
([src/work-ledger/runtimeLedgerCoordinator.ts](../src/work-ledger/runtimeLedgerCoordinator.ts))
claims work before web-search, market time-series, inferred API JSON tools,
declared tool inputs, and screenshot/artifact tool calls through the shared
`WorkLedgerClaimCoordinator`. Shared tool paths use a single
`runLedgeredToolOperation` helper for claim -> execute -> evidence -> complete/fail,
short-circuit on `reuse_completed` where a text/evidence summary is sufficient,
record `search_result` / `api_response` / `browser_snapshot` / `screenshot` /
`artifact` / `limitation` evidence, and write a deterministic, non-LLM retrospective
draft at run end. Trace events
(`work-ledger-claim-created`, `work-ledger-revalidation-created`,
`work-ledger-blocked`, `work-ledger-reused`, `work-ledger-waiting-existing`,
`evidence-ledger-recorded`, `run-retrospective-proposed`) flow through the
existing event sink so the run trace renders ledger activity inline. When no
stores are wired the entire path short-circuits and the runtime keeps its
previous behaviour.

Phase 1 limitations to address in later slices:

- Dedicated URL visit tools, file read/write tools, and some specialized future tool-use
  call sites are not yet covered. Web search, market time-series, inferred API JSON
  tools, declared tool inputs, and artifact-producing tools are covered.
- React console UX for the new ledgers is now available at `/ledger`. It supports run,
  thread, and work-key scopes; shows Work Ledger claims, Evidence Ledger records, and
  Run Retrospective proposals together; summarizes active claims, reusable results, weak
  evidence, duplicate-work signals, and review backlog; lets operators create/test manual
  claims through the same endpoint child agents use; provides an attention queue for
  failed/stale/running claims, weak evidence, and proposed retrospectives; includes a
  selected-work inspector with linked evidence and manual evidence capture; and links Run
  Workspace directly into the scoped ledger view. Remaining UX work: richer thread-level
  rollups, proposal-to-memory/tool-ticket actions, and graph overlays for ledger
  relationships.
- Distributed claim ownership across replicas is not enforced at the store layer.
- The retrospective draft is rule-based; an LLM-driven retrospective with
  proposed memory/tool/policy/prompt actions is a separate later slice.

### Domain claim coordinator (DONE)

A pure domain helper for the recursive-agent flows that still need ledger
integration ships in
[src/work-ledger/workLedgerClaimCoordinator.ts](../src/work-ledger/workLedgerClaimCoordinator.ts).
`createWorkLedgerClaimCoordinator(deps)` returns an object with
`claimWork`, `getDecision` (dry-run), `completeWork`, `failWork`, `blockWork`,
`attachEvidence`, and `attachArtifact`. It computes deterministic work keys from
agent intent (`searchQuery` / `url` / `apiProvider+endpoint` / `tool+input` /
`artifactKind+descriptor` / `freeform`), maps the persisted `WorkLedgerKind` enum
to higher-level coordinator kinds (`browser_screenshot`, `file_read`,
`file_write` collapse to existing persisted kinds so no migration is needed),
and returns one of `reuse_completed`, `wait_for_active`, `created_new`,
`revalidate`, or `blocked`. Stale-window and weak-confidence thresholds let
callers override `reuse_completed` to `revalidate`. Failure and block paths
optionally write paired `limitation` evidence and link it back to the work item.
The helper is intentionally runtime-agnostic — it does not depend on the agent
runtime, HTTP, or audit stores. The first runtime integration is now wired through
`RuntimeLedgerCoordinator`, while future call sites can reuse the same helper.

### Claim API and richer retrospective slice (DONE)

The Nest API now exposes the same domain claim coordinator through
`POST /api/work-ledger/claim`. Runtime and future child-agent callers can submit
`runId`, `ownerSpanId`, `kind`, `taskSummary`, `requestedBy`, and either `workKey` or
structured `workKeyParts`, then receive a reusable decision
(`created_new`, `reuse_completed`, `wait_for_active`, `revalidate`, or `blocked`) plus
any reusable evidence. Secret-shaped metadata is redacted before storage and audit.

Run retrospectives are also richer: the deterministic draft records suspected root
causes, failed work item ids, duplicated-work signals, and proposed tool-investigation /
policy / prompt follow-ups when the runtime saw weak tools, missing capabilities,
external blockers, repeated work, or failed ledger items. This is still a proposed
review input, not an automatic memory write.



Recursive agents need shared operational memory for a *task*, not only long-term memory
for facts. The next recursive-agent design must add three durable layers:

- **Run Retrospective Store**: after every completed, failed, cancelled, or tool-waiting
  run, the system writes a structured reflection: what worked, what failed, suspected
  root causes, duplicated work, weak tools, missing capabilities, useful evidence,
  model/agent failures, and proposed follow-up actions. Retrospectives do not directly
  become accepted memory. They create reviewable proposals: memory candidates, tool
  investigations, prompt/policy improvement tickets, limitation records, or model-tier
  tuning suggestions.
- **Thread / Run Work Ledger**: every thread and run keeps machine-readable work state,
  not only a human summary. The ledger tracks planned work, claimed work, running work,
  completed work, failed work, stale work, open questions, accepted/rejected facts,
  source URLs, search queries, API calls, screenshots, datasets, and generated files.
  Agents read this ledger before doing external work so they can reuse fresh evidence or
  wait for a sibling branch instead of repeating the same search, scrape, screenshot, or
  API call.
- **Evidence Ledger**: artifacts and source observations are normalized as evidence with
  owner span, source URL/provider, timestamp, freshness, QA status, confidence,
  limitations, and dedupe keys. Final answers, retries, and follow-up runs should cite
  evidence from this ledger whenever possible.

The dedupe protocol should be explicit:

```text
agent wants to do work
  -> computes a work key (query/url/API params/artifact intent/tool+input)
  -> checks Thread/Run Work Ledger
  -> if completed and fresh: reuse evidence
  -> if running/claimed by another branch: wait or subscribe
  -> if failed/stale/insufficient: create a new versioned attempt with reason
  -> record result and retrospective signals
```

This is also the foundation for safe parallelism: child agents can remain local and
independent while still sharing a small coordination surface that prevents duplicate work.

The universal agent should treat a **council of agents** as one available strategy, not as
a separate hardcoded orchestrator. For high-risk, ambiguous, multi-domain, or expensive
tasks, an agent may call a council planner that asks several agents, possibly with
different model tiers or providers, to propose plans or critique a solution. A synthesis
agent merges those proposals into a DAG and the Work Ledger keeps the council branches
from doing the same evidence-gathering twice.

The Tool Builder should be framed as a general **Technical Capability Builder**, not an
API-only builder. The agent should classify technical instructions/documentation into the
needed capability family first: API client, SDK wrapper, CLI adapter, browser workflow,
webhook/listener, always-on messaging service, file/media processor, protocol adapter,
database/schema workflow, or another reusable tool family. API docs are only one input
format among OpenAPI, Markdown/PDF docs, SDK docs, CLI docs, webhook docs, examples, and
plain operator instructions.

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

### Capability failure example: generated Telegram bot from scratch

A manual Tool Build E2E for "create a Telegram bot from scratch" found three generic
Tool Builder issues:

- Source-bundle always-on packages must carry the same service lifecycle contract as
  in-repo tools. Package-local `src/tools/tool.ts` now includes `ToolServiceContext`,
  `ToolServiceHandle`, and optional `startService`.
- The local HTTP source-bundle runner cannot assume `dist/runtime/server.js` is already
  present. It now auto-builds a package workspace with `npm run build` when the runtime
  entrypoint is missing, then reloads the tool into the runtime registry.
- Tool Build requests must not echo raw credential material when an operator pastes a
  token into the high-level description. Inline credentials detected in `reason`,
  `taskSummary`, `feedback`, or `credentialNotes` are redacted from queued request text
  and stored through secret handles when a secret store is configured.
- A generated always-on "service bridge" is not enough when the request explicitly asks
  for provider behavior such as Telegram Bot API `getUpdates` polling and `sendMessage`
  delivery. Deterministic behavior review now rejects those generic bridges unless QA
  evidence proves provider-specific behavior. The remaining work is a real provider
  adapter generator/LLM repair loop that can implement and test provider APIs behind the
  same portable tool contract.

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

### Capability failure example: `run_1778320304262_oanslhzc` — flights hardcode bleeds into laptop research

A run for "find me the best laptop for programming, gaming, LLMs, travel; budget 2500
EUR" produced a `discovery-1-google-com-www-google-com-travel-flights-screenshot.png`
artifact attached to a "Scenario Mapping & User Clarification" subtask. The user
correctly flagged the screenshot as "absolutely irrelevant - looks like a leak from a
previous flights run."

Root cause is **not** memory leakage or model hallucination. It is a deterministic
collision of two domain-specific hardcodes inside the supposedly universal agent:

1. `buildSearchQueries` in `src/agents/universalAgent.ts` (around line 4024) runs the
   regex `/\b[A-Z]{3}\b/g` over `subtask.prompt` and treats every three-letter uppercase
   token as an IATA code. In a laptop subtask the prompts contain `GPU`, `RTX`, `RAM`,
   `LLM`, `CPU`, `EUR`, `SSD`. With two or more matches the function silently appends a
   second parallel web.search query "X Y Z flights Google Flights Skyscanner Kayak".
   This produced real merged queries like
   `... | GPU RTX RAM flights Google Flights Skyscanner Kayak`. Results from the
   parasitic query (google.com/travel/flights, skyscanner.com, kayak.com) were merged
   into the subtask's evidence text via `mergeToolResults`.
2. `scoreArtifactUrl` (around line 4342) assigns
   `google.com/travel/flights -> 120` as the highest score in the entire system, higher
   than any other URL. When `selectBestUrlsForArtifact` sorts the URL pool by this
   scorer, the parasitic flights URL beats every relevant result (`nngroup.com`,
   `dl.acm.org`, `alibaba.com`, `amazon.es`) which all score 0. Browser discovery
   navigates to it, captures a screenshot, attaches it to the subtask as evidence.
   Semantic QA only catches it on the second worker, by which point the artifact is
   already visible to the operator.

The same shape applies to medical/doctor tasks via similar hardcoded hosts (doctolib,
jameda, topdoctors) and `shouldCollectBrowserDiscovery` (line 3891) regex
(`doctor|clinic|specialist|...`). Universal runtime currently contains at least two
embedded domain funnels (flights, medical) and any task whose text accidentally trips
their regex inherits irrelevant evidence.

Fix is structural and tracked as Phase 12. Quick gate (Slice A) is enough to remove the
acute regression; Slices B-D remove the underlying anti-pattern.

## Progress Snapshot

This is a product/architecture estimate, not a ticket counter.

- Overall target platform: about 57-62% complete. The core run orchestration, traces,
  artifacts, memory lifecycle, tool registry, and model tier plumbing exist; autonomous
  recursive agents, broad generated tool families, always-on tool supervision, and policy
  enforcement still remain.
- Current coordinator prototype: about 74% complete. It can delegate, review, synthesize,
  call tools, create artifacts, and persist runs, but it is still centrally planned rather
  than a fully recursive society of agents.
- Operator UI: about 63% complete. The shell, Dashboard, Runs, Conversations, Trace Lab,
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
  memories stay `proposed` even if the model requested `accepted`. The review queue now
  compares proposed memories against accepted/proposed memories in the same exact scope
  and warns about likely duplicates or same-title conflicts before operator accept. A
  separate LLM memory-specialist reviewer remains a future upgrade for deeper semantic
  duplication, privacy-risk explanation, and evidence grading.
- Memory policy simulation currently uses the selected run context and deterministic
  rules. It is not yet connected to editable role/policy records or audit decisions.

## Phase 1.5: Tool Investigation Tickets

Status: partially implemented.

A Tool Investigation Ticket is a durable, reviewable record of a failure context that an
operator (or, eventually, an agent) wants to study before patching anything. It is the
layer between "something looks wrong in Trace Lab / Tools / Artifacts" and "create a Tool
Build / rework request".

How it differs from a Tool Build Request:

- A Tool Build Request is a contract for *building or rebuilding* a tool. It carries
  builder/QA/registrar lifecycle, schemas, generated module/test paths, and registration
  evidence.
- A Tool Investigation Ticket is a contract for *understanding the failure first*. It
  preserves run/span/artifact context, operator commentary, and matched-tool context so
  the rebuild request that comes out of it is targeted instead of guessed.
- Multiple investigations can feed one Tool Build Request, and one investigation can be
  closed without ever becoming a build request (e.g. when the root cause is an external
  blocker, prompt issue, or memory note).

Implementation tasks:

- Add `tool_investigations` Postgres table and an in-memory store fallback. DONE.
- Add `GET/POST/PATCH /api/tool-investigations` and `GET /api/tool-investigations/:id`. DONE.
- Sanitize secret-shaped keys (secret/token/password/apiKey/credential/authorization)
  inside the stored context bundle so investigation evidence cannot leak credentials. DONE.
- Replace the silent "Create tool request / bug" inline form in the Trace Lab span
  inspector with a modal that previews the attached context, asks for an operator comment,
  creates a ticket, and shows the created ticket id. DONE.
- Show open investigations on the Tool Builds page with status, source, linked
  tool/run/span, and a one-click "Promote to Tool Build request" action that links the
  resulting build back to the investigation as `linked_to_build`. DONE for the easy path
  through the existing `POST /api/tool-build-requests`. Future work: server-side
  `POST /api/tool-investigations/:id/promote` so promotion becomes a single audited
  transaction, and an LLM triage assistant that classifies an investigation as tool logic,
  tool contract, prompt/planning issue, credential/policy issue, external blocker, or
  memory note before the operator promotes it.
- Audit `tool_investigation.created` and `tool_investigation.updated` events through the
  existing audit log. DONE.

Remaining gaps:

- Tool Detail and Artifact pages should expose the same "Create investigation" entry
  point for failures discovered outside Trace Lab.
- Investigations should accept additional triage notes, evidence attachments, and review
  decisions before being promoted to a build.
- Memory writes from a closed investigation (when the root cause is external) should
  pre-fill a proposed memory in the review queue with conservative scope/wording.

## Phase 1.6: Async Tool Rework And Run Resume

Status: implemented for the autonomous full-run retry loop. Remaining Phase 2 work is
span-level replanning and policy/UI hardening.

A run that fails because an existing tool is too weak should not silently end as `failed`.
The runtime should:

- preserve failure context as a Tool Investigation Ticket (Phase 1.5);
- promote the ticket into a Tool Build / rework request when the operator (or, later, an
  agent) decides the tool itself needs an upgrade;
- park the originating run in a durable "waiting for tool upgrade" state instead of a
  failed/cancelled terminal status;
- track the link between run, span, investigation, build request, and the eventually
  promoted tool version through a `tool_rework_waits` record;
- expose a resume action that closes the wait and feeds the recursive agent retry/resume
  engine in a future phase.

Implementation tasks:

- Add `tool_rework_waits` Postgres table and an in-memory store fallback. DONE.
- Add `RunStatus = waiting_tool_rework` plus `markWaitingForToolRework` /
  `resumeFromToolRework` on `RunStore`. DONE for in-memory and Postgres run stores.
- Add `GET /api/tool-rework-waits`, `GET /api/runs/:id/tool-rework-waits`,
  `POST /api/tool-rework-waits`, `PATCH /api/tool-rework-waits/:id`, and
  `POST /api/tool-rework-waits/:id/resume`. DONE. Stores return 503 when missing.
- Add `POST /api/tool-investigations/:id/promote` which creates a tool build request,
  links the investigation as `linked_to_build`, opens a wait when the investigation has a
  `runId`, and marks that run as `waiting_tool_rework`. DONE.
- When a tool build reaches `registered` (through PATCH or workflow runOnce), promote
  every matching wait to `promoted`, store the new version, and write a
  `tool_rework_wait.updated` audit event. DONE.
- Add audit events `tool_rework_wait.created`, `tool_rework_wait.updated`, and
  `tool_rework_wait.resumed`. DONE.
- Run Workspace shows a "Waiting for tool upgrade" panel when active waits exist for the
  selected run. DONE. Trace Lab inspector shows the linked wait/build/investigation card
  for the selected span. DONE. Tool Builds investigation cards and build cards show
  linked waits with a `Resume run` button when the wait is `promoted`. DONE.
- "Mark ready for retry / close wait" action: marks the wait as `resumed`, optionally
  records `retryRunId`, returns the run from `waiting_tool_rework` back to `failed` so
  an operator can re-issue the task with the new tool version, and writes
  `tool_rework_wait.resumed` to the audit log. DONE. The action is **not** an automatic
  agent retry; the recursive retry engine is Phase 2 work.
- Run lifecycle protection: `RunStore.complete()` and `RunStore.fail()` skip runs in
  `waiting_tool_rework` so a late agent completion or failure cannot overwrite the
  durable wait state. DONE for in-memory and Postgres run stores.
- Promotion determinism: `/api/tool-investigations/:id/promote` resolves the build target
  from registered tool metadata when `toolName` matches the registry, and returns 400
  (`code=investigation_promotion_ambiguous`) when `toolName` is unknown or the
  investigation has no matching tool, instead of letting fuzzy text inference pick a
  capability that could replace the wrong tool. DONE.
- runId validation: both promote-created waits and `POST /api/tool-rework-waits` look up
  the source run through `RunStore.get()` before creating a wait. Errors from
  `markWaitingForToolRework` propagate to the caller instead of being swallowed. DONE.
- Agent-driven wait creation: `ToolImprovementCoordinator`
  (`src/tools/toolImprovementCoordinator.ts`) centralizes investigation+build+wait
  creation, audit emission, build-registered notification, and "ready for retry" closure.
  `POST /api/tool-investigations/:id/promote`, `POST /api/tool-rework-waits`, the build
  PATCH/run hooks, and the resume endpoint all delegate to this coordinator. The
  `UniversalAgent` accepts an optional `toolImprovementCoordinator` and uses it from the
  missing/insufficient tool paths so an agent failure now opens the same investigation +
  build + wait + `waiting_tool_rework` run state that an operator-triggered promotion
  produces. The agent emits `tool-rework-wait-opened` trace events and appends a
  "Pending tool rework waits" footer to the final answer when waits are still open. DONE.
- Background build handoff: `ToolImprovementCoordinator` accepts an optional
  `backgroundBuildScheduler` and, when wired up by the HTTP layer, calls
  `ToolBuildWorker.scheduleImmediate()` immediately after creating a build request so a
  promoted investigation or agent-driven improvement does not have to wait for the
  worker's interval tick. `ToolBuildWorker.onAfterCompleted` is late-bound by
  the Nest runtime worker module to the same `notifyToolBuildRegistered` + `tool_build.registered` audit
  path the manual PATCH/`/run` endpoints already use, so a background-driven
  registration flips matching `ToolReworkWait` records to `promoted` automatically. The
  worker also joins a pending tick instead of double-claiming when ticks overlap. DONE.
- Messaging service adapter builder: `MessagingServiceToolBuildProvider`
  (`src/tools/messagingServiceToolBuildProvider.ts`) is the first provider-family
  implementation for always-on messaging adapters. It is not a Telegram branch in the
  core runtime: provider-specific behavior is isolated behind a build-provider spec,
  while the generated package still talks to Agentic only through the neutral
  `/api/tool-services/:name/inbound` and `/outbox` service contract. The first supported
  provider spec is Telegram Bot API (`getUpdates`, `sendMessage`, inline
  `Continue thread` keyboard, ack), emitted as a portable source bundle under
  `tools/<system-name>/<version>`. The generated tool resolves its token exclusively
  through `context.resolveSecret(handle)`, declares provider allowlists in its settings
  schema, and runs as `always-on` under the existing service supervisor. Future provider
  specs (Slack, WhatsApp, email, custom chat gateways) should extend this family model
  instead of adding one-off core branches. The shared deterministic behavior reviewer keeps
  rejecting requests that explicitly name a provider API when the generated output only
  produces a provider-neutral bridge.
  DONE for the build/QA/registration handoff. Remaining work: rework the built-in
  `channel.telegram.bot` into the first generated provider once parity is full,
  expose the Telegram allowlist settings inline in the Channels UI, and ship the
  generic media/file/voice intake layer that all generated provider adapters can
  share.
- Auto retry orchestrator: `ToolReworkAutoRetryCoordinator`
  (`src/tools/toolReworkAutoRetryCoordinator.ts`) hangs off
  `ToolImprovementCoordinator.notifyBuildRegistered` through an `onWaitPromoted` hook.
  When enabled by policy, it inspects every freshly promoted wait, walks the
  `parentRunId` chain to enforce `maxAutoRetriesPerRootRun`, refuses cancelled /
  orphaned source runs, and delegates retry-run creation to the manual
  `ToolReworkRetryCoordinator` so idempotency stays in one place. The new endpoint
  `POST /api/tool-rework-waits/:id/auto-retry` lets operators force-evaluate the
  policy decision and is idempotent. Policy defaults are
  `{ enabled: true, maxAutoRetriesPerRootRun: 1 }`; `TOOL_REWORK_AUTO_RETRY=disabled`
  and `TOOL_REWORK_AUTO_RETRY_MAX_DEPTH=N` tune them at boot. Audits are recorded as
  `tool_rework_wait.auto_retry_decision` with `actorId=auto-retry-orchestrator`. The
  manual `/resume` and `/retry-run` endpoints keep their existing semantics. DONE.
- Retry-run skeleton: `ToolReworkRetryCoordinator`
  (`src/tools/toolReworkRetryCoordinator.ts`) turns a `promoted` wait into a real linked
  retry run. The new run inherits the original run's task and instance/user/channel/thread
  provenance, links back through `parentRunId` and through `wait.retryRunId`, and the
  source run returns to `failed`. `POST /api/tool-rework-waits/:id/retry-run` exposes
  this and starts the retry through the same `executeRun` path used by `POST /api/runs`,
  so the retry executes through the standard agent loop with no bespoke special cases.
  Run Workspace, Tool Builds investigation/build cards, and the Trace Lab inspector all
  show "Create retry run" / "Open retry run" affordances. The endpoint is idempotent: a
  second call returns the existing retry run with `alreadyExists: true`. The existing
  `/resume` endpoint is preserved as a separate "close wait without spawning a retry"
  handoff so operators keep that semantics. The new audit action
  `tool_rework_wait.retry_run_created` records the linkage. DONE.
- Autonomous full-run loop: the Nest `RunsService` now treats `waiting_tool_rework` as a
  pending state after `agent.run()` returns or throws. If the agent opened a wait, the
  server records `run.updated` with `pendingToolRework=true` and does **not** emit
  `run.completed`/`run.failed`, complete the conversation thread, or queue outbound
  delivery for the source run. Once the build reaches `registered` through **any**
  server registration path (manual PATCH, workflow `/run`, or background worker), the
  same `onWaitPromoted -> ToolReworkAutoRetryCoordinator -> ToolReworkRetryCoordinator`
  chain creates and starts a linked retry run. The retry run owns the final answer while
  the source run remains failed handoff context. Covered by
  `tests/autonomousToolLoop.test.ts`. DONE.

Remaining work for Phase 2:

- Span-level recursive retry / replanning: replace the run-level retry skeleton with an
  engine that re-plans only the failed step against the new tool version, producing
  scoped retry spans linked through `retryRunId`/`retrySpanId` instead of recomputing the
  full task graph from scratch. `ToolReworkRetryCoordinator` and
  `ToolReworkAutoRetryCoordinator` are intentionally limited to full-run retry; future
  recursive agents should layer span-level retry on top.
- Production policy UI: today the auto-retry policy is a boot-time env knob. A future
  Policies page should expose `enabled` / `maxAutoRetriesPerRootRun` / per-source filters
  and tie into the role-aware permission story.
- Drive automatic wait creation directly from runtime tool failures (artifact tool retry
  flow, recursive agent escalation) — partially DONE through
  `ToolImprovementCoordinator.requestImprovement(source: "agent_runtime")`. The remaining
  step is letting the coordinator optionally run a synchronous Tool Build workflow before
  parking the run, so promoted versions can resume in the same call.
- Add cancellation, timeouts, and notifications for waits that linger past a configured
  policy.
- Surface a Waits page that aggregates open waits across runs, with filters by tool, run,
  and investigation.
- Resume should preserve continuation context (memory, artifacts, conversation thread)
  for the retried run instead of relying on the operator to re-issue the task.

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
  settings schemas are persisted and shown, concrete non-secret per-tool runtime settings
  are now stored through `tool_runtime_settings`, exposed via API/UI, audited on
  save/delete, and resolved at runtime before falling back to process env. The Tools
  detail page now groups runtime values, required secret handles, and declared
  `settingsSchema` hints so operators can see what is configured and what is missing.
  The UI renders typed controls for enum, boolean, number/integer, URL, and text schema
  fields, and `POST /api/tool-settings/validate` previews missing required values plus
  schema issues before save. Remaining work is bulk import/export, richer rate-limit and
  feature-flag presets, config diff/history, and policy gates for sensitive settings.
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
  traversal and non-source-bundle manifests. New server-side Tool Builds now write the
  package workspace by default and skip new `src/tools/generated`/`tests/generated`
  project-file writes unless `TOOL_BUILD_LEGACY_PROJECT_FILES=enabled` is explicitly set;
  `TOOL_BUILD_PACKAGE_WORKSPACE=disabled` remains the temporary legacy fallback.
  External-package manifests whose
  `package.ref` is
  an HTTP(S) runtime URL now load through a proxy runner that calls `/health`, `/run`, and
  optional service lifecycle routes. OCI-image manifests can now be executed by an
  explicitly enabled Docker runner (`TOOL_OCI_RUNNER=enabled`) when the container exposes
  the same HTTP runtime contract. Loading an OCI manifest is lazy: it registers the tool
  without starting Docker, starts a short-lived container for normal `/run` calls, and
  delegates `always-on` startup/heartbeat/stop to the generic Tool Service supervisor.
  Tests also prove custom non-local manifests can be loaded by adding a runner, lazy
  unhealthy OCI startups stop the just-created container, and HTTP/OCI runtimes receive
  only their declared `requiredConfigurationKeys` and `requiredSecretHandles` as scoped
  runtime envelopes. Missing required runtime values now fail before the external runtime
  is called. The OCI runner now adds Agentic Docker labels, non-secret tool identity
  environment variables, optional memory/CPU/PID/network/read-only limits, bounded `/run`
  and service lifecycle call timeouts, service lifecycle proxying, and redacted startup
  failure logs from `docker logs`.
  Runner inventory is visible through the API and Diagnostics page, and operators can
  explicitly reload generated tools after updating a source-bundle on disk. Remaining
  work is building package folders into OCI images, npm/external package
  install/sandboxing, production container pools, persistent container log streaming,
  image pull/publish policy, container-level config/secret injection policies, and richer
  runner UI controls. DONE for API/UI package import/export, package workspace writing,
  package-local build/test QA, active source-bundle promotion, package-only Builder/QA
  flow without project-file writes, package-local HTTP runtime scaffold, local HTTP
  process runner for source-bundles, source-bundle
  always-on lifecycle smoke, bounded source-bundle runtime calls, and first OCI HTTP
  proxy runner.
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
  run first; the LLM path now receives a normalized Tool Build Blueprint extracted from
  operator docs, cURL examples, endpoint lines, fixtures, credential handles, lifecycle
  hints, and previous QA failures. The builder output is validated against documented
  operations, fixture coverage, required secret handles, raw-secret leakage, and
  always-on lifecycle obligations before isolated QA plus promotion checks can run.
  Remaining work is live docs fetching/chunking, richer endpoint/schema inference,
  separate model-worker pools, and out-of-process build sandboxes.
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
  reloads/activates generated tools before final `registered` status when the workflow is
  configured with an activation runner. If activation fails, the request stays `blocked`
  with activation QA evidence and the registered tool name for repair. The Tool Builds UI
  now surfaces activation pass/fail checks directly on each card and in the preview.
- Preserve full Tool Build rework context. DONE: revision requests created from a build
  card carry the original request id/status/status detail, registered tool name when
  present, QA summary/checks/reviews, activation pass/fail evidence, and the operator
  comment into the new requested build. The UI placeholder also reflects the current
  blocker without submitting placeholder text as feedback.
- Keep Tool Build and rework request forms stable during live UI refresh. DONE: soft
  background refresh defers rendering while an operator has an open tool-build, span bug,
  or tool rework form, and universal QA/change prompts are placeholders rather than
  silently submitted defaults.
- Add a reusable Tool Builder workflow. DONE as `ToolBuildWorkflow`, with pluggable
  Builder, QA Runner, Review, Registrar, and Activation interfaces plus tests proving
  failed QA/review blocks registration, activation happens before registered status, and
  failed QA/review reports can be returned to the builder for a bounded retry.
- Add a Tool QA runner that executes targeted tests plus capability-specific smoke checks
  in an isolated container/process and writes a structured QA report back to the queue.
  DONE for temporary workspace isolation, command timeouts, targeted tests, isolated build,
  and promotion build verification.
- Implement `browser.screenshot` as the first self-service tool target. DONE with a
  Playwright provider that writes an isolated source-bundle package under
  `tools/generated.browser.screenshot/<version>`. Legacy tracked app-source screenshot
  modules (`generated.browser.screenshot.manual`, `.isolated`, and the old local-path
  variant) have been removed from `src/tools/generated`; migrations also delete stale
  durable registry rows for those legacy names while preserving a source-bundle
  `generated.browser.screenshot` package manifest when one exists.
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
  the configured XL-tier model and the same QA/registrar pipeline. DONE for the first
  generic contract layer: `ToolBuildBlueprint` parses arbitrary pasted docs/instructions
  into documentation URLs/snippets, endpoint presets, request/response fields, fixtures,
  credential handles/raw-secret candidates, runtime lifecycle, and repair context; the
  LLM prompt and validator must follow that blueprint. Remaining work is live provider-doc
  retrieval/chunking, stronger schema synthesis from OpenAPI/HTML/PDF, semantic code
  review, behavior review with live smoke evidence, and execution outside the main app
  process.
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
  search by forcing `token=supported` for address and transaction report URLs. Generic
  LLM-backed builds now compile pasted docs into a Tool Build Blueprint before prompting,
  so endpoint presets, fixtures, response fields, and credential handles are explicit
  obligations instead of freeform prompt text. Remaining work is live docs upload/fetch
  chunking, encrypted/secret-manager-backed material storage for pasted credentials,
  richer provider-specific schemas, and policy-aware runtime credential resolution for
  all generated tools.
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
- The LLM-backed generic Tool Builder must never treat pasted docs as freeform vibes.
  The request is first compiled into a Tool Build Blueprint. Generated output must mention
  the documented operation(s), include declared secret handles, cover at least one
  documented fixture when fixtures exist, and address previous QA checks during repair.
  Raw credential candidates extracted from credential notes are rejected if they appear in
  generated source, tests, docs, manifests, examples, or fixture output.
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
  rate limits, and feature flags declared by each tool contract. PARTIAL: Tools detail now
  shows editable non-secret runtime settings for declared configuration keys and optional
  custom keys, stores them durably, and keeps secret handles separate. Remaining work:
  typed controls from schema, provider URL/rate-limit grouping, diff/audit previews, and
  validation smoke before saving.
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
  under gitignored `tools/<name>/<version>` folders, make that package workspace the
  default Tool Build output, skip new legacy project-file writes unless explicitly enabled,
  include a package-local minimal Tool contract for generated TypeScript modules, include
  the sidecar package manifest in QA evidence, run structural package-workspace QA plus
  package-local build/test during command QA, persist verified package workspaces as the
  active `source-bundle` manifest, reload pre-built source-bundles from that workspace,
  prefer package-local HTTP process execution in the web server, proxy external HTTP
  packages, and optionally run OCI HTTP packages. Generated package folders now include an
  HTTP runtime server and Dockerfile entrypoint, and the local-process runner can execute
  that runtime without importing generated package code into the Agentic process.
  Remaining work is stronger production supervision, richer resource limits, log
  streaming/redaction, and packaging/building those source-bundles as external services or
  OCI images. DONE for package-only Builder/QA, source-bundle local process on-demand
  calls, always-on service lifecycle, and bounded runtime call timeouts. The local process
  runner also detects runtimes that exit before readiness and reports exit code/signal plus
  bootstrap output.
- Add provider-neutral always-on restart policy and lifecycle diagnostics. DONE for
  persisted desired/runtime state, heartbeat health, restart count, consecutive failures,
  last failure/restart metadata, bounded auto-restart after failed heartbeat,
  per-service restart policy overrides through API/UI, optional restart backoff, and a
  service-local operator approval gate for sensitive service restarts. Backoff policy now
  supports multiplier, max-cap, and jitter values so flapping services can slow down
  progressively without restarting in lockstep.
  Source-bundle HTTP process runtimes now bridge child stdout/stderr into lifecycle logs/SSE.
  Heartbeats now also refuse false-green status for service tools whose runtime failed to
  start: the supervisor retries `startService` instead of accepting static module health.
  Service restart approval gates are now visible in the unified Approvals page, where
  approve calls the normal restart endpoint and reject stops the service. Remaining work:
  generalize the inbox into a persistent approvals table for outbound actions, memory
  writes, credential usage, and policy analytics.
- Add a `ToolExecutionContext` injected into every tool call with scoped DB client,
  secret resolver, artifact store, audit writer, logger, and cancellation signal. DONE:
  registry calls now inject provenance, secret resolver, audit writer, logger, caller,
  span ids, cancellation-compatible context shape, and an abstract
  `artifacts.saveGenerated(...)` writer backed by the run artifact store. When Postgres is
  configured, tools with a declared storage contract also receive a scoped DB client that
  allows only single-statement read/write runtime queries with explicit permissions and
  rejects DDL, transactions, session changes, deletes, and maintenance operations.
- Add a `tool_migrations` or `tool_schema_migrations` table that records tool name,
  version, migration id, checksum, applied time, applied-by actor, QA report, and
  rollback/repair notes. DONE for the metadata table/store/API/audit/UI visibility.
- Extend Tool Builder contracts so a request can ask for persistent storage or a database
  maintenance capability. The builder must generate versioned migrations, tests,
  documentation, and operator-visible permission metadata. PARTIAL: generated always-on
  service contracts now emit scoped runtime permissions (`tool-db:read`/`tool-db:write`)
  that match `ToolExecutionContext.db`, QA rejects invalid migration manifests before
  promotion, and registration records idempotent pending migration manifests with
  checksum/QA evidence; full generated migration execution is still next.
- Run generated tool migrations in an isolated Postgres database during QA, including
  idempotency checks and fixture-based behavior tests. PARTIAL: service-runtime
  migrations now have a SQL planner and QA executor that runs plans twice inside a
  rollback transaction when an isolated pool is provided; wiring an actual disposable
  Postgres container/pool into the default builder remains.
- Promote tool versions transactionally: migration metadata, tool metadata, generated
  source bundle, QA evidence, and registry activation should move together. PARTIAL:
  active generated metadata and version-history rows now persist `promotionEvidence`
  linking the promoted version to its build request, QA summary/checks/reviews, package
  ref, timestamp, and migration ids. Generated promotions are also appended to a
  `tool_promotions` journal, and the server exposes `GET /api/tool-promotions` for
  operator/audit surfaces. The Tools inspector now shows the journal beside each generated
  tool, separating active state from append-only registrar decisions. The registrar now
  delegates to `ToolPromotionCoordinator`, an explicit promotion boundary that returns
  metadata, migration records, and journal records together. When Postgres is configured,
  `PostgresToolPromotionCoordinator` wraps the metadata, pending migration-manifest, and
  promotion-journal writes in one database transaction, with tests covering commit and
  rollback. Runtime activation now has a compensating rollback hook: if activation fails
  after registration, the workflow calls the activation runner rollback method when
  available, keeps the request `blocked`, and records `activation rollback pass/fail`
  evidence in the QA report/UI. DONE for the default runtime path: reloads unregister
  previously loaded generated tools before loading current metadata, and the
  metadata-backed activation runner reactivates `replacesVersion` or deletes failed
  initial generated metadata before reloading again. Remaining work is expanding the
  transactional promotion boundary into a full saga that applies/records migrations,
  activates the generated package, reloads runtime, and rolls back cleanly if any step
  fails. Runtime
  reload/activation is now represented in the workflow status and QA report, but it is
  still not part of the same Postgres
  transaction/package rollback boundary.
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
  Span-originated request forms now include rejected artifact QA evidence when the span
  payload contains it, including artifact filename, MIME type, QA reason, score, and
  signals. Runtime semantic artifact QA now treats `blocked_or_loader` screenshot
  failures as external blockers rather than automatic tool rework requests, records an
  explicit trace event for the limitation, and creates/updates accepted global failure
  memory for the blocked host/tool. DONE for first UI visibility: Memory now has a
  `Known Limitations` filter, metric, warning styling, and detail guidance for
  `external-blocker` memories. Remaining work: classify ambiguous issues with a local LLM
  before build creation and add cross-links from the rejected artifact/span directly to
  the limitation memory.
- Let agents request a versioned tool improvement, wait for the QA-approved promoted
  replacement, reload the registry, and retry the tool call once when a current tool is
  close but insufficient. PARTIAL: prompts now require workers to identify reusable tool
  improvement needs with tool name/current behavior/desired behavior/acceptance test; the
  runtime already does this for missing capabilities. Artifact-producing tool failures
  and semantic artifact QA failures now create contextual versioned rework requests with
  source span id, tool name/version, input/output summaries, and `replacesVersion` for
  generated tools. If a synchronous build/activation path makes a reworked tool version
  available in the registry during the same run, the agent now performs one bounded retry
  of the artifact tool call. Remaining work is waiting asynchronously for a background
  QA-approved promoted replacement, reloading the registry, and resuming/retrying the run
  after the background worker finishes.
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
- child agents check the Thread/Run Work Ledger before doing costly or external work and
  either reuse fresh evidence, wait for an in-flight sibling claim, or create a new
  versioned attempt with an explicit reason;
- child agents record their work claims, evidence, failures, and generated artifacts in a
  shared ledger so parallel branches do not repeat the same search, scrape, screenshot,
  API call, or file generation;
- after each run, a retrospective agent writes structured lessons about what worked,
  what failed, why it failed, and which memories/tools/prompts/policies should be
  reviewed;
- agents can invoke a council planner when task uncertainty, risk, model disagreement, or
  domain breadth warrants multiple independent plans or critiques;
- child agents can create Tool Build Requests when they detect missing capabilities;
- child agents can create Tool Rework Requests when an existing tool is insufficient;
- child agents can choose model tier and review strictness based on local task risk;
- every agent performs a local "ready to return" check before returning, independent of
  whether a separate reviewer exists;
- each child receives only scoped memory and tool permissions;
- agents can ask another instance/company/family agent for information through a federated
  request tool;
- inter-instance answers must include provenance and audit records.

Approved implementation path after the Nest API cutover:

1. **Agent call-frame runtime.** Introduce a single `AgentInvocation` contract for every
   agent call: local task, caller frame, scope/provenance, allowed tools, model tier,
   output contract, budget, deadline, and cancellation signal. The current coordinator,
   worker, reviewer, synthesizer, tool-builder, tool-QA, and future council participants
   should all run through this contract instead of special-case method paths.
   PARTIAL: [agentStrategy.ts](../src/agents/agentStrategy.ts) now creates an advisory
   `AgentStrategyDecision` after classification and emits it as `agent-strategy-selected`.
   The decision records whether the agent should answer directly, delegate, ask a council,
   call tools, request tool build/rework, or check/reuse/wait on the Work Ledger. It also
   records model-tier and review-strictness recommendations for the future invocation
   runner. PARTIAL: [agentInvocation.ts](../src/agents/agentInvocation.ts) now converts
   that decision into a root `AgentInvocation` trace payload (`agent-invocation-created`)
   with caller, local task, output contract, allowed actions/tools, model tier, review
   strictness, and depth budget. Council strategies also emit planned participant
   invocations through `agent-council-planned`; those participant invocations now run
   through the recursive executor as advisory child calls. The root invocation now emits
   `agent-invocation-return-checked` before the run returns, using the same generic
   output-contract self-check that child/council invocations will use later. PARTIAL:
   [agentInvocationRunner.ts](../src/agents/agentInvocationRunner.ts) adds a reusable
   invocation executor with depth-budget validation, handler failure wrapping, and
   output-contract self-check enforcement. Council participant invocations now execute
   through this runner as advisory child calls and feed compact notes into the planning
   prompt. PARTIAL:
   [recursiveAgentLoop.ts](../src/agents/recursiveAgentLoop.ts) adds the first
   deterministic execution-mode bridge after the root invocation. It emits
   `agent-decision-loop-completed`, chooses `answer`, `delegate`, or `wait_for_tool`,
   and can upgrade a direct-classified task into delegated execution for external tool
   work, ledger coordination, council planning, or tool build/rework. General recursive
   child execution is now started by
   [recursiveAgentExecutor.ts](../src/agents/recursiveAgentExecutor.ts), which can run one
   invocation decision, spawn recursive child/council invocations in bounded parallel
   batches, synthesize compact child returns, and emit invocation started/decision/
   completed/failed/return-check events. Root direct-answer invocations now run through
   this executor when the invocation contract does not require external evidence, and
   executor decisions are validated against allowed actions/tools before any handler is
   called. Direct tool-wait/rework and external-blocker paths remain on the compatibility
   direct runner until span-level retry can resume only the blocked step. Remaining work
   is wiring the full UniversalAgent worker, reviewer, tool-builder, ledger, and retry
   flows through this executor.
2. **Recursive delegation.** Let any agent spawn child agents when its local task is too
   broad, risky, tool-heavy, or context-heavy. Child agents may recursively delegate again
   within depth, budget, deadline, and policy limits. A parent only receives compact child
   returns, artifacts, evidence references, and self-check results. PARTIAL:
   `runRecursiveAgentExecutor()` supports recursive child spawning, depth-budget
   enforcement, parallel batch execution, synthesized child returns, and lifecycle trace
   emission. The remaining slice is replacing the current central worker/reviewer DAG with
   executor-backed child handlers that can call tools, claim ledger work, and request
   improvements without special-case top-level code.
3. **Council mode.** Make "ask a council" one ordinary strategy available to the
   universal agent. PARTIAL: council participant invocations now run through the generic
   recursive executor and produce advisory notes before planning. The next slices should
   let those participants call tools/ledger safely when allowed, run under policy-specific
   budgets, and have a synthesis agent choose or merge a final plan. Council branches must
   still claim Work Ledger entries before external work so two advisors do not repeat the
   same search, screenshot, scrape, or API request.
4. **Work Ledger integration.** Before costly/reusable work, every agent claims a
   deterministic work key. Fresh completed evidence is reused, in-flight sibling work is
   waited on or observed, failed/stale work is revalidated with a reason, and every claim
   links to Evidence Ledger records and artifact ids. This is the dedupe spine for
   parallel recursive branches. PARTIAL: the current runtime uses the shared claim
   coordinator for web search, market time-series, inferred API JSON tools, declared
   tool inputs, and artifact-producing tools; the same coordinator is now available via
   `POST /api/work-ledger/claim`.
5. **Tool improvement loop.** When a child agent finds that a required capability is
   missing or a tool output is insufficient, it creates a Tool Investigation/Rework
   request with the exact span context, waits for background build/QA/promotion when
   policy allows, then retries either the failed span or the whole run. Tool requests are
   not special UI actions; they are agent-call outcomes that join the same trace.
6. **Retrospective learning.** Every run ends with a structured retrospective: what
   worked, what failed, which tools or prompts were weak, where work duplicated, which
   evidence was useful, and which memories/tool tickets/policy updates should enter
   review. These records stay proposed until accepted by policy/operator review.
   PARTIAL: the deterministic retrospective now includes suspected root causes and
   proposed tool/policy/prompt follow-ups; LLM-assisted retrospective review and UI
   approval remain future slices.

Remaining recursive-agent gaps:

- Replace the central one-shot planner with an agent runtime that can recursively spawn
  workers, reviewers, tool builders, tool QA agents, and tool users.
- Add distributed claim locks / transactional claim ownership across replicas and a UI
  for Work Ledger, Evidence Ledger, and retrospective review.
- Add the LLM-assisted retrospective review queue that turns structured reflection into
  memory proposals, tool investigations, prompt/policy improvement tickets, and
  limitation records without auto-polluting accepted memory.
- Add council-planning as a universal-agent strategy: multiple model tiers/providers can
  propose or critique plans, then a synthesis agent merges the plan while dedupe ledger
  entries prevent duplicate external work. PARTIAL: the strategy selector now flags
  council mode and emits participant hints; the invocation layer writes council
  participant call contracts to trace; the recursive executor now runs those participant
  calls as advisory notes. Tool/ledger-enabled council participants and a dedicated
  synthesis invocation remain future work.
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
- channel-source panel for non-web/provider-created runs with provider, source user/chat,
  source message/thread ids, and links back to Channels, Conversation, and Trace. DONE
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
- Channels: installed always-on tool health, lifecycle logs, restart policy controls,
  provider-neutral identity mappings, incoming/outgoing/system event history, links to
  runs/conversations, and `Allow as Admin` from ignored inbound events. New
  bots/listeners/webhooks are requested and built through Tool Builds. DONE for the
  product console shell; media/file/voice transport and delivery retry analytics remain.
- Conversations: thread summaries, linked runs, Telegram/web source messages, split/merge
  controls, continuation composer, destructive delete with associated runs/traces, and
  channel activity for provider-originated runs. PARTIAL: channel activity is implemented;
  split/merge remains.
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
  telemetry. DONE for the operator shell: Channels now lists installed
  `startupMode=always-on` tools with start/stop/restart/heartbeat controls, heartbeat and
  health cards, restart-policy toggles, lifecycle logs, provider-neutral runtime events,
  channel identity mappings, manual allow/block/delete, and an `Allow as Admin` shortcut
  that maps ignored events into normal channel identities. Remaining work is richer
  delivery retry analytics, provider media/file/voice transport, and service-level
  settings forms generated from each tool manifest.
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

## Phase 12: Domain-Neutral Universal Agent

Status: **shipped (Slices A.1 → E)**. The Phase 12 cleanup is complete: domain-specific
URL whitelists no longer live in `src/agents/*.ts`; they are data on tool contracts,
in built-in seeds, or in scoped memory entries. A CI-enforced lint test fails the build
if a flight aggregator or medical portal host name reappears in the runtime. Tracking
issue: see "Capability failure example: `run_1778320304262_oanslhzc`" in Recent Systemic
Findings for the failure that motivated this phase.

Shipping summary:

- **Slice A.1** (5f1c069): regex-based `inferTaskIntents` gates the IATA / from-to /
  source-hints / medical-seed branches in `buildSearchQueries`, plus the flight and
  medical host categories in `scoreArtifactUrl`. Closes the
  `run_1778320304262_oanslhzc`-style cross-domain leak.
- **Slice B** (ff6f0ec): host whitelist moves into `Tool.evidencePatterns` plus a
  built-in seed (`src/tools/builtinEvidencePatterns.ts`). `scoreArtifactUrl` becomes a
  thin wrapper around `scoreUrlAgainstPatterns`, which is pure data-driven matching.
- **Slice C** (a4b6a09): operators can publish, override, or demote evidence patterns
  through scoped memory entries tagged `evidence-pattern` + `intent:<name>`. JSON spec
  parsed by `loadEvidencePatternsFromMemory`. Same review queue lifecycle as any other
  memory.
- **Slice D** (0f048b0): `rankDiscoveryUrls` asks an S-tier LLM to pick the best
  candidate URLs for the subtask. Heuristic remains the documented fallback when the
  LLM is unreachable, the JSON parses fail, or `URL_RANKER_LLM=disabled` is set. New
  trace span `discovery-url-ranked` exposes the source and rejected URLs.
- **Slice E** (be2a00f): every domain-specific regex is quarantined in
  `src/agents/intentInference.ts`. `tests/banDomainTokensInAgents.test.ts` is the CI
  lint that fails the build if any banned host token leaks back into `src/agents/*.ts`.

Counts: ~1.2k lines net delta across `src/agents/`, `src/tools/`, `src/memory/`. New
tests: 14 (Slice A) + 12 (Slice B) + 10 (Slice C) + 9 (Slice D) + 2 (Slice E) = 47.
`npm run verify` exit 0, 412 total.

Goal: remove the domain-specific hardcodes (flights, medical-doctor portals, country
hint lists) from `src/agents/universalAgent.ts` and re-express them as data living on
tools, classification output, or scoped memory entries. After this phase no string
inside `universalAgent.ts` should mention `flights`, `skyscanner`, `kayak`, `doctolib`,
`jameda`, or any other concrete provider, and no regex over `subtask.prompt` should
guess a task domain.

Why: today the "universal" agent contains two embedded domain funnels (flights,
medical) wired through text regex + URL host whitelists. They activate
deterministically on unrelated tasks (laptop research trips `GPU/RTX/RAM` matched by
the IATA regex, a "specialist" mention triggers medical discovery, and so on),
producing irrelevant evidence and screenshots. Adding more domains by extending these
hardcodes is the wrong direction; the platform principle (Capability Platform, Not
Case Patches) forbids it.

### Slice A - Hot-fix: gate the existing hardcodes behind explicit intent

Acute regression mitigation. Cheap. Does not remove the anti-pattern but stops
laptop/research/code/etc. tasks from triggering flight or medical funnels.

Status: **shipped as Slice A.1** (regex-based `inferTaskIntents` instead of plumbing a new
`intent[]` field through `ClassificationResult`). The full Slice A still includes
classifier-driven `intent[]` plumbing once the schema work lands; the regex inference is
a placeholder that can be replaced without touching call sites — `inferTaskIntents` is
the single migration point.

Implementation tasks:

- Extend the classification step to return an `intent: string[]` array along with the
  existing `mode/domains/riskLevel`. Allowed values seed list:
  `flight-search`, `medical-lookup`, `product-comparison`, `market-research`,
  `code-generation`, `geopolitical-assessment`, `travel-planning`, `text-research`,
  `data-extraction`, `other`. Free-form values are also accepted; runtime treats
  anything outside the seed list as `other`.
- Plumb `intent[]` through `UniversalAgentOptions` and `Subtask` (each subtask inherits
  the run-level intent unless the planner overrides for a child subtask).
- Gate the IATA branch in `buildSearchQueries` (`src/agents/universalAgent.ts:4024-4027`)
  behind `intent.includes("flight-search")`. Same for the `from X to Y` `routeMatch`
  branch (line 4028-4031) and the `sourceHints` line that scans for
  `google flights|skyscanner|kayak|...` keywords (line 4010).
- Gate the medical seed query (line 4017-4023) behind `intent.includes("medical-lookup")`.
- Gate `shouldCollectBrowserDiscovery` regex (line 3891-3905) so the
  `doctor|clinic|specialist|...` and `flight|ticket|...` keywords only trigger discovery
  when the matching intent is in `intent[]`. Otherwise discovery only fires when
  `subtask.requiredTools` explicitly lists `browser-operate`.
- Update tests:
  - `tests/universalAgent.test.ts` add a "laptop research" fixture asserting no flight
    query is appended for prompts containing `GPU/RTX/RAM/CPU/LLM/EUR`.
  - Add a positive test for `intent=flight-search` keeping the existing flight branch
    behaviour.
- Add a memory entry under `feedback` scope `global` recording the bug pattern so future
  agents do not regress (proposed -> accepted via review).

Out of scope for Slice A:

- Do not yet remove the host whitelist in `scoreArtifactUrl`; it still protects flight
  runs while we have not built tool-owned evidence patterns.
- Do not yet rewire URL ranking through an LLM call.

Definition of done: the run that motivated this phase
(`run_1778320304262_oanslhzc`-style task) no longer issues the parasitic
"X Y Z flights ..." merged query, and no `discovery-1-google-com-www-google-com-travel-flights-screenshot.png`
artifact appears for non-`flight-search` intents.

### Slice B - Tool-owned evidence patterns

Move the host whitelist out of the runtime into tool contracts.

Implementation tasks:

- Extend `ToolContract` in `src/tools/registry.ts` (or wherever the contract type lives)
  with optional:

      evidencePatterns?: Array<{
        intent: string;
        hosts?: string[];                  // exact host or suffix match
        urlPatterns?: string[];            // regex strings
        score: number;                     // 1..200, higher = stronger evidence
        rejectIfBlocked?: boolean;         // login-wall / captcha => reject
        notes?: string;
      }>

- Replace `scoreArtifactUrl` body (`src/agents/universalAgent.ts:4342-4361`) with a
  registry lookup:

      function scoreArtifactUrl(url, activeIntents, registry) {
        return registry
          .evidencePatternsFor(activeIntents)
          .map(p => matchPattern(url, p) ? p.score : 0)
          .reduce((a,b) => Math.max(a,b), 0);
      }

  The registry returns only patterns whose `intent` is in `activeIntents`. Patterns
  for inactive intents do not influence ranking.
- Move the existing flight-host scores (google.com/travel/flights, skyscanner.com,
  kayak.com, momondo.com, kiwi.com, expedia.com, trip.com) into a new built-in tool
  contract (e.g. seed `flight.search` capability stub even if no real flight tool is
  registered yet). Same for medical hosts.
- For the country-hint dictionary in `buildContextSearchHints`
  (`src/agents/universalAgent.ts:4036-4057`), move into a memory-backed lookup or a
  `geo.context` capability tool. Out of scope to rewrite right now; mark as TODO with a
  reference to this phase in code comment.
- Update `selectBestUrlsForArtifact` to accept `activeIntents` parameter and pass
  through.
- Tests: add a tool registry stub with patterns for two intents, verify that scoring is
  intent-scoped.

Definition of done: `grep -n "google\.\|skyscanner\|kayak\|doctolib\|jameda" src/agents/universalAgent.ts`
returns zero matches.

### Slice C - Memory-driven evidence patterns

Promote tool-owned patterns to a learnable layer so operators can add/edit/disable
patterns without a code release.

Implementation tasks:

- Define a new memory entry shape (additive, no schema change). Convention: `tags`
  contains `evidence-pattern` and `intent:<name>`. `reusableProcedure` carries a YAML
  block with `intent`, `hosts`, `url_patterns`, `score`, `reject_if_match`. Add a small
  parser in `src/memory/evidencePatternParser.ts` that decodes this block into the same
  `EvidencePattern` shape used by tool contracts.
- At evidence-collection time, runtime calls
  `skillMemory.search("evidence-pattern intent:" + intent, 8, { visibleScopes })` and
  unions the parsed patterns with tool-contract patterns. Memory patterns can override
  tool-contract patterns (operators can demote a built-in score by writing a memory
  entry with `score: 0`).
- Add UI on the Memory page: a filter "Evidence patterns" and a structured editor that
  validates the YAML block against the schema.
- Add a Trace Lab span `evidence-pattern-resolved` showing which patterns (memory id,
  tool source) influenced the URL ranking for a given subtask.
- Memory hygiene: `evidence-pattern` entries default to `scope: global`,
  `sensitivity: normal`, `status: proposed` until reviewed.

Definition of done: deleting all `accepted` `evidence-pattern` memory entries reverts
URL scoring to tool-contract defaults. Adding a new entry like
`{intent: product-comparison, hosts: [pccomponentes.com, amazon.es], score: 90}` makes
those hosts rank higher than blogs in the next product-comparison run, with no code
change.

### Slice D - LLM-driven URL ranking for browser discovery

Replace heuristic sort with a small LLM call. Domain knowledge becomes whatever the
classifier model already has, no whitelist needed for the long tail.

Implementation tasks:

- Add `rankDiscoveryUrls(subtask, candidates, intents)` that issues an S-tier LLM call:
  prompt contains `subtask.title`, `subtask.prompt` (truncated), and the candidate URLs
  with their search-result snippets. Output is JSON:
  `{ selected: [url1, url2], rejected: [{url, reason}] }`.
- `selectBestUrlsForArtifact` becomes the fallback for when (a) the LLM is unreachable,
  (b) the result fails JSON parse, or (c) explicitly disabled via env
  `URL_RANKER_LLM=disabled`.
- Add Trace Lab span `discovery-url-ranked` with selected/rejected URLs and reasons.
- Metric: percentage of `Browser artifact rejected by semantic QA` events should drop
  meaningfully on the next batch of runs after Slice D ships. Add a Diagnostics
  card showing the seven-day rolling rate.
- Tests: mock the LLM client, fixture covering "laptop research" rejecting flight URLs
  and a "find me a flight to Lisbon" run picking the right hosts.

Definition of done: ranking decisions are visible in Trace Lab; the
`scoreArtifactUrl`-based path is the documented fallback only.

### Slice E - Cleanup and verification

Remove transitional shims and verify no domain strings remain in core runtime.

Implementation tasks:

- Delete commented or dead branches left over from Slices A-D.
- Add a CI lint rule (or a unit test) that fails the build if `src/agents/*.ts` contains
  any of:
  `flight`, `flights`, `skyscanner`, `kayak`, `momondo`, `expedia`, `aviasales`,
  `doctolib`, `jameda`, `topdoctors`, `hospital`, `clinic`, `aerzte`, `arzt`, `medecin`.
  These tokens are allowed only inside `evidencePatterns` definitions on tool contracts
  or inside scoped memory.
- Update `docs/architecture.md` and `docs/modules/agent-runtime.md` so they no longer
  reference flights or medical examples in the runtime section.

Definition of done: lint rule above is green; manual reproduction of
`run_1778320304262_oanslhzc` produces only laptop-relevant discovery artifacts; running
"find a flight LIS->LAX" still produces flight-relevant artifacts.

### Risks and rollback

- Removing flight scoring before Slice B ships would degrade real flight runs. Order
  matters: Slice A first (gate), then Slice B (move whitelist to tool contracts), then
  Slice C/D in any order.
- Memory-backed patterns can be poisoned by a malicious or wrong proposal. Mitigation:
  evidence-pattern entries follow the existing memory proposal review pipeline; nothing
  applies until `accepted`.
- LLM ranker latency adds ~200-400ms per discovery step. Mitigation: cap concurrency,
  fall back to heuristic when budget is tight.

### Files of interest

Anchor points for whoever picks this up cold:

- `src/agents/universalAgent.ts:3891-3905` - `shouldCollectBrowserDiscovery` regex.
- `src/agents/universalAgent.ts:4003-4067` - `buildSearchQueries`,
  `buildContextSearchHints`, `cleanSearchQuery`.
- `src/agents/universalAgent.ts:4302-4380` - URL selection + `scoreArtifactUrl` +
  `isLowValueProofUrl` + `extractHttpUrls`.
- `src/agents/universalAgent.ts:1541-1595` - `collectBrowserDiscoveryEvidence` (caller).
- `src/agents/universalAgent.ts:1304-1410` - `runWebSearch` (caller of
  `buildSearchQueries`).
- `src/memory/skillMemory.ts` - target store for memory-backed evidence patterns.
- `src/tools/registry.ts` - target location for the new `evidencePatterns` field on
  `ToolContract`.


## Phase 13: Tools-As-Services

Status: **shipped (Slices A-G + follow-ups)**. The Phase 13 cleanup converted the
built-in tools that need heavy runtime (browser automation, chart rendering, market
data, telegram polling) from in-process classes into dockerized HTTP services. The
runtime now talks to them through `HttpToolAdapter` / `BrowserOperateHttpTool`
instead of importing their implementation.

Shipping summary:

- **Phase A** (36bc096): tool-service HTTP contract + callback API + JWT-style
  tokens + SDK skeleton in `tools/sdk/`.
- **Phase B** (7f4d749): `browser.operate` extracted as the first dockerized tool
  service. New `tools/browser-operate-service/` build context.
- **Phase C** (732123c): `chart.generate`, `market.timeseries`, `telegram.bot`
  follow the same pattern. `HttpToolAdapter` becomes the generic transport.
- **Phase D** (43f586b): `dockerToolPackageManifest` factory + scaffold so the
  tool-builder agent can produce service-shaped packages from the start.
- **Phase E** (e4a223f): per-tool stats + package manifest export endpoints.
- **Phase F** (dd4023f): structured improvement spec carried on
  `tool_build_request` (symptom, expectedBehavior, failureExamples, acceptanceTest).
- **Phase G** (deffdd1): deprecation header on `generatedToolLoader` + docs.
- **Migrations #1-5** (4011809 → 919b925 → 0af80a8 → a7b9879): activate
  `*_RUNNER=docker` for all four built-ins; port telegram long-poll loop into
  the dockerized service; drop the in-process tool classes (kept only the data
  types + type guards the runtime still reads); collapse the legacy generated
  loader into `toolPackageRunner.ts`.

Bug-fix follow-ups (run-level, see git log for details): thread artifact reuse
(`A`), POST `/api/runs` dedup window (`B`), `/api/threads/:id` alias (`C`), browser
cross-subtask dedup (`E`), revised-attempt artifact preservation (`F`), numerical
currency grounding in synthesis guard (`G`), screenshot-reuse planner directive
(`H`), null-defense in review path. Plus tool-builder issues TB-001 (over-broad
DocumentArtifact regex), TB-002 (provider order), TB-004 (outputs coverage), TB-005
(user-driven tool policy `denied`/`preferred` + capability prefix matching).

The Manual Run panel on the Tools page lets the operator hit any registered tool
with a hand-crafted JSON input and download the resulting artifacts. The Artifacts
page lets the operator delete artifacts (metadata + underlying object).


## Phase 14: Tool-Build Council

Status: **Phases A–F shipped, plus a full set of follow-up fixes; Phase G
(legacy delete) is the only pending slice.** The legacy tool-build pipeline
(six provider classes, deterministic reviewers, LLM reviewer, background
worker, "Build queue" UI) was replaced by a multi-model council driven from
inside `UniversalAgent.runToolBuildCouncil`. See
`docs/architecture/tool-build-council.md` for the design + the post-MVP
follow-ups.

Why: the legacy chain mis-matched providers (TB-001/002), produced generic HTTP
wrappers without domain inputs (TB-003/006), and required a separate UI concept
("build queue") that doesn't match how tools should actually be built. The new
flow treats tool creation as another mode of the agent: brainstorm → vote →
implement → review → revise → QA → repair → register, with every step a normal
run event.

Principles:
1. Only three primary entities: `Agent`, `Tool`, `LLM`. Tool-build is a mode of
   `UniversalAgent.run`, not a new orchestrator class.
2. The council is the list of models in `model_tier_settings.<codingTier>.models`
   (operator just picks which tier; defaults to L).
3. Side-by-side build: new path lands first, legacy stays compiling, deletion is
   the last phase only after live smoke passes.

Slices:

- **Phase A** (0d40351, 1008460): `coding_council_config` table + Postgres /
  in-memory store + `GET/PUT /api/settings/coding-council` + Settings UI
  section. Defaults: tier=L, maxRevisionAttempts=3, maxQaRepairAttempts=5,
  qaTimeoutMs=30000. **Shipped.**
- **Phase B** (shipped): pure helpers — Borda counting math, brainstorm / vote /
  implement / review / revise / repair prompt builders + unit coverage.
- **Phase C** (shipped): `UniversalAgent.runToolBuildCouncil` method end-to-end
  with a scripted council integration test.
- **Phase D** (shipped): `POST /api/tool-build-runs` (create + list) wiring the
  context into `RunsService.executeRun`, production `CouncilToolAdapter` wired
  via Nest DI.
- **Phase E** (shipped): Tool Builds page rewritten around
  `/api/tool-build-runs`; the Tools-page detail view has a Versions panel
  (rollback + LLM-written change summary) and a Request-changes form (file
  uploads supported).
- **Phase F / TB-005** (shipped): canonical source-bundle scaffold owned by
  `CouncilToolAdapter` so every council-built tool actually loads; LLM only
  emits the Tool body file. Plus a long tail of fixes:
    - Trace Graph parent edges + in-progress timers + cancel propagation.
    - LLM-synthesized canonical description + diff-aware `changeSummary` per
      version.
    - `Phase 2` reader sub-builds: missing `reads:<mime>` capability triggers
      an auto-spawned reader council run; parent run resumes when the reader
      registers.
    - Capability-aware self-check, planner, worker, reviewer — they all read
      `toolCatalogBlock(tools)` from the live registry instead of hard-coded
      tool names.
    - `BUILTIN_TOOLS=disabled` env flag for pure-council mode; bootstrap
      reconciles the `tools/` directory (orphan removal + last-5 version
      pruning).
- **Phase G** (pending): delete the legacy provider chain, workflow, worker,
  workspace QA, and "build queue" endpoints once F passes.

## Phase 15: Skill Memory Consolidation (JSON → Postgres)

Status: **Designed, not started.**

Today `SkillMemoryStore` has two implementations:
`SkillMemory` (JSON file, default path `memory/skills.json`) and
`PostgresSkillMemory` (full implementation: lexical+semantic search,
embeddings, scope/sensitivity). The `skill_memories` Postgres table already
exists (`src/db/migrate.ts:285`) with pgvector + gin indexes. Production
runtime selects between them at
`src/server/persistence/persistence.module.ts:132`:
`pool ? new PostgresSkillMemory(...) : new SkillMemory()`.

The JSON store is now effectively a legacy fallback that creates more problems
than it solves:

1. **Tests dirty the repo.** `tests/universalAgentToolBuildCouncil.test.ts:111,263,306`
   call `new SkillMemory()` without arguments, which writes to the
   real `memory/skills.json` in the working tree. The file shows as modified
   in every fresh checkout.
2. **Silent fallback hides misconfig.** If Postgres is briefly unavailable
   at server bootstrap, the server flips to JSON without telling anyone, then
   accumulates state in a file nobody is watching.
3. **CLI writes into the repo.** `src/cli.ts:15` instantiates
   `new SkillMemory()` next to the source tree, so the same default-path
   issue bleeds into local CLI runs.

**Why now:** memory shouldn't be a runtime artifact in git. Server has a
proper backend already — it just needs to be the only backend, with the
JSON path repurposed for explicit standalone use.

### Principles (kept deliberately small so any slice can be skipped)

1. **`SkillMemoryStore` interface is the contract.** No agent or service
   code learns about the concrete backend. Adding SQLite / Redis later is a
   new class, nothing else.
2. **Each slice is one PR, independently revertible.** No slice depends on a
   later slice's wiring. Slice 1 ships even if Slice 3 never does.
3. **Server fail-fast is opt-in via config flag**, so if the new behaviour
   regresses we toggle one env var instead of reverting a PR.
4. **No data migration assumed.** Existing JSON content is either junk (test
   artefacts) or one real entry — Slice 5 is optional and only runs if the
   operator decides the existing file is worth preserving.

### Slices

- **Slice A — add ephemeral in-memory store, make file path explicit.**
  Files: `src/memory/skillMemory.ts`.
  - Add `InMemorySkillMemory implements SkillMemoryStore` — a pure `Map`,
    no disk I/O, no semantic search (just substring/lexical match).
  - Drop the default value on `SkillMemory` constructor — `filePath`
    becomes a required arg. The compiler now flags every call site that
    relied on the implicit `memory/skills.json` write.
  - Purely additive (new class) plus one small signature tightening.
  - Revert = restore default arg + delete the new class.

- **Slice B — migrate CLI and tests to in-memory or explicit paths.**
  Files: `src/cli.ts`, ~16 test files under `tests/`.
  - `src/cli.ts`: branch on `DATABASE_URL`. If set → create pool, run
    `migrate`, return `PostgresSkillMemory`. Otherwise → `InMemorySkillMemory`.
    JSON file remains available only when the user passes
    `--memory-file=<path>`.
  - `tests/universalAgentToolBuildCouncil.test.ts` (the 3 dirty call sites):
    `new InMemorySkillMemory()`.
  - Other tests already pass an explicit `join(tmpdir, "skills.json")` —
    leave them alone unless trivial to flip; their writes never touch the
    repo.
  - Revert = restore `new SkillMemory()` calls + reintroduce default arg.

- **Slice C — gate the server fallback behind a flag.**
  Files: `src/server/persistence/persistence.module.ts`, `src/server/config/env.ts`.
  - Add `skillMemoryRequirePostgres: boolean` (default `true`) to env.
  - Replace the silent ternary with:
    ```ts
    if (pool) return new PostgresSkillMemory(pool, embedding);
    if (env.skillMemoryRequirePostgres) {
      throw new Error("Skill memory requires Postgres; set DATABASE_URL or skillMemoryRequirePostgres=false");
    }
    return new InMemorySkillMemory(); // ephemeral fallback, never touches disk
    ```
  - Rollback path: set `skillMemoryRequirePostgres=false` in the env file,
    no code change.

- **Slice D — stop tracking `memory/skills.json`.**
  Files: `.gitignore`, repo state.
  - `git rm --cached memory/skills.json`.
  - Add `memory/skills.json` to `.gitignore`.
  - Commit "Stop tracking runtime skill memory state".
  - Revert = `git add memory/skills.json` + remove gitignore line.

- **Slice E (optional) — one-shot importer for existing JSON state.**
  Files: new `scripts/import-skill-memory-json.mjs`.
  - Reads `memory/skills.json`, iterates entries.
  - For each: compute embedding via the same provider Postgres uses,
    insert into `skill_memories` with `ON CONFLICT (id) DO NOTHING`.
  - Idempotent: re-running has no effect once entries exist.
  - Pure addition; deletable in one commit.
  - Only worth running if operators want the one "Multi-Criteria Set
    Intersection" entry currently in the file preserved into Postgres.

### What doesn't change

- `SkillMemoryStore` interface, `SkillMemoryEntry` schema.
- Postgres table, indexes, migrations.
- Docker production runtime (it was already on Postgres).
- Agent read/write call sites in `UniversalAgent`.

### Risks and rollback

| Risk | Mitigation |
|---|---|
| Server suddenly refuses to start on a host without DB | Slice C ships behind `skillMemoryRequirePostgres` flag; set to `false` to restore old fallback without redeploy. |
| In-memory CLI mode silently loses learning between runs | Documented; users who want persistence pass `--memory-file=<path>` or set `DATABASE_URL`. |
| Lost the one accepted JSON entry on cutover | Slice E (importer) handles it; skip the slice if entry is considered junk. |
| 16 test call sites take longer than expected | Slices A–C still ship as a working set even if Slice B drags; the file just stays dirty until the test migration lands. |

### Estimate

- Slice A: ~30 min
- Slice B: ~1 h (mechanical, type-driven)
- Slice C: ~15 min
- Slice D: ~5 min
- Slice E: ~1–2 h if needed

Core cleanup ≈ 2 h. Optional importer adds 1–2 h.

## Phase 16: Tool-Build Council Robustness

Status: **In progress.** Surfaced from real failing runs:
`run_1778526527329_lour2zbm` (web.duckduckgo.search, "Tool not registered"),
`run_1778526527354_9vyn7xg0` (screenshot.url, same),
`run_1778537976034_gyr3a62p` (screenshot.url rework, "QA failed after 5 repair
attempts" yet UI label is "completed").

The Phase 14 council pipeline ships but has six independent defects that
emerged once we ran four parallel rebuilds and a rework against the same
tool. None of them block the design — each is local, testable, and
revertible.

### Defects

1. **Race on `reloadGeneratedTools`** — the provider in
   `src/server/workers/runtime-workers.module.ts:98` holds a *shared
   mutable* `loadedNames: Set<string>` across calls. Concurrent reloads
   (one council finishes while another is mid-build) unregister
   everything, then race to add their own results back. Net effect:
   tools that were registered fine get evicted mid-flight.
2. **No fallback when new version fails to load.**
   `promoteReplacement` (`src/tools/toolMetadataStore.ts:225,267`)
   flips the active version to the new one with `status: "disabled"`
   immediately. If `loadGeneratedTools` then fails to import the new
   bundle (TS error, missing dep, file write incomplete), the loader
   silently marks it unhealthy and the registry has neither the old
   nor the new version of the tool. QA call ⇒ `Tool not registered`.
3. **Disk / DB drift.** DB rows exist for versions whose
   `tools/<name>/<version>/` directory was never written or got pruned
   later. `loadGeneratedTools` returns `loaded: false` without a loud
   error; `updateHealth` writes `ok: false` but the operator only sees
   "Tool not registered" downstream.
4. **Repair attempt counter is inconsistent with "broke".** The run
   trace shows one `tool-build-code-repaired` event with
   `status: failed` ("Repair attempt 1 broke: Repair step returned no
   parsable files") but the final summary reads "QA failed after 5
   repair attempts". Either the counter advances on broken repairs
   (and the rest of the events are missing from the trace) or it does
   not (and the message lies). Pick one.
5. **`tool-build-registered` with `status: failed`.** Same event type
   covers "registered successfully" and "registered without passing
   QA". Trace UI renders both with the same green-tinted label until
   the operator hovers. Should be two distinct types
   (`tool-build-registered` / `tool-build-registration-aborted`).
6. **Run status `completed` even when QA never passed.** The rework
   run finishes with `Built screenshot.url v1.0.1; QA never passed
   after 5 repair attempts.` and yet the Runs page chips it as
   `completed`. The terminal status of a tool-build run should be
   `failed` whenever the final outcome is `QA failed after N
   attempts`.

### Slices (each independently revertible)

- **Slice A — atomic reload (defect #1).**
  `src/server/workers/runtime-workers.module.ts`.
  Replace the shared closure with a single async-mutex-guarded
  function that builds the new in-memory set first, then atomically
  swaps registry entries. No "unregister all, then reload" window.
  Tests: parallel-call test that interleaves two `reloadGeneratedTools()`
  calls against an in-memory `ToolRegistry` + `ToolMetadataStore` and
  asserts every tool ends up registered exactly once.

- **Slice B — registry resilience (defect #2 + #3).**
  `src/tools/councilToolAdapter.ts`, `src/tools/toolPackageRunner.ts`.
  After `promoteReplacement` + `reloadGeneratedTools`, the adapter
  checks `deps.getRegisteredTool(toolName)`; if undefined, roll back
  the promotion (re-activate the prior version) and surface a
  *loud* error so QA never runs against a missing tool. Loaders
  must also verify the on-disk module file is readable before
  returning `loaded: true`. Tests: adapter integration test where
  the package runner is stubbed to fail; assert prior version stays
  active and the run fails fast at the registration step (not at QA).

- **Slice C — registered-event split (defect #5).**
  `src/types.ts`, `src/agents/universalAgent.ts`, web-react Trace
  Graph color mapping. Introduce
  `tool-build-registration-aborted` for the "registered but QA never
  passed" path; reserve `tool-build-registered` for the green
  success path. Tests: trace-emit unit assertions on both branches.

- **Slice D — run terminal status (defect #6).**
  `src/agents/universalAgent.ts` (the place that decides the final
  run-level status for tool-build runs) + RunsService completion
  path. If `qaPassed === false` at the end of the loop, run
  finishes as `failed`, even when "all artefacts were produced".
  Tests: integration test that drives the council to a "5 repair
  attempts exhausted" state and asserts `run.status === "failed"`.

- **Slice E — repair attempt counter (defect #4).**
  `src/agents/universalAgent.ts` repair loop. Either always count
  broken-repair as an attempt and emit five trace events, or stop
  the loop when repair breaks (no point retrying if the model can't
  emit parsable files). Recommended: count + emit, so the trace is
  honest. Tests: assert event count matches the configured
  `maxQaRepairAttempts` when every repair returns no parsable
  files.

- **Slice F — operational follow-ups (no code).**
  - Fix the macOS Docker bind mount: it currently resolves to the
    Claude session worktree (`/Users/.../.claude/worktrees/...`)
    rather than the canonical checkout. Tracked under operator
    docs, not under runtime code.
  - Decide whether `google/gemma-4-26b-a4b` should stay in the
    default council tier — it routinely emits empty output and
    forces Borda fallback, costing ~80 s per run. Either drop
    retries from 2 to 1, demote the model, or remove it from the
    default tier.

### Validation set

After each slice, the same three runs are re-triggered through the
council:

- Fresh build for a new tool name (no DB row exists yet).
- Rebuild for an existing tool (`screenshot.url`, two versions on
  disk).
- Rework with a free-form instruction
  (`screenshot.url` → "use Playwright instead of thum.io").

Acceptance per slice ships when none of the three regress and the
specific defect the slice targets stops reproducing.

## Phase 17: Dynamic Research Delegation

Status: **Designed, starting.** Surfaced from Phase 16 reworks where
LLMs (qwen, gemma) repeatedly emitted code against stale knowledge of
third-party APIs (thum.io, DuckDuckGo) and could not self-correct
because they had no way to check the current docs.

**Goal.** Any LLM step inside the agent — council brainstorm /
implement / repair, or a regular `UniversalAgent` worker call — may
optionally delegate a research request to a fresh sub-agent run.
The delegate receives a plain-English question, uses its full tool
catalog (`web.search`, `browser.operate`, `file.read`, …) to find
an answer, and returns the synthesized result so the calling LLM
can continue with up-to-date facts.

**Key design choice (per operator feedback).** The calling LLM
does **NOT** see the names of available tools. It only knows there
is a "research delegate" that can answer questions in natural
language. Sub-agent picks tools dynamically based on the question.
The set of tools therefore stays a runtime detail — adding a new
tool to the registry instantly extends what the delegate can do
without touching prompts.

### UX (LLM perspective)

The prompt for brainstorm / implement / repair gains ONE block:

```
## Research (optional)

If you need facts beyond your training data — current API docs,
library versions, recent best practices — emit a research request:

<request_research>your question in plain English</request_research>

A universal agent will run with full tool access and return
findings. Max 3 requests per turn. If you don't need external info,
just answer normally — no penalty.
```

The LLM either answers directly OR emits a `<request_research>` block.
The coordinator parses, spawns a `UniversalAgent.run(question)`,
takes its `finalAnswer`, wraps it in `<research_result>…</research_result>`,
and re-prompts. Up to `maxRequests` cycles, then a forced-final-answer
nudge.

### Slices

- **Slice A — pure helper.** `parseResearchRequest(text)` regex /
  permissive parser + `runLLMWithResearch(llm, messages, delegate,
  options)` iteration loop. Pure, side-effect-free, unit-tested with
  scripted LLM. Lives at `src/agents/researchDelegate.ts`.

- **Slice B — `UniversalAgent.spawnResearch(question, parentCtx)`.**
  Spawns a fresh `agent.run(question, …)` inheriting instanceId /
  requesterUserId / signal from the parent. Caller gets the
  `finalAnswer`. Recursion guard: passes
  `researchDisabled: true` into the child run options so the
  sub-agent cannot recursively spawn more research.

- **Slice C — wire into council.** `runToolBuildCouncilInner`
  routes brainstorm + implement + repair LLM calls through
  `runLLMWithResearch`. Gated behind env `COUNCIL_RESEARCH_ENABLED`
  (default false). Vote and review phases stay on the plain
  `llm.complete` path — they don't benefit and we want to keep
  costs predictable.

- **Slice D — trace events.** Emits
  `research-request started` / `completed` events (parent =
  current council span) with the question + truncated findings in
  the payload. TraceLab shows them inline so the operator can see
  "during brainstorm, model asked for X, got back Y".

- **Slice E — Settings toggle.** `coding_council_config.researchEnabled`
  + Settings UI checkbox so operators don't need to set env vars.
  Follow-up after A–D stabilise.

- **Slice F — wire into regular `UniversalAgent.runWorker`.** Same
  helper, applied to worker LLM calls in the normal classify→plan→
  delegate flow. Higher regression risk; kept as a follow-up.

### Risks

| Risk | Mitigation |
|---|---|
| Sub-agent hangs or runs long | Per-request timeout (default 60 s); inherit parent `signal` so cancel propagates |
| Sub-agent returns garbage and hurts proposal quality | Findings reach the LLM as DATA, not directives — LLM can ignore. Prompt: "findings may be partial, verify carefully" |
| Infinite recursion (sub-agent requests its own research) | Child run option `researchDisabled` short-circuits the loop |
| Parser misses the marker → text returned as-is | Permissive regex; non-parsed reply is treated as a final answer. Operator sees in trace if a `<request_research>` block leaked through |
| Cost explosion | `maxRequests = 3` hard cap per LLM call; opt-in env / config flag; trace shows every spawn so operator can tune |

## Phase 18: Tool Version Lifecycle — 3 States

Status: **Designed, not started.**

The `tool_modules.status` column today is a 2-state union (`available` /
`failed` / `disabled` is on the books but semantically just "not
loaded") that two different code paths write to with different
meanings:

1. **Council `markAvailable`** (Phase 16 Slice G) — flips to
   `available` after a fresh QA pass. This is the meaningful
   "blessed" signal.
2. **`updateHealth`** at load time (legacy) — flips to `available`
   based purely on a static file-presence check by the package
   runner (entrypoint compiles, package.json present). Says
   nothing about whether the tool actually does its job at
   runtime.

Both write `available` to the same column, so the UI cannot
distinguish "file exists" from "QA passed". This is how
`screenshot.url v1.0.7` ended up labelled `available active`
in the Tools UI even though every manual call returned `HTTP 400`
— the loader was happy that the source bundle imported, status
flipped to `available`, and nothing later set it back.

### Goal

Make the lifecycle explicit with three labelled states the UI can
render distinctly:

| Status | Meaning | Sources |
|---|---|---|
| `loaded` | Loader imported the source bundle successfully. Says nothing about runtime correctness. | `updateHealth(ok=true)` |
| `available` | A QA pass (council or operator) has confirmed the tool actually works. | `markAvailable` |
| `failed` | A hard signal that the tool is broken: load-time exception, runtime QA verdict failed, or operator marked broken. | `updateHealth(ok=false)`, Slice F rollback path |

`disabled` remains as the **initial** state after
`registerGenerated` / `promoteReplacement` — meaning "newly
created, not yet probed".

So the timeline of a happy-path build is:

```
disabled  (promoteReplacement)
  ↓ loader imports
loaded
  ↓ council QA passes
available
```

A failed-QA build:

```
disabled  (promoteReplacement)
  ↓ loader imports
loaded
  ↓ council QA fails
failed   (Slice F rollback also re-activates previous version)
```

A pre-existing tool reloaded at server start:

```
available (preserved from last run)
  ↓ loader imports
available  (loader does not downgrade)
```

### Slices

- **Slice A — store schema.** Extend `ToolModuleStatus` union to
  `"disabled" | "loaded" | "available" | "failed"`. Stays
  string-backed in Postgres so no migration. InMemory store
  pattern-matches the new value.

- **Slice B — `updateHealth` no longer writes `"available"`.** It
  writes `"loaded"` on success, `"failed"` on failure. The 7
  existing tests in `tests/toolPackageRunner.test.ts` that assert
  `status === "available"` after load are updated to assert
  `status === "loaded"`. Council `markAvailable` is the ONLY
  promote-to-available path.

- **Slice C — Tools-page UI.** New badge tone for `loaded` (yellow
  / neutral, "imports OK but not blessed"). `available` stays
  green. `failed` red. `disabled` grey/inactive.

- **Slice D — operator "Mark available" action.** Per-version
  button in the Versions panel that calls `markAvailable` directly
  for a row currently `loaded`. Lets operators bless a tool they
  manually tested via Manual Run without forcing a fresh council
  QA cycle. Audit-logged.

- **Slice E — back-compat sweep.** Anywhere agent/registry code
  checks `status === "available"` to decide whether to expose a
  tool, the rule becomes `status === "available" || status === "loaded"`.
  The runtime treats `loaded` as callable; the UI distinction is
  presentation-only. (Open question: should the planner prefer
  `available` over `loaded`? Probably yes — leave for a later
  follow-up.)

### Risks

| Risk | Mitigation |
|---|---|
| Existing rows in production have `available` from updateHealth — they should not auto-downgrade to `loaded` on next reload | Slice B's revised `updateHealth` will, on `ok=true`, write `loaded` ONLY when current status is `disabled`. If current is already `available`, keep it. So a one-time pass through the loader won't strip prior blessings. |
| Tests | Slice B updates the 7 toolPackageRunner tests; nothing else asserts on `status`. |
| UI looks busier with one more badge | Keep the colour palette minimal — `loaded` is a softer green-yellow, `available` is solid green. |


## Phase 20: Auto-Improvement Migration to Council

Status: **Planned. Required follow-up to Phase G.**

Phase G deletes the legacy tool-build queue (`toolBuildProviders`,
`toolBuildWorkflow`, `toolBuildWorker`, `toolBuildRequestStore`,
+ provider implementations). The two systems that depended on it for
**autonomous self-healing** lose their backend in the process:

- **`ToolImprovementCoordinator`** — agent calls `improveTool(name,
  reason)` mid-run when a worker tool returns persistent failures.
  Today this creates a `tool_build_request` row + an investigation
  ticket; the legacy queue picks it up.
- **`ToolReworkAutoRetryCoordinator`** — when a tool rework
  (improvement) finishes, the original run that triggered it is
  auto-resumed.

After Phase G these flows are **gone**. The operator can still build
tools manually through the council UI, but the runtime cannot fix a
broken tool by itself.

### Goal

Re-wire `ToolImprovementCoordinator` + `ToolReworkAutoRetryCoordinator`
to drive **council runs** (`/api/tool-build-runs`) instead of legacy
queue rows. Single pipeline, both manual + autonomous paths converge
on it.

### Slices

- **Slice A — `ToolImprovementCoordinator.requestImprovement` migrates
  to council.** Instead of `toolBuildRequestStore.create(...)`, it
  POSTs to `tool-build-runs` with `existingToolName` + a generated
  `bugContext` describing the failure observed in the parent run.
  The agent's worker no longer waits for a "queued" state — it
  returns a `waiting_tool_rework` signal pointing at the council run.

- **Slice B — `ToolReworkAutoRetryCoordinator.notifyBuildRegistered`
  hooks the council `tool-build-registered` event.** When the
  council finishes with `qaPassed === true` and the rebuilt tool
  matches a pending wait, the parent run auto-resumes (Phase 19
  Slice A resume path). When the council aborts via `registration-aborted`,
  the wait is marked failed with the operator-visible reason from
  the trace.

- **Slice C — drop `tool_build_requests` table and store entirely.**
  Migration removes the legacy table; investigations link to council
  run ids instead.

- **Slice D — investigation UI updates.** The Tool Investigations
  page links to the council run's Trace Lab page rather than the
  retired build-request page.

### Risks

- Council runs are slower than the legacy queue (council is multi-LLM
  brainstorm + vote; queue picked the first available provider).
  Auto-improvement latency grows from ~30s to ~3min. Mitigation: a
  fast-path `councilSize === 1` mode that skips brainstorm/vote when
  the trigger is an autonomous improvement — picks the default coding
  model and goes straight to implement.
- Migration order matters: Slice A before Phase G's removal of
  `toolBuildRequestStore`, otherwise improvement requests fail with
  "store not configured" before they're rerouted.


## Phase 21: Implement-phase prompt budgeting & JSON-mode

Status: **Planned. Follow-up to Phase G empty-content debugging.**

Phase G shipped three surgical fixes in `src/llm/client.ts`:

- single-attempt for explicit-model calls (was `[m, m]`; council owns
  cross-model fallback via Borda, the duplicate added ~40 s per
  gemma-empty without recovery value);
- `finish_reason` surfaced in the empty-content error string so the
  trace shows `(finish_reason=length)` for overflow vs `(finish_reason=stop)`
  for refusal — one-glance diagnosis;
- whitespace-only output is treated as empty (was `!content`, now
  `!content?.trim()`) — gemma sometimes returns `"\n\n"` on overflow
  and the falsy-check let it slip through to a confusing downstream
  parser error.

Plus the Q4 council-side emit at `universalAgent.ts:894-921`: each
implement-attempt failure now produces a `tool-build-code-drafted`
span with status `failed` carrying `payload.prompt` and the error
detail, so empty-Gemma is now visible in Trace Lab.

What's still open after that:

- **Slice A — total-prompt budgeting.** The implement prompt stacks
  existing source (≤12 kchars), each reference doc (≤12 kchars,
  unbounded fan-out), proposal, constraints, and the optional
  research block. With two refs a rework prompt hits ~36 kchars
  before the proposal, easily overflowing gemma's ~8 k context.
  Compute char-length once and either (a) short-circuit gemma when
  the prompt exceeds a tier-specific threshold and jump to the next
  Borda candidate without an LLM call, or (b) shrink the reference
  docs proportionally so the total fits.

- **Slice B — JSON-mode for implement.** The implement prompt asks
  for `{ "files": [...] }` and parses with a brittle JSON sniffer.
  LM Studio supports `response_format: { type: "json_object" }` on
  most models; passing it would (1) make gemma-style "no commentary"
  redundant (the server enforces JSON-only), (2) bump success rate
  on quantised models, (3) let us drop the `parseFilesJson` fallback
  ladder.

- **Slice C — model role config.** Phase 16 Slice F notes that
  gemma is reliable as a brainstorm proposer but flaky as an
  implementer. Add a per-phase `disallowedModels` config so an
  operator can ban a model from implement/repair without removing
  it from the council entirely.

- **Slice D — per-retry visibility (optional).** The Q4 emit fires
  once per implement-candidate, not once per inner LLM retry. With
  Slice A above the inner retry is now a single call, so this is
  cosmetic; skip unless an operator complains.

### Risks

- Slice A's char-threshold is model-dependent. A wrong value either
  skips a perfectly viable gemma call (false positive) or lets a
  prompt through that still overflows (false negative). Mitigation:
  log every short-circuit decision with the actual prompt size so
  the threshold can be tuned from telemetry rather than guesswork.
- Slice B's JSON-mode is server-dependent. LM Studio supports it but
  vLLM / llama.cpp variants may not — gate behind a config flag and
  fall back to the prompt-only mode when the server rejects the
  request.


## Phase 22: Robust QA — cross-LLM repair + always-on research

Status: **Slices A + B shipped.** Slice C planned.

The screenshot.url council run `run_1778597878583_42xra50c` exposed
two interacting weaknesses. Gemma drafted code that did

```ts
const stealth = StealthPlugin();
browser = await puppeteerExtra.launch({ plugins: [stealth] });
```

`puppeteer-extra` silently ignores the `plugins:` option — the
correct API is `puppeteer.use(stealth)` BEFORE launch. Without an
active stealth plugin Twitch.tv served an effectively blank page,
the QA oracle saw 3 507-byte screenshots, and 5 repair attempts by
Gemma each reproduced the same wrong API call. The reviewer
(Qwen) couldn't catch it either — TypeScript accepted the literal,
no documentation lookup was wired up, and Qwen never owned the
repair so its model weights never got a chance.

### Slice A — Cross-LLM repair fallback after N failures (shipped)

`src/agents/universalAgent.ts`. The QA-repair loop now tracks
`failedRepairsByCurrentModel` per current model. After 2
consecutive failed repair attempts by the same LLM, the next
repair is routed to the next-best Borda candidate. A
`tool-build-council-winner-selected` switch event is emitted with
`payload.reason = "consecutive_repair_failures"` so the Trace
Inspector shows operators that the second model is now in play.
With `maxQaRepairAttempts=5`, two-model councils get a 2+2 split
(Gemma 2 repairs → Qwen 2 repairs) before aborting. Single-model
councils (rare; council requires ≥2 proposers in a tier) keep the
pre-Phase-22 behaviour via the `repairIdx + 1 < candidates.length`
guard.

Regression: `tests/universalAgentToolBuildCouncilRepairFallback.test.ts`.

### Slice B — Research delegation on by default (shipped)

`src/agents/universalAgent.ts`. The Phase 17 research delegation
used to be opt-in (`COUNCIL_RESEARCH_ENABLED=enabled`). It is now
on unless the operator sets `COUNCIL_RESEARCH_ENABLED=disabled`.
Cost when unused: one extra system message per LLM call. Cost
when used: one sub-agent run with full tool access (typically a
web.search via the registry). The LLM ignores the affordance
when it's confident — no penalty.

`src/agents/toolBuildCouncil.ts` (`repairPrompt`). The repair
prompt now explicitly nudges the model to emit a
`<request_research>` block FIRST when the QA failure suggests
library/API misuse (wrong plugin init, wrong option name, removed
since training cutoff). This is the only way to break a wedged
repair loop where the model is confidently-wrong about an API.

### Slice C — Batch / multi-URL QA input (planned)

`src/agents/toolBuildCouncil.ts` (`synthesizeQaInputPrompt`). The
synthesizer today produces a single JSON object. When `qaCriteria`
mentions "test on N sites/cases/examples" the synthesizer should
produce a batch of N inputs and the QA loop should call the tool
N times, presenting the oracle with the full batch verdict. This
unlocks "10 sites including twitch.tv" criteria as runtime-
validatable instead of release-smoke-only.

Implementation sketch:
- Extend the synthesizer prompt to detect cardinality cues and
  optionally emit `{"batch":[obj1, obj2, ...]}`.
- In the QA loop, if `batch` is present, call the tool per entry
  and collect the outputs.
- The oracle receives a batch verdict: pass iff every per-call
  output satisfies the criterion. Per-call failure ids feed
  the repair prompt so the model knows which inputs broke.

### Risks

- Slice A: by default a 2+2 split means Gemma gets ONE failed
  repair before its second attempt; if Gemma's first repair was
  actually fine but flaky-tool-output failed QA, we still rotate.
  Acceptable — the next model is held to the same standard.
- Slice B: research sub-agents are slow (~30-60 s each). If a
  model gets enthusiastic and emits research requests on every
  call, council time inflates by N×30 s. `maxRequests=3` per call
  caps the worst case; if it becomes a problem, drop to 1 for
  repair-phase only.
- Slice C: batch tool calls multiply the QA budget. A 10-site
  batch with 5 repair attempts = 50 tool calls. Cap the batch
  cardinality at 5-8 by default and let operators bump it
  explicitly when they know the tool is fast.
