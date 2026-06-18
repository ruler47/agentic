# Roadmap

Status date: 2026-05-24.

Current active roadmap: [Core Toolbelt Roadmap](roadmap-core-toolbelt.md).

As of 2026-06-02, new Tool Creation V1 and external-action feature expansion is paused
except for bug fixes needed to keep the current app usable. The active direction is to
stabilize a preinstalled portable core toolbelt first, then improve agent behavior on top
of that stable substrate, and only then reintroduce the builder as an extension layer.
The historical roadmap below is retained as context until it is pruned.

The older rebuild plan below is historical context. Older coordinator DAG,
recursive-agent, tool-build queue, tool-build council, investigation, and
tool-rework-wait designs should be treated as inactive unless they are deliberately
reintroduced through the core-toolbelt roadmap.

## Product North Star

Agentic should be a deployable assistant platform for exactly one family, household,
company, or team per running instance.

The platform has three first-class primitives:

- **Agent**: an LLM-driven actor that receives a local task, uses the available context,
  calls tools when useful, can delegate when the task justifies it, and returns through a
  checkable contract.
- **Tool**: an independently versioned, portable capability package with a manifest,
  schemas, docs, its own `package.json` dependencies, settings, secret handles, runtime
  runner, health, QA evidence, artifacts, and optional storage migrations. A good tool
  should be usable outside Agentic as a small smart npm-style package, a local HTTP
  runtime, or a container.
- **LLM**: a local or remote model resolved through tier/provider policy. Better models
  should improve outcomes without requiring special-case product code.

The core should contain the minimum deterministic machinery needed to make those three
primitives safe and observable: registry, schemas, ledgers, artifacts, permissions,
provenance, audit, and UI. It should avoid hardcoded private pipelines.

Tool implementations should not become permanent Agentic source code. Agentic should be
able to import/export them, run them as isolated packages or containers, and eventually
publish high-quality generic tools such as screenshot, PDF reader, search, document
parser, browser automation, or channel automation packages. Tool creation is not a menu
of hardcoded implementation types. The builder agent receives a desired capability and
must choose the best implementation strategy: wrap an existing npm package, call an
external API, use a CLI, run browser automation, write custom TypeScript, or combine
approaches. When an existing npm package is the best strategy, the generated tool should
declare that dependency in its own package workspace and wrap it behind the normal
`/health` and `/run` contract instead of adding the dependency to the Agentic app.

## Current Baseline

The active runtime is `BaseAgent` in `src/agents/baseAgent.ts`.

Current behavior:

- `POST /api/runs` creates a run and executes `BaseAgent`.
- Runs and run events are durable when `DATABASE_URL` is configured. Host
  `npm run web:dev` now loads `.env`/`.env.local`, so a local Postgres-backed dev run
  should use `docker compose up -d postgres` plus
  `DATABASE_URL=postgres://agentic:agentic@127.0.0.1:5432/agentic`.
- `BaseAgent` gives one LLM the registered tool schemas plus a `finish` action.
- `BaseAgent` frames each task before the first model step and emits
  `agent-task-framed`. The frame is a generic quality contract: narrow facts can stay
  direct, while broad/current recommendation, comparison, or purchase-selection tasks
  require structured research, freshness checks, multiple source-backed claims, and
  claim-focused proof. Broad frames now also require a source read/extract step after
  search, so agents cannot finish broad recommendations from snippets alone. Broad
  frames include a first explicit research plan, answer contract, proof strategy, and
  external action policy. Reservation/purchase/message/API write requests can be
  researched and prepared. The prompt contract supports two execution modes:
  `approval` pauses at the final commit boundary, while `auto` may commit only when
  required inputs and a suitable commit executor are sufficient. Both modes require
  filled-field text proof, a pre-submit proof artifact, a post-submit proof artifact,
  and confirmation id/status capture when the provider exposes them.
- The first external-action proposal slice is active. When a run actually asks for a
  state-changing external action such as a reservation, purchase, outbound message, or
  write API call, `BaseAgent` emits a proposed action contract and RunsService stores it
  on the run result. The proposal appears in `/approvals`, can be approved or rejected,
  and records trace/audit events. Approved proposals expose the first commit boundary:
  `POST /api/action-proposals/:id/commit` records a blocked commit attempt until a ready
  generated commit executor is attached. Ready generated executors must name a registered
  tool with `external-action-commit*` capability and typed `toolInput`; then the endpoint
  executes the tool and records started/committed/failed trace plus audit evidence.
  Missing executors can now be planned/built from the proposal through
  `POST /api/action-proposals/:id/build-executor`; the endpoint records a linked build
  request, reuses a matching registered executor when available, or starts Tool Creation
  for a disabled candidate. Tool Creation and Tool Editing now have an explicit
  `external-action-commit` package kind, so generic commit executors are not accidentally
  scaffolded as echo/browser/API tools. The generated commit executor is provider-neutral:
  it preserves fixture/mock confirmation support for QA, and for prepared browser
  sessions it can replay safe preparation steps, use discovered submit candidates for the
  final approved commit, and return before/after proof artifacts plus confirmation
  metadata. If the prepared context is incomplete, it returns `missing_requirements`
  instead of pretending to submit. `/api/action-proposals/fixture` and the Approvals page
  now provide a safe end-to-end exam: create a fixture proposal, prepare it, approve it,
  attach the active generated executor, and commit with a fixture confirmation. The
  Approvals UI has a first-class Commit readiness panel that shows approval,
  preparation, profile hydration, replay, executor, and last-commit state; commit buttons
  are gated by that derived state plus explicit operator commit input. Approved profile
  fields must be replay-prepared before commit, and generated executors receive raw
  hydrated values only at execution time while trace/audit/UI surfaces keep masked
  previews. Browser-based external commits now additionally require a proof artifact and
  at least one concrete submit/control candidate with a label or selector; text-only
  commit-boundary notes do not unlock the final submit button or backend commit endpoint.
  Preparation proof artifacts are visual-QA checked before they count toward commit
  readiness; rejected screenshots can remain visible for diagnostics but are excluded
  from prepared-session proof ids. Prepared sessions count only successful fill/type tool
  steps as filled fields; optional skipped, target-not-found, or target-failed steps keep
  the action draft in `needs_more_input`, and the Run Workspace plus `/approvals` hide
  the final submit button until the shared readiness gate is actually ready.
  Approval-mode runs are persisted as `waiting_approval`; rejecting or committing the
  proposal resumes and completes the same run, updates the conversation thread, and
  queues channel outbox delivery through the normal run outbound path. The fixture
  endpoint also accepts `mode: "auto"` for automode exams that must not enter the
  approval queue. Automode now auto-attaches a matching registered generated
  `external-action-commit*` executor when one is available, executes it immediately with
  request-provided commit input, and appends an explicit automode result to the run. If
  no ready executor/input exists, the same flow records `external-action-commit-blocked`
  or `external-action-commit-failed` instead of silently presenting a successful action.
  Stronger prepare/dry-run generation and provider-specific confirmation proof remain
  Phase 9 work.
- Runs module boundaries are now being enforced. External action proposal approval,
  executor build planning, and commit execution live in `ActionProposalsService`; tool
  catalog/reuse helpers live in `run-tool-catalog.ts`. The Tools module split has moved
  independent concerns out of the old monolith: runtime settings live in
  `ToolSettingsService`; manual/pinned version execution and candidate loading live in
  `ToolManualRunService`; catalog/health/reload/manifest read-admin paths live in
  `ToolRegistryAdminService`; version activation/rejection/delete/agent-acceptance live
  in `ToolVersionLifecycleService`; source-bundle file helpers and tool-creation trace
  helpers live in small utility modules. ESLint is part of `npm run verify` and enforces
  `max-lines=800` for TS/TSX files without per-file exceptions.
- Agent runtime boundaries have been extracted from the old `BaseAgent` monolith.
  Task framing/research contracts live in `src/agents/taskFrame.ts`, external-action
  policy/proposal logic lives in `src/agents/externalActionPlanning.ts`, agent-visible
  tool catalog prompt/schema helpers live in `src/agents/agentToolCatalog.ts`, and
  proof-source URL normalization lives in `src/agents/proofSourceUrls.ts`.
- The LLM may answer directly or call a registered tool.
- Tool calls go through `ToolRegistry`.
- Tool calls receive run-scoped context: run/thread/user/instance provenance, a scoped
  artifact writer, secret/configuration resolvers, callback metadata, audit, and logger.
