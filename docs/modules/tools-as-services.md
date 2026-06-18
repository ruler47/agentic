# Tools as Services

Agentic treats tools as external capability packages or services, not as application
source code.

The platform core owns:

- tool metadata and version registration;
- schemas, docs, capabilities, startup mode, settings, and secret handles;
- health/load status and per-version run stats;
- runner configuration for source-bundle, OCI-image, external HTTP, or legacy local-path
  packages;
- run-scoped callback contracts for artifacts, ledger claims, memory search, and events.

The tool implementation itself lives outside the Agentic source tree. The default local
workspace is top-level `tools/`, and that directory is gitignored. Generated/imported
packages under `tools/<system-name>/<version>` are runtime/operator data used to build or
run independent packages and containers. They must not import Agentic internals or add
dependencies to Agentic's root `package.json`.

## Registry Boundary

Agents never discover tools by reading `tools/` directly. They receive only the tool
registrations that are explicitly enabled for agent use.

- `available` generated tools can be offered to agents when policy allows.
- An `available` tool is still omitted from agent prompts when its required runtime
  settings or secret handles are unresolved; operators can see and fix that state through
  runtime readiness in Tools.
- `loaded` generated tools have importable runtime code and can be manually tested, but
  are not offered to agents until promoted to `available`.
- `disabled` tools remain visible to operators for manual testing but are omitted from
  agent prompts.
- `failed` or missing packages can stay registered in metadata so the UI can show that a
  known tool exists but is unavailable because its package/runtime/image is missing,
  unhealthy, or misconfigured.

This keeps the platform deterministic at the boundary while letting tool implementations
be dynamic.

For each run, the agent prompt receives an enriched catalog for callable tools rather
than raw package paths: active version, source, status, capabilities, schema keys,
examples, required settings/secrets, health, usage counters, change summary, and compact
version history. Non-active candidate versions can appear in that history so the agent
can decide whether to request `request_tool_edit`, but only the active `available`
registration becomes a normal callable tool schema. An agent-requested creation or edit
may attach one pinned candidate as `run_scoped_candidate` for the originating run; if
that run succeeds after using it, the candidate is accepted globally and becomes the
active available version for later agents.

When a generated HTTP/API tool executes, its result must include structured diagnostics
alongside the API payload: operation id, method, requested and resolved target, redacted
URL, target base URL, auth handle metadata, HTTP status, and timeout/fetch failure
details when no response is received. These diagnostics are generic platform metadata,
not provider-specific fields, and are shown in run traces so wrong target selection or an
inactive older active version is visible immediately.
For non-2xx HTTP responses, generated clients normalize the provider body into
`providerError` with a status category, readable summary, code when present, and generic
retry/repair hints. The same payload includes the operation `inputContract` inferred from
the docs/OpenAPI contract, allowing a later agent turn to change parameters or select a
different operation without adding provider-specific logic to Agentic core.
The BaseAgent preserves this payload in the tool message sent to the next model turn and
adds a generic repair instruction. The model is expected to use the generated
`inputContract` as the authoritative contract, retry with corrected parameters, switch to
another operation or target when available, or explain that the provider rejected the
request if no useful retry is possible.

## Runtime Contract

Tool runtimes expose a small HTTP-compatible envelope:

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Report runtime health. |
| `POST /run` | Execute one tool invocation. |
| `POST /service/start` | Optional always-on service start. |
| `POST /service/stop` | Optional always-on service stop. |

`POST /run` receives tool-specific `input` plus run-scoped context:

```json
{
  "input": {},
  "context": {
    "instanceId": "instance-local",
    "runId": "run_x",
    "threadId": "thread_x",
    "userId": "user-admin",
    "toolName": "browser.screenshot",
    "now": "2026-05-16T00:00:00.000Z",
    "configuration": {},
    "callback": {
      "baseUrl": "http://app:3000/api/tools/callbacks",
      "token": "<short-lived bearer>",
      "scope": ["artifacts.save", "ledger.claim", "memory.search", "events.emit"]
    }
  }
}
```

The result is plain JSON:

```json
{
  "ok": true,
  "content": "human readable summary",
  "data": {},
  "artifacts": [
    {
      "filename": "proof.png",
      "mimeType": "image/png",
      "contentBase64": "..."
    }
  ]
}
```

Inline artifacts use `contentBase64`. The Agentic runtime rehydrates that into Buffer
payloads before storing artifacts.

