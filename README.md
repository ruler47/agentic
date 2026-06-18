# Agentic Universal Agent

TypeScript prototype being rebuilt around a small Agent / Tool / LLM runtime. The default
path is now `BaseAgent`: one LLM receives the registered tool schemas, calls only the
tools it needs, saves returned artifacts, and marks the run failed when a required action
does not actually complete. The large runtime is being split by responsibility: task
framing, external-action planning, agent-visible tool catalog formatting, and proof URL
normalization now live in dedicated `src/agents/*` modules while the execution loop
continues to shrink.

Project instructions and long-term collaboration notes for AI agents live in [AGENTS.md](AGENTS.md).

## Product Direction

The long-term target is a deployable assistant platform for a family, household, company,
or team. The system should adapt to the group over time while keeping context scoped:

- shared group/company/family memory for this instance;
- personal memory for each member;
- channel identities such as Telegram users;
- conversation threads so Telegram and web can distinguish new tasks from follow-up
  questions, clarifications, and corrections;
- whitelisted requesters;
- auditable outbound messages and reminders;
- instance-scoped tools and credentials;
- simplified API onboarding where an admin provides documentation and access, then the
  system creates a reusable TypeScript tool module with tests and QA.

The active product path is the rebuild runtime: `BaseAgent` plus the registered Tool
catalog and model provider settings. Older coordinator, recursive, tool-build queue,
tool-build council, investigation, and tool-rework flows may still exist in historical
source/docs while the repository is cleaned, but they are not active API/UI surfaces.
See [docs/roadmap.md](docs/roadmap.md) for the rebuild plan.

Default local model endpoint:

- Base URL: `http://127.0.0.1:1234/v1`
- Model: `google/gemma-4-26b-a4b`

## Run

```bash
npm install
npm run dev -- "top 5 cities in Spain by population, sorted by distance to the sea"
```

Run the browser console in Docker:

```bash
docker compose up --build
```

Then open `http://127.0.0.1:3000`.

The compose stack includes the app, Postgres, Redis, MinIO, and SearXNG. Legacy
built-in/reference tools are disabled by default; current tool capability should come
only from generated/imported source-bundle, OCI, or external packages created or imported
through the platform lifecycle. Docker-stack artifacts use Postgres metadata plus MinIO
object payloads.

If a run needs to be stopped while the app is still online, use the Run Workspace
`Cancel Run` action or `POST /api/runs/:id/cancel`. Rebuilding the app container while a
run is active interrupts in-process work; on the next boot the app recovers unfinished
runs as failed instead of resuming them.

Run the browser console directly on the host:

```bash
npm run web:dev
```

This starts the Nest API on `http://127.0.0.1:3000` and the React console on
`http://127.0.0.1:3001`. Backend bootstrap, migrations, and host dev load `.env` and
`.env.local`. Set `DATABASE_URL=postgres://agentic:agentic@127.0.0.1:5432/agentic` and run
`docker compose up -d postgres` when you want runs, run events, tool metadata, and
artifacts metadata to survive API restarts. Without `DATABASE_URL`, runs use the
in-memory store and are intentionally lost on restart. The sidebar and Diagnostics page
read `/api/health` and show the active persistence mode for each stateful store.

Override model settings:

```bash
LLM_BASE_URL=http://127.0.0.1:1234/v1 LLM_MODEL=google/gemma-4-26b-a4b npm run dev -- "your task"
```

Optional tier-specific model overrides:

```bash
LLM_MODEL_TIER_S=cheap-model,cheap-backup \
LLM_MODEL_TIER_M=balanced-model,balanced-backup \
LLM_MODEL_TIER_L=strong-review-model \
LLM_MODEL_TIER_XL=deep-review-model \
docker compose up --build
```

If a tier override is not set, the app falls back to `LLM_MODEL`.
In the web console, open Models to edit and persist model tier policy in Postgres.
The same page now includes a durable Provider Registry for local endpoints, remote
OpenAI-compatible providers, and memory embedding providers. Remote API keys should be
stored through secret handles/settings rather than prompts or memory.

Optional memory embedding provider:

