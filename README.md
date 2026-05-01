# Agentic Universal Agent

TypeScript prototype of a coordinator agent that accepts one concrete user task, decomposes it, delegates focused subtasks to worker agents, reviews their outputs, and stores reusable lessons in shared long-term skill memory.

Project instructions and long-term collaboration notes for AI agents live in [AGENTS.md](AGENTS.md).

Default local model endpoint:

- Base URL: `http://127.0.0.1:1234/v1`
- Model: `google/gemma-4-26b-a4b`

## Run

```bash
npm install
npm run dev -- "top 5 cities in Spain by population, sorted by distance to the sea"
```

Run the browser console in Docker:

```bash
docker compose up --build
```

Then open `http://127.0.0.1:3000`.

The compose stack includes the app, Postgres, Redis, MinIO, and SearXNG-powered web search.

Run the browser console directly on the host:

```bash
npm run build
npm run web
```

Override model settings:

```bash
LLM_BASE_URL=http://127.0.0.1:1234/v1 LLM_MODEL=google/gemma-4-26b-a4b npm run dev -- "your task"
```

Optional tier-specific model overrides:

```bash
LLM_MODEL_TIER_S=cheap-model \
LLM_MODEL_TIER_M=balanced-model \
LLM_MODEL_TIER_L=strong-review-model \
LLM_MODEL_TIER_XL=deep-review-model \
docker compose up --build
```

If a tier override is not set, the app falls back to `LLM_MODEL`.

## Verify

```bash
npm run verify
```

For manual smoke testing after a build:

```bash
node dist/cli.js "Скажи одним предложением, что такое универсальный агент"
```

## Request Execution Structure

1. **Coordinator receives exactly one concrete user task.**
2. **Task classifier estimates complexity.**
   - Simple tasks can be answered directly.
   - Multi-domain or uncertain tasks are decomposed.
3. **Planner creates focused subtasks.**
   - Each subtask has a role, expected output, tools, and review criteria.
4. **Worker agents execute subtasks independently.**
   - Workers receive only relevant context and selected skill-memory entries.
5. **Reviewer agents check each worker result.**
   - Reviewers look for missing evidence, bad assumptions, contradictions, and next actions.
6. **Coordinator synthesizes final answer.**
   - It uses worker outputs, review notes, and its own judgment.
7. **Skill memory is updated.**
   - Reusable patterns, failures, and successful methods are stored for future agents.

## Shape

```text
User Task
  -> Coordinator
      -> SkillMemory.search()
      -> Planner
          -> WorkerAgent(research)
          -> WorkerAgent(coding)
          -> WorkerAgent(review)
      -> ReviewerAgent for risky outputs
      -> Synthesizer
      -> SkillMemory.add()
  -> Final Answer
```

The current implementation is intentionally compact. It is a runnable architecture skeleton, not a full browser/search/coding sandbox yet.

## Modules

- [Agent runtime](docs/modules/agent-runtime.md)
- [Web console](docs/modules/web-console.md)
- [Target infrastructure](docs/modules/infrastructure.md)
- [Roadmap](docs/roadmap.md)
