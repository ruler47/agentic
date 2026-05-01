# AGENTS.md

Project context and working notes for AI coding agents.

This file is the first place to read before changing the project. Keep it current when
architecture, commands, conventions, or collaboration rules change.

## Project

Agentic Universal Agent is a TypeScript prototype of a coordinator agent.

The coordinator accepts one concrete user task, decides whether to answer directly or
delegate, creates focused subtasks for worker agents, reviews their results, synthesizes
the final answer, and stores reusable lessons in shared skill memory.

## User Collaboration Notes

- The user wants the project in TypeScript.
- The user expects code changes to be covered by tests.
- Before reporting completion, run automated checks and a relevant manual test.
- Manual checks must include the actual user-visible surface, API responses, trace logs,
  and database records when persistence is involved.
- Return only working code with the expected execution result.
- Keep this file updated with important project notes, links, commands, and decisions.
- The user prefers a universal agent that delegates narrow, context-heavy work to
  separate agents, then accumulates the results centrally.

## Local Model

Default OpenAI-compatible endpoint:

- Base URL: `http://127.0.0.1:1234/v1`
- Model: `google/gemma-4-26b-a4b`

Environment overrides:

- `LLM_BASE_URL`
- `LLM_MODEL`
- `LLM_TEMPERATURE`
- `LLM_MODEL_TIER_S`
- `LLM_MODEL_TIER_M`
- `LLM_MODEL_TIER_L`
- `LLM_MODEL_TIER_XL`

Tier variables can contain one model or a comma-separated fallback list. In the web app,
the editable tier policy is stored in Postgres and exposed through the System Inventory
panel.

## Commands

Install dependencies:

```bash
npm install
```

Run full verification:

```bash
npm run verify
```

The verification command runs:

- `npm run typecheck`
- `npm run test:types`
- `npm test`
- `npm run build`

Manual CLI smoke test:

```bash
node dist/cli.js "Скажи одним предложением, что такое универсальный агент"
```

Run the full container stack:

```bash
docker compose up --build
```

The `npm run dev` command uses `tsx`; in some sandboxes it can fail on IPC pipe
permissions. If that happens, use `npm run build` and then `node dist/cli.js ...`.

## Important Files

- [README.md](README.md) - quick start and request execution summary.
- [docs/architecture.md](docs/architecture.md) - detailed architecture and delegation model.
- [src/agents/universalAgent.ts](src/agents/universalAgent.ts) - main coordinator runtime.
- [src/agents/modelTier.ts](src/agents/modelTier.ts) - model tier selection policy.
- [src/agents/prompts.ts](src/agents/prompts.ts) - prompts for classification, planning,
  workers, reviewers, synthesis, and learning.
- [src/llm/client.ts](src/llm/client.ts) - OpenAI-compatible LLM client.
- [src/memory/skillMemory.ts](src/memory/skillMemory.ts) - shared file-based skill memory.
- [src/tools/registry.ts](src/tools/registry.ts) - tool registry skeleton.
- [src/tools/tool.ts](src/tools/tool.ts) - versioned tool module contract.
- [src/tools/fileTools.ts](src/tools/fileTools.ts) - sandboxed workspace file tools.
- [src/settings/modelTierSettings.ts](src/settings/modelTierSettings.ts) - model tier
  policy contract and in-memory implementation.
- [src/settings/postgresModelTierSettings.ts](src/settings/postgresModelTierSettings.ts)
  - Postgres-backed model tier policy.
- [src/server/http.ts](src/server/http.ts) - web API and static UI server.
- [src/runs/inMemoryRunStore.ts](src/runs/inMemoryRunStore.ts) - replaceable run store.
- [src/runs/postgresRunStore.ts](src/runs/postgresRunStore.ts) - Postgres-backed run store.
- [src/db/migrate.ts](src/db/migrate.ts) - database migrations.
- [public/](public/) - browser console UI.
- [memory/skills.json](memory/skills.json) - current long-term skill memory store.
- [tests/](tests/) - automated tests.
- [docs/modules/](docs/modules/) - module-level documentation.
- [docs/roadmap.md](docs/roadmap.md) - planned memory, tools, recursive agents, and model tiers.

## Architecture Notes

Request flow:

```text
User task
  -> Coordinator
  -> SkillMemory.search()
  -> Complexity classification
  -> Direct answer or delegated plan
  -> Worker agents
  -> Reviewer agents, with one bounded worker revision if review returns `needs_revision`
  -> Final synthesis
  -> SkillMemory.add()
```

Delegation is preferred when the task:

- crosses multiple domains;
- needs research and implementation;
- can consume too much context in one thread;
- benefits from independent review;
- requires both creation and verification.

Direct mode is acceptable when the task is narrow, stable, low risk, and does not require
fresh research or codebase inspection.

## Testing Policy

For code changes:

- Add or update automated tests.
- Run `npm run verify`.
- Run a manual test that exercises the user-visible path.
- Mention any untested risk explicitly if full verification is impossible.

For documentation-only changes:

- Automated tests are not required unless docs include generated or validated examples.
- Run a lightweight manual check by reading the changed file and confirming links/commands
  still make sense.

## Current Test Coverage

- `tests/json.test.ts` covers JSON extraction from model output.
- `tests/skillMemory.test.ts` covers file-backed skill memory.
- `tests/toolRegistry.test.ts` covers tool registration and lookup.
- `tests/universalAgent.test.ts` covers direct and delegated orchestration with a fake LLM.

## Maintenance Rules

- Keep edits small and consistent with the existing TypeScript style.
- Prefer Node built-ins unless a dependency clearly improves the system.
- Do not store full transcripts in skill memory; store compressed reusable lessons.
- Keep worker context narrow: original task summary, one subtask, relevant memory, output
  expectations, and review criteria.
- Preserve trace parent links when adding orchestration steps; the UI depends on
  `parentSpanId` to draw direct arrows.
- Add links here when introducing new core docs, modules, commands, or workflows.
- UI changes must be checked through the HTTP server, not only by reading static files.
- Prefer Docker Compose for project runtime and manual verification.
- File tools must stay inside the configured workspace root (`FILE_TOOL_ROOT`, default
  `workspace`).