```bash
EMBEDDING_MODEL=text-embedding-3-small \
EMBEDDING_BASE_URL=https://api.openai.com/v1 \
EMBEDDING_API_KEY=secret-handle-or-runtime-secret \
docker compose up --build
```

Without `EMBEDDING_MODEL`, memory retrieval uses the portable deterministic local
embedding provider. Remote embedding vectors are projected into the current 128-dimensional
pgvector column and fall back locally if the endpoint fails.

Provider registry API:

```bash
curl http://127.0.0.1:3000/api/model-providers
curl -X POST http://127.0.0.1:3000/api/model-providers \
  -H 'content-type: application/json' \
  -d '{"label":"OpenAI prod","kind":"chat","providerType":"openai-compatible","baseUrl":"https://api.openai.com/v1","modelIds":["gpt-5.2"],"apiKeySecretHandle":"openai-prod-key"}'
```

Memory operators can rebuild and evaluate retrieval through the web API:

```bash
curl -X POST http://127.0.0.1:3000/api/memories/reembed
curl -X POST http://127.0.0.1:3000/api/memories/evaluate-retrieval \
  -H 'content-type: application/json' \
  -d '{"cases":[{"id":"example","query":"Spanish pharmacy sources","expectedMemoryIds":["memory-id"]}]}'
```

## Verify

```bash
npm run verify
```

`verify` runs lint, typecheck, type-test, Node tests, and the TypeScript build. The
root ESLint config enforces a hard TS/TSX file-size budget (`max-lines=800`) with an
explicit temporary allowlist for known oversized legacy files.

Current server cleanup is moving oversized module responsibilities behind smaller
services: run action proposals are isolated in `ActionProposalsService`, and the Tools
module now has dedicated services for runtime settings, manual/pinned-version execution,
registry/read-admin operations, version lifecycle mutations, source-bundle file helpers,
and tool-creation trace helpers. Remaining files above 800 lines are explicit migration
debt and should only shrink.

For manual smoke testing after a build:

```bash
node dist/cli.js "Скажи одним предложением, что такое универсальный агент"
```

## Request Execution Structure

1. **Run is created from a concrete user task.**
   The server resolves instance, requester, channel, thread context, attachments, and
   audit metadata before execution starts.
2. **`BaseAgent` receives the task and tool catalog.**
   One LLM sees the available tool schemas plus a `finish` action. Before the first
   model step, the runtime creates a task frame that describes the intended quality bar:
   narrow fact lookup, current lookup, exploratory research, product selection, or tool
   build/rework. Broad frames now also carry a concrete research plan, answer contract,
   proof strategy, and external action policy so the model must reason about the ideal
   answer, likely disappointments, required evidence, and approval boundaries before it
   acts.
3. **The model either answers or calls tools.**
   Tool calls go through `ToolRegistry`; tool inputs and outputs are recorded in trace
   events. Identical successful tool calls inside the same run are reused from the
   run-local cache instead of executing the same tool version/input again.
   Trace events carry parent span ids, so Trace Lab can show the caller/callee graph.
   LLM and tool spans also expose normalized `input` and `output` in the inspector.
4. **Artifacts are saved through the shared artifact store.**
   Tools may return files, screenshots, structured data, or text previews. The runtime
   stores those artifacts and links them to the run result. If a task depends on public
   external URL evidence and artifact saving is available, the agent is expected to save
   a screenshot or equivalent proof artifact before finishing, even when the user did
   not explicitly ask for proof. If the model tries to finish early, the return gate
   starts a bounded repair turn and instructs it to capture proof before `finish`.
   Artifact links open inline for preview; adding `?download=1` returns
   `content-disposition: attachment`, and the React artifact cards expose separate
   Preview/Open and Download actions.