External action commit executors use the same runtime envelope. They are generated
portable tools, not provider-specific core branches. The active generic executor receives
an approved proposal plus `preparedSession`, `replaySteps`, `commitCandidates`, and
operator input; it may replay safe browser preparation and perform only the final
approved commit candidate. It must return `missing_requirements` when the prepared
context is insufficient, and it returns provider confirmation metadata plus proof
artifacts when a commit succeeds.
The platform also gates commit before executor invocation: a prepared browser session
must include proof artifacts and at least one concrete submit/control candidate with a
label or selector. Text-only commit-boundary notes are not executable commit candidates.

## Callback API

Generated/container tools can call back into Agentic through
`POST /api/tools/callbacks/*` using the scoped bearer token in their context.

| Action | Path | Scope |
| --- | --- | --- |
| Save artifact | `/api/tools/callbacks/artifacts` | `artifacts.save` |
| Claim ledger work | `/api/tools/callbacks/ledger/claim` | `ledger.claim` |
| Search shared memory | `/api/tools/callbacks/memory/search` | `memory.search` |
| Emit run event | `/api/tools/callbacks/events` | `events.emit` |

This is the future bridge for richer always-on tools such as Telegram adapters: the bot
implementation remains its own service/container, while Agentic receives normalized
events, artifacts, identity hints, and delivery evidence through explicit callbacks.

## Package Workspace

- `TOOL_PACKAGE_WORKSPACE_ROOT` defaults to `tools`.
- `TOOL_PACKAGE_ROOT` can point to a custom package root.
- `tools/` is gitignored and should not contain tracked Agentic source.
- App startup and `POST /api/tools/reload-generated` scan configured package roots for
  `tool.package.json`, register discovered source-bundle manifests, and load them through
  source-bundle/OCI/external runners.
- There is no automatic core-tool seeding. Even basic fetch/search/screenshot/artifact
  capabilities must enter through Tool Creation or import so their metadata, package
  source, QA evidence, and enabled/disabled status are explicit.
- Source-bundle HTTP runtimes inherit host/container Playwright settings by default.
  Operators can set `TOOL_SOURCE_BUNDLE_PLAYWRIGHT_BROWSERS_PATH=0` when a package
  deliberately stores Playwright browser binaries inside its own workspace.

## Tool Creation Direction

Tool creation is capability-driven. A builder agent receives a requested capability,
researches possible implementation routes, chooses among npm package, external API, CLI,
browser automation, custom TypeScript, source-bundle, or OCI/container strategies, writes
a portable package, runs package-local QA, and registers metadata. The create request can
choose its agent availability policy: keep the new tool disabled for manual verification,
or mark it `available` immediately after successful package QA. The automatic path is
still blocked when QA reports `requiresManualLiveVerification`, for example when the
package needs a runtime secret handle for a live API call; in that case the operator must
run the pinned version manually before marking it available to agents.

Package QA is behavioral, not only structural. A creation request or LLM-authored package
snapshot can provide `behaviorExamples` as either single-call checks or multi-step
scenarios. Scenario steps call the same package repeatedly, can save a previous result
with `saveAs`, and can pass values into later calls with placeholders such as
`{{created.data.id}}`. QA can assert content, data paths/equality/includes, artifact MIME,
and PNG visual usability before registration.

Documentation is another behavior source. Operator-provided docs, OpenAPI JSON/YAML,
cURL examples, HTML endpoint pages, or docs URLs are inspected during implementation
discovery. Docs URLs are fetched with a bounded same-origin crawl for relevant API/auth/
reference/example links, so base URL, auth, endpoint, and response examples can come from
separate pages. OpenAPI operations, cURL snippets, and simple HTML method/path examples
can produce docs-derived `external-api` candidates and QA fixtures, including simple
chained scenarios such as `POST /items` followed by `GET /items/{{created.data.id}}`.
Uploaded OpenAPI files are parsed as independent specs even when stored as adjacent tool
context entries without YAML document separators. The YAML reader supports nested lists,
block scalar descriptions, and server variables, and expands concrete server targets
from variable enums. When an enum ticker lines up with a human-readable list in the spec
description, those names are added as target aliases, so agents can select by either the
short documented value or the user-facing name.
OpenAPI fixtures can be derived from explicit media examples or from referenced component
schemas with `example`, `default`, or enum values. HTML docs can contribute base URL,
method/path, query examples, auth hints, and a nearby JSON response example. This is
still provider-neutral; the docs create a contract that a generated package must satisfy,
not a hardcoded API branch. When docs produce a chained create/read scenario, standalone
OpenAPI fixtures are restricted to operations that can execute without hidden path or
state prerequisites. Standalone fixtures may use documented path/query examples,
defaults, or enum values when available; the scenario remains the primary proof for
stateful APIs.

