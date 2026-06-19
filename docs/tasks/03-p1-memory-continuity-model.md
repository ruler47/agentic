# P1 Memory Continuity Model

## BA View

### Problem

The product needs several kinds of memory, but they are not yet clearly separated in
behavior or UI. The assistant must remember what happened in a run, what happened in a
conversation, what the user/group prefers, and what reusable lessons were accepted from
past runs.

### Desired Behavior

Memory must be scoped and explainable:

- Run memory: what this run has already done.
- Thread memory: what this conversation already established.
- User memory: preferences, identity, channels, safe personal facts.
- Group memory: household/team defaults, location, policies, shared preferences.
- Accepted retrospective memory: reusable lessons approved after runs.

The agent should receive compact, relevant memory only. It should not dump every prior
event into prompts.

### User Stories

- As a user, I can ask a follow-up and the assistant remembers prior answer/artifacts.
- As a user, the assistant remembers my location or preference when that matters.
- As an operator, I can see which memory scope influenced a run.
- As an operator, I can reject or edit proposed long-term memories.

### Non-Goals

- Do not auto-store every model statement as memory.
- Do not leak another user/channel's private memory into a request.
- Do not use memory as a substitute for current-data proof.

## Architect / Tech Lead View

### Proposed Solution

Define a first-class runtime memory context assembled before each run.

Recommended contracts:

- `RunMemoryView`
  - completed steps
  - tool calls
  - artifacts
  - blockers
  - current action proposal state
- `ThreadMemoryView`
  - summary
  - accepted facts
  - rejected attempts
  - open questions
  - artifact references
- `UserMemoryView`
  - identity
  - channel aliases
  - approved preferences
  - approved profile fields
- `GroupMemoryView`
  - location
  - shared preferences
  - policies
  - default tools/models
- `AcceptedLearningView`
  - accepted retrospectives
  - reusable procedures
  - known weak tools or patterns

Runtime flow:

1. Resolve requester/channel identity.
2. Resolve thread or new-task decision.
3. Build scoped memory views.
4. Compact and rank memory by task relevance.
5. Emit `memory-context-prepared` trace event.
6. Pass memory sections to fast paths and ReAct prompts.
7. After run, create retrospective proposal, not automatic memory.

Privacy:

- Every memory item has scope, provenance, accepted/rejected status, and last-used time.
- Personal memory requires matching requester or explicit group visibility.
- Secrets never become memory.

### Likely Files

- `src/conversations/*`
- `src/instance/*`
- `src/memory/*`
- `src/agents/baseAgentPrompt.ts`
- `src/agents/baseAgentThreadContext.ts`
- `src/agents/taskFrame.ts`
- `web-react/src/routes/Memory.tsx`
- `web-react/src/routes/Conversations.tsx`
- tests for thread resolution, memory context, and prompt construction

## QA View

### Acceptance Criteria

- Follow-up run receives relevant thread summary and artifact metadata.
- A new unrelated task does not inherit irrelevant thread facts.
- User-scoped memory is not visible to another user.
- Group memory is visible when policy allows.
- Accepted retrospective memory is visible only after review/accept.
- Trace Lab shows compact memory sections used by the run.
- Memory UI can show provenance and scope.

### Automated Tests

- Thread follow-up context is included.
- New task gets no stale thread context.
- User memory is scoped by user id/channel identity.
- Group memory is included for the instance.
- Rejected retrospective is not used.

### Manual Verification

1. Run a task that produces an artifact.
2. Ask a follow-up in the same thread about that artifact.
3. Start a new task and confirm it does not inherit the artifact unless relevant.
4. Add/edit a group preference and confirm it appears in a relevant run.
5. Review Memory page and Trace Lab.

## PM / Feature Owner View

### Delivery Plan

1. Document memory scopes and data ownership.
2. Add typed memory view contracts.
3. Build a memory context assembler.
4. Wire into BaseAgent prompt/context.
5. Add trace event and UI inspection.
6. Add review flow for retrospective-to-memory.
7. Add tests for scope isolation.
8. Run manual conversation and group-profile smokes.
9. Update docs and close this task.

### Done When

- The agent can explain which memory it used.
- Follow-ups improve without creating hidden stale-context behavior.
- Memory is scoped by run/thread/user/group/accepted-learning boundaries.