5. **The run finishes through a minimal return gate.**
   The runtime rejects empty answers and fails runs when a required artifact action, such
   as an explicitly requested screenshot, did not actually produce an artifact. Public URL
   evidence runs are still pushed toward proof by default, but if screenshot proof fails
   while a useful report has already been drafted, the runtime preserves the answer and
   either saves a JSON source-evidence proof artifact or adds an explicit proof note.
   It also blocks broad recommendation/product-selection answers that have not satisfied
   their research contract, treats step-budget exhaustion as a failed run rather than
   a weak completed answer, and adds a consistency note when deterministic checks catch
   a wrong relative weekday, a failed proof artifact reference, or proof
   artifact/source attribution mismatch. Failed proof artifact references are stripped
   from the final answer before the note is appended.

Tool creation and tool editing are also normal observable runs. Their trace graph now
links builder discovery, strategy, package authoring, package QA, metadata registration,
registry reload, and completion/failure, with normalized `input` and `output` available
in the inspector for each lifecycle span.
Behavior QA distinguishes real package failures from flaky live providers: structural,
build, test, semantic mismatch, and bad artifact checks remain hard failures, while
transient network/provider/auth problems during public live examples are retried and then
stored as `requiresManualLiveVerification` warnings on the QA report.

The next roadmap phases continue from this base: Tool Creation V1 and the first Tool
Editing V1 path are active, and the first External Action proposal queue is wired.
Approval-gated real-world tasks such as booking a table, sending a message, submitting a
form, or calling a write API can now produce run-linked proposals in `/approvals`;
approving or rejecting a proposal records trace and audit evidence. Approved proposals
also expose a commit boundary: each proposal carries a `commitExecutor` contract with
executor kind, readiness, risk, missing requirements, and expected proof. Commit attempts
record `external-action-commit-blocked` from that contract until a generated executor is
attached. When a ready generated executor names a registered tool with
`external-action-commit*` capability and a typed `toolInput`, the commit endpoint runs it
through `ToolRegistry`, emits `external-action-commit-started`, then records
`external-action-committed` or `external-action-commit-failed` with the confirmation
payload. If no executor is attached, `/approvals` can now request one through
`POST /api/action-proposals/:id/build-executor`: the run trace records the executor build
request, reuses an already registered matching executor when possible, or starts the
normal Tool Creation pipeline for a disabled candidate. The remaining work is richer
builder-agent package authoring, pinned version
manual tests, stronger prepare/dry-run planning, confirmation proof artifacts,
child-agent delegation, ledgers, memory, and channels in working slices.

## Artifacts

The web console accepts multiple file attachments with a task. In the Docker stack, new
artifact metadata is stored in Postgres and binary payloads are stored in MinIO through an
S3-compatible object store. The server keeps a local filesystem fallback so older
workspace artifacts and non-Docker development still download through the same
`/api/runs/:id/artifacts/:artifactId` links.
The default local fallback is `workspace/artifacts` in host development and
`/app/workspace/artifacts` inside the Docker container; `ARTIFACT_ROOT` overrides both.

When an answer produces files, the final response can include artifact links. Artifact
creation is driven by reusable tool capabilities, not case-specific runtime branches. For
example, `chart.generate` is a data-agnostic visualization tool: if the task asks for a
graph/chart and validated context contains parsable time-series arrays, the runtime can
invoke this registered TypeScript tool, save an SVG chart, and show it in the Answer
panel. Series names come from input keys, and values can be read from common numeric
fields or the first numeric field in each point.
Text-like input and generated output artifacts also store a short content preview, so the
UI can show source/text snippets and compact CSV/TSV table previews before download.
Accepted artifacts can include compact `quality` metadata from deterministic or tool-level
QA; the UI shows this as a QA badge with the underlying reason available in run, trace,
and artifact views.
Structured-data requests should use registered data acquisition tools that return
validated dataset artifacts. A narrow current example exists for one crypto time-series
source, but the architectural target is provider-configurable, reusable TypeScript tools
with schemas, secret handles, source QA, and versioned upgrades.

