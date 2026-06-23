# AGENTS.md

Project context and working notes for AI coding agents.

This file is the first place to read before changing the project. Keep it current when
architecture, commands, conventions, or collaboration rules change.

## Project

Agentic is a TypeScript rebuild of a universal assistant platform for one family,
household, company, or team per running instance.

The platform has three first-class primitives:

- **Agent**: an LLM-driven actor that receives one local task, uses visible context,
  calls registered tools when useful, may later delegate, and returns through a
  checkable contract.
- **Tool**: an independently versioned, portable capability package with a manifest,
  schemas, docs, its own `package.json` dependencies, settings, secret handles, runner,
  health, QA evidence, artifacts, and optional migrations. Tools should be usable outside
  Agentic as small npm-style packages, local HTTP runtimes, or containers when they are
  generic enough.
- **LLM**: a local or remote model resolved through tier/provider policy. Better models
  should improve outcomes without product-specific hardcoding.

The current rebuild baseline is intentionally small. `BaseAgent` is the only active agent
runtime. The older coordinator DAG, recursive prototype, council tool-builder, legacy Tool
Build queue, investigation flow, and tool-rework wait flow were removed from the active
tree on 2026-05-15. Reintroduce those ideas only through the roadmap, not by reviving the
deleted pipeline.

As of 2026-06-22, the active roadmap is `docs/roadmap-core-toolbelt.md` and the
executable queue is `docs/tasks/README.md`. The immediate priority is run-quality
improvement: token/time metrics, a Working Decision Ledger blackboard, source/search
discipline, proof-policy cleanup, and continuation-memory visibility. Tool builder and
external actions remain useful infrastructure, but new feature expansion in those areas
should wait until the run loop is observable, measurable, and reliable. Core tools should
be first-party portable packages registered through the same manifest, versioning,
settings, secret-handle, runner, artifact, health, and trace contracts as generated
tools.
The primary branch is now `main` at merge commit `cac5b9d`, which merges the verified
split `BaseAgent` runtime and core toolbelt from `codex/split-mainline`. Continue from
`main`; keep `codex/split-mainline` only as a preserved checkpoint branch.
The companion handoff is `docs/agent-handoff.md`. Do not continue from
`claude/phase17-research-delegation` as the active base; it was audited and still uses a
large legacy `UniversalAgent` runtime.

## Development Convention

Before implementing any non-trivial roadmap/runtime task, follow
`docs/development-convention.md`. The short rule: do not code directly from a rough
idea. First upgrade the relevant `docs/tasks/*.md` file into a self-contained
spec-first/test-first execution contract: idea, measurable increment, use cases, weak
spots, edge cases, behavior spec, architecture, low-level technical plan, test plan, and
decomposition. Implementation starts only after the task is "ready" by that convention.

For tiny mechanical fixes, use a compact version of the same process. For critical
outage/security fixes, patch first only if delay is risky, then backfill the task/handoff
documentation.

## Current Runtime

- `POST /api/runs` creates a run and executes `BaseAgent`.
- Run persistence is durable when `DATABASE_URL` is set; otherwise `RunsService` uses the
  in-memory store and runs disappear on server restart. Backend bootstrap, migrations,
  and host `npm run web:dev` load `.env` and `.env.local`, so local dev should set
  `DATABASE_URL=postgres://agentic:agentic@127.0.0.1:5432/agentic` when the compose
  Postgres service is running.
- `/api/health` exposes persistence diagnostics for database mode and stateful stores.
  The sidebar and Diagnostics page show whether runs, secrets, tool metadata, audit,
  conversations, ledgers, and artifacts are durable or volatile.
- Run metrics are projected from persisted events, not stored as authoritative columns.
  `RunsService` enriches list/detail DTOs with `metrics`: elapsed time, LLM/tool counts,
  failed tool count, artifact count, provider token usage when available, model summary,
  and slowest events. LLM events must include per-step `startedAt`, `completedAt`,
  `durationMs`, selected `model`, and numeric `usage` when the provider returns it.
  Providers without usage must remain explicit `usage unavailable`; do not display or
  persist fake zero-token totals.
- `BaseAgent` frames the task before the first LLM step, emits `agent-task-framed`, then
  sends the task, bounded context, task frame, available tool schemas, and a `finish`
  action to one LLM. The frame is generic and quality-oriented: broad/current
  recommendation, comparison, or purchase-selection tasks require structured research,
  freshness checks, multiple source-backed claims, at least one source read/extract step,
  and claim-focused proof instead of a one-search/snippet answer.
- Task framing also carries a `sourcePolicy`. Explicit no-internet/no-web requests forbid
  external source tools (`web.search`, `web.read`, `web.extract`, `http.request`,
  `browser.operate`, `browser.screenshot`) and the runtime blocks those calls without
  making the whole run unrecoverable if the model can still answer locally. Broad global
  research gets a mixed user-language/English search plan; docs/API tasks bias toward
  official reference queries; local-provider tasks bias toward location-aware provider
  queries. If a broad mixed-language run tries to finish before covering a planned query
  language, BaseAgent emits a bounded source-plan repair instruction
  (`agent-source-search-plan-repair-requested`) instead of silently accepting shallow
  research.
- Tool calls execute only through `ToolRegistry` with run-scoped runtime context:
  run/thread/user/instance provenance, per-call span id, artifact writer, callback
  envelope, secret/configuration resolvers, audit, and logger.
- BaseAgent tool calls write Work/Evidence Ledger records through the per-run
  `RuntimeLedgerCoordinator`: claim a run-local execution work item before execution,
  store the canonical reusable work key in metadata, complete or fail the work item after
  execution, record evidence with tool/source/artifact/QA metadata, and link generated
  artifact ids back to the work item. Ledger writes are observability-only and must not
  fail the user run when a ledger store is unavailable.
- Safe deterministic tool calls now use the Ledger as execution memory, not only audit.
  Successful `http.request` `GET`/`HEAD` calls publish a thread/instance-scoped
  reusable-index work item without a `runId`; later identical calls in the same scope can
  reuse fresh passed evidence for up to 10 minutes while still creating a run-local
  work/evidence record and trace events (`work-ledger-reuse-available`,
  `work-ledger-reuse-applied`). Reuse is disabled for HTTP tasks with current/fresh/live
  signals such as "сейчас", "latest", "today", "цена", or "курс"; those skips emit
  `work-ledger-reuse-skipped` so Trace Lab explains why a fresh tool call happened.
  Deterministic `data.transform` and inline-content `document.extract` calls also publish
  reusable-index records; mutable `file.read`, `file.write`, URL extraction, and path
  extraction do not reuse because their contents or artifacts can change.
- Explicit local file/document/data tasks frame as `local_utility`: use
  `document.extract`, `data.transform`, `file.read`, and `file.write` directly, suppress
  web/browser discovery unless the user asks for external discovery or visual proof, and
  treat local tool output / generated files as the proof.
- Obvious local JSON/CSV/text transformation tasks can use the local utility fast path:
  infer direct `data.transform` / `file.read` / `file.write` / `document.extract`
  chains deterministically, execute them through the normal registry/Ledger/trace path,
  save `file.write` outputs as run artifacts, and finish without entering the general
  LLM ReAct loop. Less obvious file/document/data tasks still use the `local_utility`
  frame and the regular agent loop with only the local tool family available.
- Narrow explicit current fact tasks can use the current-fact fast path when `web.search`
  and `web.read` are both available. The runtime deterministically searches, ranks
  proof-worthy sources away from stale/social/listing noise, reads the selected source,
  can use selected search evidence directly when the read is blocked but the snippet has
  standalone current evidence, optionally captures a focused `browser.screenshot` only
  when the task asks for visual proof, and then performs one no-tools synthesis call
  grounded to the selected primary source. Broad recommendations/selections stay on the
  normal research path. If screenshot QA fails, the run should degrade to source-evidence
  proof instead of losing the answer.
