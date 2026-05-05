# Agent Runtime Module

## Purpose

The agent runtime owns task execution. It can be reused without the web UI.

Main file:

- `src/agents/universalAgent.ts`
- `src/tools/tool.ts`
- `src/tools/registry.ts`

## Responsibilities

- Search shared skill memory.
- Classify a task as direct or delegated.
- Plan focused subtasks.
- Execute subtasks as a dependency-aware DAG.
- Run worker agents.
- Run reviewer agents.
- Ask workers to revise once when a reviewer returns `needs_revision`.
- Persist structured worker/reviewer call frames inside run events.
- Emit a local return self-check before worker/reviewer results are considered ready to
  move upward.
- Synthesize the final answer.
- Store reusable skill memory.
- Emit typed events for external observers.
- Run registered tools, such as `web.search`, and inject tool evidence into worker prompts.
- Select a model tier for each LLM step and expose it in trace payloads.
- Accept input artifacts and include them in agent context.
- Request output artifacts from registered tools, currently `chart.generate` for SVG
  charts from parsed time-series data.
- Accept compact conversation-thread context for continuation runs.
- Receive optional conversation-thread context and include it in bounded runtime context
  for continuation runs.
- Future: receive full instance/user/channel context from adapters and use it to scope
  memory, tools, artifacts, policies, and outbound actions.

## Public Contract

```ts
const result = await agent.run(task, {
  // Future context fields:
  // instanceId,
  // requesterUserId,
  // channel,
  // threadId,
  // parentRunId,
  // threadContext,
  inputArtifacts,
  saveArtifact: async (artifact) => artifactStore.saveGenerated(runId, artifact),
  requestToolBuild: async (request) => toolBuildRequestStore.create(request),
  onEvent: (event) => {
    // Persist, stream, or render event.
  },
});
```

The runtime does not know about HTTP, browsers, databases, or queues. That separation is
intentional: another project can import the runtime and provide its own interface.
The same rule should apply to Telegram and future channels: always-on generated tools
resolve identity and permissions before calling the runtime, instead of embedding provider
logic inside agent execution.

## Future Context Contract

The current `run(task, options)` contract accepts thread context but is still mostly
single-user. The target contract adds full context without making the runtime depend on
web or Telegram infrastructure:

```ts
type AgentRunContext = {
  instanceId: string;
  requesterUserId: string;
  channel: "web" | "telegram" | "api" | string;
  threadId?: string;
  parentRunId?: string;
  sourceMessageId?: string;
  sourceChatId?: string;
  sourceThreadId?: string;
  threadContext?: {
    summary: string;
    acceptedFacts: string[];
    rejectedAttempts: string[];
    openQuestions: string[];
    relevantArtifactIds: string[];
  };
  permissionScope: {
    memoryScopes: Array<"global" | "group" | "user" | "run">;
    toolCapabilities: string[];
    outboundActions: string[];
  };
};
```

Runtime responsibilities with context:

- pass context to memory retrieval so global/group/user memories are scoped;
- pass context to tools so instance/user credentials and policy can be enforced;
- include context in trace events and artifacts;
- include thread context in classifier/planner prompts as bounded summary, not raw
  transcript;
- emit enough output for the caller to update the thread summary after the run;
- create outbound action requests rather than directly sending provider messages;
- keep secret handles out of prompts, memory, artifacts, and trace details.

## Extension Points

- Replace `LlmClient` with another OpenAI-compatible or provider-specific client.
- Resolve model ids through the durable provider registry described in
  `docs/modules/model-providers.md` so local and remote chat providers can coexist.
- Replace `SkillMemory` with a database-backed implementation.
- Add tool execution to worker agents through a tool registry.
- Add self-service tool scaffolding on top of the versioned tool contract.
- Persist generated tool metadata in `tool_modules` and load promoted executable modules
  into `ToolRegistry` at startup.
- Add deeper retry policy and budget controls for repeated `needs_revision` verdicts.
- Allow recursive child-agent creation instead of coordinator-owned orchestration.
- Add a reusable thread classifier that distinguishes new tasks, continuations,
  clarification questions, and corrections before run execution.