Screenshot requests use the same artifact path once a screenshot-capable generated tool
is registered. Tool Creation V1 can build a portable `browser.screenshot` source-bundle
package that uses `playwright-core`, resolves Chromium from runtime configuration/cache,
returns PNG bytes as an artifact-shaped payload, and keeps the tool disabled until
manual review. The current generated screenshot package defaults to viewport-sized proof
captures (`fullPage: false`) and accepts `focusText` or `selector` so the screenshot can
scroll the relevant value or section into view before capture. BaseAgent can also
request tool creation through its `request_tool_creation` meta-action when no enabled
registered tool satisfies a required capability, or request a versioned edit through
`request_tool_edit` when an enabled generated tool is relevant but insufficient. Both
paths create linked Tool Creation runs and records with `source: "agent"`.
Operator-created packages still start disabled until promotion. Agent-requested
creations and edits are loaded back into the same run as pinned `run_scoped_candidate`
versions. If the model tries to answer after receiving a candidate but before calling
it, the runtime blocks that answer, emits `agent-candidate-use-repair-requested`, and
gives the model a bounded repair turn to use the candidate for the original task. If the
agent uses that candidate and the run succeeds, the version is marked available,
activated, and reused by future agents. If the candidate is still not used, the base
return gate fails the run instead of reporting a false success.
Candidate promotion only happens after that return gate passes. A candidate used in a
step-budget failure is not accepted globally, and edited candidate versions execute
against their own versioned cache key so they cannot reuse stale output from the previous
version.

For current-info/source-backed answers, proof is now part of the base runtime contract:
after a tool returns public source URLs, `BaseAgent` prompts the model to use an
available screenshot/artifact tool or request creation of a missing `browser.screenshot`
style tool. This is intentionally generic URL evidence handling, not a special market or
bitcoin path. Screenshots are proof only: current facts such as prices, quotes, weather,
and news must first come from a search/fetch/data tool that returns text or structured
evidence, and screenshot-only answers fail the return gate. Screenshot proof artifacts
receive compact `quality` metadata; failed visual/blocker/source-match QA means the
artifact is saved for inspection but does not satisfy the proof requirement. Failed proof
QA is returned to the next model step so the agent can retry with a better source,
focused viewport, selector, or `focusText` instead of treating the artifact as valid.
The runtime now extracts source-backed proof signals from non-screenshot evidence and
asks the screenshot tool to use the best signal as `focusText`; semantic screenshot QA
receives those expected signals so normal focused proof screenshots are not downgraded
only because the original task text was broad. When screenshots are blocked, noisy, or
only prove a generic roundup, BaseAgent can save a JSON `source-evidence-proof` artifact
from extracted URL evidence. For broad product-selection tasks, that source proof must
match concrete final-answer candidate signals such as product/model names; generic terms
do not satisfy claim proof.
Proof repair now uses a claim-aware proof target planner: it chooses the source URL and
`focusText` from final-answer claims that are actually present in source evidence. This
prevents generic page signals such as a year from becoming the proof target when a more
specific product, service, version, API, or value is available.
Visual QA rejects proof screenshots with centered consent modals and lower-left consent
panels over blurred/low-detail content while avoiding normal page sections with CTA
buttons. Tool package behavior QA can also assert artifact MIME type and PNG visual
usability, so browser/screenshot tool candidates can fail package QA when they return an
image that is blocked by a cookie/consent UI instead of useful page proof.

Before proof repair, `BaseAgent` also checks source grounding for source-backed answers:
concrete final-answer claim signals such as names, versions, specs, dates, prices, or
other externally checkable identifiers must be present in collected non-screenshot source
evidence. If a broad/current task tries to answer from model memory or unsupported
claims, the runtime emits `agent-source-grounding-repair-requested` and gives the model a
bounded chance to read/gather better evidence or soften/remove the claim. If budget is
exhausted but the draft still has user value, the answer is preserved with a clear source
grounding note rather than silently pretending the unsupported claims were verified.
When fallback proof is a JSON source-evidence artifact rather than a passing screenshot,
the runtime strips stale "confirmed by screenshot" wording from the preserved draft before
adding the actual proof artifact reference.

The first
Tool Creation V1 slice can create source-bundle packages from a capability request in
the Tools page or:

```bash
curl -X POST http://127.0.0.1:3000/api/tools/create-package \
  -H 'content-type: application/json' \
  -d '{"name":"demo.echo","request":"Create a small echo tool","capabilities":["demo-echo"]}'
```

