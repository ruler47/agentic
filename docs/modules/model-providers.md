# Model Providers

## Purpose

Model providers are the durable catalog for chat and embedding endpoints. They are
separate from model tier policy:

- providers describe where models live, what kind of endpoint they use, which model ids
  are available, and which secret handle should be used;
- tier policy decides which chat model ids are attempted for `S`, `M`, `L`, and `XL`;
- embedding providers are memory infrastructure and must not be mixed into chat tiers.

This keeps local LLMs, remote OpenAI-compatible providers, and future memory embedding
models visible and operator-editable without putting raw API keys in prompts, memory,
trace events, or source code.

## Data Model

Core files:

- `src/settings/modelProviderStore.ts`
- `src/settings/postgresModelProviderStore.ts`
- `src/db/migrate.ts`
- `src/server/http.ts`

Each provider stores:

- `id` and `label`;
- `kind`: `chat` or `embedding`;
- `providerType`: `local`, `remote`, `openai-compatible`, or `deterministic`;
- optional `baseUrl`;
- `modelIds` and optional `defaultModel`;
- optional `apiKeySecretHandle`;
- optional embedding `dimensions`;
- lifecycle `status`;
- health status/detail timestamps.

Docker/Postgres persists providers in `model_providers`. If no rows exist, the store
seeds two defaults from environment:

- `local-chat` from `LLM_BASE_URL`, `LLM_MODEL`, and tier override model lists;
- `memory-embedding` from `EMBEDDING_*` settings or the deterministic fallback.

## API

```text
GET    /api/model-providers
POST   /api/model-providers
PATCH  /api/model-providers/:id
DELETE /api/model-providers/:id
GET    /api/models/catalog
```

`/api/models/catalog` still probes configured OpenAI-compatible `/models` endpoints for
operator visibility, and now also includes the durable provider registry.

## UI

The Models page shows:

- discovered local chat models;
- active embedding provider information;
- durable Provider Registry cards;
- an Add Provider form;
- the existing S/M/L/XL tier policy editor.

Remote credentials should be created as secret handles first and referenced by handle
name in the provider form. Raw API key values are intentionally not accepted here.

## Current Limitations

Runtime model routing still uses the tier model id list and the main `LlmClient` base URL.
The provider registry is the durable operator and future resolver layer. Remaining work:

- provider-aware runtime resolution of `provider:model` references;
- provider healthcheck actions;
- selectable provider/model dropdowns in tier cards;
- DB-backed embedding provider activation plus automatic memory re-embedding when the
  active embedding model changes.
