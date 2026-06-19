# Current Architecture

Status date: 2026-06-19.

This document describes the active code path in `main`. Historical recursive/council
runtime files and legacy tool-build queues are not active.

## Product Shape

Agentic currently has four runtime layers:

- **API/UI layer**: Nest controllers plus the React console.
- **Run orchestration layer**: `RunsService`, context resolution, run persistence, trace
  events, artifacts, approvals, channel outbound delivery, and recovery.
- **Agent layer**: `BaseAgent`, a bounded ReAct-style loop around one task.
- **Tool layer**: `ToolRegistry`, preinstalled core tools, generated/source-bundle tools,
  OCI/source-bundle runners, service supervisor, metadata, settings, and secrets.

```mermaid
flowchart TD
  U["User / Telegram / API client"] --> UI["React Console or channel adapter"]
  UI --> RC["RunsController"]
  RC --> RS["RunsService"]
  RS --> CR["RunContextResolver\nuser, channel, thread, attachments"]
  CR --> Stores["Run / Thread / User / Group stores"]
  RS --> BA["BaseAgent"]
  BA --> TF["TaskFrame\nmode, budgets, proof, external-action policy"]
  BA --> LLM["LlmClient\nmodel tier policy"]
  LLM --> BA
  BA --> TR["ToolRegistry"]
  BA --> WL["Work/Evidence Ledger\nrun-local execution + reusable-index"]
  TR --> CT["Core toolbelt\nweb, browser, http, file, document, data, external.action, telegram"]
  TR --> GT["Generated/imported tools\nsource-bundle / HTTP process / OCI"]
  CT --> AR["ArtifactStore"]
  GT --> AR
  WL --> Stores
  BA --> FG["Finalization gates\nproof, source grounding, raw tool syntax, truncation"]
  FG --> RS
  RS --> API["Run result, trace events, artifacts, proposals"]
  API --> UI
```

## Main Code Map

### Agent Runtime

- `src/agents/baseAgent.ts`: runtime facade and ReAct loop.
- `src/agents/baseAgentLocalUtility.ts`: deterministic fast path for obvious local
  data/file/document chains that can be satisfied by `file.read`, `document.extract`,
  `data.transform`, and `file.write` without entering the LLM ReAct loop.
- `src/agents/taskFrame.ts`: task classification, research/proof contract, default step
  budgets, and external-action policy.
- `src/agents/baseAgentPrompt.ts`: system prompt and tool schemas passed to the model.
- `src/agents/baseAgentToolExecution.ts`: registered tool execution, tool-call cache,
  evidence capture, artifact save hooks.
- `src/agents/baseAgentToolLedger.ts`: Work/Evidence Ledger classification,
  run-local claim/evidence writes, and safe reusable-index publication/lookup for
  deterministic `http.request` calls.
- `src/agents/baseAgentFinalization.ts`: final-answer gates, action proposal creation,
  result assembly.
- `src/agents/baseAgentEvidence.ts` and `src/agents/baseAgentProof.ts`: source/proof
  extraction, proof repair, screenshot/source checks.
- `src/agents/baseAgentThreadContext.ts`: follow-up rewriting so prior-thread questions
  can answer from conversation context instead of repeating work.
- `src/agents/baseAgentTruncation.ts`: rolling context compaction and truncated-answer
  repair.

### Run Orchestration

- `src/server/modules/runs/runs.service.ts`: run creation, execution, cancellation,
  recovery, artifacts, finalization, outbound delivery.
- `src/server/modules/runs/run-context-resolver.ts`: user/channel/thread resolution,
  thread context rebuild, attachment parsing.
- `src/server/modules/runs/run-agent-runtime-helpers.ts`: bridges runs to BaseAgent,
  tool creation/edit callbacks, secrets/configuration, channel outbound events.
- `src/server/modules/runs/run-ledger-runtime.ts`: durable run event sink plus
  Work/Evidence Ledger coordinator wiring for each run.
- `src/server/modules/runs/action-proposals.service.ts` plus
  `action-proposal-*.ts`: external-action proposal, approval, prepare, profile
  hydration, commit readiness, fixture/commit support.
- `src/runs/postgresRunStore.ts`: durable run/event storage with `getMeta()` for light
  SSE polling.

### Tool System

- `src/tools/coreToolbelt.ts`: registers preinstalled first-party tools by default.
- `src/tools/registry.ts`: in-process registry and execution boundary.
- Core tools:
  - `web.search`, `web.read`
  - `browser.operate`, `browser.screenshot`
  - `http.request`
  - `file.read`, `file.write`
  - `document.extract`
  - `data.transform`
  - `external.action.prepare`, `external.action.commit`
  - `channel.telegram`
- Generated/imported tool infrastructure:
  - `src/tools/toolCreationV1*.ts`
  - `src/tools/toolPackageRunner*.ts`
  - `src/tools/toolPackageWorkspaceQa.ts`
  - `src/tools/toolServiceSupervisor.ts`
  - `src/tools/toolMetadataStore.ts` and Postgres adapters.