The server first records a builder strategy decision, then writes the package under
`tools/<name>/<version>`, runs package-local build/tests, registers and reloads the
manifest, and leaves the tool disabled until an operator manually runs and enables it.
Each attempt is tracked as a Tool Creation record with status, strategy, QA report,
package ref, file list, dependencies, creation `runId`, and errors when applicable. A
Tool Creation attempt is also visible as a normal run in Runs/Run Workspace, with trace
events for discovery, strategy selection, authoring, package QA, registration, and
completion/failure. Runs and Dashboard mark these lifecycle runs with a tool badge so
they are visible in the common run list without looking like ordinary user tasks.
The `tools/` workspace is gitignored runtime/operator data, not Agentic platform source.
Live web-search requests are recognized as a dedicated `web-search` strategy; the
generated source bundle exposes `query`/`limit`, can use a configured JSON search
endpoint, falls back to DuckDuckGo HTML search, and enriches results with page previews
so agents receive source evidence, not only links.
Tool identity and agent visibility live in the tool metadata store; agents receive only
registered tools that an operator has enabled with active status `available`. A
registered or loaded tool can be visible in the UI but unavailable to agents when its
package/runtime/image is missing, disabled, unhealthy, failed to load, or has not yet
been promoted. Without Postgres, this metadata persists to `workspace/tool-metadata.json`
so accepted tool versions survive local dev-server restarts. Operator-disabled tools
remain marked `disabled` through startup/reload health checks, while previously
available tools that no longer load are marked `failed` with the loader reason.
Tool names should describe capability (`web.fetch`, `browser.screenshot`,
`text.slugify`) rather than provenance. Whether a tool was generated by the platform,
imported from a bundle, backed by an OCI image, or attached as an external service is
stored in manifest/creation metadata, not encoded as a permanent `generated.*` prefix.
On startup and on `POST /api/tools/reload-generated`, the server now scans the configured
tool package workspace for `tool.package.json`, registers source-bundle manifests only
when they carry successful package QA evidence, and then loads them through the package
runners. This keeps generated packages portable while preventing failed build attempts
from being bootstrapped as real tools.
There is no automatic core-tool seeding: even basic fetch/search/screenshot/artifact
tools must be created, imported, registered, and enabled by the same platform lifecycle
as any other tool.
Source-bundle HTTP runtimes inherit the host/container Playwright browser configuration;
set `TOOL_SOURCE_BUNDLE_PLAYWRIGHT_BROWSERS_PATH=0` only when a package should keep
Playwright browser binaries inside its own workspace.
For generated browser screenshot tools, `CHROMIUM_PATH` or
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can point at the executable explicitly; otherwise
the package searches standard Playwright browser cache directories before falling back to
the package-local `playwright-core` default.
When request body `discoveryMode: "npm"` or `TOOL_BUILDER_DISCOVERY=npm` is used, the
builder searches the npm registry for implementation candidates, records the selected
package evidence, inspects selected package metadata/README hints when available, and
adds the dependency only to the generated tool package workspace. When README usage shows
a default callable, named export, or namespace member, the builder records an
`adapterContract` and the generated package uses that contract in `/health` and `/run`.
The contract can now also capture simple README object-call shapes such as
`stringify({ foo: "bar" })`, derive the tool input schema from those fields, and pass
the object directly to the package instead of forcing every npm adapter through
`text/options`.
Creation requests may also include `behaviorExamples`; Tool Creation V1 also forwards
the original task as `sourceTask` for agent-requested builds. Examples can be a single
`input` plus expected output checks or a `steps` scenario. Scenario steps call the same
tool multiple times, can save a step output with `saveAs`, and can reference prior output
fields with placeholders such as `{{created.data.id}}`. QA can assert content, data
paths/equality/includes, artifact MIME, and PNG visual usability. The builder can infer
examples from explicit `Input -> Output` text and simple text-transform tasks such as
camelCase, slug, lowercase, uppercase, and trim. README package examples with expected
output comments can also become behavior QA, and LLM-authored source-bundle snapshots may
return API/multi-step/chained criteria when deterministic inference is not enough. Those
examples run against the built package before registration and fail the creation if the
package does not satisfy them. OpenAPI-derived QA now treats create-then-read scenarios
as the primary proof for stateful APIs and avoids brittle standalone path-param/query
checks unless the required parameter values are available from examples, defaults, enums,
or documented example objects.
Creation requests can also provide API docs as `docs`, `documentation`, `apiDocs`,
`openApiSpec`, `openapi`, `curlExamples`, or docs URL fields. Discovery turns OpenAPI
JSON and cURL snippets into provider-neutral external-API candidates and behavior QA
fixtures, including simple chained create/read scenarios, so the generated package must
prove it satisfies the documented API contract before registration.
Tool manifests now carry a provider-neutral `integration` contract. On-demand API tools
record `mode=run-on-demand`, HTTP operations, generic API targets, auth shape, required
secret handles, and QA fixtures. Targets are neutral endpoint variants with `id`,
`baseUrl`, aliases, labels, and free metadata; domain concepts such as networks,
regions, tenants, or environments stay in docs/tool context rather than Agentic core.
Bot/listener/webhook requests record `mode=always-on-service`, provider, inbound/outbound
event schemas, lifecycle operations, and runtime callback strategy. The first
deterministic `service-adapter` scaffold writes an always-on source bundle with generic
lifecycle endpoints; provider-specific loops such as Telegram polling/webhooks must be
authored inside the generated package, not added to Agentic core.
The deterministic HTTP API scaffold now accepts `url` or `baseUrl + path`, `method`,
`target`, `query`, JSON `body`, and safe non-secret headers. OpenAPI `securitySchemes`
are converted to required secret handles with credential placement metadata, and
generated HTTP clients apply those credentials from runtime context only. OpenAPI
operations can now be called by `operationId`; generated clients fill method/path/base
URL from the integration manifest, resolve `target` against integration targets, use the
only documented operation as a default when a single-operation API tool receives just
`query`/`body`, replace path placeholders from `pathParams`, merge query parameters, and
expose `$ref`-derived
request schemas in the operation input contract. JSON responses are exposed as top-level
`data` fields plus `data.response`, which lets multi-step package QA create a resource and
feed fields such as `{{created.data.id}}` into a later call.