## Agent Call Frames And Self-Checks

Phase 4 introduces the first durable contract needed for recursive agents without yet
replacing the coordinator-led DAG. Worker and reviewer spans now carry a `callFrame`
payload:

- `id`: stable frame id derived from the span id;
- `runId`, when available through runtime context;
- `spanId` and `parentSpanId`;
- `role` and `actor`;
- local task and output contract;
- dependency span ids for reviewed upstream inputs;
- model tier;
- started/completed timestamps;
- status and compact output summary.

Before a worker or reviewer emits its completed span, it emits
`agent-self-check-completed` as a child event. This is the universal "ready to return"
check that every future recursive child agent should perform before handing work to its
caller. Current worker checks are deterministic:

- non-empty output;
- known evidence state;
- required artifact presence;
- typed artifact QA from the artifact requirement contract;
- visible limitations/blockers in the output.

Current reviewer checks verify:

- valid verdict;
- explanatory notes;
- returned `subtaskId` matches the worker being reviewed.

Because call frames and self-checks are stored as normal `run_events`, they are durable in
Postgres, stream through SSE, and appear in Trace Lab without adding a separate persistence
path. A later recursive runtime can either keep this event-backed model or project the same
payload into a dedicated call-frame table if it needs query-heavy scheduling.

## Tool Registry Metadata

`ToolRegistry` owns executable in-process tools. `ToolMetadataStore` owns the durable
registry catalog used by the UI and future Tool Builder flow.

When Postgres is enabled, server startup syncs every built-in tool contract into
`tool_modules`:

- name and version;
- description;
- capabilities;
- startup mode;
- input/output schemas;
- source (`builtin` today, `generated` later);
- status and last health result.

`GET /api/tools` reads this catalog. `GET /api/tools/health` runs registered tool
healthchecks and persists the latest status back into the catalog.

## Tool Build Requests

When a task needs a capability that is not registered, the runtime emits `tool-missing`.
If a `requestToolBuild` callback is configured, it also creates a durable Tool Build
Request and emits `tool-build-requested`.

Each request stores:

- missing capability and reason;
- source run/span;
- desired inputs and outputs;
- lifecycle status from `requested` through `registered` or `blocked`;
- status detail, QA report, and registered tool name when available;
- TypeScript module path and test path;
- generated input/output schemas;
- acceptance criteria;
- QA criteria and builder instructions.

This is intentionally a contract and queue, not arbitrary runtime code execution. The API
exposes `GET /api/tool-build-requests/:id` and `PATCH
/api/tool-build-requests/:id`, while `ToolBuildWorker` consumes the same queue in the
background. The worker claims the oldest `requested` row through the store, marks it
`building`, runs Builder -> QA -> Registrar, and reloads generated tools after a passing
registration. Manual `POST /api/tool-build-requests/:id/run` remains as an operator
fallback.

`ToolBuildWorkflow` is the reusable orchestration boundary for that flow. It has pluggable
Builder, QA Runner, Review, and Registrar interfaces. The workflow marks a request
`building`, attaches the QA report, runs configured code/behavior review gates, returns
failed QA or review evidence to the builder for bounded retry attempts, stops on final
`qa_failed`, and only marks `registered` after QA plus all configured review gates pass
and the Registrar returns a generated tool name.