- BaseAgent loops are budgeted BY DEFAULT: `maxSteps` comes from the task frame
  (`defaultMaxStepsForTaskFrame` — 10 base, 12 for product selection, 18 for external
  action preparation) and `maxToolCalls` defaults to `maxSteps * 4`. Unbounded research
  was a product bug (observed live: 209 events / 16 minutes on one selection run).
  Callers may still override the budgets explicitly for deliberately long loops.
  The FINAL budgeted step forbids tool calls (`toolChoice: "none"`) and pushes a
  wrap-up nudge so the run ends with an answer synthesized from collected evidence,
  not a step-limit failure stub. Truncated final answers and raw tool-syntax leakage
  (`<tool_call>` / `<function=` XML from local models) each get a bounded no-tool
  repair extension step past the budget; after that the finalization gate fails the
  run honestly. Direct no-tool frames such as `direct_fact` and
  `thread_context_answer` with no research contract must keep `toolChoice: "none"` for
  every LLM step, including repair extensions. If a truncated draft contains raw
  function-style tool prose such as `file.read(path="...")`, the repair prompt scrubs
  that partial draft instead of reinforcing the invalid syntax. Within one run,
  repeated or near-duplicate `web.search` queries are
  skipped and traced with `duplicateSkipped` so the model must reuse prior evidence
  or change strategy materially.
- LLM tool context is scoped by task frame. No-tool frames, including explicit
  no-internet/no-web comparison frames with a zero research contract, send no tool
  schemas and no tool catalog to the model. Research/product-selection frames get only
  source/proof tools; local-utility frames get file/document/data tools; external-action
  frames get source/browser/prepare tools. Run-scoped candidate tools remain visible
  regardless of the frame. This keeps local-model context under control and prevents
  unrelated tools from steering the task.
- `RunSourceRegistry` is the run-scoped source memory for the normal research loop. It
  normalizes and redacts URLs before display/persistence, strips tracking and secret-like
  query parameters, skips duplicate normalized `web.read` attempts, records blocked or
  failed source reads as rejected evidence, and allows a retry only when the read strategy
  changes materially. Source lifecycle events are `source-search-plan-created`,
  `source-discovered`, `source-read-recorded`, `source-read-skipped`, and
  `source-rejected`. Broad research must not treat technical assets or search result
  pages as durable sources: CSS/fonts/images/scripts, provider search pages such as
  `youtube.com/results`, and social/search result pages are filtered from source
  discovery, skipped before `web.read` unless the user explicitly targets that host, and
  kept out of the Working / Decision Board candidate list.
- Small-context local models get rolling context compaction: once the dialog exceeds
  `DEFAULT_CONTEXT_CHAR_BUDGET` (60k chars), tool messages older than the most recent
  three are compacted to a short head before each LLM step. A context-window error from
  the model compacts to half the current size (keeping only the latest tool result
  verbatim) and retries the same step; recovery is bounded because compaction
  eventually has nothing left to shrink.
- Run-scoped tool candidate attachment is DETERMINISTIC: a generated tool is attached
  to a run only when a distinctive token of its NAME appears in the task (e.g. "амл"
  matches `crypto.aml.gl`). Description/capability text-similarity matching is
  forbidden — it once attached a stale `example.com` reservation-commit tool to an
  ordinary booking task. Host-attached initial candidates are OFFERS: the
  unused-candidate gate skips them (`initialAttachment: true`); only candidates the
  agent itself requested mid-run must be used before finishing.
- Thread memory must survive restart/resume: any path that starts a run with only a
  `threadId` gets the conversation context rebuilt from the thread record
  (`RunContextResolver.threadContextForThreadId`). The thread summary appends the
  newest "Answered:" digest at the END; prompt rendering must keep enough tail
  (currently 1 400 chars) so the latest answer is not truncated away.
- Follow-up questions about prior answers, sources, artifacts, or already-discussed facts
  can frame as `thread_context_answer`. That mode answers from thread summary, accepted
  facts, and open questions, and it must not force a fresh web/current lookup just to cite
  what the previous answer already used.
- Before tool execution, `BaseAgent` asks `RuntimeLedgerCoordinator` for a compact
  `PriorWorkContext` when a thread-scoped Work/Evidence Ledger is available. Empty threads
  stay silent. Source/artifact follow-ups can short-circuit from passed prior evidence with
  no LLM call and no new tool call; the trace emits
  `work-ledger-prior-context-resolved` and `work-ledger-prior-context-applied`, and the
  Ledger records a run-local prior-work decision/evidence item for the applied reuse.
  Fresh/current requests treat prior evidence as context only and continue to fresh
  tools. Failed or blocked prior evidence is never reused as truth; it is exposed as
  `retryExclusions` so browser/search/external-action retries can avoid rejected URLs.
- Run/thread/user/group/accepted-learning memory is assembled through
  `MemoryContextView` in `src/agents/memoryContext.ts`. `RunAgentRuntimeHelpers` retrieves
  accepted visible memories from `SkillMemoryStore`, `BaseAgent` filters them through
  memory policy, injects the compact view into the prompt, and emits
  `memory-context-prepared`. Do not add ad hoc memory prompt sections elsewhere.
- Memory-source use is observable through `memory-use-resolved` events built by
  `src/agents/memoryUse.ts`. Records cover run, thread, user profile, group profile,
  accepted memory, Work Ledger, and Evidence Ledger with statuses `used`, `available`,
  `ignored`, `stale`, or `insufficient`. These records are safe summaries only: expose
  source, status, reason, and safe ids, not raw memory content or secrets. The Working /
  Decision Board projects them into `snapshot.memoryUse`, and Run Workspace plus
  Conversation detail render them for operators. After prior-work resolution,
  `baseAgentPriorWork` must rebuild `MemoryContextView`; otherwise Ledger decisions are
  not visible in the prompt or memory-use projection.
- The whole `/api` surface supports an opt-in shared operator token:
  `AGENTIC_API_TOKEN` set -> every request needs `Authorization: Bearer`,
  `x-agentic-token`, or `?token=` (timing-safe compare); unset keeps the open
  localhost-dev behavior. Exempt: `/api/health`, `/api/tools/callbacks/*`
  (own HMAC tokens), `/api/fixtures/*` (local browser fixture pages). The
  React console does not attach the token yet — enable it only for headless
  /API deployments until the UI learns to store it.
- Core toolbelt tools are preinstalled first-party tools registered at bootstrap through
  `createCoreToolbelt()` by default. Set `BUILTIN_TOOLS=disabled` only for focused tests
  or generated-tool-only experiments. Core tools are synchronized into tool metadata as
  built-ins and should be directly offered to agents when metadata/readiness marks them
  available. Generated/package tools still use the manual QA/promotion flow.
- `/api/tools` now returns normalized `ToolCatalogEntry` records from
  `src/tools/toolCatalog.ts`. Each record has a `catalogLayer`
  (`core`, `generated-active`, `generated-inactive`, or `legacy-reference`) plus
  `agentEligibility`. The React Tools page defaults to `core + generated-active` and
  exposes Core, Generated, Inactive, and All filters. The run-side tool catalog uses the
  same eligibility helper, so agents receive only tools that are registered, available,
  runtime-ready, healthy, and safe to expose. Guarded commit tools such as
  `external.action.commit`, loaded/disabled/failed tools, and missing generated packages
  stay visible for operators but are not offered to agents.
- Durable agent-level smoke on 2026-06-18 passed the active core-toolbelt baseline:
  direct no-tool answer, `http.request` JSON fast path without screenshot proof,
  current web fact with QA-passed screenshot proof, and `data.transform` -> `file.write`
  with a previewable/downloadable CSV artifact in the React Run Workspace.
- Durable manual smoke on 2026-06-19 rechecked the P0 fast/correct path on the active
  stack: `run_1781888955776_r5xgx351` completed a simple direct answer with no tool
  events and no raw tool syntax, while `run_1781888955810_o4iy48ap` completed a current
  Bitcoin price request with `web.search`, `web.read`, QA-passed `browser.screenshot`,
  and downloadable PNG artifact `artifact_1781888964363_ap1p51dc`.