- `BaseAgent` only sees registered tools whose active metadata status is `available` and
  whose runtime settings/secret handles are resolvable; `loaded`, `disabled`, `failed`,
  and runtime-blocked tools remain inspectable/manual-runnable but are not offered in
  the agent prompt.
- Operators can create the first deterministic source-bundle tool packages from the
  Tools page or `POST /api/tools/create-package`. Creation now passes through the first
  `ToolBuilderAgent` strategy planner: it records whether the current package is using a
  custom TypeScript shell, HTTP/API shell, npm default-callable adapter, compatibility
  template, or imported source bundle, along with candidates/rejected options and
  implementation notes. The executable package still writes under `tools/<name>/<version>`,
  runs package-local build/test QA, records durable creation history, reloads the
  registry. Operator-created tools now accept an explicit activation policy: default
  manual verification keeps the version disabled, while `available_on_success` marks it
  available after successful QA. Live API/package QA that requires runtime secrets or
  provider access still forces manual verification before agent availability.
  Agent-requested creations attach the freshly created candidate back
  into the originating run as `run_scoped_candidate`; if the run succeeds after using
  it, the version is accepted, marked available, activated, and reused by future agents.
  If the model tries to finish after a candidate is attached but before using it,
  `BaseAgent` performs a bounded repair turn, emits
  `agent-candidate-use-repair-requested`, and tells the model to call the candidate for
  the original task. If the candidate is still not used, the base return gate fails the
  run instead of reporting success. Each creation also creates a normal run with parent-linked
  `tool-creation-*` events for discovery, strategy, authoring, package QA, metadata
  registration, registry reload, and completion/failure. Those lifecycle spans expose
  normalized `input` and `output` payloads for Trace Inspector, so tool creation/editing
  is observable through the same graph contract as normal agent/tool runs.
  Source bundles can be exported and imported again through the API.
  The builder now has a dedicated `web-search` strategy with a portable source-bundle
  scaffold that searches via configurable JSON endpoint or DuckDuckGo HTML fallback and
  enriches top results with page previews.
- Operators can request an edited version of an existing generated tool from the Tools
  page or `POST /api/tools/generated-modules/:name/versions`. Tool Editing V1 reuses the
  same discovery, strategy, authoring, package QA, registration, reload, creation-record,
  audit, and run-trace path as Tool Creation V1. The new version is registered as an
  inactive disabled candidate while the previously active version remains active.
  Operator edits require manual verification/promotion. Agent-requested edits are pinned
  back into the originating run as `run_scoped_candidate`; if that run succeeds after
  using the candidate, the candidate is accepted, marked available, activated, and reused
  by future agents. Previous versions remain in version history for activation/rollback.
  Creation reuse treats the default initial version `0.1.0` as non-binding when newer
  non-failed versions already exist for the same generated tool, so agent-requested
  missing-capability flows do not accidentally downgrade a tool family.
- Operators can manually run a specific generated version from the Versions panel or
  `POST /api/tools/generated-modules/:name/versions/:version/run`. This loads the pinned
  package version through its runner without activating it or exposing it to agents.
- Operators can also explicitly ask a normal run to use a disabled generated tool. The
  runtime attaches the matched version as a run-scoped manual-promotion candidate so the
  agent can produce real task evidence from it, while avoiding accidental global
  activation when the tool's inferred API contract is still wrong.
- If the operator names a concrete generated version in the task, for example
  `tool.name@0.1.20`, the runtime pins that exact version as the run-scoped candidate even
  when a different version is already active globally.
- Docs-only API onboarding must prove the executable API contract, not only URL
  reachability. Generated `http-json` clients reject HTML/SPA shells as
  `html_api_mismatch` so frontend documentation links do not masquerade as working API
  endpoints.
- Inactive generated versions are activation-gated by evidence: activation and
  mark-available require a successful pinned manual run or a completed run-scoped
  candidate run for that exact version. The Versions panel shows pinned manual evidence;
  Run Workspace shows run-scoped candidate evidence with operator activate/reject actions
  after the run completes.
- DONE: version lifecycle observability is explicit. Creation, pinned manual run,
  mark-available, activation, agent acceptance, rejection, and delete actions are returned
  with each version and appended to the original tool creation/edit trace as linked
  spans with input/output payloads.
- DONE: rejected candidates are preserved, not deleted. A rejected version receives
  `reviewStatus: "rejected"` plus lifecycle/audit evidence; activation, mark-available,
  agent-scoped loading, and reusable-candidate selection skip it.
- DONE: the Tools page has a Candidate Review queue over the enriched tool catalog. It
  groups generated versions into manual-run, ready-to-activate, activated, failed,
  rejected, and superseded states and exposes direct select, pinned sample run, activate,
  reject, origin-trace, evidence-run/evidence-trace, and decision-trace actions. Versions
  lower than the active version stay in rollback history but are not counted as
  actionable activation work.
- Tool names are semantic capability names such as `web.fetch`, `browser.screenshot`, or
  `text.slugify`; generated/imported/OCI/external provenance is stored in manifest and
  creation metadata, not as a required name prefix.
- Returned artifacts, screenshots, and tool-written artifacts are saved through the
  normal artifact path.
- Runs fail when the requested artifact action was required but no artifact was produced.
- Runs that use public external URL evidence now try to produce proof: when artifact
  saving is available, `BaseAgent` asks for a screenshot/equivalent artifact before
  finish and the return gate fails if no proof artifact exists. This is generic URL
  evidence behavior, not a domain-specific bitcoin/market pipeline.
- Broad recommendation/product-selection runs are blocked from finishing after shallow
  evidence such as one search result or one roundup. `BaseAgent` emits
  `agent-research-contract-repair-requested` and tells the model to collect independent
  research steps for freshness/current baseline, candidate discovery, and final
  candidate verification. These frames now require at least one successful source
  read/extract call; if the available tool only returns shallow snippets, the repair
  prompt tells the model to call or request a web read/extract tool instead of
  fabricating a high-confidence answer.
- If the model tries to finish a source-backed/current answer before producing proof,
  `BaseAgent` now performs a bounded repair turn: the attempted final answer is blocked,
  a `agent-proof-repair-requested` trace event is emitted, and the model is instructed
  to call the proof tool or request one before calling `finish` again.
- If the model tries to finish after a run-scoped generated candidate was attached but
  before it was called, `BaseAgent` now performs the same bounded repair pattern with
  `agent-candidate-use-repair-requested`: the attempted answer is blocked and the model
  is instructed to call the candidate tool before finishing. This turns the old terminal
  "created but did not continue" failure into an in-run recovery opportunity.
- Current external-data tasks such as prices, quotes, weather, or news now require a
  non-screenshot search/fetch/data tool before the final answer. Screenshot tools are
  treated as proof only, so screenshot-only current-data answers fail the return gate.
- Screenshot proof artifacts now get quality metadata. Failed visual/blocker/source-match
  QA leaves the artifact inspectable but prevents it from satisfying the proof
  requirement. Failed QA is returned to the next model step as an explicit retry reason,
  and the run/trace artifact gallery shows the same `quality` status and checks as the
  Artifacts page.
- BaseAgent now extracts source-backed proof signals from non-screenshot evidence,
  includes the best value as screenshot `focusText` guidance, and passes those expected
  signals into semantic screenshot QA. This removes false `semantic_mismatch` warnings
  for proof screenshots that correctly focus the object/value found by the source
  evidence. For broad recommendation/product-selection tasks, proof QA also receives
  final-answer claim signals and does not treat source URL match alone as authoritative;
  screenshots should prove final candidates/claims, not just the intermediate research
  page.
- Proof repair now has a claim-aware target planner. When evidence contains generic
  signals such as a year plus concrete answer claims such as a product, service, version,
  API, or value, the repair instruction chooses the concrete matched claim as
  `focusText` and records why that source was selected.
- Visual screenshot QA now rejects lower-left consent panels over blurred/low-detail
  content, not only centered modals, while keeping normal CTA-heavy page sections valid.
  Tool package behavior QA can validate artifact MIME and PNG visual usability, so
  screenshot/browser candidates can fail creation/edit QA when they return blocked proof
  artifacts despite `ok: true`.
- BaseAgent now has a generic source-grounding return gate for source-backed answers.
  Concrete final-answer claim signals must be found in collected non-screenshot source
  evidence before proof repair runs. Unsupported claim answers trigger
  `agent-source-grounding-repair-requested`; if budget is exhausted, useful drafts are
  returned with a visible source-grounding note instead of being silently treated as
  verified.