Integration shape is explicit in the package manifest through `integration`
(`agentic.tool-integration.v1`). `run-on-demand` integrations describe callable API or
library operations, base URL when known, auth type, secret handles, and QA examples.
Generated single-operation API tools can use that manifest operation as the default when
an agent supplies only operation inputs such as `query` or `body`. `always-on-service`
integrations describe provider events, outbound responses, lifecycle operations, and
runtime callback strategy. A Telegram bot, Slack adapter, webhook receiver, or API client
therefore uses the same Tool Creation lifecycle; provider-specific code belongs in the
generated package and its container/runtime, while Agentic core only sees the manifest,
schemas, health, events, callbacks, and registered tool version.

Secret handles are visible but values are not. `POST /api/secret-handles/status` lets the
Tools page show whether a generated tool's required handles are registered and resolvable
without returning raw credentials. Inline secret refs are redacted in public responses.
Tool creation and edit requests may include a raw credential in the operator/agent
request body for onboarding convenience, for example an API key or bot token pasted into
the natural-language task. Before discovery, strategy selection, traces, creation
records, prompts, package authoring, or QA see that input, Agentic extracts matching
credentials, stores them as inline secret handles scoped to the tool name
(`secret.tool.<tool-name>.<purpose>`), and replaces the request text/body value with a
redacted marker. The handle is tied to the extension/tool family, not to a specific
version, so later edits reuse or overwrite the same tool-scoped credential unless the
operator supplies a different purpose.
The Tools UI exposes this as an optional credentials field on create/edit forms. It posts
the raw value only once for onboarding and then shows the resulting required handles; the
tool detail and Settings pages continue to show handle status/reference metadata without
revealing values.
The create form is operator-facing rather than builder-facing: operators provide a tool
name, description, task, optional API documentation URLs, optional YAML/JSON/Markdown/text
documentation files, and optional credentials. YAML/OpenAPI specs are uploaded through
the same general documentation file picker as other docs, not through a separate YAML
field. Capabilities, dependency hints, discovery mode, authoring mode, and manual
behavior QA JSON remain advanced overrides. When manual behavior QA is omitted, the
builder derives QA fixtures from OpenAPI specs, crawled docs, cURL examples, README
examples, and the original task whenever possible.
Docs-derived live QA is intentionally conservative: templated server URLs, incomplete
rendered endpoint paths, empty query/path examples, and examples without concrete
expected response signals still produce integration contracts and operations, but they do
not become hard live behavior checks until the builder has concrete parameter values and
expected output signals.
Failed or QA-failed creation attempts can be deleted from Creation history. This removes
the creation record, linked trace run, package workspace under `tools/<name>/<version>`,
and tool-scoped secret handles such as `secret.tool.<name>.*`; registered tools still use
the normal generated-tool lifecycle delete.
When a manual run or pinned-version manual run cannot start because runtime values are
missing, the response includes a structured `missing_runtime_requirements` diagnostic
with missing configuration keys, missing secret handles, and operator actions. This keeps
runtime readiness failures part of the tool contract rather than an unstructured process
error. Agent tool calls use the same diagnostic shape in trace output and in the next
model turn, so the agent can stop retrying the blocked call, explain the missing runtime
requirements, or continue with partial work when that is still useful.
The tool catalog also exposes computed `runtimeReadiness` for every registered tool.
Readiness resolves required configuration keys through the runtime settings store and
required secret handles through the secret handle store. `GET /api/tools/health` combines
package health with readiness, so a tool can be visibly blocked even when its source
bundle or container is otherwise healthy.
The same readiness calculation gates the agent-visible catalog: blocked tools remain in
the operator registry and can be manually inspected, but they are not included in the
tool schemas passed to `BaseAgent`.