- `data.transform` should accept common LLM-shaped operation inputs where reasonable:
  JSON-looking string inputs are parsed before operations, operation path aliases include
  `path`, `key`, `field`, and `column`, and sort direction may be `direction` or `order`.
- Successful `file.write` tool calls should register the written content as an output
  artifact from the tool input payload, not by rereading a shared workspace path. This is
  required for future containerized tools that do not share the app filesystem.
- Every migration statement that recreates `runs_status_check` must include
  `waiting_approval`; durable databases can already contain paused approval runs.
- Automated P0 coverage verifies `http.request` creates `api_call` work plus
  `api_response` evidence, `file.write` links generated file artifacts through both
  Work Ledger and Evidence Ledger, and explicit local data/file tasks frame as
  `local_utility`. It also verifies cross-run safe reuse for identical stable
  `http.request` GET calls and deterministic `data.transform` calls through the
  reusable-index path, and verifies that current/fresh tasks bypass reusable HTTP
  evidence with a trace-visible `work-ledger-reuse-skipped` event. Durable live smoke
  also passed across a backend
  restart: `run_1781818681262_rpvsg59u` keeps one completed `api_call`, one
  `api_response`, linked artifact `artifact_1781818687616_9q389ujl`, and the same data is
  visible in the React Ledger page in `Backend ready · postgres` mode.
- BaseAgent trace spans now use stable parent/child ids for the root agent, context,
  every LLM step, every tool call, artifact saves, and the return gate. LLM spans record
  safe normalized `input`/`output`; tool spans record summarized tool `input`/`output`.
  Trace Lab renders these as arrows plus inspector call details. LLM route decisions are
  also trace-visible through `model-route-selected`, including the requested tier,
  selected model, matched capabilities, and rejected candidates.
- Runs also emit a Working / Decision Board projection through
  `src/agents/workingDecisionLedger.ts`. `RunsService` wraps the run event sink and
  derives `working-decision-*` events from task framing, prior-work reuse, LLM/tool
  activity, artifacts, repair gates, finalization, and completion/failure. The board is
  event-derived, not a separate source of truth, and the React Run Workspace plus Trace
  Lab render the latest snapshot with objective, phase, known facts, candidates,
  rejected evidence, open questions, next action, draft status, compact metrics, scores,
  source/proof refs, and uncertainties. `BaseAgent` exposes a safe
  `update_working_board` meta-action so the model can write structured progress without
  exposing hidden chain-of-thought; invalid updates are redacted, rejected, and preserved
  as board evidence instead of failing the run. Source events from `RunSourceRegistry`
  are projected into source facts/candidates/rejected evidence so operators can see which
  pages were discovered, read, skipped, or blocked. Trace Lab prefers semantic LLM labels
  derived from model output, such as `Choose tools: web.read`, when available.
- Source-backed/current answers require proof by default when artifact saving and proof
  tools make it possible. If the model tries to finish early, BaseAgent emits
  `agent-proof-repair-requested`, blocks that `finish`, and gives the model a bounded
  repair turn to capture focused proof before finishing again. If screenshot proof keeps
  failing but a useful text report already exists, the runtime preserves the draft and
  either saves a JSON source-evidence proof artifact from extracted URL evidence or
  returns a degraded answer with an explicit proof note instead of losing the report.
  External-action preparation tasks are the exception: source proof for the chosen
  provider is useful, but filled-form screenshots and commit proof belong to the
  approval/prepare/commit lifecycle, not the base agent loop. External-action
  preparation proof artifacts are visual-QA checked before they count as usable commit
  proof; failed/blocked screenshots can remain visible in UI diagnostics but are not
  returned as prepared-session proof ids.
- API/HTTP/JSON endpoint tasks and local-utility tasks should use structured protocol or
  source evidence as proof by default. They must not trigger visual proof repair or call
  `browser.screenshot` / `browser.operate` unless the user explicitly asks for visual
  proof of a web page. They may still save a sanitized structured/source proof artifact
  such as HTTP status, response fields, and source URL. Explicit HTTP/API URL commands
  (`GET`, `POST`, cURL/API/JSON endpoint wording with a URL) are treated as an explicit
  `http.request` tool need, even when the task otherwise frames as a direct fact. They
  must not be answered from model memory; the return gate requires structured/source
  evidence before completion.
- BaseAgent is offered only tools whose `ToolCatalogEntry.agentEligibility.offered` is
  true. `loaded`, `disabled`, `failed`, unhealthy, runtime-missing, guarded-commit, and
  metadata-only generated tools remain visible in Tools for manual checks but are omitted
  from agent prompts/tool schemas.
- One exception exists for operator testing: if the task explicitly asks to use a
  particular disabled generated tool, RunsService may attach the best matching healthy
  version to that run as a `run_scoped_candidate`. If the task names a concrete generated
  version such as `tool.name@0.1.20`, RunsService pins that exact version for the run even
  when another version is globally active. The agent must call it before finishing, but
  the candidate uses `promotionPolicy=manual` and is not made globally available from that
  run automatically. After completion, Run Workspace can use that successful run-scoped
  candidate run as verification evidence for an operator-triggered activate/reject
  decision.
- Before each run, RunsService enriches the visible tool catalog from metadata. The LLM
  sees callable tool names plus active version, source/status, capabilities, schema keys,
  examples, required settings/secrets, health, usage counters, change summary, and compact
  version history. Candidate versions are context only unless a tool creation/edit
  request attaches one candidate to the current run as `run_scoped_candidate`.
- BaseAgent also exposes a `request_tool_creation` meta-action. When the LLM determines
  that no enabled registered tool can satisfy a required capability, RunsService turns
  that request into the normal Tool Creation V1 flow with `source: "agent"`, a linked
  parent run id, trace events, package-local QA, and a generated package candidate. For
  agent-originated task runs, the freshly created or reused candidate is loaded back into
  the same run as `run_scoped_candidate`; the agent must use it to finish the original
  task. If the model tries to finish before calling that candidate, BaseAgent blocks the
  answer, emits `agent-candidate-use-repair-requested`, and gives the model a bounded
  repair turn to use the candidate first. If that run passes the return gate after using
  the candidate, RunsService accepts it as agent-verified evidence, marks the version
  available, activates it, and reloads the registry for future agents. Operator-originated
  creation still requires manual pinned-run evidence before promotion.
- BaseAgent also exposes `request_tool_edit`. When an enabled generated tool is relevant
  but insufficient, RunsService routes the request into Tool Editing V1 with
  `source: "agent"`, a linked parent run id, and a disabled inactive candidate version.
  The previous active version remains active for other runs, while the requesting run can
  use the new version as a pinned `run_scoped_candidate`. If that run succeeds after
  using the candidate, RunsService accepts it as agent-verified evidence, marks the
  version available, activates it, reloads the registry, and future agents get the
  improved version instead of requesting the same edit again. Similar future edit
  requests reuse a matching inactive candidate before building another package.