- BaseAgent now has a first deterministic final-answer consistency gate. Before a run is
  marked completed, it checks relative date/weekday claims against runtime
  `currentDateTimeIso`/timezone, checks that referenced proof artifacts did not fail QA,
  and checks that proof artifacts are not attributed to a different source than their
  artifact metadata. Mismatches emit `agent-final-answer-grounding-degraded` and append a
  consistency note instead of silently returning a green but misleading response. Failed
  proof artifact markdown/lines are removed from the final answer before the note is
  appended.
- Artifact cards in Run Workspace, Trace Inspector, and Artifacts expose explicit
  Preview/Open and Download actions. The artifact API serves inline preview by default
  and attachment download with `?download=1`.
- The active generated `browser.screenshot` package captures viewport screenshots by
  default, supports `focusText` / `selector`, and was manually verified on a BTC price
  run to capture `1280x720` proof instead of a full-page dump.
- Local no-Postgres tool metadata now persists to `workspace/tool-metadata.json`, so
  accepted generated versions such as `browser.screenshot@0.1.3` and `web.search@0.1.0`
  survive dev-server restart without committing generated package state.
- Startup/reload now preserves operator-disabled tools as `disabled` and marks previously
  available generated tools as `failed` when their package/runner cannot load.
- Identical tool calls inside a single run are deduplicated by tool name and stable input
  JSON. The LLM receives the prior result and the trace marks the call as reused instead
  of hitting the same tool twice.
- Trace Lab now has stable parent/child graph edges for root agent, context, LLM steps,
  tool calls, artifacts, and return gate. The inspector shows safe normalized LLM/tool
  `input` and `output`, so an operator can see what each model/tool received and returned.
- Tool creation and tool editing runs now use the same parent/child observability
  contract: builder discovery, strategy selection, package authoring, QA, registration,
  reload, completion, and failure spans show what they received and what they returned.
- The React console shows Dashboard, Runs, Trace Lab, Ledger, Memory, Artifacts, Tools,
  Models, Group Profile, Users, Channels, Policies, Approvals, Scheduler, Audit Log,
  Settings, and Diagnostics.

Recently removed from the active product surface:

- `/api/tool-build-runs`
- `/api/tool-build-requests`
- `/api/tool-investigations`
- `/api/tool-rework-waits`
- `/api/tool-migrations`
- Tool Builds page
- Coding Council settings UI
- Tools-page "Request changes" forms
- Trace Lab investigation/rework modal flows

Known caveat: historical docs and migration tombstones still mention the removed legacy
flows. Active source, tests, routes, and UI should not direct operators back to the old
pipeline.

## Guiding Rules

- Keep the running product testable after every phase.
- Prefer one small working vertical slice over many half-wired abstractions.
- Rebuild from the active UI/API inward: users should always be able to try what changed.
- Treat tool creation/editing/versioning as a first-class product, not a hidden developer
  shortcut.
- Keep generated tools out of Agentic app source by default.
- Treat generated tools as portable npm/container-style packages: dependencies live in
  the tool package, package import/export is a product feature, and the core talks to the
  tool through manifest/schema/runtime contracts.
- Store credentials only as secret handles or runtime configuration, never in prompts,
  memory, traces, generated source, or artifacts.
- Preserve instance/user/channel/thread/run provenance in every durable record.
- Every phase must update documentation and tests before it is considered done.

## Phase 0: Base Cutover And Smoke

Status: done for the first rebuild cutover.

Goal: make the app run through the minimal Agent / Tool / LLM base without the broken
legacy tool-build/council product surface.

Completed:

- Added `BaseAgent`.
- Routed `RunsService.executeRun()` through `BaseAgent`.
- Disabled active legacy build/rework/investigation/migration modules.
- Removed legacy Tool Builds and Coding Council UI entry points.
- Added regression coverage for screenshot artifacts returned as `Buffer` content.
- Updated Nest API smoke tests to assert removed legacy endpoints return `404`.
- Verified local and Docker builds.
- Manual smoke run: simple API run completed with answer `ok`.

Definition of done:

- `npm run typecheck`
- `npm run test:types`
- `npm test`
- `npm run build`
- `npm run build --prefix web-react`
- Docker image builds with `npm run verify` inside the image.
- Manual smoke through browser UI and API.

## Phase 1: Repository Cleanup

Status: done for the first cleanup slice.

Goal: remove dead legacy code so future work is not pulled back into the old architecture
by accident.

Tasks:

- Delete inactive server modules for legacy tool builds, tool build runs,
  investigations, rework waits, and migrations after confirming no active imports. DONE.
- Delete legacy `UniversalAgent`, recursive prototype, council tool-builder, and related
  tests after confirming they are not used by the base runtime. DONE.
- Keep reusable domain primitives that still matter: tool registry, artifact store,
  model providers, memory, users, conversations, audit, ledgers, tool service supervisor,
  and package runners.
- Replace tests that only preserve legacy behavior with base-runtime tests or remove
  them. DONE for the first cleanup slice.
- Update `AGENTS.md`, `README.md`, `docs/modules/*`, and `docs/api-surface.md` to reflect
  the active API only. DONE for the primary operator docs; historical architecture notes
  are explicitly non-authoritative.
- Add a "removed legacy endpoints" section to API docs. DONE.

Deliverables:

- Smaller compile graph.
- No active docs that instruct operators to use deleted endpoints.
- Test suite organized around the new base runtime.

Acceptance tests:

- Removed endpoints still return `404`.
- Base run still completes.
- Tools page can run with no built-in/reference tools and still supports generated tool
  creation plus manual tool runs.
- Dashboard, Runs, Run Workspace, Trace Lab, Tools, Models, Ledger, Memory, Artifacts,
  Channels, Settings render without missing chunks.

## Phase 2: BaseAgent Hardening

Goal: make the simple agent loop reliable enough to be the foundation for everything
else.

Tasks:

- Define a strict `AgentRunContext` passed to `BaseAgent`: instance id, requester id,
  channel, thread id, source ids, timezone, locale, visible memory scopes, tool policy,
  artifact policy, and budget. PARTIAL: `BaseAgentRunContext` now carries instance,
  requester, channel, thread, source ids, current date/time, timezone, locale, requester
  summary, group profile summary, thread summary/facts/questions, and input artifact
  metadata.
- Add deterministic preflight context: current date/time, group profile summary,
  requester summary, thread summary, accepted facts, open questions, recent artifacts,
  and available tools. PARTIAL/DONE for the base runtime: current date/time, group
  profile, requester, thread summary/facts/questions, input artifacts, and enriched
  available tool catalog are now included in the base prompt.
- Normalize LLM tool-call parsing for all supported OpenAI-compatible providers.
- Add max turns, max tool calls, per-tool timeout, LLM timeout, and final-answer fallback
  handling. PARTIAL: `BaseAgent` now enforces max steps, max tool calls, LLM timeout, and
  per-tool timeout with cancellation signals.
- Add a return gate: final answer must satisfy required artifacts, non-empty output,
  explicit limitations, and no unexecuted tool-call syntax. PARTIAL: the base return gate
  now rejects empty answers, raw unexecuted tool-call JSON, missing required screenshot
  artifacts, missing proof artifacts after public URL evidence, exhausted step budget,
  exceeded tool budget, failed artifact saves, unused run-scoped generated/edited tool
  candidates, and all-tool-failed runs.
- Improve trace events: prompt summary, selected tool, tool input summary, tool output
  summary, artifact ids, final gate result, token/model metadata when available. PARTIAL:
  `agent-context-prepared` records safe runtime context and available tool metadata before
  the first LLM call; `agent-invocation-decision-selected`, `tool-started`,
  `tool-completed`, `artifact-created`, and `agent-invocation-return-checked` now describe
  the active base loop. DONE for parent-linked BaseAgent spans and generic inspector
  input/output for LLM and tool calls; token accounting remains provider-dependent.
- Add cancellation propagation to stop long tool calls and LLM calls where the provider
  supports abort.
- Add clear user-visible errors for missing model endpoint, missing tool, invalid tool
  input, missing proof artifact, failed artifact save, and timeout.
- Pass a safe runtime context into tools so built-in, HTTP, OCI, and future generated
  tools can use the same provenance, artifact, secret, configuration, callback, audit,
  and logging contract. DONE for the base `RunsService` -> `BaseAgent` -> `ToolRegistry`
  path.

Deliverables:

- `BaseAgent` can run simple answer, tool call, screenshot, file artifact, and failed-tool
  scenarios predictably.
- Tools can create artifacts directly through the runtime context, not only by returning
  artifact payloads to the agent.
- Run Workspace explains why a run failed without inspecting logs.

Acceptance tests:

- Direct answer run.
- One-tool run.
- Multi-tool run where the second tool uses the first output.
- Required screenshot run that passes when screenshot artifact exists.
- Required screenshot run that fails when no screenshot artifact exists.
- Current-data proof run where the search/data evidence value is carried into screenshot
  `focusText` and semantic QA passes on the matched value.
- Tool timeout produces failed run with trace evidence.
- Cancellation leaves terminal `cancelled` state and late output cannot overwrite it.

Manual smoke:

- "Ответь одним словом: ok"
- "Открой example.com и сделай скриншот"
- "Создай текстовый файл с кратким отчетом"

## Phase 3: Tool Registry And Tool Runtime Base

Goal: make tools first-class and inspectable before rebuilding tool creation.

Tasks:

- Define the canonical tool manifest shape used by built-in and generated tools.
- Separate tool metadata from executable runtime:
  - manifest and docs;
  - schemas;
  - settings schema;
  - required configuration keys;
  - required secret handles;
  - startup mode;
  - runner type;
  - version status;
  - health and usage stats.
- Stabilize manual tool run in the Tools UI.
- Add schema-driven input forms for common JSON schema shapes.
- Store manual run evidence: input, output, artifacts, error, duration, actor. PARTIAL:
  manual runs now record richer audit evidence with input/output previews, duration,
  actor, result status, tool version, and structured missing-runtime diagnostics for
  absent configuration keys/secret handles; agent tool-call traces use the same
  diagnostic payload; usage counters refresh in the Tools UI.
- Add version list, active version, health, docs, examples, and recent run stats to Tools
  without exposing edit/rework flows yet. PARTIAL: the Tools detail view shows usage
  counters, active status, and computed runtime readiness; operators can enable/disable
  a tool for agent use.
- Removed built-in/reference tools from the default active registry. Reintroduce those
  capabilities only as generated/imported packages with manifests, QA, and promotion
  evidence.
- Decide what remains in-process and what must run as HTTP/OCI service.

Deliverables:

- Operators can inspect a tool and manually verify it.
- Agents and UI read the same registry contract.
- Operators can disable a tool without deleting it; disabled and runtime-blocked tools
  stay visible for manual checks but disappear from the BaseAgent tool prompt.

Acceptance tests:

- `GET /api/tools` returns only active registry records.
- Manual run validates input.
- Manual run stores artifacts.
- Healthcheck updates visible status and fails visibly when runtime readiness is blocked
  by missing required settings or secret handles.
- A disabled or runtime-blocked tool is not offered to `BaseAgent`. DONE for
  metadata-backed run execution and unit/API coverage.

## Phase 4: Tool Creation V1

Status: in progress. Package creation is working end-to-end with durable creation
records, source-bundle export/import, the first generic builder strategy decision record,
a guarded LLM package-authoring path, npm registry discovery, first package metadata/
README inspection evidence, README-driven npm adapter contracts for default/named/
namespace callable package shapes, simple object-call input schema shaping, and behavior
examples that gate package registration. Creation attempts now also create normal runs
with trace events visible in Run Workspace; Runs and Dashboard mark those records as
tool lifecycle runs. The first browser screenshot artifact package strategy is active
and produces a portable `browser.screenshot` source bundle. Broader API-doc research and
richer adapter synthesis are still future work.

Goal: reintroduce tool creation from scratch as a small, auditable flow, not the old
council pipeline and not a growing catalog of special-case templates. The product goal
is: given a requested capability, create a tool by any suitable means and prove it works.

Initial scope:

- One request creates one new tool package.
- The builder is a normal agent run using strong model tier policy.
- Output is an out-of-tree package under `tools/<tool-name>/<version>`.
- Tool name is a semantic capability identifier; source/provenance is metadata.
- The package owns its own `package.json`; allowed npm dependencies are installed only in
  the package workspace and never added to the Agentic app.
- The package exposes `GET /health` and `POST /run`.
- The package can be imported/exported by manifest plus source bundle, and can later be
  promoted to an OCI/container runtime or published as an npm package when it is generic
  enough.
- Dockerfile is required.
- Manifest is required.
- Tests are required.
- Generated source must not import Agentic internals.

Flow:

```text
operator submits desired tool
  -> create Tool Creation record
  -> create Tool Creation run/span for operator-visible trace
  -> builder agent analyzes the capability contract and QA examples
  -> builder agent researches possible implementation strategies when needed
  -> builder agent chooses package/API/CLI/browser/custom-code/container strategy
  -> builder agent drafts manifest/source/tests/Dockerfile/README
  -> isolated build and tests
  -> behavior QA with operator-supplied criteria
  -> manual operator test in Tools UI
  -> promote version to available
```

Tasks:

- Create the new minimal build record model. Do not reuse the deleted legacy queue shape
  unless it still fits after review.
- Add a minimal synchronous creation endpoint for deterministic package templates. DONE:
  `POST /api/tools/create-package` writes, builds/tests, registers, reloads, audits, and
  returns QA evidence plus a durable creation record for `echo` and `http-json`
  source-bundle packages.
- Add durable Tool Creation records. DONE: `tool_creations` tracks requested/building/
  qa_failed/registered/failed, source, request, package ref, manifest path, file list,
  dependencies, builder strategy decision, QA report, runId, error, and timestamps.
- Show Tool Creation as a run/trace graph. DONE: `POST /api/tools/create-package`
  creates a normal run and emits `tool-creation-*` events for discovery, strategy,
  authoring, package QA, registration, and completion/failure; Tools creation history
  links back to that run.
- Add Tool Builder page with only the first necessary fields:
  - display name;
  - desired behavior;
  - expected input;
  - expected output;
  - example request;
  - example successful response;
  - QA criteria;
  - docs/references;
  - allowed npm dependencies or "let builder choose";
  - secret handles;
  - startup mode.
- Replace the operator-facing `kind` choice with capability-oriented requirements. The
  builder may internally decide to use a package wrapper, HTTP client, browser workflow,
  service adapter, or custom code, but operators should not have to pick from
  implementation templates. PARTIAL/DONE for the Tools UI: the visible `kind` selector is
  gone and the backend records the strategy decision. Full arbitrary implementation
  writing remains future work.
- Add first Tools-page creation panel for package name, kind, request, description, and
  capabilities. DONE for the deterministic V1 templates.
- Add a builder agent prompt that produces a complete package, not partial snippets, and
  records its strategy decision, researched packages/APIs, rejected options, and fallback
  reason when it writes custom code. PARTIAL/DONE for guarded authoring:
  `ToolBuilderAgent` records a typed strategy decision, and
  `ToolBuilderPackageAuthor` can ask an XL-tier model for a complete source-bundle
  snapshot. The snapshot must be JSON, include required source/runtime/test files, avoid
  unsafe paths, avoid raw secrets, and avoid Agentic app imports before package QA sees
  it. If authoring fails, the durable record keeps fallback notes and the deterministic
  scaffold writer is used.
- Add generic implementation discovery:
  - search npm registry/docs when the request implies a common library capability;
  - inspect package README/API shape enough to generate a thin adapter;
  - fall back to custom TypeScript only when a suitable dependency/API is unavailable or
    unsafe;
  - persist selected dependencies and rejected candidates in creation QA evidence.
  PARTIAL: `ToolImplementationDiscovery` can search the npm registry, select safe
  package/version candidates, add package-local dependencies, inspect selected package
  metadata/README/entry hints, infer the first adapter contracts for default callable,
  named export callable, namespace member callable README examples, and simple object
  argument schemas, and store search, inspection, and adapter evidence in the strategy
  record. It also inspects operator-supplied docs/OpenAPI/cURL/HTML text or URLs and can
  turn OpenAPI JSON/YAML operations, cURL snippets, and simple HTML method/path examples
  into docs-derived behavior fixtures, including simple multi-step `POST -> GET`
  scenarios. Tool package manifests now support
  provider-neutral `integration` contracts for `run-on-demand` API clients and
  `always-on-service` bots/listeners/webhooks. The first deterministic `service-adapter`
  source bundle scaffold builds with generic lifecycle hooks and secret handles. The
  deterministic HTTP API scaffold now supports operation calls through `url` or
  `baseUrl + path`, generic `target`, `method`, `query`, JSON `body`, safe headers,
  parsed JSON response data, chained behavior QA, OpenAPI security-scheme extraction
  into runtime secret handles, `operationId` dispatch, `pathParams` replacement,
  standalone path/query examples from documented examples/defaults/enums,
  integration-level base URLs and neutral targets, single-operation default dispatch,
  and `$ref`-derived request/response schema examples.
  BaseAgent now also stores sanitized structured JSON proof artifacts for successful
  API/data tool calls when source-based proof is enough. Full provider-loop source
  synthesis and richer referenced schema extraction/validation from those contracts is
  next.
