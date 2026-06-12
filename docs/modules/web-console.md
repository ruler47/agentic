# Web Console Module

Status date: 2026-05-15.

## Purpose

The web console is the browser UI and HTTP API for the current Agentic rebuild. It lets an
operator submit runs, inspect traces, manage tools, view artifacts, configure models, and
check system state.

Main files:

- `src/server/main.nest.ts`
- `src/server/app.module.ts`
- `src/server/modules/**`
- `web-react/src/**`

The old hand-rolled web UI and legacy Tool Builds/Coding Council pages are no longer
active product surfaces.

## Current Pages

Active React routes:

- `/` Dashboard
- `/runs`
- `/run/:runId`
- `/conversations`
- `/conversation/:threadId`
- `/trace`
- `/trace/:runId`
- `/ledger`
- `/memory`
- `/artifacts`
- `/tools`
- `/models`
- `/group-profile`
- `/users`
- `/channels`
- `/policies`
- `/approvals`
- `/scheduler`
- `/audit-log`
- `/settings`
- `/diagnostics`

Removed from navigation:

- `/tool-builds`
- Coding Council settings section
- Tools-page "Request changes" panels
- Trace Lab investigation/rework modal flow

## Core API

Health:

```http
GET /api/health
```

Create a run:

```http
POST /api/runs
content-type: application/json

{
  "task": "one concrete task",
  "instanceId": "instance-local",
  "requesterUserId": "user-admin",
  "channel": "web",
  "threadId": "optional existing thread",
  "parentRunId": "optional previous run",
  "attachments": [
    {
      "filename": "input.txt",
      "mimeType": "text/plain",
      "contentBase64": "..."
    }
  ]
}
```

Dashboard and Conversation continuation composers expose an external-action mode
selector. `Approval` keeps state-changing actions paused at the operator decision and
commit boundary. `Automode` prepends an explicit automode directive to the submitted
task so the existing agent policy may commit only when required inputs, a ready generated
executor, confirmation handling, and proof are sufficient. A durable first-class
`externalActionMode` request field is still a follow-up contract cleanup.
After an operator approves an approval-mode proposal, the backend automatically attempts
the safe non-mutating follow-up chain: browser preparation/proof capture and generated
commit-executor attach/build. The final external commit still requires the explicit
Run Workspace commit control.

Run lifecycle:

```http
GET  /api/runs
GET  /api/runs/:id
POST /api/runs/:id/cancel
POST /api/runs/:id/restart
POST /api/runs/:id/resume
GET  /api/runs/:id/events
GET  /api/runs/:id/artifacts/:artifactId
DELETE /api/runs/:id/artifacts/:artifactId
```

Conversation threads:

```http
GET  /api/conversation-threads
GET  /api/conversation-threads/:id
POST /api/conversation-threads/:threadId/runs
```

Tools:

```http
GET  /api/tools
GET  /api/tools/health
POST /api/tools/create-package
GET  /api/tool-creations
GET  /api/tools/:name/source-bundle
POST /api/tools/source-bundles
POST /api/tools/:name/run
PATCH /api/tools/:name/status
GET  /api/tool-package-runners
GET  /api/tool-settings
PUT  /api/tool-settings
DELETE /api/tool-settings/:toolName/:key
POST /api/tool-settings/validate
```