- Tool Creation V1 has a first source-bundle path:
  `POST /api/tools/create-package` and the Tools page accept a capability request, run it
  through `ToolBuilderAgent` strategy planning, create a package under
  `tools/<name>/<version>`, run package-local build/test QA, register and reload the
  manifest, and record durable creation history. Create requests accept
  `activationPolicy: "manual" | "available_on_success"`: manual keeps the tool disabled
  for pinned verification, while available-on-success enables it after successful QA
  unless QA reports `requiresManualLiveVerification` for live provider/secret-dependent
  checks. `ToolBuilderPackageAuthor` can ask the
  XL-tier model for a complete JSON source-bundle snapshot when
  `TOOL_BUILDER_AUTHORING=llm` or request body `authoringMode: "llm"` is used; guardrails
  reject unsafe paths, raw secrets, and Agentic-internal imports before package QA. If
  authoring fails, the durable record keeps fallback notes and the guarded scaffold
  writer is used. `ToolImplementationDiscovery` can search npm registry candidates when
  `TOOL_BUILDER_DISCOVERY=npm` or request body `discoveryMode: "npm"` is used; selected
  dependencies are package-local, selected package metadata/README hints are inspected
  when available, and discovery/inspection evidence is stored in the creation record.
  README usage can produce an `adapterContract` for default callable, named export, or
  namespace member npm APIs; README examples with a single object argument can also
  produce `inputMode: "object"`, a derived object input schema, and an example payload.
  The generated package uses that contract during `/health` and `/run`. Creation requests
  can include `behaviorExamples`; examples may be single-call checks or multi-step
  scenarios. Scenario steps call `tool.run()` repeatedly, can save prior outputs with
  `saveAs`, and can pass values into later inputs with placeholders such as
  `{{created.data.id}}`. QA can assert content, data paths/equality/includes, artifact
  MIME, and PNG visual usability. ToolBuilderAgent can also infer examples from explicit
  input/output text, README package examples with expected output comments, and simple
  original-task text transforms such as camelCase, slug, lowercase, uppercase, and trim.
  Operator-provided docs, OpenAPI JSON/YAML, cURL snippets, HTML endpoint pages, and docs
  URLs are inspected during implementation discovery and can produce provider-neutral
  `external-api` candidates plus behavior QA fixtures, including simple chained
  `POST -> GET` scenarios. Docs URLs use a bounded same-origin crawl for relevant
  API/auth/reference/example links. HTML docs extraction can merge base URL, method/path/
  query examples, auth hints, and nearby JSON response examples across those pages. When
  a chained OpenAPI scenario exists, generated standalone fixtures are limited to
  operations that can run without hidden path/state context, so QA proves the capability
  instead of failing on brittle docs examples.
  Tool package manifests can also carry `integration` contracts. On-demand API clients
  use `mode=run-on-demand`; bots, listeners, and webhooks use
  `mode=always-on-service` with inbound/outbound event schemas, lifecycle operations,
  callback strategy, and secret handles. `service-adapter` generation must preserve
  inherited always-on integration contracts during edits; the UI and backend must not
  downgrade an always-on base version to an echo/custom scaffold because of a stale
  strategy hint, and QA rejects always-on packages without `startService()`. Activating,
  promoting, or agent-accepting a new always-on version must restart the running service
  supervisor process when that service is desired running; metadata-only version switches
  leave stale provider loops alive. Known
  messaging providers can use deterministic generated provider loops inside the source
  bundle; for Telegram this means `getUpdates` -> generic
  `/api/tool-services/:name/inbound`, generic outbox polling -> `sendMessage` plus
  artifact-aware `sendPhoto`/`sendDocument`, and outbox ack. Service-event intake must record failed run creation
  as explicit `system/failed` events, and allowing a channel identity from an inbound
  event should replay that event once into a normal run. Outbound provider error details
  are secret-redacted before persistence. Unknown channel senders should be reviewed in
  the Channels page `Pending channel users` flow, where operators can map the event to an
  existing user or create a new user before aliases are allowed and the inbound event is
  replayed. Unknown providers may still fall back to a service
  scaffold, but core runtime must not grow provider-specific branches. The deterministic
  HTTP API scaffold accepts `url` or
  `baseUrl + path`, generic `target`, `method`, `query`, JSON `body`, and safe non-secret
  headers, then turns OpenAPI security schemes into runtime secret-handle requirements, supports
  `operationId` dispatch with `pathParams`, derives standalone path/query examples from
  documented examples/defaults/enums, stores OpenAPI server URLs as provider-neutral
  integration targets, expands OpenAPI server variables into concrete targets, parses
  adjacent uploaded YAML/OpenAPI context files independently even without YAML document
  separators, preserves block scalar descriptions, and can add human-readable target
  aliases when enum values line up with names in spec descriptions. It can default to the
  only documented operation for single-operation API tools,
  derives request/response QA examples from `$ref` component schemas,
  and exposes parsed JSON response fields at
  top-level `data` plus `data.response` so chained QA can pass values such as
  `{{created.data.id}}` into later calls.
  Do not add provider/domain-specific concepts such as blockchains, restaurant providers,
  or messaging vendors to the core contract; represent them as generated-tool docs,
  target aliases, schemas, settings, and metadata.
  LLM-authored package snapshots may also return behavior examples; if the plan did not
  already have deterministic examples, those authored criteria are executed as package
  QA. These examples are stored in the manifest/strategy record and executed against the
  built package before registration, so a package that compiles but misses expected
  behavior remains `qa_failed`. ToolBuilderAgent also
  recognizes live web-search requests as a dedicated `web-search` strategy and known-URL
  page-reading/extraction requests as a `web-read` / `web-extract` source-bundle
  strategy. `web.read@0.1.0` was created through Tool Creation V1, behavior-QA'd against
  example.com, manually run against a laptopunderbudget.com article, and enabled for
  agents so broad research can read source pages beyond shallow search snippets.
  Creation/editing runs now emit
  parent-linked discovery, strategy, authoring, QA, registration, reload, and
  completion/failure spans with normalized `input`/`output` so Trace Inspector can show
  what each lifecycle stage received and returned. The deterministic scaffold exposes
  `query`/`limit`, tries a configurable JSON search endpoint, falls back to DuckDuckGo
  HTML result parsing, and enriches results with short page previews so a task can finish
  from evidence instead of only receiving links.
  Browser screenshot requests can select a `browser-screenshot` package strategy. The
  generated package owns `playwright-core`, exposes URL/viewport/wait options, resolves
  Chromium from `CHROMIUM_PATH`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, or standard
  Playwright cache directories, and returns PNG bytes through an artifact-shaped result.
  Current generated screenshot packages default to viewport capture (`fullPage: false`)
  and support optional `focusText` / `selector` inputs so proof images scroll the
  relevant value or page section into view instead of storing a noisy full-page dump.
  Each creation attempt also creates a normal run and stores `runId` on the Tool
  Creation record; Runs/Run Workspace show `tool-creation-*` trace events for discovery,
  strategy selection, authoring, package QA, registration, and completion/failure.
  Runs and Dashboard mark these records with a tool lifecycle badge.
  Failed/QA-failed creation attempts can be deleted from Creation history. Cleanup removes
  the creation record, linked trace run, package workspace under `tools/<name>/<version>`,
  and tool-scoped secret handles such as `secret.tool.<name>.*`; registered tools still
  use the normal generated-tool lifecycle delete.
  Tool names are semantic capability names (`web.fetch`, `browser.screenshot`,
  `text.slugify`), while generated/imported/OCI/external provenance belongs in manifest
  and creation metadata.
  `GET /api/tools/:name/source-bundle` exports portable source bundles; `POST
  /api/tools/source-bundles` imports and re-QAs them.
- Tool Editing V1 is active for generated source-bundle tools:
  `POST /api/tools/generated-modules/:name/versions` and the Tools page "Request tool
  edit" form accept an operator change request, create `tools/<name>/<new-version>`, run
  package-local QA, register an inactive disabled candidate, reload the runtime, record
  a Tool Creation history row and normal traceable run, then leave the previous active
  version active until promotion. Operator edits still use manual verification/promotion;
  agent-requested edits use scoped continuation first and auto-accept only after the
  originating run succeeds with the candidate. Previous versions remain visible in the
  versions panel for activation/rollback.
- Tool onboarding/edit context is first-class per tool. `tool_context_items` stores docs,
  OpenAPI specs, docs URLs, uploaded file text, notes, and QA examples; version edits
  automatically feed active context items back into the builder, and the Tools UI can
  show, edit, or delete individual context entries without touching versions or secrets.
- Generated tool versions can be manually run without activation through
  `POST /api/tools/generated-modules/:name/versions/:version/run` and the Tools Versions
  panel. Use this for candidate/rollback review; it loads the pinned package through its
  runner but does not expose that version to agents. The same panel now shows an
  active-versus-candidate review with package refs, status, capabilities, health, run
  counts, QA summary/checks, pinned manual-run evidence, run-scoped candidate evidence,
  and the explicit activation action. Server-side activation and mark-available reject
  inactive generated versions until that exact version has a successful pinned manual run
  or completed run-scoped candidate run recorded as evidence.