- Add dependency policy for generated packages:
  - dependencies must be declared in the tool package only;
  - no root `npm install` for a generated capability;
  - no raw secrets in `package.json`, lockfiles, README, source, or tests;
  - dependency choice is captured in QA evidence and review output.
- Add package validator:
  - manifest schema;
  - safe paths;
  - no raw secrets;
  - Dockerfile exists;
  - README exists;
  - test command exists;
  - `/health` and `/run` contract exists.
- Add package import/export:
  - export manifest + source bundle;
  - import an existing package workspace or bundle;
  - preserve package provenance, version, QA evidence, and dependency metadata. DONE for
    source-bundle export/import through `GET /api/tools/:name/source-bundle` and
    `POST /api/tools/source-bundles`.
- Add isolated execution for build/test. DONE for package-local TypeScript build/tests.
- Add behavior QA before registration. PARTIAL: `behaviorExamples` can be supplied in
  `POST /api/tools/create-package` / Tools UI or inferred from explicit input/output
  text, README package examples with expected output comments, and simple original-task
  text transforms. Agent-requested builds pass the original run task as `sourceTask`,
  inferred/authored examples are stored in the strategy/manifest, and QA executes them
  against built `tool.run()` output before registration. Behavior examples now support
  multi-step scenarios: steps can save prior outputs, reference them through placeholders
  such as `{{created.data.id}}`, and assert content, data paths, artifact MIME, and visual
  artifact quality. LLM-authored package snapshots can now return behavior criteria for
  API/multi-step/chained scenarios when deterministic inference has none. OpenAPI
  JSON/YAML specs and cURL docs can now generate initial fixtures automatically; OpenAPI
  create/read scenarios are tested end-to-end against package output, can derive request
  and response examples from referenced component schemas, and standalone generated
  fixtures avoid operations that need hidden path/state context unless examples provide
  those values. Docs URLs now use a bounded same-origin crawl for relevant API/auth/
  reference/example links, so HTML docs can provide base URL, method/path/query examples,
  auth hints, and nearby JSON response examples across multiple pages. Raw credentials
  pasted into creation/edit requests are now extracted before discovery/planning/tracing,
  stored as version-independent tool-scoped inline secret handles, and replaced with
  redacted markers plus manifest secret-handle requirements. The Tools create/edit UI now
  has an operator-oriented create flow for name, description, task, docs URLs, local
  YAML/JSON/Markdown/text docs files, and optional credential onboarding. YAML/OpenAPI
  specs use the same general documentation file picker as other docs, not a separate
  YAML textarea. It shows the registered required handles after creation and keeps
  capabilities/dependencies/discovery/authoring/manual behavior QA as advanced overrides.
  Docs-derived live QA now skips templated server URLs, incomplete rendered endpoint
  paths, empty query/path examples, and examples without concrete expected response
  signals; those docs still create integration contracts/operations for the generated
  package. Failed/QA-failed creation attempts can be deleted from Creation history,
  removing their creation record, linked trace run, package workspace, and tool-scoped
  secret handles while leaving registered tools under the normal lifecycle delete.
  Richer integration-contract-driven adapter source synthesis remains next.
- DONE: live behavior QA is classified separately from package/semantic failure.
  Behavior examples that depend on public external URLs, search queries, or documented
  API operations now retry transient/provider failures and record structured
  `issues`, `warnings`, and `requiresManualLiveVerification` in the QA report. A
  package with passing structural/build/test checks can be registered disabled with
  manual live verification required when the only failure is transient network,
  provider-blocked, or auth-missing. Semantic mismatches, bad visual artifacts, missing
  expected data, wrong MIME, unsafe paths, build failures, and package test failures
  remain hard QA failures.
- Add first browser artifact package strategy. DONE: screenshot-oriented requests select
  `browser-automation`, generate a `browser-screenshot` source bundle with
  package-local `playwright-core`, URL/viewport/wait input schema, Dockerfile Chromium
  setup, local Chromium cache resolution, and PNG artifact-shaped output.
- Add a generated tool import/promotion endpoint. PARTIAL: creation registers a manifest
  and reloads the generated tool registry; startup/reload also bootstrap source-bundle
  manifests found in the configured package workspace, while manual activation is done
  through `PATCH /api/tools/:name/status`.
- Keep promotion manual in V1.

Deliverables:

- Create a simple screenshot tool or echo/API tool from the UI. DONE for
  `browser.screenshot` and `demo`/test source-bundle packages.
- Create a tool from a natural-language capability request where the builder decides the
  implementation strategy itself, including wrapping a known npm package when that is the
  best route without adding that dependency to Agentic.
- Build output is inspectable and testable.
- Creation process is inspectable in Runs/Run Workspace.
- Package output is portable: an operator can run it independently as a package/runtime
  or import it into another Agentic instance.
- Operator can run the generated tool manually before activation.

Acceptance tests:

- Successful generated echo tool. DONE in `tests/toolStatsService.test.ts`, including
  package QA, source-bundle HTTP runner reload, durable creation record, export/import,
  and manual invocation before/after import.
- Failed generated tool remains unpromoted with QA evidence.
- Raw secret in request or output is redacted/rejected.
- Unsafe file path is rejected.
- Guarded LLM-authored package snapshots are accepted only after path/content guardrails
  and package-local build/test QA. DONE in `tests/toolStatsService.test.ts` with a fake
  LLM-authored uppercase package.
- Dependency is installed only inside the generated package workspace. PARTIAL: package
  metadata and QA path support package-local runtime dependencies; next coverage should
  prove the generic builder can choose and wrap a dependency as one strategy, not expose a
  hardcoded npm-wrapper tool type.
- Successful generated browser screenshot tool. DONE in `tests/toolStatsService.test.ts`
  and manual API/UI smoke: `browser.screenshot` builds, registers disabled, appears in
  Tools, links to its creation run, and manually captures `https://example.com/` as PNG
  artifact output.
- Exported package can be imported again and manually run. DONE for deterministic
  source-bundle packages.
- Package workspace survives an empty metadata store / restart. DONE in
  `tests/toolPackageRunnerLoader.test.ts`: `loadGeneratedTools` discovers
  `tool.package.json`, registers it, loads the package, and preserves `available`
  status across repeated bootstrap passes.
- No automatic core-tool seeding. DONE: tool packages are created/imported only through
  the platform lifecycle; startup may load registered packages from the gitignored
  workspace but does not invent even basic fetch/search/screenshot/artifact tools.
- Generated tool can be disabled without deleting history.

## Phase 5: Tool Editing And Versioning

Goal: support "this tool works badly, improve it" through versions.

Tasks:

- Add version model:
  - tool name;
  - version;
  - parent version;
  - status: draft, building, qa_failed, ready_for_manual_test, available, active,
    disabled, archived;
  - changelog;
  - QA evidence;
  - promotion actor/time.
- Add "request change" flow on a specific version.
- DONE for first rebuild slice: generated tools now expose "Request tool edit" in the
  Tools page and `POST /api/tools/generated-modules/:name/versions`. The flow creates
  `tools/<name>/<new-version>`, runs package QA, registers the replacement version,
  reloads, records a `tool_creations` history row, creates a normal traceable run, and
  leaves the edited version disabled for manual verification.
- Builder receives:
  - current manifest;
  - current source summary;
  - current tests;
  - failing manual run evidence;
  - operator feedback;
  - acceptance criteria.
- DONE: add side-by-side version comparison in UI. The Tools Versions panel compares the
  active version with the next inactive candidate, including package refs, status,
  capabilities, health, run counts, QA summary, QA checks, pinned manual evidence,
  run-scoped candidate evidence, and the activation action.
- DONE: add active-version switch with pinned evidence gate. The existing versions panel
  can activate inactive generated versions and mark loaded versions available only after
  a successful pinned manual run or completed run-scoped candidate run for the exact
  version.
- Add rollback to previous active version.
- Prevent agents from using draft/failed/disabled versions.

Deliverables:

- Operator can create v2 from v1, manually test it, activate it, and roll back. DONE for
  generated source-bundle packages: the Versions panel can run a pinned version, activate
  inactive versions, compare active/candidate evidence, and leave disabled/failed
  candidates hidden from agents.

Acceptance tests:

- v1 remains callable while v2 is building. DONE for generated source-bundles: v2 is
  registered only after package QA passes and remains inactive while v1 serves other
  runs. For agent-requested edits, v2 can be pinned into the requesting run as
  `run_scoped_candidate`.