For current external-data API calls, BaseAgent now saves a structured JSON proof artifact
from the sanitized request/response when the tool is an API/data capability and the task
does not require claim-specific broad-research proof. Screenshot proof remains available
for page/visual evidence, but a JSON API endpoint no longer has to be screenshotted just
to satisfy the proof gate.

Tool Creation V1 can also generate `web-read` source bundles. The generated `web.read`
tool reads a known URL, extracts title, readable text, and links, and is intended for
research flows where `web.search` snippets are too shallow. Its implementation lives in
the gitignored tool package workspace, not Agentic app source.
When `TOOL_BUILDER_AUTHORING=llm` or request body `authoringMode: "llm"` is used, the
builder asks the XL-tier model for a complete source-bundle snapshot. That snapshot must
be JSON, include source/runtime/test files, stay inside safe package paths, avoid raw
secrets, and avoid importing Agentic app internals before normal package QA runs. If the
LLM snapshot is missing or unsafe, the creation record keeps fallback notes and the
guarded scaffold writer is used instead.
Source bundles can be exported with `GET /api/tools/:name/source-bundle` and imported
with `POST /api/tools/source-bundles`; imports run the same package-local QA and start
disabled until verified. Existing generated tools can request an edited version with
`POST /api/tools/generated-modules/:name/versions` or the Tools page "Request tool edit"
panel. BaseAgent uses the same endpoint through `request_tool_edit` for agent-requested
rework. Editing reuses the same discovery/strategy/authoring/package-QA/trace path,
registers the new version as an inactive disabled candidate, reloads the runtime, and
keeps the previous active version active until promotion. Operator edits still require
manual verification/promotion. Agent-requested edits get scoped continuation inside the
originating run; successful use promotes the candidate globally, while a similar future
edit request reuses a matching inactive candidate before building another package.
Operators can also run any registered generated version directly with
`POST /api/tools/generated-modules/:name/versions/:version/run` or the Versions panel,
which tests a candidate package without activating it or offering it to agents. The
Versions panel also shows a side-by-side review of the active version and the next
inactive candidate: package refs, status, capabilities, health, run counts, QA summary,
QA checks, pinned manual-run evidence, and the explicit activation action. Server-side
promotion is evidence-gated: an inactive generated version cannot be activated or marked
available until that exact version has a successful pinned manual run recorded in audit.
Version lifecycle actions are also inspectable: creation, pinned manual run,
mark-available, activation, agent acceptance, rejection, and delete show in the Versions
panel and are appended to the original creation/edit trace with input/output payloads.
Rejecting a candidate does not delete it: the version stays visible with
`reviewStatus: "rejected"` and a reason, while activation, mark-available,
agent-scoped loading, and reusable-candidate selection are blocked for that version.
The Tools page also has a Candidate Review queue over the enriched `/api/tools` catalog,
grouping inactive generated versions into manual-run, ready-to-activate, failed,
rejected, and superseded buckets with direct run/activate/reject/trace actions. Older
versions below the current active version remain available for explicit rollback, but
they are not counted as actionable candidates.