- Version lifecycle actions are first-class observable events. Creation, pinned manual
  run, mark-available, activation, agent acceptance, rejection, and delete actions appear in
  the Versions panel and are appended to the original tool creation/edit trace run with
  normalized input/output payloads.
- Rejected generated versions are not deleted. They remain in version history with
  `reviewStatus: "rejected"` and a rejection reason, but the server blocks activation,
  mark-available, agent-scoped loading, and future reusable-candidate selection for that
  version.
- The Tools page has a Candidate Review queue built from the enriched `/api/tools`
  catalog. It groups generated versions into `needs manual run`, `ready to activate`,
  `activated`, `failed`, `rejected`, and `superseded`; exposes select, pinned sample
  run, activate, reject, origin-trace, evidence-run/evidence-trace, and decision-trace
  links; and keeps accepted/rejected plus older superseded versions out of the actionable
  queue. Superseded versions remain visible in version history for explicit rollback.
- Tool-returned and tool-written artifacts/screenshots are saved through the normal
  artifact store path. The React run/trace artifact gallery and the Artifacts page show
  artifact `quality` status/check details when present.
- Tool Creation/Editing QA distinguishes deterministic package failure from live-source
  fragility. Structural/build/test failures and semantic behavior mismatches remain hard
  `qa_failed` results. Public external URL/search/API behavior examples retry transient
  network/provider failures and can register the candidate disabled with
  `requiresManualLiveVerification` plus structured QA warnings/issues when the package
  itself passed deterministic checks.
- Generated `http-json` API clients treat HTML/SPA responses as API contract mismatches,
  not successful JSON/API calls. A docs-only API tool can be created, but it is not
  considered good just because a frontend URL returns HTTP 200. New generated HTTP
  clients also return structured request diagnostics for every call: selected operation,
  requested/resolved target, redacted URL, auth handle metadata, status, and bounded
  fetch timeout/failure detail. Non-2xx provider responses must include a generic
  `providerError` summary/category/hints plus the selected operation `inputContract`, so
  the next agent attempt can repair parameters or choose a different operation without
  provider-specific core code. Secret-looking query params and credentials must be
  redacted before trace/UI exposure.
- The BaseAgent tool-result message renderer turns `http_provider_error` diagnostics into
  explicit repair guidance for the next model turn. The agent sees the provider error
  summary/category, generated operation input contract, and generic retry instructions, so
  it can correct parameters or select another operation/target without a domain-specific
  retry branch in core runtime.
- Runs fail when an explicitly required artifact action produced no artifact.
- Visual screenshot QA rejects centered consent modals and lower-left consent panels over
  blurred/low-detail page content while avoiding ordinary page sections with CTA
  buttons. Tool package behavior examples may now require
  `expectedArtifactMimeType` and `expectedArtifactVisualOk`, so Tool Creation/Editing QA
  can fail browser/screenshot candidates that return blocked proof images even when the
  package compiles and returns `ok: true`.
- Runs that use public external URL evidence should produce a proof artifact when the
  runtime has artifact saving wired. `BaseAgent` prompts for a screenshot/equivalent
  artifact; screenshot proof artifacts get compact `quality` metadata and failed
  visual/blocker/source-match/claim-match QA does not count as usable proof. Failed proof
  QA is fed back into the next LLM step so the agent can retry with the exact source URL,
  tighter `focusText`/selector, or another directly relevant source. When screenshot
  proof is unavailable or repeatedly rejected, BaseAgent can save a JSON
  `source-evidence-proof` artifact from `web.read`/search evidence. Broad
  product-selection source proofs must match concrete final-answer candidate signals
  such as model names, not generic words like "gaming" or "price". The preinstalled
  `browser.screenshot` wrapper must run visible-page text extraction before capturing
  the image, so current-fact synthesis and proof QA can inspect what was visible on the
  page instead of treating the PNG as opaque. Browser artifact semantic QA must receive
  the extracted visible text/links from the tool result and hard-reject provider
  interstitial, security-check, login, consent, loader, or challenge pages before
  source-URL or claim-signal matches can mark the artifact usable.
- BaseAgent extracts proof signals such as source-backed values from non-screenshot
  evidence and includes the best one in the proof instruction as `focusText`. Screenshot
  semantic QA receives those expected signals so a focused proof image is checked against
  the object/value found by the earlier evidence, not only against the source URL.
- Proof repair uses a claim-aware proof target planner. It ranks source URLs by
  final-answer claim matches and chooses `focusText` from those matched claims, so generic
  signals such as a year do not override a concrete product, service, version, API, or
  value that the answer actually depends on.
- Source-backed answers now pass a generic source-grounding gate before proof repair.
  Concrete final-answer claim signals such as names, versions, specs, dates, prices, or
  externally checkable identifiers must appear in non-screenshot source evidence gathered
  during the same run. If they do not, BaseAgent emits
  `agent-source-grounding-repair-requested` and asks the model to gather/read better
  evidence or remove/soften unsupported claims. If budget is exhausted but the answer has
  user value, BaseAgent preserves it with an explicit source-grounding note.
- Final answers also pass a first deterministic consistency gate. BaseAgent checks
  relative date/weekday claims against runtime date/timezone, checks that named proof
  artifacts did not fail QA, and checks that proof artifacts are not attributed to a
  different source than their artifact metadata. When a mismatch is found, it emits
  `agent-final-answer-grounding-degraded` and appends a visible consistency note.
  Failed proof artifact markdown/lines are stripped from the final answer before the
  note is appended, so rejected screenshots are not still presented as proof.
- If screenshot proof failed and the run falls back to a JSON `source-evidence-proof`
  artifact, BaseAgent removes stale "confirmed by screenshot" wording from the preserved
  draft before adding the actual proof artifact reference.
- Screenshot proof regrading must not use the failed claim-check's own expected signals
  as evidence. A rejected proof can be upgraded only from independently passed browser
  semantic/source checks that actually contain final-answer claim signals.
- Broad recommendation/product-selection runs have a research contract. If the model
  tries to finish after shallow evidence, `BaseAgent` emits
  `agent-research-contract-repair-requested` and asks for independent freshness,
  candidate discovery, final-claim verification, and a source read/extract call on a
  candidate URL. If search snippets are not enough or no reader exists, the model should
  request a web read/extract tool rather than fabricate the recommendation. The repair
  instruction must name the actually available sanitized read/extract tool actions
  (`web_read`, `web_extract`, or equivalent) and tell the model that the next tool call is
  a source read/extract call, not another broad search. For these frames, proof QA also
  receives final-answer claim signals, so a screenshot of an intermediate roundup heading
  is not enough proof for final recommendations. Product-selection quality is measured
  by source coverage more than raw search count: two successful research calls plus at
  least three independent proof-worthy URLs and at least one successful source read are
  sufficient for the gate.
- Artifact endpoints render inline by default and support `?download=1` for attachment
  download. React artifact cards show image previews/lightbox, text previews when
  available, QA status, and separate Preview/Open versus Download actions. Run Workspace
  and Conversation views hydrate final-answer markdown links such as
  `![Proof](coinmarketcap.png)` to the matching run artifact URL; bare filename links
  must not render as broken `/run/.../file.png` paths.
- For current external facts such as prices, quotes, weather, or news, screenshots are
  proof only. The run must first use a search/fetch/data tool that returns text or
  structured evidence; a screenshot-only answer fails the base return gate. Successful
  API/data tools can now produce a sanitized `structured-data-proof` JSON artifact from
  the request/response, so JSON endpoints do not need a screenshot when source-based proof
  is sufficient.
- Successful identical tool calls inside one run are reused by tool name plus stable
  input JSON, and the trace records the repeated call as reused instead of executing the
  same tool again.
- Agent-requested tool creation should not downgrade an existing generated tool family:
  a default `0.1.0` request is non-binding when newer non-failed versions exist, and the
  host should attach the best healthy/latest candidate.
- Generated tool edits receive the editable per-tool context store. Current edit context
  can also invalidate inherited integration targets generically: if docs or operator
  notes explicitly forbid a host, URL fragment, or target alias, matching inherited
  targets and base URLs are removed before the builder merges the next contract.