### Persistence And Settings

- `src/server/persistence/persistence.module.ts`: wires stores, LLM client, core toolbelt,
  registry, secrets, runtime settings, artifacts, work/evidence ledger.
- `src/server/config/env.ts`: local environment. Core tools are enabled by default;
  `BUILTIN_TOOLS=disabled` is an opt-out test/experiment mode.
- `src/settings/modelProviderStore.ts` and `src/settings/modelTierSettings.ts`: model
  provider/tier settings.
- `src/server/common/guards/api-token.guard.ts`: opt-in shared API token guard through
  `AGENTIC_API_TOKEN`.

## Request Lifecycle: Current Bitcoin Price

Example user task: "Какая сейчас цена биткоина? Дай краткий ответ и proof."

```mermaid
sequenceDiagram
  participant User
  participant API as RunsController
  participant Runs as RunsService
  participant Ctx as RunContextResolver
  participant Agent as BaseAgent
  participant LLM as LlmClient
  participant Tools as ToolRegistry
  participant Search as web.search
  participant Shot as browser.screenshot
  participant Ledger as Work/Evidence Ledger
  participant Store as Run/Artifact stores

  User->>API: POST /api/runs { task }
  API->>Runs: createAndStart()
  Runs->>Ctx: resolve user/channel/thread/context
  Ctx-->>Runs: RunCreateContext + threadContext
  Runs->>Store: create run + started event
  Runs->>Agent: run(task, runtime context, tool catalog)
  Agent->>Agent: frameTask() => current_lookup
  Agent->>LLM: system prompt + context + tool schemas
  LLM-->>Agent: call web.search
  Agent->>Ledger: claim search work item
  Agent->>Tools: run web.search
  Tools->>Search: query current BTC price
  Search-->>Tools: source URLs/snippets/data
  Tools-->>Agent: tool result + evidence
  Agent->>Ledger: complete work + record search evidence
  Agent->>LLM: summarized evidence
  LLM-->>Agent: call browser.screenshot for proof URL
  Agent->>Ledger: claim screenshot work item
  Agent->>Tools: run browser.screenshot
  Tools->>Shot: viewport screenshot
  Shot-->>Tools: PNG artifact candidate
  Tools-->>Agent: screenshot result
  Agent->>Store: save artifact + trace event
  Agent->>Ledger: link screenshot evidence + artifact id
  Agent->>LLM: proof evidence
  LLM-->>Agent: finish(final answer)
  Agent->>Agent: finalization gates\nsource grounding, proof, no raw tool syntax
  Agent-->>Runs: AgentRunResult
  Runs->>Store: complete run, events, artifacts
  Runs-->>API: run record
  API-->>User: answer + artifacts + trace
```

## Request Lifecycle: Local Data/File Task

Example user task: "Отсортируй JSON по age desc, сохрани CSV в smoke-people.csv."

```mermaid
sequenceDiagram
  participant User
  participant API as RunsController
  participant Agent as BaseAgent
  participant LLM as LlmClient
  participant Tools as ToolRegistry
  participant Data as data.transform
  participant File as file.write
  participant Ledger as Work/Evidence Ledger
  participant Artifacts as ArtifactStore
  participant UI as React Run Workspace

  User->>API: POST /api/runs { task }
  API->>Agent: run(task, core tool catalog)
  Agent->>Agent: frameTask() => local utility / file artifact
  alt explicit local fast path
    Agent->>Agent: infer local tool chain deterministically
    opt source file/document named
      Agent->>Tools: run file.read or document.extract
      Tools-->>Agent: source content
    end
    Agent->>Tools: run data.transform
    Tools->>Data: parse JSON/CSV/text, sort/filter/template, serialize
    Data-->>Tools: transformed content
  else ambiguous local utility request
    Agent->>LLM: bounded prompt + data/file tool schemas
    LLM-->>Agent: call data.transform
    Agent->>Tools: run data.transform
    Tools-->>Agent: transformed content
  end
  Agent->>Ledger: claim analysis work item
  Agent->>Ledger: complete analysis + record evidence
  opt output file requested
    Agent->>Ledger: claim artifact-generation work item
    Agent->>Tools: run file.write
    Tools->>File: write path + content
    File-->>Tools: ok result
    Agent->>Artifacts: save file.write content as smoke-people.csv
    Artifacts-->>Agent: artifact id + download URL
    Agent->>Ledger: complete work + record file evidence + artifact link
  end
  Agent-->>API: completed answer + artifact metadata
  UI-->>User: Final answer, timeline, preview, download
```

`file.write` artifacts are created from the content passed into the tool call. This avoids
depending on a shared filesystem path and keeps the behavior compatible with future
containerized tool execution.

## External Action Lifecycle

External actions are state-changing tasks such as bookings, form submits, purchases, API
writes, or outbound messages. The active safety model is prepare -> approve -> commit.

