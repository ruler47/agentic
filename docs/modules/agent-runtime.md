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
- Synthesize the final answer.
- Store reusable skill memory.
- Emit typed events for external observers.

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
- Add retry and revision loops when reviewer verdict is `needs_revision`.

## Tests

- `tests/universalAgent.test.ts`