- Run statuses are only `queued`, `running`, `completed`, `failed`, and `cancelled`.
- `resume` currently restarts the run; span-level resume/retry is future work.

## Removed Legacy Surface

The following are intentionally gone from the active product:

- `/api/tool-build-runs`
- `/api/tool-build-requests`
- `/api/tool-investigations`
- `/api/tool-rework-waits`
- `/api/tool-migrations`
- Tool Builds page
- Coding Council settings UI
- Trace Lab investigation/rework modal flow
- Tools-page request-change/rework forms
- `UniversalAgent`, recursive executor/scaffold, council tool-builder, legacy Tool Build
  providers/workflow/worker, Tool Investigation stores, and Tool Rework Wait stores

The database migration converts old `waiting_tool_rework` runs to `failed` and drops the
removed legacy tables. API tests keep 404 coverage for the deleted endpoints.

## User Collaboration Notes

- The user wants the project in TypeScript.
- The user expects code changes to be covered by tests.
- Before reporting completion, run automated checks and a relevant manual test when the
  change has user-visible behavior.
- Manual checks must include the actual user-visible surface, API responses, trace logs,
  and database records when persistence is involved.
- Return only working code with the expected execution result.
- Keep this file, `README.md`, `docs/roadmap.md`, `docs/api-surface.md`, and relevant
  module docs updated with architecture changes.
- Do not hardcode private/special pipelines such as a market, chart, Telegram, or search
  branch. Build generic reusable capabilities through the registry, tool versions, QA,
  and documentation.
- Do not turn tool creation into a growing set of operator-facing private templates.
  Tool creation means: an agent receives the requested capability, defines the manifest
  and QA contract, researches possible implementations when needed, chooses among
  package/API/CLI/browser/custom-code/container strategies, writes a complete portable
  source bundle, proves it works, and leaves activation to manual review.
- Requests should eventually accept files and responses should return files when the task
  calls for artifacts such as screenshots, reports, datasets, or source bundles.
- The product should preserve instance/user/channel/thread/run provenance so group memory,
  personal memory, credentials, tools, outbound messages, and policies do not leak across
  scopes.
- Credentials must be stored through secret handles, not prompts, memory, source,
  artifacts, or traces. The Tools page checks required handles through
  `POST /api/secret-handles/status`, showing registered/resolvable state while redacting
  inline values. Manual tool runs return a structured `missing_runtime_requirements`
  diagnostic when a package cannot start because required configuration keys or secret
  handles are absent; the UI renders those keys/handles explicitly and links to settings
  instead of exposing only a raw runner error. The `/api/tools` catalog also includes
  computed `runtimeReadiness` for each tool, and healthchecks fail with the same missing
  runtime requirements message when a tool package is healthy but cannot actually be
  called because settings or secret handles are unresolved. `BaseAgent` receives only
  tools whose active metadata status is `available` and whose runtime readiness is
  `ready`; blocked tools remain visible/manual-runnable for operators but are not offered
  as callable agent schemas.
- Tool creation/edit requests may include raw onboarding credentials such as API keys or
  bot tokens in the natural-language body. The server must extract those values before
  discovery/planning/tracing/package authoring, store them as inline secret handles
  scoped to the tool family (`secret.tool.<tool-name>.<purpose>`), and pass only redacted
  input plus the registered handle through the rest of the lifecycle. These handles are
  version-independent for the registered extension/tool family. The Tools create/edit UI
  exposes this as an optional credential onboarding field and shows the resulting handle
  names after creation without revealing values.
- The Tools create UI is operator-facing. The normal path is tool name, description,
  natural-language task, API docs URLs, optional YAML/JSON/Markdown/text documentation
  files, and optional credentials. YAML/OpenAPI files are attached through the same
  general documentation file picker as other docs, not through a separate YAML field.
  Capabilities, dependencies, discovery mode, authoring mode, and manual behavior QA JSON
  are advanced overrides. Empty behavior QA means the builder should derive fixtures from
  docs/examples and the task, not require the operator to invent tests manually.
- Docs-derived Tool Creation QA must be conservative. Templated OpenAPI server URLs,
  incomplete rendered HTML endpoint paths, missing required path/query examples, and docs
  examples without concrete expected response signals should create integration contracts
  and operations, but not hard live behavior QA fixtures.

## Local Model

Default OpenAI-compatible endpoint:

- Base URL: `http://127.0.0.1:1234/v1`
- Model: `google/gemma-4-26b-a4b`

Environment overrides:

- `LLM_BASE_URL`
- `LLM_MODEL`
- `LLM_TEMPERATURE`
- `LLM_MAX_TOKENS` controls the app-side `max_tokens` sent for tool-capable chat
  completions; default is `6000`.
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

## Durable Artifacts

Docker/S3-compatible artifact storage uses:

- `MINIO_ENDPOINT`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `MINIO_BUCKET`
- optional `S3_REGION`

When those variables and `DATABASE_URL` are present, artifact metadata is stored in
Postgres and payloads are stored in MinIO/S3. Local files under `ARTIFACT_ROOT` remain a
fallback.
Without `ARTIFACT_ROOT`, the local fallback defaults to `workspace/artifacts` in host
development and `/app/workspace/artifacts` inside the Docker container.

## Generated Tool Workspace

- `TOOL_PACKAGE_WORKSPACE_ROOT` defaults to `tools`.
- `TOOL_PACKAGE_ROOT` can point at a specific legacy/custom source-bundle package root.
- The top-level `tools/` directory is intentionally gitignored and excluded from Docker
  build context. It contains runtime/operator package source for independent
  source-bundle or container tools, not Agentic platform source.
- Tool identity and agent visibility come from metadata registration in the tool store
  (Postgres when configured, otherwise local JSON at `workspace/tool-metadata.json`).
  Agents receive only tools that are registered, loaded, and enabled by status/policy;
  missing or unhealthy package code can remain registered but must not be offered as
  callable. Operator-disabled tools stay `disabled` across startup/reload health checks;
  tools that were `available` but can no longer be loaded are marked `failed` with the
  loader reason.
- Generated packages should live under `tools/<system-name>/<version>` with their own
  manifest, README, Dockerfile, package metadata, TypeScript build config, source, and
  tests.
- App startup and `POST /api/tools/reload-generated` scan the configured package roots
  for `tool.package.json`, register discovered source-bundle manifests into the generated
  tool metadata store, and then load them through package runners. This is the bootstrap
  path for gitignored/generated packages after a restart or an empty in-memory store.
- There is no automatic core-tool seeding. Even basic fetch/search/screenshot/artifact
  tools must be created, imported, registered, and enabled by the same platform lifecycle
  as any other tool.
- `TOOL_SOURCE_BUNDLE_PLAYWRIGHT_BROWSERS_PATH` can pin Playwright browser lookup for
  source-bundle HTTP runtimes, for example `0` when a package intentionally stores
  browser binaries in its own workspace. By default the runner inherits the host or
  container Playwright configuration.
- Generated packages may depend on npm libraries, but those dependencies must be
  declared and installed inside the package workspace only. Do not add package-specific
  dependencies to Agentic's root `package.json`.
- Wrapping an npm package is one generic builder strategy, not a dedicated product type.
  The builder should choose it when research shows a suitable package exists; otherwise
  it should fall back to another implementation strategy and record why.
- Tool packages should be importable/exportable as manifest + source bundle, runnable
  through `/health` and `/run`, and later promotable to OCI/container or publishable
  npm-style distribution when the package is generic and high quality.
- Tool creation attempts are tracked by `src/tools/toolCreationStore.ts` and persisted in
  Postgres table `tool_creations` when `DATABASE_URL` is configured. Records include the
  builder strategy decision, candidate/rejected implementation routes, selected
  dependencies, QA report, package ref, file list, creation `runId`, and errors.
