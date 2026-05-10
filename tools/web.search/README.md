# web.search (in-process built-in)

> **Status:** in-process — runs inside the runtime app process, not as a docker
> service. This directory is a registry marker so `tools/` mirrors the live
> tool registry; the implementation lives in `src/tools/webSearchTool.ts`.

## What it does
Calls a SearXNG-compatible JSON search endpoint and returns the top organic
results. Used by every agent task that needs web evidence and doesn't have a
more domain-specific search tool registered.

## Registered as
```
name:        web.search
version:     1.0.0
capabilities: web-search, research, current-information
startup:     on-demand
input:       { query: string, limit?: 1..10 }
output:      { ok, content, data: { items: [{title, url, snippet}] } }
```

## Implementation
- File: `src/tools/webSearchTool.ts`
- Registered in: `src/server/persistence/persistence.module.ts`
- Configuration: `SEARXNG_BASE_URL` env (defaults to compose `searxng:8080`).

## Why not a docker service yet
This is one of the four remaining in-process built-ins (the others are
`file.read`, `file.write`, `channel.telegram.bot`). They will eventually move
to `tools/web-search-service/` etc. mirroring `browser-operate-service`. The
stub directory exists so the operator can see the registered tool in `tools/`
even before that migration lands.