```mermaid
flowchart TD
  T["User task\nfind and prepare booking"] --> R["Run + BaseAgent research"]
  R --> P["ExternalActionProposal\nconcrete target/action/data"]
  P --> Pause["Run pauses / waiting approval"]
  Pause --> Approve["Operator approve"]
  Approve --> Prepare["external.action.prepare or browser.operate\nfill safe fields, capture proof, stop before submit"]
  Prepare --> Ready{"Ready to commit?"}
  Ready -- "missing data/profile approval/proof" --> Pause
  Ready -- "ready" --> Commit["external.action.commit\nfinal provider submit or fixture commit"]
  Commit --> Report["Final report\nsubmitted data summary, confirmation/status, proof, cancellation/location notes"]
```

## Memory Model In Code

Current memory is split but not finished:

- **Run memory**: run events, tool results, artifacts, and trace spans in the run store.
- **Thread memory**: `ConversationThreadStore` summary, accepted facts, rejected attempts,
  open questions, artifact ids. Restart/resume paths rebuild this context by thread id.
- **User/channel memory**: `UserStore` maps local users and channel identities.
- **Group memory**: `GroupProfileStore` is wired into runtime context.
- **Longer-term skill memory**: `SkillMemory` / `PostgresSkillMemory` exists, but accepted
  retrospective-to-memory flow still needs product-level review.
- **Work/Evidence Ledger**: BaseAgent tool calls claim a run-local execution work item
  before execution, store the canonical reusable work key in metadata, complete or fail
  the item after execution, record evidence with source/tool/artifact metadata, and link
  artifact ids when a tool produces files or screenshots.
  Stable `http.request` GET/HEAD calls also publish a thread/instance-scoped
  reusable-index item without `runId`; later identical stable calls can reuse fresh
  passed evidence for up to 10 minutes while still creating run-local work/evidence.
  Deterministic `data.transform` and inline-content `document.extract` calls use the
  same reusable-index path without a freshness TTL. Current/live HTTP tasks bypass reuse
  and emit `work-ledger-reuse-skipped` so operators can see that the repeated tool call
  was intentional.

## Verified State

- `npm run verify` passed on 2026-06-19: lint, typecheck, test typecheck, 518 tests, build.
- Targeted suites passed:
  - BaseAgent runtime and local utility coverage.
  - External action preparation/approval: 29 tests.
  - Focused env/core-toolbelt/auth regression: 12 tests.
- Live API smoke passed after enabling core toolbelt by default:
  - `/api/health` responds.
  - React dev shell responds on port 3001.
  - `/api/tools` exposes all 12 preinstalled core tools.
  - Manual `http.request` call to JSONPlaceholder succeeds.
  - Manual `data.transform` JSON->CSV sort succeeds.
- Durable agent-level smoke passed after that:
  - Direct no-tool run: `run_1781798532541_ru78eo3j`.
  - HTTP JSON fast path with structured proof and no screenshot:
    `run_1781798586255_qgomrub6`.
  - Current web fact with QA-passed screenshot proof: `run_1781798630478_7gakwrcv`.
  - Data/file artifact path with preview/download in React:
    `run_1781799687705_rtayd8nl`.
- Automated BaseAgent P0 coverage confirms `http.request` writes an `api_call` work
  item plus `api_response` evidence, and `file.write` links the saved artifact id to
  both Work Ledger and Evidence Ledger records. It also confirms explicit local utility
  tasks frame as `local_utility`, obvious JSON/CSV/file transform chains complete
  through the deterministic local utility fast path without an LLM call, `file.write`
  fast-path outputs become downloadable artifacts, a second identical stable
  `http.request` GET in the same thread/instance uses Ledger evidence instead of
  executing another HTTP call, deterministic `data.transform` calls reuse passed
  evidence, and current/fresh HTTP tasks bypass that reuse and trace the reason.
- API-only HTTP/JSON endpoint tasks use structured/source proof by default. They avoid
  browser/screenshot proof unless the user explicitly asks for visual proof of a web
  page.
- Durable Ledger product smoke passed on Postgres/S3 and survived server restart:
  `run_1781818681262_rpvsg59u` completed an `http.request` JSON task, `/api/work-ledger`
  shows one completed `api_call`, `/api/evidence-ledger` shows one `api_response`, both
  records link `artifact_1781818687616_9q389ujl`, and the React Ledger page shows
  `Backend ready · postgres` with the same work/evidence/artifact records.

## Current Gaps

- `npm run web` without `DATABASE_URL` starts in-memory stores. That is acceptable for
  smoke tests, but real persistence testing must set Postgres env.
- Work/Evidence Ledger writes and safe `http.request` reuse are covered in BaseAgent unit
  tests and durable live smoke. The next product step is expanding this to
  operator-visible recovery, follow-up reuse, external-action recovery, and more
  deterministic tool families.
- External-action UI is safer than before but still complex. The next UX target is one
  understandable proposal/proof/approval/commit path.
- Tool Builder V1 still exists and works for source-bundle candidates, but strategic
  builder work should wait until the core tool contract is live-tested.
- The remaining over-800-line files should be split when touched.