The first concrete Builder implementations are provider-backed and guarded rather than
unrestricted runtime code execution. `BrowserScreenshotToolBuildProvider` can satisfy
`browser-screenshot` requests
by writing a Playwright TypeScript tool and generated tests. `GenericApiToolBuildProvider`
can satisfy reusable API capability requests such as `api.aml.score` by writing a
domain-neutral HTTPS JSON adapter with typed URL/method/query/body inputs, optional
declared secret handles, generated tests against a local HTTP server, structured
status/url/json/text evidence, and nested `score` extraction for score-bearing API
responses. Provider presets can still stay generic; for example a Global Ledger-style
request maps network/address inputs to the documented HTTPS endpoint while keeping the
API key behind a declared secret handle. The Global Ledger preset now also has a
versioned replacement path: v1.1.0 fixed `totalFunds` final-score extraction and source
parsing, while v1.2.0 enables Unified search by appending `token=supported` to address
and transaction report URLs. `LlmToolBuildProvider` is now available as a guarded fallback
after deterministic providers decline an unknown/custom capability family: it asks the
configured XL-tier OpenAI-compatible model for the requested TypeScript module/test pair,
rejects unexpected paths and raw-looking secret material, and then hands the generated
output to the same QA and registration lifecycle. Set `TOOL_BUILD_LLM_PROVIDER=disabled`
to keep Tool Builds deterministic-provider-only. `CommandToolQaRunner` now uses
temporary workspace isolation: it copies project source/tests/config into a disposable QA
directory, links dependencies, runs the generated-tool test and build there with command
timeouts, then runs promotion tests/build in the real project only after isolated QA
passes. After QA, deterministic review gates check generated source/manifest contract
safety and whether QA evidence has the expected test/build shape. If
`TOOL_BUILD_LLM_REVIEW=enabled`, the workflow also runs LLM code and behavior reviewers
that inspect the durable request contract, QA report, and generated module/test previews.
Their structured `pass`, `needs_revision`, or `fail` findings are stored in
`qaReport.reviews` and can be returned to the builder for repair. `MetadataToolRegistrar`
records the generated metadata, after which the server reloads generated tools into the
active registry. This gives us a real end-to-end loop while keeping generated code behind
contract validation, QA, and review gates.

The worker is enabled by default in `src/server/main.ts`. Set
`TOOL_BUILD_WORKER=disabled` for a fully manual queue, or tune polling/batch size with
`TOOL_BUILD_WORKER_INTERVAL_MS` and `TOOL_BUILD_WORKER_BATCH_SIZE`.

The registrar path now supports generated metadata registration into `tool_modules` with
human `displayName`, stable system-name/version conflict checks, and generated-tool
deletion. Registered generated modules start as `disabled` until the runtime can load
their executable TypeScript module and pass health checks.

Generated module loading now goes through a `ToolPackageRunner` contract. The installed
runners are:

- `LocalPathToolPackageRunner`, which preserves the current compiled TypeScript path;
- `SourceBundleToolPackageRunner`, which loads pre-built out-of-tree packages from
  `TOOL_PACKAGE_ROOT` (default `tool-packages`) when a manifest declares
  `package.type="source-bundle"` and `package.ref` stays inside that package root.
- `ExternalHttpToolPackageRunner`, which loads `external-package` manifests whose
  `package.ref` is an HTTP(S) runtime URL. It proxies `GET /health`, `POST /run`, and
  optional service lifecycle calls through `POST /service/start` and
  `POST /service/stop`.
- `OciImageToolPackageRunner`, which is disabled by default and becomes available when
  `TOOL_OCI_RUNNER=enabled`. It starts a Docker container for `package.type="oci-image"`,
  publishes internal port `TOOL_OCI_INTERNAL_PORT` (default `8080`), waits for the same
  `/health` contract, and then proxies runtime calls through the external HTTP adapter.

Future package runners can use the same extension point for npm packages, sandboxed
process pools, or remote execution platforms.

Local-path loading is deliberately constrained:

- metadata must include a project-relative `modulePath`;
- the app imports the compiled JavaScript equivalent from `dist`;
- the exported object must implement the `Tool` interface;
- exported name/version/capabilities must match `tool_modules`;
- healthcheck must pass before the tool is registered in `ToolRegistry`;
- failed imports, mismatches, or failed healthchecks update registry status to `failed`.
- imported package manifests with no installed runner (for example non-HTTP external
  package references such as npm coordinates, or OCI images while the OCI runner is
  disabled)
  are not marked failed during startup; they remain disabled metadata until a package
  runner/supervisor can execute that reference type. Tests prove that a registered
  external runner can load such a manifest without changing the core loader.

The first OCI runner is intentionally conservative: it starts one HTTP runtime container
per loaded package and delegates tool semantics to that container. It does not yet pull
images, rotate containers, stream container logs, enforce resource limits, or pass
runtime secrets into containers. Those belong to the next runner-supervisor hardening
phase.