The target shape is closer to "smart npm packages" than app plugins: each generated tool
owns its package metadata, source, tests, Dockerfile, runtime contract, and npm
dependencies. Tool creation is capability-driven rather than template-driven: a builder
agent should decide whether to wrap an existing npm library, call an external API, use a
CLI, automate a browser flow, write custom TypeScript, or combine strategies. If it wraps
an npm library, that dependency belongs in the tool package workspace, not in Agentic's
root app. Good generic tools should be importable/exportable as source bundles, runnable
independently through `/health` and `/run`, and eventually promotable to container or
npm-style distribution.

Tool contracts are persisted in Postgres when the Docker stack is running. The
`tool_modules` catalog stores version, capabilities, schemas, source, status, required
configuration keys, secret handles, docs/examples, success/failure counters, and latest
health details. The Tools page currently focuses on registry visibility, manual runs,
health, settings, versions, pinned version runs, usage counters, enable/disable policy,
required secret handle status, and the first source-bundle creation/editing panels. Secret
status checks show only registered/resolvable state plus public refs; inline secret values
remain redacted. Manual tool runs now return structured runtime diagnostics when a
package cannot start because required configuration keys or secret handles are missing;
the Tools UI shows the missing keys/handles and links operators to the settings surface
instead of leaving the failure as an opaque tool error. The same catalog now exposes
`runtimeReadiness`, so Tools and healthchecks can show that a package is blocked by
missing runtime values before an agent or operator attempts a real call. The run runtime
uses the same readiness check when building the agent tool catalog: an `available`
registration with missing settings or unresolved secret handles is omitted from agent
schemas until the operator completes its runtime configuration.

The target registry remains an operator-visible capability catalog: tool name, versions,
changelog, schemas, required settings/env keys, required secret handles, examples,
success/failure counters, health, linked run/span issues, generated source/tests, QA
reports, and declared storage contracts. Future generated tools should be created as
out-of-tree packages or services, not as permanent Agentic app source.

## Shape

```text
User Task
  -> Run context resolution
  -> BaseAgent
      -> LLM with registered tool schemas
      -> optional ToolRegistry calls
      -> artifact save
      -> finish / return gate
  -> Final Answer
```

The current implementation is intentionally small. Delegated agents, arbitrary
builder-agent tool creation, tool editing/versioning, richer ledgers, and channel
automation are rebuilt in roadmap phases rather than kept as active legacy behavior.

## Modules

- [Architecture](docs/architecture.md)
- [Agent runtime](docs/modules/agent-runtime.md)
- [Web console](docs/modules/web-console.md)
- [Instance context and personalized assistant model](docs/modules/instance-context.md)
- [Target infrastructure](docs/modules/infrastructure.md)
- [Browser operate tool](docs/modules/browser-operate.md)
- [Roadmap](docs/roadmap.md)