- Failed v2 does not affect active v1. PARTIAL: QA failure stops before registration.
- Active switch changes what `BaseAgent` sees. DONE: only active `available` tools are
  offered to new `BaseAgent` runs. The originating run can use its scoped candidate
  immediately, and successful completion accepts/promotes it for later agents.
- Manual run is pinned to chosen version. DONE for generated versions through
  `POST /api/tools/generated-modules/:name/versions/:version/run`.
- Activation without pinned evidence is rejected server-side. DONE for generated source
  bundles through activation and mark-available endpoints.
- Deleting/archiving inactive versions does not remove audit evidence.

## Phase 6: Agent Delegation V1

Status: in progress. First slices are active: BaseAgent exposes
`request_tool_creation` and `request_tool_edit` meta-actions. RunsService routes accepted
missing-capability requests into Tool Creation V1, and accepted generated-tool rework
requests into Tool Editing V1, as linked source `agent` lifecycle runs. Generated tools
created by operators still start disabled and must pass promotion before general agent
use. Agent-requested created/edited candidates now get scoped use inside the originating
run and are globally promoted when that run succeeds after using them; matching inactive
edit candidates are reused before building another version.

Goal: add child agents only where they improve a task, while simple tasks stay simple.

Tasks:

- Define `AgentInvocation` as the durable contract for any agent call:
  - caller;
  - local task;
  - context slice;
  - allowed tools;
  - budget;
  - output contract;
  - required evidence/artifacts;
  - parent span id.
- Add an LLM decision step that can choose:
  - answer directly;
  - call tool;
  - delegate;
  - ask for stronger model;
  - ask for tool creation/editing;
  - finish with limitation.
- Put the usable tool catalog in each agent prompt/context slice: name, description,
  capabilities, input/output schemas, examples, status, and relevant policy/budget hints.
  The agent should use an existing tool when it fits, request tool creation when a needed
  capability is missing, and request tool editing when an existing tool is close but
  insufficient. DONE for BaseAgent: RunsService builds a metadata-backed catalog limited
  to active `available` tools and includes active version, source/status, capabilities,
  schema keys, examples, required settings/secrets, health, usage counters, change
  summary, and compact version history in the prompt and `agent-context-prepared` trace.
  Callable schemas still include only active available tools plus `request_tool_creation`,
  `request_tool_edit`, and `finish`, except for one current-run
  `run_scoped_candidate` produced by agent-requested creation/edit. Agent-requested
  creation and editing emit `tool-missing` / `tool-creation-*` trace events, create
  linked lifecycle runs, are visible in the common Runs list, and fail the return gate if
  the candidate is attached but not used to finish the task.
- Add bounded child-agent execution with max depth and max parallel children.
- Add shared run context so child agents see what siblings are doing and what evidence
  already exists.
- Add synthesis step that consumes child outputs.
- Add return gate for every child before parent can use the output.

Rules:

- Direct low-risk tasks should not spawn children.
- Delegation must be justified in trace.
- Children get narrow tasks and narrow tool permissions.
- Parent remains responsible for final answer.

Acceptance tests:

- Simple "what time is it" style task stays single-agent.
- Multi-part research delegates into 2-3 children.
- Duplicate evidence gathering is blocked by ledger.
- Child failure is represented as limitation, retry, or parent-level failure.

## Phase 7: Work Ledger, Evidence Ledger, Memory, And Threads

Goal: make multi-agent work coordinated and reusable without bloating prompts.

Tasks:

- Re-evaluate existing ledger code and keep only what fits the new runtime.
- Add `claimWork` to BaseAgent/tool execution path:
  - search query;
  - URL visit;
  - API call;
  - screenshot;
  - file read/write;
  - artifact generation.
- Store evidence records for tool outputs, screenshots, datasets, files, URLs, and
  limitations.
- Add thread/run context compaction:
  - accepted facts;
  - rejected attempts;
  - open questions;
  - relevant artifacts;
  - recent evidence ids.
- Make continuation runs reuse artifacts/evidence where appropriate.
- Add retrospective draft after every run:
  - what worked;
  - what failed;
  - duplicated work;
  - weak tool/model signals;
  - proposed memory/tool/policy follow-ups.

Acceptance tests:

- Two child agents cannot take the same screenshot work item simultaneously.
- Follow-up "use that screenshot" reuses prior artifact metadata.
- Failed source becomes limitation evidence, not fake success.
- Memory retrieval respects instance/user/thread scope.

## Phase 8: Channels And Always-On Tools

Goal: make Telegram and future channels ordinary tools/services.

Tasks:

- Keep channel identity resolution provider-neutral.
- Ensure always-on tool packages use the same manifest/version/health lifecycle.
- Normalize inbound events into `POST /api/runs` with source provenance.
- Normalize outbound events through policy-gated tool calls.
- Add per-channel thread continuity.
- Add service lifecycle UI:
  - running/stopped/failed;
  - logs;
  - restart policy;
  - pending approval;
  - last events.

Acceptance tests:

- A fake channel service creates a run.
- Unknown source identity is denied.
- Allowed identity maps to requester.
- Long outbound answer is split by channel tool, not by core runtime branch.

## Phase 9: External Action Lifecycle, Policies, Secrets, And Outbound Actions

Goal: make the system safe enough for a real family/team instance and for actions that
change the outside world, such as sending a message, booking a table, creating a
calendar event, submitting a form, calling a third-party write API, starting an
always-on bot, or changing an external database.

Tasks:

- Define an `ExternalAction` contract for every tool operation that can mutate outside
  state:
  - action type;
  - target system;
  - exact data that will be sent;
  - expected external change;
  - reversibility/cancellation notes;
  - risk level;
  - required approval policy;
  - required proof after execution.
- Add a two-step execution lifecycle:
  - `prepare`: tool/agent gathers data, fills forms, or builds an API request, but does
    not commit the external action;
  - `commit`: after policy approval, the same run resumes and performs the action.
- Add run state `waiting_approval` for prepared actions that require user/operator
  approval before commit.
- Add an approval record model linked to run/span/tool/action:
  - proposed action JSON;
  - human-readable summary;
  - required approver;
  - approval/denial reason;
  - timestamps;
  - resumed run/span after approval.
- Add action proof records:
  - before screenshot/API preview when available;
  - submitted request summary with secrets redacted;
  - after screenshot/API response;
  - confirmation id or provider receipt when available;
  - fallback limitation when proof cannot be obtained.
- Add browser/action-tool support for safe form workflows:
  - navigate/read/fill/select;
  - handle cookie/consent blockers;
  - stop before final submit;
  - return proposed action summary;
  - commit only after approval;
  - capture confirmation proof.
- Define policy records for:
  - memory access;
  - tool access;
  - secret use;
  - outbound messages;
  - destructive actions;
  - spend/time budgets.
- Add approval queue for policy-gated actions.
  - PARTIAL: `/approvals` now lists run-linked action proposals and supports
    approve/reject decisions with trace and audit records. Proposals persist a
    `commitExecutor` contract with executor kind, readiness, risk, missing requirements,
    and expected proof. Approved proposals can run a guarded commit path; without a ready
    generated commit executor, the attempt is recorded as
    `external-action-commit-blocked`. With a ready generated executor, the endpoint calls
    the named `external-action-commit*` tool through `ToolRegistry` and records
    `external-action-committed` or `external-action-commit-failed`. Missing executors can
    be planned/built from the approved proposal and traced back to the source run.
- Add secret-handle UX:
  - create handle; DONE in Settings.
  - validate required handles; DONE for Tools detail through `POST /api/secret-handles/status`.
  - never reveal values; DONE for public status/list/get responses, including inline-secret redaction.
  - audit use by handle only.
- Add outbound action records:
  - recipient;
  - channel;
  - body;
  - reason;
  - generated by run/span;
  - approval state.

Acceptance tests:

- A restaurant-like booking flow can prepare a reservation action, wait for approval,
  resume, commit, and store confirmation proof without hardcoding restaurants into the
  core runtime.
- A form/API write action cannot commit while approval is pending.
- Denied approval prevents commit and records the denied action as limitation evidence.
- Agent cannot use a tool outside policy.
- Agent cannot access another user's private memory.
- Outbound action waits for approval when policy requires it.
- Secret values never appear in trace, artifact, memory, audit, or generated source.

### Phase 9A: Online Booking / Appointment Execution Roadmap

