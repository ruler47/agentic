# Agent Runtime Module

## Purpose

The agent runtime owns task execution. It can be reused without the web UI.

Main file:

- `src/agents/universalAgent.ts`

## Responsibilities

- Search shared skill memory.
- Classify a task as direct or delegated.
- Plan focused subtasks.
- Run worker agents.
- Run reviewer agents.
- Ask workers to revise once when a reviewer returns `needs_revision`.
- Synthesize the final answer.
- Store reusable skill memory.
- Emit typed events for external observers.
- Run registered tools, such as `web.search`, and inject tool evidence into worker prompts.

## Public Contract

```ts
const result = await agent.run(task, {
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
- Add deeper retry policy and budget controls for repeated `needs_revision` verdicts.
- Allow recursive child-agent creation instead of coordinator-owned orchestration.

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