This gives the future Tool Builder a safe promotion path: write TypeScript, run QA, register
metadata, rebuild/restart, then let the loader promote the tool after contract validation.

For browser screenshot requests, the runtime can now use that path during the original
run: if `browser-screenshot` is missing, the build callback may create/register/reload the
tool, then the agent invokes it and saves the returned PNG artifact.

## Model Tiers

The runtime chooses a tier for each LLM call:

- `S`: cheap bookkeeping, classification, memory learning.
- `M`: normal planning, worker execution, synthesis.
- `L`: strict review or riskier reasoning.
- `XL`: high-risk architecture, migration, security, audit, or similar work.

Tier selection is implemented in `src/agents/modelTier.ts`. `LlmClient` maps tiers to
environment overrides (`LLM_MODEL_TIER_S`, `LLM_MODEL_TIER_M`, `LLM_MODEL_TIER_L`,
`LLM_MODEL_TIER_XL`) and falls back to `LLM_MODEL` when a tier-specific model is not set.
The same OpenAI-compatible client can point at a local endpoint or a remote provider such
as the OpenAI API by changing base URL, model names, and API-key secret/configuration.
In the web server, tier policy is loaded from `model_tier_settings` on each request so UI
changes affect subsequent LLM calls without rebuilding the container.
For transport failures, HTTP errors, or empty assistant content, `LlmClient` retries each
configured model up to the tier's attempt limit, then escalates to the next tier when the
policy permits it.

## Artifacts

Artifacts are represented as metadata records with:

- `id`
- `runId`
- `kind`: `input` or `output`
- `filename`
- `mimeType`
- `sizeBytes`
- `url`

The web server provides a local artifact sink. The runtime stays storage-agnostic by
calling `saveArtifact` when it needs to persist a generated file.

Current artifact behavior:

- Input files submitted through the UI/API are saved before the run starts and are passed
  into the agent as `inputArtifacts`.
- If the original task asks for a chart/graph and worker outputs include a parsable
  time-series array, the runtime invokes the registered `chart.generate` TypeScript tool
  and saves the returned SVG line chart artifact. The chart parser is data-agnostic: it
  derives series names from JSON keys and numeric values from common numeric fields or
  the first usable numeric field.
- Synthesis receives artifact links and should mention useful files in the final answer.
- If no registered tool provides a required capability, the runtime emits a `tool-missing`
  trace event and can persist a Tool Build Request with a builder/QA contract.

Known limitation: artifact generation is deterministic and narrow today. It does not yet
create missing tools autonomously, execute arbitrary plotting code, create screenshots, or
store artifacts in MinIO/S3.

## Subtask DAG

Planner output can include `dependsOn` on each subtask:

```json
{
  "id": "review-report",
  "title": "Review generated report",
  "dependsOn": ["build-report"]
}
```

The runtime normalizes dependencies, drops missing/self dependencies with planning
warnings, and executes ready subtasks in parallel by DAG level. A dependent worker starts
only after all required upstream workers have completed and passed through review. The
worker prompt receives a compact "Dependency results" section containing reviewed upstream
outputs and review notes.

Trace events keep direct parent links:

- independent workers hang from the planner span;
- dependent workers hang from the latest dependency worker span;
- `payload.dependencySpanIds` contains all upstream worker spans for UI arrows and
  observability;
- review spans hang from the worker they review.

## Review And Revision Loop

Each worker is reviewed immediately after it completes. If the reviewer passes the
result, that result is sent to synthesis. If the reviewer returns `needs_revision`, the
same worker receives only the review notes as revision instructions, produces a revised
result, and that revision is reviewed again.

Trace shape:

```text
planner
  -> worker
       -> reviewer
       -> worker revision
            -> reviewer
```

The final synthesis receives the latest worker result plus the full review history, so a
user or UI can see what was rejected and what was fixed.

## Tests

- `tests/universalAgent.test.ts`
- `tests/chartArtifact.test.ts`
