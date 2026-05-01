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
       -> worker
            -> reviewer
  -> synthesizer
  -> memory learning
```

Workers now request their own review immediately after finishing, so reviews can run while
other workers are still active. The coordinator waits for reviewed worker results before
calling the synthesizer.

This is not yet a fully autonomous recursive agent society. It is still centrally
orchestrated, but the trace contract is ready for nested agent calls.

## Phase 1: Reliable Memory

Replace file-backed lexical memory with persistent database-backed memory.

Tasks:

- Store skill memories in Postgres.
- Add embeddings with `pgvector`.
- Store source run IDs and evidence.
- Search by semantic similarity plus tags.
- Show memory hits in UI with confidence and why they matched.
- Add tests proving repeated similar tasks retrieve prior memories.

Why current memory misses:

- It uses `memory/skills.json`, not Postgres.
- In Docker it is not mounted as durable project state.
- Search is token-based, not semantic.
- The agent only stores a memory when the LLM returns `shouldStore: true`.
- Stored lessons are generic, so specific repeated requests may not match well.

## Phase 2: Tool Registry

Add a first-class tool registry.

Tool contract:

- name;
- version;
- input schema;
- output schema;
- capabilities;
- startup mode;
- healthcheck;
- trace event mapping.

Initial tools:

- `web.search`
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
  -> otherwise proposes new tool module
  -> scaffold tool
  -> test tool
  -> register tool
  -> use tool
  -> shut down if ephemeral
```

Guardrails:

- Generated tools must be sandboxed.
- Generated tools must include tests.
- Tool activation must have resource limits.
- Tools must be reviewed before becoming reusable.

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

Agents choose model tier by risk and complexity.

Example tiers:

- `Tier S`: cheap/fast check, formatting, simple extraction.
- `Tier M`: normal reasoning and synthesis.
- `Tier L`: complex review, high-risk reasoning, architecture decisions.
- `Tier XL`: adversarial review or high-stakes synthesis.

Reviewers should be able to select a stronger model than the worker when the content is
complex or risky.

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

## Phase 7: Durable Artifacts

Use MinIO/S3 for generated artifacts:

- screenshots;
- source files;
- datasets;
- reports;
- exported documents.

Artifacts should be linked from trace cards and final answers.
