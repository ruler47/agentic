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

## Phase 1: Reliable Memory

Status: partially implemented.

The runtime now uses Postgres-backed memory when `DATABASE_URL` is present. Search uses
Postgres full-text search plus lexical rescoring. The next step is semantic retrieval with
`pgvector`.

Tasks:

- Store skill memories in Postgres. DONE
- Add embeddings with `pgvector`.
- Store source run IDs and evidence.
- Search by semantic similarity plus tags.
- Show memory hits in UI with confidence and why they matched.
- Add tests proving repeated similar tasks retrieve prior memories.

Remaining memory gaps:

- Search is token-based, not semantic.
- The agent only stores a memory when the LLM returns `shouldStore: true`.
- Stored lessons are generic, so specific repeated requests may not match well.

## Phase 2: Tool Registry

Status: partially implemented.

The runtime has a first-class tool registry and an initial `web.search` tool powered by
SearXNG. Built-in tool contracts are synced into a persistent `tool_modules` table when
Postgres is configured, so future generated tools can be versioned, health-checked, and
promoted without being only in process memory.

Tool contract:

- name;
- version; DONE
- input schema; DONE
- output schema; DONE
- capabilities; DONE
- startup mode; DONE
- healthcheck; DONE
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
- API/UI expose source, status, schemas, startup mode, and capabilities.

Every tool call must emit trace events with:

- caller span;
- tool name;
- input summary;
- output summary;
- duration;
- status.

## Phase 3: Self-Service Tool Modules

Allow agents to create or activate tools when the registry lacks a needed capability.

Flow:

```text
agent needs capability
  -> searches tool registry
  -> activates existing tool if available
  -> otherwise delegates tool creation to a Tool Builder agent
  -> Tool Builder agent scaffolds the module
  -> Tool Builder agent delegates verification to a Tool QA agent
  -> Tool QA agent writes/runs tests and performs a manual smoke check when applicable
  -> Tool Registrar agent registers the verified tool contract
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
- Tool activation must have resource limits.
- Tools must be reviewed before becoming reusable.
- A failed QA step must prevent registration.
- Ephemeral tools must be cleaned up after the run unless explicitly promoted.

Next implementation tasks:

- Add a tool registry persistence table. DONE for metadata; remaining work is loading
  generated executable modules from persisted registry records.
- Add `tool-missing` trace events. DONE
- Add a Tool Builder agent contract. DONE for persistent build request contracts and a
  provider-based generated source writer; remaining work is LLM-authored provider
  creation for new capability families.
- Add a Tool QA agent contract. DONE for generated QA criteria, isolated generated-tool
  test execution, TypeScript build verification, and promotion checks; remaining work is
  richer visual QA and separate worker pools.
- Add a persistent Tool Build Queue. DONE via `tool_build_requests` and
  `/api/tool-build-requests`.
- Add Tool Build Queue lifecycle APIs. DONE via `GET/PATCH
  /api/tool-build-requests/:id`, builder status details, QA reports, and registered tool
  references.
- Add a Tool Registrar service with version conflict checks. DONE.
- Load executable generated modules after QA/registration. DONE for compiled project-local
  modules with contract validation and health promotion.
- Enforce TypeScript-only generated tool modules. DONE through provider output paths,
  targeted tests, and `npm run build` in QA.
- Add a Tool Builder worker that consumes queued requests, writes TypeScript source,
  creates focused tests, delegates QA, and registers only after QA passes. DONE for
  provider-backed builds through `POST /api/tool-build-requests/:id/run`.
- Add a reusable Tool Builder workflow. DONE as `ToolBuildWorkflow`, with pluggable
  Builder, QA Runner, and Registrar interfaces plus tests proving failed QA blocks
  registration and failed QA reports can be returned to the builder for a bounded retry.
- Add a Tool QA runner that executes targeted tests plus capability-specific smoke checks
  in an isolated container/process and writes a structured QA report back to the queue.
  DONE for temporary workspace isolation, command timeouts, targeted tests, isolated build,
  and promotion build verification.
- Implement `browser.screenshot` as the first self-service tool target. DONE with a
  Playwright provider that writes module and smoke-test files.
- Prove the full loop with a test task that requires a missing screenshot capability.
  DONE in automated runtime tests; remaining work is repeated manual browser/UI evidence
  after Docker rebuilds.

Remaining Phase 3 gaps:

- Replace provider-authored source with a higher-level Tool Builder agent that can create
  new providers/modules for unknown capability families.
- Move generated-tool QA from temporary workspace isolation to a stricter worker service
  or container pool with CPU/memory/network limits.
- Add LLM/provider repair implementations that consume failed QA reports; the workflow
  already supports bounded retry attempts.
- Persist generated source bundles and QA artifacts in object storage.

## Phase 4: Recursive Universal Agents

Move from coordinator-only orchestration to recursive agents.

Desired behavior:

```text
agent receives one task
  -> decides if it can solve directly
  -> if not, creates child agents
  -> gives each child only local context
  -> child agents can recursively delegate
  -> child returns reviewed result to parent
  -> parent accumulates and returns upward
```

Each agent should know:

- its local task;
- its caller;
- allowed budget;
- available tools;
- relevant memories;
- output contract.

Each agent should not need to know:

- the whole global task graph;
- unrelated sibling context;
- final UI structure.

## Phase 5: Model Tier Selection

Status: partially implemented.

Agents choose model tier by risk and complexity. The current implementation selects a
tier for each LLM call, sends it through `LlmClient`, and shows the tier in trace cards.
Tier model lists are configurable and persisted in Postgres so the user can run several
local LLMs and assign multiple candidates to each tier.

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
- Postgres-backed model tier settings.
- API/UI for viewing and updating model tier policy.
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

Remaining:

- Timeline mode by wall-clock time.
- Filters and run comparison.
- Rich artifact and memory-hit panels.

## Phase 7: Durable Artifacts

Status: partially implemented.

Implemented:

- User requests can include file attachments through the web UI/API.
- Attachments are persisted as input artifacts in `workspace/artifacts`.
- Runs can return downloadable artifact links in `result.artifacts`.
- The runtime invokes the registered `chart.generate` TypeScript tool when a task asks
  for a graph/chart and task context or worker output contains a parsable time series.
- Artifact creation emits trace events.

Remaining:

- Promote artifact metadata to Postgres.
- Store payloads in MinIO/S3 instead of local manifests.
- Add artifact previews in the UI for images, PDFs, screenshots, datasets, and source
  bundles.
- Make reviewers artifact-aware across all file types, not only chart requests.
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

Target examples:

- User asks for a market analysis with a graph:
  - collect structured market data;
  - generate a real chart image;
  - review the image/artifact, not just the chart code;
  - return text plus a downloadable/previewable file.
- User asks for a dossier with screenshots/photos/PDF:
  - search/open web pages;
  - manage cookies/session state when needed;
  - capture screenshots;
  - inspect the screenshots;
  - assemble a PDF/report artifact.

Implementation tasks:

- Add explicit artifact contracts to subtasks (`requiredArtifacts`, type, acceptance
  criteria).
- Add DAG dependencies between subtasks so reviewers and synthesizers wait for required
  parent artifacts. DONE for reviewed text outputs; remaining work is typed artifact
  dependencies.
- Add structured data tools for market/crypto time series instead of relying on search
  snippets.
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
- Add artifact-aware review prompts that fail when a requested file is missing or only
  represented as code/prose.
- Allow the recursive universal-agent flow to delegate missing capability creation to
  Tool Builder, Tool QA, and Tool Registrar agents.