This is the concrete path from the current proposal-only state to "book a table" or
"schedule a haircut" as a real user-visible capability. The implementation must remain
provider-neutral: restaurants, salons, dentists, repair services, hotel requests, and
other bookings all use the same external-action lifecycle.

Current baseline:

- `web.search`, `web.read`, and `browser.screenshot` are active generated tools.
- `ExternalActionProposal`, run-scoped approval controls, `/approvals`, approve/reject,
  blocked commit traces, and generated commit-executor planning already exist. `approval`
  mode creates a `waiting_approval` run; Run Workspace now shows the pending proposal and
  lets the operator prepare proof, approve/reject, attach or build a commit executor, and
  commit the action so the same run resumes to `completed`. `/approvals` remains a
  cross-run queue. `auto` mode keeps the run out of the approval queue and may commit only
  when required inputs, executor readiness, and proof capture are sufficient.
  Dashboard and Conversation composers now expose the mode as a visible Approval/
  Automode selector instead of relying only on the user remembering magic wording. The
  selector currently writes the automode directive into the task text; the next cleanup is
  storing a durable `externalActionMode` field on the run context.
- Approval-mode runs now auto-advance after operator approval through the safe
  non-mutating part of the lifecycle: prepare browser proof, capture artifacts, and
  attach/build a generated commit executor when possible. The final provider-changing
  `commit` remains a separate explicit action in Run Workspace.
- External-action intent boundary is explicit: informational tasks such as “find a
  restaurant that can be booked online” remain research/recommendation tasks and must not
  pause for approval. Approval proposals are only for execution/preparation requests such
  as “find and book”, “reserve”, “schedule”, “send”, “submit”, or approved automode.
  Bookable-place/service lookups with supplied contact details, date/time or service
  constraints, and approval/proof/filled-form wording are now treated as preparation
  requests, so users can write natural short tasks instead of full internal checklists.
  For those preparation requests, the base agent does not chase proof screenshots inside
  its own loop; filled-form and provider confirmation proof are produced by the
  approval/prepare/commit lifecycle.
- Requirements/checklist questions such as “what data do you need from me to book?”
  are direct answers, not booking attempts. They must not create approval proposals,
  enter research repair, or remain visible as pending approval queue items after the run
  completes.
- Approval pause is reserved for concrete ready proposals. If a reservation/appointment
  proposal still lacks date/time, party size, contact, target, or equivalent required
  inputs, the run must not enter `waiting_approval`; the UI surfaces it as an unfinished
  draft instead of asking the operator to approve an unclear action.
- Generated `browser.operate` can now be created through the normal Tool Creation V1
  source-bundle flow and used as a safe prepare executor through
  `POST /api/action-proposals/:proposalId/prepare`. Preparation is traced, audited, and
  can save a proof artifact without committing the external action. Operators can replay
  the latest prepared session, and generated commit-executor build requests now receive
  the prepared session, replay steps, and proof artifact ids as context.
- Local action fixtures now include a real safe HTML form under
  `/api/fixtures/external-actions/:actionType`. Fixture proposals point to that page,
  carry collected draft fields, and default preparation turns those collected inputs into
  browser fill commands while preserving `prepareOnly` and never clicking the final
  confirmation control.
- The safe fixture commit path is now end-to-end: after approval, Tool Creation can build
  an `external-action-commit` source-bundle executor, the proposal attaches it, commit
  hydrates the latest prepared session/replay/artifact context, and the generated
  executor calls the local fixture commit endpoint to receive provider-style
  confirmation evidence. Live provider executors remain gated behind generated
  provider-specific implementation and explicit approval.
- Prepare-only proposals now keep a separate `preparation.targetUrl`, selected from
  source evidence by generic booking/form/action URL signals. The visible proposal
  target remains human-readable, while the browser preparation runner opens the
  actionable URL before ordinary source links.
- Live prepare-only proposals now avoid treating canonical contract fields such as
  `party_size` or `date_or_time` as DOM labels unless explicit page/form commands are
  present. The generic target extractor also skips section headings such as booking
  details and reads target values from field-label lines like `Restaurant: Skina`, so
  operator approvals show the actual venue/service instead of a response heading.
- Prepare-only execution now has a provider-neutral adaptive navigation pass: after the
  first safe browser read, it scores extracted links by generic action intent
  (`reservation`, `appointment`, `purchase`, message, API write) and may run a second
  safe `navigate` pass on the likely booking/form URL. It can also run one bounded
  safe-advance pass through a generated `safe_advance` action candidate when the page has
  no form yet, for example an open-flow `Book`, `Reserve`, `Select`, or `Continue` CTA.
  That safe-advance click may use browser/DOM fallbacks when normal actionability fails,
  but final submit/pay/confirm/send controls stay blocked and no data is committed;
  same-host links are only a bonus after an action-like link signal is present, so
  policy/review/social links are not followed. Consent dismissal now prefers
  reject/deny controls, includes common consent-provider selectors, and no longer
  reports a dialog dismissed unless the visible consent text disappears after a real
  click path.
- The next `browser.operate` generated version advertises
  `browser-field-candidates`: fill/type/select/click commands can carry safe candidate
  selectors, labels, placeholders, and test ids plus `optional:true`. The preparation
  runner only emits these commands when the active tool version declares that capability,
  so old generated versions keep the previous command contract.
- `browser.operate` now also advertises `browser-form-schema`. Prepare sessions can run
  `extractForms` to capture observed form fields, labels, names, types, required flags,
  placeholders, autocomplete hints, and submit candidates. The prepared-session summary
  persists those fields so approval review shows what the provider page actually exposed.
- The core preparation runner now uses that observed form schema for a second safe,
  provider-neutral preparation pass. It maps generic user/action values such as party
  size, date, time, contact, service, and notes onto the fields actually exposed by the
  page, uses selector/label candidates, captures a proof screenshot, and still does not
  click commit/submit controls.
- Preparation now also records required form-field gaps and profile availability without
  silently entering sensitive contact details. User/group profile values are normalized
  from common key shapes such as `contact.email`, `contactEmail`, `phone`, and
  `displayName`, stored as masked previews in the prepared session, and shown to the
  operator as "available after confirmation" rather than auto-submitted data.
- Operator-approved profile hydration is now a separate audited preparation step.
  `/approvals` can approve profile-backed required fields such as contact email/phone;
  the approval event stores only field ids and masked previews. A replay preparation then
  resolves the current profile value at execution time, fills the approved fields, and
  redacts those raw values from trace/audit payloads.
- Commit execution now treats approved profile hydration as an explicit boundary. If an
  operator approved profile-backed fields but the action has not been replay-prepared
  with those fields, commit is blocked with a clear requirement. After replay, generated
  commit executors receive a structured `hydratedInputs` snapshot with actual values at
  execution time, while run trace and audit payloads retain only masked previews.
- External Action v2 is the next product hygiene target. The generic flow should support
  "find, prepare, show proof, submit after one approval, then report" for any online
  external action: booking, appointment, game/session reservation, order, outbound
  message, API write, or similar provider workflow. The first contract slice is
  `preparedSession.actionDraft`: a provider-neutral draft that records target, action,
  page URL, draft data, missing commit blockers, proof artifacts, concrete commit
  controls, operator next step, and mandatory post-commit report requirements. This is
  intentionally not provider-specific; Booksy/barbershop remains only an exam case.

Roadmap:

0. **External Action v2: one-approval action flow.**
   - Goal: a user can ask naturally to find and perform an online action with minimum
     follow-up. The agent researches, chooses a target, prepares a filled draft, captures
     proof, pauses once before the final external mutation, commits after approval, and
     returns a complete outcome report.
   - Generic preparation contract: persist selected target, action, page URL, visible
     draft data, missing blockers, proof artifacts, concrete commit controls, and
     post-commit report requirements in `preparedSession.actionDraft`.
   - Generated preparation tool: `external.action.prepare` is the preferred
     source-bundle capability for safe browser preparation; `browser.operate` remains a
     fallback. The tool extracts text/links/forms, captures proof, exposes field/form
     capabilities, detects action controls outside forms on modern SPA/provider pages,
     classifies safe-advance versus final-commit controls, applies robust fallback
     clicks only to safe-advance controls, and is called through the registry like any
     other generated tool.
   - Generic commit gate: final submit is unavailable until preparation has proof plus a
     concrete submit/control candidate, not just a textual intent boundary.
   - Generic post-commit report: every successful/failed external action must state
     outcome, submitted data summary, provider confirmation/status, proof artifacts,
     destination/location/effected resource, and cancellation/undo/recovery path when
     available.
   - UI goal: approval cards show a human "what will happen" draft first, with advanced
     technical readiness collapsed.
   - Exams: local fixture first, then a live no-payment provider flow; domain examples
     such as barbershop, restaurant, online game/session, and API write are only exams,
     not hardcoded product branches.

