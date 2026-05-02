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
- Synthesize the final answer.
- Store reusable skill memory.
- Emit typed events for external observers.
- Run registered tools, such as `web.search`, and inject tool evidence into worker prompts.
- Select a model tier for each LLM step and expose it in trace payloads.
- Accept input artifacts and include them in agent context.
- Request output artifacts from registered tools, currently `chart.generate` for SVG
  charts from parsed time-series data.

## Public Contract

```ts
const result = await agent.run(task, {
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

## Extension Points

- Replace `LlmClient` with another OpenAI-compatible or provider-specific client.
- Replace `SkillMemory` with a database-backed implementation.
- Add tool execution to worker agents through a tool registry.
- Add self-service tool scaffolding on top of the versioned tool contract.
- Persist generated tool metadata in `tool_modules` and load promoted executable modules
  into `ToolRegistry` at startup.
- Add deeper retry policy and budget controls for repeated `needs_revision` verdicts.
- Allow recursive child-agent creation instead of coordinator-owned orchestration.

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
now exposes `GET /api/tool-build-requests/:id` and `PATCH
/api/tool-build-requests/:id`, so future Builder, QA, and Registrar agents can claim a
request, publish test evidence, and mark the module registered without inventing a
separate protocol. The next step is a Tool Builder agent that consumes this queue, writes
the TypeScript module, asks a Tool QA agent to test it, and only then asks a registrar to
promote it into `ToolRegistry`.

`ToolBuildWorkflow` is the reusable orchestration boundary for that flow. It has pluggable
Builder, QA Runner, and Registrar interfaces. The workflow marks a request `building`,
attaches the QA report, returns failed QA evidence to the builder for bounded retry
attempts, stops on final `qa_failed`, and only marks `registered` after the Registrar
returns a generated tool name.

The first concrete Builder implementation is provider-backed rather than open-ended code
generation. `BrowserScreenshotToolBuildProvider` can satisfy `browser-screenshot` requests
by writing a Playwright TypeScript tool and generated tests. `CommandToolQaRunner` now uses
temporary workspace isolation: it copies project source/tests/config into a disposable QA
directory, links dependencies, runs the generated-tool test and build there with command
timeouts, then runs promotion tests/build in the real project only after isolated QA
passes. `MetadataToolRegistrar` records the generated metadata, after which the server
reloads generated tools into the active registry. This gives us a real end-to-end loop
while keeping unknown capability families blocked until a provider or future LLM-authored
builder can safely handle them.

The registrar path now supports generated metadata registration into `tool_modules` with
name/version conflict checks. Registered generated modules start as `disabled` until the
runtime can load their executable TypeScript module and pass health checks.

Generated module loading is deliberately constrained:

- metadata must include a project-relative `modulePath`;
- the app imports the compiled JavaScript equivalent from `dist`;
- the exported object must implement the `Tool` interface;
- exported name/version/capabilities must match `tool_modules`;
- healthcheck must pass before the tool is registered in `ToolRegistry`;
- failed imports, mismatches, or failed healthchecks update registry status to `failed`.

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