- The current deterministic Tool Creation V1 flow writes packages through
  `src/tools/toolCreationV1.ts` after `src/tools/toolBuilderAgent.ts` plans the strategy
  and optional `src/tools/toolImplementationDiscovery.ts` / `src/tools/toolBuilderPackageAuthor.ts`
  steps provide implementation candidates and a guarded package snapshot or fallback;
  newly created packages start disabled for agents even though their runtime is loaded
  for manual runs. Current scaffold strategies include echo, HTTP/JSON, npm adapter, and
  browser screenshot artifact packages.
- Future tool creation must produce out-of-tree packages or services, not permanent app
  source under `src/tools/generated`.

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

- `npm run lint`
- `npm run typecheck`
- `npm run test:types`
- `npm test`
- `npm run build`

Linting uses ESLint flat config and enforces `max-lines=800` for TS/TSX source and
tests. Any oversized file must be split by bounded context instead of growing further.
The current allowlist is an explicit migration debt list, not permission for new large
files.

Build the React console:

```bash
npm run build --prefix web-react
```

Manual CLI smoke test:

```bash
node dist/cli.js "Скажи одним предложением, что такое универсальный агент"
```

Run recommended local web/API development:

```bash
cp .env.example .env
npm run docker
npm run web
```

`npm run docker` starts only Postgres, Redis, MinIO, and SearXNG through Docker Compose.
The app runs on the host through `npm run web`, which loads `.env` and `.env.local`.
Stop the support services with `npm run docker:stop`; follow their logs with
`npm run infra:logs`.

Run the full container stack only when validating the app image:

```bash
npm run docker:full
```

Use `npm run docker:full:detached` for detached full-stack validation. The full-stack
mode runs the app inside Docker and uses compose service DNS such as `postgres`,
`minio`, and `searxng`; host-dev `.env` uses `127.0.0.1` service URLs.

The `npm run dev` command uses `tsx`; in some sandboxes it can fail on IPC pipe
permissions. If that happens, use `npm run build` and then `node dist/cli.js ...`.

## Important Files

- `README.md` - quick start and current execution summary.
- `docs/tasks/README.md` - active executable task queue. Work task specs in numeric
  order and remove completed task files after implementation, verification, docs update,
  and merge.
- `docs/current-architecture.md` - active architecture diagrams, code map, request
  lifecycle, external-action lifecycle, memory model, verified state, and current gaps.
- `docs/roadmap.md` - active rebuild plan and phase order.
- `docs/api-surface.md` - active HTTP API contract and removed endpoint list.
- `docs/modules/agent-runtime.md` - current `BaseAgent` runtime contract.
- `docs/modules/web-console.md` - current React console surface.
- `src/agents/baseAgent.ts` - active minimal agent runtime facade and LLM loop.
- `src/agents/baseAgentPrompt.ts`, `src/agents/baseAgentToolLifecycle.ts`,
  `src/agents/baseAgentToolExecution.ts`, `src/agents/baseAgentLocalUtility.ts`,
  `src/agents/baseAgentCurrentFact.ts`, `src/agents/baseAgentFinalization.ts`,
  `src/agents/baseAgentEvidence.ts`, `src/agents/baseAgentProof.ts`, and
  `src/agents/baseAgentArtifacts.ts` - split `BaseAgent` prompt/schema, generated-tool
  lifecycle calls, registered tool execution, deterministic local/current fast paths,
  return-gate finalization, source/proof reasoning, and artifact QA helpers. Keep future
  runtime changes in these smaller
  responsibility modules instead of growing `baseAgent.ts`.
- `src/agents/taskFrame.ts` - task framing, research contracts, and broad/current task
  return-gate repair instructions used by `BaseAgent`.
- `src/agents/externalActionPlanning.ts` - external action policy/proposal contracts for
  reservations, purchases, outbound messages, and write APIs.
- `src/agents/agentToolCatalog.ts` - agent-visible tool catalog filtering, prompt
  formatting, schema descriptions, and per-run tool call cache keys.
- `src/tools/toolCatalog.ts` - normalized operator/runtime tool catalog layers,
  sort order, health summary, and agent eligibility rules shared by `/api/tools` and
  run-side tool exposure.
- `src/agents/proofSourceUrls.ts` - shared proof-worthy URL normalization and same-page
  comparison helpers.
- `src/agents/modelTier.ts` - model tier selection policy.
- `src/settings/modelRouting.ts` - tier plus capability-aware LLM route resolver.
- `src/llm/client.ts` - OpenAI-compatible LLM client.
- `src/server/modules/runs/runs.service.ts` - run creation/execution/cancel/restart API
  orchestration.
- `src/server/modules/runs/action-proposals.service.ts` - external action approval,
  executor build planning, and commit boundary orchestration.
- `src/server/modules/runs/external-action-run-completion.ts` and
  `src/server/modules/runs/run-external-action-pause.ts` - shared external-action run
  pause/resume helpers for `approval` versus `auto` mode.
- `src/server/modules/runs/run-tool-catalog.ts` - run-side tool catalog/reuse helpers.
- `src/server/modules/tools/tools.service.ts` - tool creation/editing orchestration
  facade. Larger responsibilities are split into registry admin, manual run, settings,
  version lifecycle, and package workflow services.
- `src/server/modules/tools/tool-registry-admin.service.ts` - tool catalog, health,
  reload, enable/disable, package runner diagnostics, manifest import/export, version
  listing, and usage stats.
- `src/server/modules/tools/tool-version-lifecycle.service.ts` - generated tool family
  delete, version delete, mark available, reject, activate, replacement promotion, and
  agent-verified candidate acceptance.
- `src/server/modules/tools/tool-manual-run.service.ts` - manual tool execution, pinned
  generated-version execution, and agent candidate-version loading.
- `src/server/modules/tools/tool-settings.service.ts` - runtime setting list/set/delete
  and schema validation for generated/external tools.
- `src/server/modules/tools/tool-source-bundle-files.ts` and
  `src/server/modules/tools/tool-creation-trace.ts` - small helpers for source-bundle
  file IO/validation and tool-creation trace run events.
- `src/runs/types.ts` - run record/status/event contracts.
- `src/runs/inMemoryRunStore.ts` and `src/runs/postgresRunStore.ts` - run persistence.
- `src/tools/tool.ts` - versioned tool module contract.
- `src/tools/registry.ts` - tool registry.
- `src/tools/toolPackage.ts` - portable tool package manifest contract.
- `src/tools/toolBuilderAgent.ts` - first generic Tool Creation strategy planner.
- `src/tools/toolImplementationDiscovery.ts` - npm registry implementation discovery
  provider.
- `src/tools/toolBuilderPackageAuthor.ts` - guarded LLM package snapshot author/parser.
- `src/tools/toolCreationV1.ts` - guarded source-bundle package writer used by the first
  builder strategy loop.
- `src/tools/postgresToolCreationStore.ts` - Postgres-backed Tool Creation run records;
  JSONB fields are explicitly serialized before writes because package dependency arrays
  must be stored as JSON, not PostgreSQL arrays.
- `src/tools/toolPackageRunner.ts` - barrel export for source-bundle, external HTTP,
  OCI, and local-path package runners. Implementations live in
  `toolPackageRunnerSourceBundle.ts`, `toolPackageRunnerHttpRuntime.ts`,
  `toolPackageRunnerExternal.ts`, `toolPackageRunnerOci.ts`, and shared type/helper
  modules.
- `src/tools/toolServiceSupervisor.ts` - lifecycle supervisor for always-on tools.
- `src/artifacts/artifactStore.ts` - artifact store contracts and local/durable
  implementations.
- `src/settings/modelProviderStore.ts` and `src/settings/postgresModelProviderStore.ts`
  - durable model provider registry.
- `src/instance/userStore.ts` and `src/instance/postgresUserStore.ts` - user and channel
  identity resolution.
- `src/conversations/threadResolution.ts` - new-task versus continuation resolution.
- `src/audit/*` - audit event contracts and stores.
- `src/work-ledger/*` - Work Ledger, Evidence Ledger, and retrospective stores.
- `web-react/src/app/router.tsx` - React route list.
- `web-react/src/routes/Tools.tsx` - tool registry/operator tool surface.
- `tests/baseAgent.part*.test.ts` - current runtime unit coverage split by behavior.
- `tests/nestApi.test.ts` - Nest API smoke coverage, including deleted endpoint 404s.