1. **Structured action proposal contract.**
   - Add appointment as a first-class action type alongside reservation, purchase,
     outbound message, API write, and generic external action.
   - Persist a structured preparation contract: collected inputs, missing inputs,
     commit boundary, operator checklist, and proof plan.
   - Acceptance: reservation and appointment runs create proposals that explain exactly
     what is safe to prepare and what is forbidden before approval.

2. **Generated `browser.operate` capability.**
   - Create or import a generated tool that can navigate, read DOM, click, fill, select,
     wait, extract forms, and capture screenshots.
   - It must support `prepareOnly` / `stopBeforeCommit` so it can fill or preview forms
     without submitting final state-changing actions.
   - Status: base generated capability and proposal prepare endpoint are implemented.
     The local fixture page is now the required safe exam for draft filling and
     stop-before-commit behavior.
   - Status: the source generator now supports optional field-candidate commands, and
     adaptive preparation can use them to fill obvious party/date/time/service fields
     only after it reaches a likely action form page.
  - Status: active `browser.operate@0.1.4` extracts form schema during preparation,
    and action proposal planning now normalizes common user-provided party size,
    date/time, and contact values before form preparation.
  - Status: schema-aware preparation can use observed fields from `extractForms` for a
    safe follow-up fill pass, so the platform is no longer limited to guessing labels
    before seeing the actual provider form.
  - Status: required observed fields now become explicit approval gaps. Profile-backed
    values are visible as masked availability hints but are not auto-filled when policy
    says contact/final details require operator approval.
  - Status: approved profile hydration can replay a preparation with operator-selected
    profile fields while preserving the no-raw-secrets/no-raw-contact-data trace
    boundary.
  - Status: commit execution now refuses approved-but-not-replayed profile fields and
    passes replayed hydrated inputs to generated commit tools through an audited,
    redacted boundary.
   - Acceptance: a local fixture booking page can be navigated and filled up to a
     confirmation button without submitting.

3. **Action session state.**
   - Persist the prepared action session: current URL, page title, filled fields,
     cookies/session reference if available, before screenshot, candidate submit button,
     and reconstruction steps.
   - Status: `preparedSession` is now extracted from browser preparation output and
     exposed through `/api/action-proposals`: current URL, page title when available,
     text preview, links, filled fields, replay steps, commit candidates, warnings, and
     proof artifact ids. The Approvals UI displays this compact prepared-session summary
     and can trigger a replay preparation using the same endpoint.
   - Status: commit-executor build requests include the latest prepared session, replay
     steps, and related artifact ids so generated executors can reconstruct the prepared
     state instead of starting blind after approval.
   - Remaining: store resumable browser state/cookies/session handle for sites where
     deterministic replay is not enough.
   - Acceptance: an approval record can show the prepared browser state and replay
     deterministic steps; follow-up acceptance is live browser/session resume after
     approval.

4. **Approval UX for real actions.**
   - `/approvals` should show action type, target, date/time/person/service/contact
   fields, missing inputs, risk, commit boundary, before proof, and exact payload or
   form data.
   - Status: `/approvals` can approve available profile-backed gaps and then replay the
     preparation so the operator can review the filled draft before any commit executor
     is allowed to mutate an external system.
   - Status: generated commit execution receives hydrated profile fields only after
     operator approval and replay, and commit traces redact the raw values.
   - Operators can approve, reject, or send the run back with missing details.
   - Acceptance: a user can understand what will be sent without opening Trace Lab.

5. **Commit executor lifecycle.**
   - After approval, commit through a versioned generated executor or browser action
     runner, not through ad hoc core code.
   - Store submitted payload summary, provider response, confirmation id/status, after
     screenshot, and failure reason if commit fails.
   - Status: `/api/action-proposals/:id/commit` executes only approved proposals through
     a generated tool that declares `external-action-commit`. Immediately before
     execution, the server hydrates the tool input with the latest prepared session,
     replay steps, and proof artifact ids, so a newer preparation replay is not lost
     behind an older attached executor snapshot. Tool Builder now treats
     `external-action-commit` as a first-class package kind with a safe fixture/mock
     scaffold and a clear `missing_requirements` failure for unfinished live providers.
     A local fixture proposal endpoint now exercises create -> prepare -> approve ->
     build -> attach -> commit without mutating real external systems. The fixture commit
     endpoint returns provider-style confirmation data so the audit/trace output proves
     the commit path, not only a mocked success string. Executor reuse is scoped by the
     target-specific `external-action-commit-*` capability so a generic or older
     reservation executor cannot be silently reused for a different provider/target.
   - Remaining: generate and activate real provider/browser commit executors for live
     booking/API flows; add durable browser session/cookie resume when
     deterministic replay cannot reconstruct the provider state.
   - Acceptance: approved fixture booking commits once, records proof, and duplicate
     commit attempts are idempotent or blocked.

6. **Profile and policy integration.**
   - Use user/group profile for reusable contact data and preferences, but never expose
     secrets or payment data directly to LLM text.
   - Require separate approval for payment, irreversible bookings, outbound messages,
     or sensitive personal data.
   - Acceptance: missing profile fields are listed; payment-like steps always require an
     explicit stronger approval.

7. **Real-world exams.**
   - Prepare-only: "Find a good restaurant in Marbella for 4 people tonight and prepare
     a reservation, but do not confirm."
   - Appointment: "Find a barber/salon near me tomorrow and prepare a haircut booking."
   - Fallback: when no online form is available, prepare a WhatsApp/email/phone script as
     an outbound-message proposal instead of pretending to book.
   - Commit: use a local fixture first, then a real no-payment provider only after the
     approval and proof surfaces are reliable.

Test strategy:

- Unit tests for action-type inference, preparation contracts, commit boundary text, and
  executor build requests.
- API tests for proposal creation, approval, blocked commit, executor-build planning, and
  ready executor commit.
- UI tests/smoke for Run Workspace and `/approvals`: pending proposal cards,
  preparation boundary, missing inputs, approve/reject, approved queue, and
  commit/resume state.
- Browser/manual tests against local fixture pages before any real provider.
- Trace checks for every phase: proposal created, approval decision, executor build,
  commit started, committed/failed, and proof artifacts.

## Phase 10: Evaluation And Release Discipline

Goal: know whether the platform is getting better.

Tasks:

- Add a small standard evaluation suite:
  - direct answer;
  - tool call;
  - screenshot artifact;
  - file artifact;
  - generated tool happy path;
  - generated tool failed QA;
  - versioned tool improvement;
  - delegated research;
  - channel intake;
  - memory follow-up.
- Record cost/time/tool-call counts per run.
- Add per-model/provider success metrics.
- Add regression fixtures for user-visible UI flows.
- Add "known not ready" page/section in docs and UI diagnostics.

Acceptance tests:

- `npm run verify`
- React build
- Docker build
- API smoke
- Browser UI smoke
- At least one real run with persisted audit, trace, artifacts when applicable, and DB
  records checked.

## Current Test Command Set

```bash
npm run typecheck
npm run test:types
npm test
npm run build
npm run build --prefix web-react
docker compose up --build
```

When ports are already occupied, use a compose override for host ports; do not treat a
host port conflict as a product failure if the image builds and the app starts on an
alternate port.

## Immediate Next Step

Continue Phase 4 with API/docs crawling and deeper generated-tool behavioral proof. The
current runtime now persists Postgres `tool_creations` JSONB fields safely, keeps
per-version tool-call cache entries, refuses to promote run-scoped candidates from runs
that hit the step limit, derives first behavior examples from explicit input/output text
or simple original-task text transforms before attaching a candidate, frames broad
recommendation tasks before execution, requires a source read/extract step for broad
recommendations, and classifies live behavior QA separately from deterministic package/
semantic failures. Next, continue Tool Creation V1 API-doc crawling and multi-call QA
fixtures. The previous docs/package-example QA item is partly done for README usage
examples, LLM-authored criteria, chained scenario execution, and live-QA transient
classification. OpenAPI YAML parsing, `$ref` schema-derived QA examples, simple HTML
endpoint extraction, and bounded same-origin multi-page docs crawling are now active;
`web.read@0.1.0` is a generated, behavior-QA'd, manually verified source-bundle tool.
Next open work: generated secret mapping UI, richer integration-contract-driven adapter
source synthesis, and deeper automatic fixture extraction for less structured APIs.