The Tools page shows registry metadata, schemas, runtime settings, package runners,
service lifecycle state, usage counters, manual run output, downloadable artifact-shaped
payloads, structured missing-runtime diagnostics, and an Enable/Disable control. If a
manual run fails before package execution because required configuration or secret
handles are absent, the result panel lists the exact keys/handles and links to Settings.
The detail header and Runtime readiness panel also show the same state proactively from
the `/api/tools` catalog, before a manual run is attempted.
The same readiness state is used by the run runtime when it builds the agent-visible
tool catalog, so a misconfigured `available` tool is visible to operators but not offered
as a callable schema to agents.
Run traces use the same diagnostic payload for agent tool calls, so the inspector can
show what blocked the call without parsing free-form process errors. For generated
HTTP/API tools, the inspector surfaces the selected operation, requested/resolved target,
redacted request URL, HTTP status, and timeout/fetch diagnostics from the tool result
payload. This lets operators distinguish "wrong version/target", "missing secret",
"provider timeout", and "API returned an unexpected document" without reading package
source. Non-2xx API responses also expose the normalized provider error summary/category,
while the full JSON output keeps the generated operation input contract for agent retry
planning.
Agent-facing tool messages use the same data: failed generated API calls are labeled as
repairable when they include `http_provider_error`, and the next model turn receives the
provider summary, category, hints, and input contract instead of only a raw failure blob.
For candidate review, a normal run can explicitly pin a generated version with text such
as `tool.name@0.1.20`; that version is attached as a run-scoped candidate without
activating it globally. When the run completes, Run Workspace shows a candidate review
panel with the tested version, replaced version, trace link context, and operator actions
to activate or reject the candidate. Activation remains manual, but the successful
run-scoped candidate run is accepted as verification evidence for that exact version.
The Tools Candidate Review queue uses the same lifecycle evidence: it separates
manual-run, ready-to-activate, activated, rejected, failed, and superseded versions and
links each entry back to origin traces, evidence runs/traces, and decision traces when
those records exist.
It also has the first Tool Creation panel. The
operator describes the desired capability; the backend can run implementation discovery,
then `ToolBuilderAgent` records a strategy decision such as custom TypeScript shell,
HTTP/API shell, npm-package adapter, compatibility template, or imported source bundle.
The runtime then writes a source-bundle package, runs package QA, records durable
creation history, registers the manifest, reloads the registry, and leaves the new tool
disabled until the operator manually tests and enables it. The creation panel accepts
package-local npm dependency ranges; those dependencies belong to the tool package, not
Agentic's root app. Discovery can be disabled or pointed at the npm registry; when npm
discovery is used, the creation history shows selected package evidence plus package
metadata/README inspection evidence when the registry exposes it. npm package discovery
can also record an adapter contract inferred from README usage: default callable, named
export, or namespace member. The creation history shows the adapter summary, and the
generated package uses that contract during `/health` and `/run`. When README usage shows
a simple object argument, the adapter summary includes object fields such as
`object(foo, sort)`, and the generated tool schema validates and forwards that object
directly. The creation panel also
accepts JSON behavior QA examples. Those examples are saved into the strategy record and
executed against the built package before registration, so a package that compiles but
does not satisfy the expected behavior remains `qa_failed`. When
`TOOL_BUILDER_AUTHORING=llm` or request body `authoringMode: "llm"` is used, the builder
can ask the XL-tier model for a complete source-bundle snapshot; guardrails reject unsafe
paths, raw secrets, and imports from Agentic app internals before package QA. If
authoring fails, the creation record shows fallback notes and the scaffold writer still
goes through QA. Tool names should be semantic capability names rather than provenance
labels; generated/imported/external source is shown through creation/manifest metadata.
Creation history records link to the creation run when `runId` is present, so operators
can inspect the builder process in the Run Workspace timeline/graph. The common Runs
list and Dashboard recent-runs list mark tool creation/edit lifecycle runs with a tool
badge and show lifecycle steps instead of ordinary tool-call counts. Disabled tools are
still visible and manually runnable for diagnosis,
but they are not offered to `BaseAgent`.

Tool services and channels:

```http
GET   /api/tool-services
POST  /api/tool-services/:name/start
POST  /api/tool-services/:name/stop
POST  /api/tool-services/:name/restart
POST  /api/tool-services/:name/heartbeat
PATCH /api/tool-services/:name/restart-policy
GET   /api/tool-services/logs
GET   /api/tool-services/logs/events
GET   /api/tool-service-events
POST  /api/tool-service-events
POST  /api/tool-service-events/:eventId/allow-identity
POST  /api/tool-services/:name/inbound
GET   /api/tool-services/:name/outbox
POST  /api/tool-services/:name/outbox/:eventId/ack
```

Secrets and settings:

```http
GET    /api/secret-handles
POST   /api/secret-handles
POST   /api/secret-handles/status
GET    /api/secret-handles/:handle
DELETE /api/secret-handles/:handle
GET    /api/model-providers
POST   /api/model-providers
GET    /api/models/catalog
```

Ledgers and memory:

```http
GET   /api/work-ledger
POST  /api/work-ledger
POST  /api/work-ledger/claim
PATCH /api/work-ledger/:id
POST  /api/work-ledger/:id/evidence
POST  /api/work-ledger/:id/artifacts
GET   /api/evidence-ledger
POST  /api/evidence-ledger
GET   /api/run-retrospectives
POST  /api/run-retrospectives
PATCH /api/run-retrospectives/:id
GET   /api/memories
POST  /api/memories/reembed
POST  /api/memories/evaluate-retrieval
```

## Removed Legacy Endpoints

These endpoints are intentionally removed in the rebuild baseline and should return
`404`:

- `/api/tool-build-runs`
- `/api/tool-build-requests`
- `/api/tool-investigations`
- `/api/tool-rework-waits`
- `/api/tool-migrations`

New tool creation and editing flows are planned in
[../roadmap.md](../roadmap.md), Phases 4 and 5. Do not restore these routes just to make
old UI/tests pass.

## Current Manual Smoke

After a build, verify:

1. Open the console.
2. Check Dashboard loads and `/api/health` reports `ok`.
3. Submit `Ответь одним коротким словом: ok`.
4. Open the run workspace and confirm:
   - status becomes `completed`;
   - final answer is present;
   - trace contains start/completed events;
   - audit log records created/started/completed.
5. Open Tools and confirm registered tools render.
6. Create a small `demo.echo` source-bundle tool from the Tools creation panel or
   `/api/tools/create-package`.
7. Confirm the Tools sidebar shows a registered creation history record with QA evidence
   and an "Open creation run" link.
8. Export the created tool through `/api/tools/:name/source-bundle`, then import the same
   bundle through `/api/tools/source-bundles` in a clean package workspace.
9. Run the created tool from the Tools manual-run panel and confirm the output matches
   the input.
10. Enable the created tool, confirm its status changes, then disable it again if it was
   only a smoke artifact.
11. Confirm removed legacy endpoints return `404`.

## UI Design Rules

- Keep the first screen as the actual workspace, not a landing page.
- Do not expose controls for backend flows that are not active.
- Prefer dense operational UI over marketing-style cards.
- Keep run status, trace, audit, artifacts, and tool state easy to cross-check.
- When a persistence feature is involved, the UI should have a way to inspect the stored
  record or link to the relevant page.

## Roadmap Hooks

Upcoming UI work follows [../roadmap.md](../roadmap.md):

- Phase 1: remove dead legacy UI/API docs and tests.
- Phase 2: improve BaseAgent trace and failure explanations.
- Phase 3: improve Tools manual-run and registry detail.
- Phase 4: expand Tool Creation V1 beyond deterministic package strategies. Current
  working strategies include echo, HTTP/JSON, npm adapter, and browser screenshot
  artifact packages; next work is richer agent-authored/API-doc-driven packages.
- Phase 5: add versioned tool editing and active-version switching. First slice is now
  available in Tools as "Request tool edit"; it creates a new QA'd inactive disabled
  candidate with a linked run trace while the previous active version stays active. The
  Versions panel can also run a pinned generated version without activating it, and shows
  active versus candidate review details before promotion: package ref, status,
  capabilities, health, run counts, QA summary, QA checks, pinned manual-run evidence,
  run-scoped candidate evidence, and the activation action. The server rejects
  activation/mark-available for inactive generated versions until that exact version has
  a successful pinned manual run or completed run-scoped candidate run.
- Phase 6: show child-agent invocation graph. First runtime slice is active for missing
  capabilities and generated-tool rework: an agent can request Tool Creation V1 or Tool
  Editing V1, and the linked lifecycle run is shown in the common Runs/Trace surfaces
  with the tool badge.
- Phase 7: connect ledger/evidence/retrospective actions to the new runtime.