## Current Roadmap Order

1. Finish repository cleanup and documentation alignment.
2. Harden `BaseAgent`: context, tool-call parsing, budgets, return gates, cancellation,
   trace detail, tool runtime context, and clearer user-facing errors. PARTIAL: the
   task frame now includes a research plan, answer contract, proof strategy, external
   action policy, and source read/extract requirement so broad runs reason about ideal
   outcomes, failure modes, evidence, and approval boundaries before acting.
   DONE (2026-06-13): default step/tool budgets from the task frame, final-step
   wrap-up, truncation/raw-syntax repair extensions, rolling context compaction for
   small-context local models, and event-I/O perf (O(1) appendEvent, batched list,
   getMeta-driven SSE polling).
3. Stabilize the tool registry/runtime UI: manifests, manual run evidence, versions,
   active version, health, usage stats, and disabled-tool policy.
4. Continue Tool Creation V1: richer API-doc-driven adapter synthesis, file/PDF artifact
   tools, schema shaping from inspection evidence and behavior examples, and creation-run
   graph polish. Live behavior QA now has retry/classification, and OpenAPI YAML/reference
   schema plus bounded HTML docs crawling is active. Raw credentials pasted into
   creation/edit requests are now extracted into version-independent tool-scoped secret
   handles before builder/traces see the request; next work is generated secret mapping
   UI and generated multi-call fixtures for less structured API docs.
5. Finish tool editing/versioning gaps: stronger rollback evidence and less disruptive
   candidate promotion semantics. Side-by-side active/candidate comparison and
   pinned-manual-run activation gating are already in the Tools Versions panel/API.
6. Add External Action Lifecycle before real-world committing tasks: generic action
   contracts, prepare/commit split, `waiting_approval`, approval records, policy
   checks, and proof records for bookings, outbound messages, form submissions, and
   third-party write APIs. External actions have two execution modes: `approval` pauses
   the same run at the final boundary and resumes it after operator reject/commit; `auto`
   keeps the run out of the approval queue and may commit only when inputs, executor
   readiness, and proof capture are sufficient. First slice: `BaseAgent` emits run-linked
  external action proposals for requested write actions; Run Workspace shows the
  run-scoped approval panel and can prepare, approve/reject, attach/build an executor,
  and commit the approved action while the run remains `waiting_approval`. `/approvals`
  remains a cross-run queue. Approved proposals expose a guarded commit endpoint
  that reads the proposal's persisted `commitExecutor` contract. Commit execution is a
  generic reusable capability: build/reuse `external.action.commit` with
  `external-action-commit` + `external-action-commit-generic`, and keep concrete
  provider/URL/business/user/prepared-session/proof details in the proposal payload, not
  in a target-specific tool name or package source. Generic commit tools are not exposed
  in normal agent tool catalogs; they are callable only through the guarded
  approval/commit endpoint. The UI derives one operator-facing primary action from the
  shared external-action readiness state: approve/prepare proof, prepare/replay, attach
  executor, or submit externally. Approval-mode approval may safely auto-prepare proof
  and attach an available executor, but the final external mutation remains behind the
  explicit submit action. Without a ready executor, commit records
  `external-action-commit-blocked`; with a ready executor, the endpoint requires a
  registered generic commit tool plus typed `toolInput`, executes it through
  `ToolRegistry`, and records `external-action-committed` or
  `external-action-commit-failed`. Missing executors can be planned/built through
  `POST /api/action-proposals/:id/build-executor`; the endpoint records a linked build
  request, reuses a matching registered executor when available, or starts Tool Creation
  for a disabled candidate. The contract records executor kind, readiness, risk, missing
  requirements, and expected proof. The preinstalled `external.action.commit` is a
  guarded generic executor and declares `external-action-commit-generic`; do not attempt
  to generate another tool with the same name when it can be attached. Automode uses the
  same contract without entering the
   approval queue: it auto-attaches a matching registered generated executor, forwards
  request-provided commit input, records committed/failed/blocked trace events, and
  appends the automode outcome to the run final answer.
  Safe preparation is also a generated capability: `external.action.prepare` declares
  `external-action-prepare`, `browser-action-candidates`,
  `browser-field-candidates`, `browser-form-schema`, and `browser-safe-advance`.
  The platform prefers it for approval preparation and only falls back to
  `browser.operate`; compatibility preparation normalizes commands to carry both
  `action` and `type`, injects an explicit first `navigate` for the core HTTP browser
  runtime, strips schema/semantic-fill commands when the selected tool lacks the required
  capability, and uses selector-based common-field fallback for core browser runtimes
  without semantic fill. Local URLs sent to Docker-hosted browser runtimes are rewritten
  through `BROWSER_OPERATE_LOCALHOST_ALIAS`, defaulting to `host.docker.internal`. The
  tool must surface action controls both inside normal forms and
  outside forms on SPA/provider pages as generic action candidates. Prepare-only runs may
  click a generated `safe_advance` candidate such as a "book/select/continue" CTA to open
  the next draft step, with bounded browser/DOM click fallbacks only for those
  safe-advance commands, but must still block final submit/pay/confirm/send controls
  until the external action commit boundary. The core owns approval state, commit
  readiness gates, proof/artifact storage, and trace/audit records. Cookie/consent
  dismissal should prefer rejection/deny controls when present, include common
  provider selectors, and only report success after visible consent text disappears
  following a real click path. Prepared sessions must count only actually successful
  fill/type tool steps as filled fields; skipped optional fields, missing selectors, and
  failed target interactions keep the action draft in `needs_more_input`. Run Workspace
  and `/approvals` must hide the final external-submit button until the shared commit
  readiness gate says the proposal is ready.
- External action intent must distinguish “find a place/API/service that can be booked
  or used online” from “book/use/submit it for me.” Informational availability lookups
  must not create `waiting_approval` proposals; only explicit execution or preparation
  requests such as “find and book”, “reserve”, “schedule”, “send”, “submit”, or approved
  automode should pause/commit. A bookable-place lookup that includes user contact/
  identity details, date/time or service constraints, and an approval/proof/filled-form
  instruction is treated as an external-action preparation request even if the wording is
  “find where I can book online,” because the user has supplied the data needed to prepare
  the action. The same applies when a continuation supplies contact/service/time details
  and says to use/take/select the best known target from the previous online-booking
  lookup.
- “Do not submit/send/book without my confirmation” is an approval boundary, not a reason
  to suppress the proposal. The run should create the proposal, mark approval required,
  and let the prepare/commit lifecycle handle the proof and final resume. Continuation
  runs with only contact/service/time details should inherit the prior external-action
  intent from thread summary/facts/questions when that thread context clearly describes
  booking, submission, form filling, or confirmation.
- Requirements questions such as “what data do you need from me to book/reserve/schedule”
  are direct checklist tasks. They must not create external action proposals, trigger
  broad research repair, or appear in `/approvals`.
- Approval pauses require a concrete ready proposal. Draft proposals with missing
  date/time, party size, contact, target, payload, or equivalent required inputs should
  complete with a checklist or question instead of blocking the run on an unclear
  approval.
7. Add agent delegation only after the single-agent/tool/action path is stable.

## Working Rules

- Keep edits scoped to the active rebuild path.
- Do not restore deleted legacy runtime pieces unless the user explicitly asks for an
  archeology task.
- Prefer existing TypeScript/Nest/React patterns in the repo.
- Use `rg`/`rg --files` for search.
- Use `apply_patch` for manual file edits.
- Do not revert user changes.
- Run tests before reporting completion when code changed.
- Run-scoped generated/edited tool candidates are promoted only after the base return
  gate passes. Step-budget exhaustion is a failed run and must not accept candidates.
- Operator-explicit tests of disabled generated tools are run-scoped but manual-promotion
  only; they prove whether a candidate can be called without accidentally enabling a bad
  API contract for all future agents.
- Tool-call dedupe is scoped by tool name, tool version, and input so edited candidates
  execute instead of reusing stale results from the previous version.
