# P0 Ledger Recovery And Reuse

## BA View

### Problem

The Work/Evidence Ledger records useful facts, artifacts, rejected attempts, and tool
outputs, but the agent still treats too much of it as passive audit. Follow-up questions
and retries should use existing work before reacquiring data.

### Desired Behavior

The agent should use Ledger state as operational memory:

- follow-up questions reuse prior source evidence and artifacts;
- repeated deterministic work can reuse passed evidence when safe;
- failed/rejected evidence becomes machine-readable retry guidance;
- external action preparation avoids repeating rejected provider URLs;
- operators can inspect why the agent reused, refreshed, or rejected prior work.

### User Stories

- As a user, after a BTC run I can ask "какой источник ты использовал?" and the system
  answers from prior evidence.
- As a user, if a screenshot was rejected because of a blocker, the next attempt does not
  repeat the same blocked URL.
- As an operator, I can open Ledger and see the exact work item and evidence record used
  by the follow-up.

### Non-Goals

- Do not reuse stale/current data when the user asks for fresh information.
- Do not reuse failed or weak evidence as truth.
- Do not make browser form state globally reusable.

## Architect / Tech Lead View

### Proposed Solution

Create a runtime evidence resolver that sits between task framing and tool execution.

Core responsibilities:

- Build a compact `PriorWorkContext` from run/thread scoped Ledger records.
- Score evidence by freshness, quality status, source URL, artifact type, and task fit.
- Expose clear decisions: `reuse`, `refresh`, `retry_excluding`, `ignore`.
- Feed accepted prior evidence into thread-context and current run prompts.
- Feed rejected evidence into retry policy for browser/search/external-action flows.

Recommended contracts:

- `EvidenceReuseDecision`
  - `decision`
  - `reason`
  - `workItemId`
  - `evidenceIds`
  - `artifactIds`
  - `sourceUrls`
  - `limitations`
  - `retryExclusions`
- `PriorWorkContext`
  - current thread facts
  - recent artifacts
  - successful source evidence
  - failed/rejected evidence
  - external-action blockers

Use cases:

- Follow-up answer path: answer from thread + Ledger before new tool calls.
- Current task: bypass reuse and record explicit `work-ledger-reuse-skipped`.
- External action retry: exclude rejected customer-action URLs and prefer discovered
  valid candidates.
- Artifact reuse: show prior artifact metadata to the agent before reacquiring.

### Likely Files

- `src/work-ledger/*`
- `src/agents/baseAgentToolLedger.ts`
- `src/agents/baseAgentThreadContext.ts`
- `src/conversations/threadResolution.ts`
- `src/agents/taskFrame.ts`
- `src/server/modules/runs/runs.service.ts`
- `web-react/src/routes/Ledger.tsx`
- tests for BaseAgent, thread context, Ledger API, external action retry

## QA View

### Acceptance Criteria

- Follow-up run can answer from prior evidence with zero new search/browser calls when
  prior evidence satisfies the question.
- Fresh/current run explicitly bypasses reuse and records why.
- Weak/failed evidence is not reused as truth.
- Rejected browser URLs are available as retry exclusions.
- Ledger UI shows reuse/retry decisions.
- Trace Lab shows reuse or skip events.
- Durable Postgres smoke confirms records survive restart.

### Automated Tests

- Prior evidence reused for a source-summary follow-up.
- Prior evidence ignored when task asks for fresh/current data.
- Failed evidence with QA `failed` is not reused.
- External-action retry excludes a rejected URL.
- Artifact metadata appears in continuation context.

### Manual Verification

1. Run a current web fact task with proof.
2. Ask a follow-up in the same conversation: "какой источник был?"
3. Confirm no new web search if prior evidence is enough.
4. Force a rejected screenshot/action URL in a fixture.
5. Retry and confirm the same rejected URL is excluded.
6. Restart backend with Postgres and confirm Ledger state still appears.

## PM / Feature Owner View

### Delivery Plan

1. Inventory existing Ledger records and quality fields.
2. Define `EvidenceReuseDecision` and `PriorWorkContext`.
3. Add resolver unit tests before wiring into BaseAgent.
4. Wire resolver into follow-up/thread-context path.
5. Wire retry exclusions into browser/external-action source selection.
6. Add Trace Lab event payloads.
7. Update Ledger UI for reuse/retry decisions.
8. Run durable smoke.
9. Update docs and close this task.

### Done When

- Follow-up recovery uses prior work by default when safe.
- Operators can inspect the reuse decision.
- Repeated work is reduced without introducing stale-current-data bugs.