The first on-demand API scaffold is operation-oriented rather than URL-only. It accepts
an absolute `url` or `baseUrl + path`, generic `target`, `method`, `query`, JSON `body`,
and safe non-secret headers. OpenAPI `securitySchemes` become secret-handle requirements with
credential placement metadata (`header`, `query`, or `cookie`), and generated clients
apply those credentials only from runtime secret context. OpenAPI operations can be called
by `operationId`; the generated client fills method/path from the manifest, resolves
`target` against provider-neutral integration targets derived from OpenAPI servers,
replaces path placeholders from `pathParams`, merges query parameters, and carries basic
`$ref`-derived request schemas into the operation input contract. It parses JSON responses into top-level
`data` fields and keeps HTTP metadata under `data.response`, so behavior QA can verify
API-specific values and chained flows can feed values from one call into the next.

Tool names are capability names, not source labels. Use names such as `web.fetch`,
`browser.screenshot`, or `text.slugify`; whether a package was generated by Agentic,
imported as a source bundle, backed by an OCI image, or connected as an external service
belongs in manifest and creation metadata.

Wrapping an npm package is one strategy, not a special product path. If the builder finds
a good package, that dependency belongs inside the tool package. If not, the builder can
write a custom implementation or use another runtime route. Good generic tools should be
exportable/importable as source bundles and eventually promotable to OCI images or
npm-style distribution. Each creation attempt should also be observable as a normal run
with tool-creation trace events so operators can inspect how the builder chose and
proved the package.

Tool Editing V1 uses the same lifecycle for an existing generated tool: change request
-> builder strategy -> package authoring -> package-local QA -> new
`tools/<name>/<version>` source bundle -> inactive candidate registration -> reload ->
scoped validation -> activation. Operator edits still require manual pinned verification
before activation. Agent-requested edits are different: after package QA, the edited
candidate is loaded as a pinned callable tool only for the originating run. If the agent
uses that version and the run succeeds, the host records agent-run success as evidence,
marks the candidate `available`, activates it, and reloads the registry so future agents
do not ask for the same improvement again. If a matching inactive candidate already
exists for a later request, RunsService reuses it as the scoped candidate instead of
creating another package. Previous versions remain in version history and can be
activated from the Tools page for rollback, but the Tools Candidate Review queue marks
versions lower than the active version as `superseded` and excludes them from actionable
activation work. Operators can run any registered generated version from
the Versions panel or `POST /api/tools/generated-modules/:name/versions/:version/run`;
future edits also receive the editable per-tool context store. If current edit context
contains explicit negative constraints such as a forbidden host, URL fragment, or target
alias, the builder filters matching inherited integration targets and base URLs before
merging new documentation-derived contracts. This keeps stale package manifests from
overriding operator/docs corrections while staying provider-neutral.

Live web-search requests use a dedicated ToolBuilderAgent `web-search` strategy instead
of the generic echo/custom shell. The scaffolded source bundle exposes `query`/`limit`,
can call a configured JSON search endpoint, falls back to DuckDuckGo HTML search, and
fetches short page previews for top results so agents can complete evidence-based tasks
such as current prices without hand-coded platform modules.
this loads the pinned package through its runner without activating it.

The first browser artifact strategy is `browser.screenshot`. It is still created as an
ordinary source-bundle package, not as Agentic app source: the package owns
`playwright-core`, declares URL/viewport/wait input schema, returns PNG bytes in an
artifact-shaped result, and can run in Docker with Chromium installed by its Dockerfile.
Generated screenshot packages default to viewport capture (`fullPage: false`) and expose
optional `focusText` / `selector` inputs. Agents should pass the value or section they
need to prove so the package scrolls that object of interest into view before capture.
Local runs resolve Chromium from `CHROMIUM_PATH`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`,
or standard Playwright cache directories.

## Files Of Interest

- `src/tools/tool.ts` — platform-side tool contract.
- `src/tools/toolPackage.ts` — portable package manifest contract.
- `src/tools/toolPackageRunner.ts` — barrel export for package runners.
- `src/tools/toolPackageRunnerSourceBundle.ts`,
  `src/tools/toolPackageRunnerHttpRuntime.ts`,
  `src/tools/toolPackageRunnerExternal.ts`, and `src/tools/toolPackageRunnerOci.ts` —
  source-bundle, local HTTP process, external HTTP, OCI, and local-path runner
  implementations.
- `src/tools/toolPackageBootstrap.ts` — package-root manifest bootstrap.
- `src/tools/toolCreationV1.ts` — first guarded source-bundle package writer.
- `src/server/modules/tools/tools.service.ts` — create/import/edit lifecycle endpoints
  and Tool Creation trace events.
- `src/tools/toolCallbackToken.ts` — scoped callback token issuer.
- `src/server/modules/tool-callbacks/` — callback HTTP surface.
