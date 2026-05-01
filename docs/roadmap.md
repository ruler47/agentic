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

Workers now request their own review immediately after finishing, so reviews can run while
other workers are still active. The coordinator waits for reviewed worker results before
calling the synthesizer. A failed review triggers one bounded revision pass before
synthesis.

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
SearXNG.

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
- `file.read`
- `file.write`
- `browser.screenshot`
- `db.query`

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

- Add a tool registry persistence table.
- Add `tool.missing-capability` trace events.
- Add a Tool Builder agent contract.
- Add a Tool QA agent contract.
- Add a Tool Registrar service with version conflict checks.
- Implement `browser.screenshot` as the first self-service tool target.
- Prove the full loop with a test task that requires a missing screenshot capability.

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
- UI trace tier badges.

Remaining:

- Retry within the same tier when a model fails or produces review-rejected output.
- Reviewer-generated failure reasons attached to model attempts.
- Fallback to the next model in the same tier.
- Escalation to the next tier after same-tier candidates fail.
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
- Collapsible trace cards with stable incremental rendering.
- Status, actor, activity, duration, and parent-child metadata.

Remaining:

- Timeline mode by wall-clock time.
- Filters and run comparison.
- Rich artifact and memory-hit panels.

## Phase 7: Durable Artifacts

Use MinIO/S3 for generated artifacts:

- screenshots;
- source files;
- datasets;
- reports;
- exported documents.

Artifacts should be linked from trace cards and final answers.
