# Agentic React UI (v2)

Parallel React rebuild of `public/app.js`. Runs on port `3001`, proxies `/api/*`
to the legacy backend so both UIs read the same data.

## Run

```bash
# Terminal A — backend (legacy + React both read this)
PORT=3000 npm run web:dev

# Terminal B — React UI
cd web-react && npm run dev
# → http://127.0.0.1:3001
```

If port `3000` is already taken (e.g. by Docker), point Vite at a different
backend port:

```bash
# Terminal A
PORT=3010 npm run web:dev

# Terminal B
cd web-react && AGENTIC_BACKEND_URL=http://127.0.0.1:3010 npm run dev
```

The legacy UI (`public/app.js`) still serves from whichever port the backend
listens on. Open both side-by-side to compare screens.

## Stack

- React 19 + TypeScript
- Vite 6 (dev + build)
- React Router 7 (data router)
- TanStack Query 5 (server state)
- Tailwind 4 (`@theme` tokens mirror legacy palette)
- Zustand (UI state, added when needed)
- @xyflow/react (Trace Lab graph, Phase 3)

## Type sharing

Backend types are imported through the `@server/*` path alias (TypeScript
`paths` + Vite `resolve.alias`). The React bundle never executes backend
runtime code; only `export type` declarations cross the boundary.

## Phase status

- [x] Phase 0 — scaffold, sidebar, placeholder routing
- [x] Phase 1 — API hooks, Dashboard with run file attachments, Runs list, Run Workspace, SSE stream
- [x] Phase 2 — Trace Lab (timeline / graph via xyflow / logs + inspector + filters)
- [x] Phase 3 — Tool Builds + Investigations modal + Rework Waits
- [x] Phase 4 — Tools + Models + Group Profile + Settings + Diagnostics
- [x] Phase 5 — Conversations + Memory + Artifacts
- [x] Phase 6 — Users + Channels + Approvals + Audit Log (Policies + Scheduler stay placeholders until backend lands them)
- [x] Phase 7 — polish: vitest unit tests, route-level code splitting, ErrorBoundary, page loader
- [ ] Phase 8 — retire legacy `public/app.js` *(on hold — keeping legacy alongside while operators compare)*

## Tests

```bash
cd web-react && npm test
```

Vitest runs the pure-function suites that protect the most critical behaviour:

- `lib/format.test.ts` — relative time, durations, run lifetime math
- `lib/fetch.test.ts` — `apiFetch` wrapper + `ApiError` carrying server payload
- `features/trace/buildTraceNodes.test.ts` — span normalization, parent linkage, dependency ids, filters
- `features/trace/graphLayout.test.ts` — category vs depth layout positioning
- `features/investigations/buildSpanInvestigationDraft.test.ts` — span → draft, **explicit regression that text mentioning "screenshot" never auto-retargets `browser.operate` to `browser.screenshot`**

## Bundle

Code-split by route. Each page loads on demand, the heavy `@xyflow/react`
dependency lives in the Trace Lab chunk.

| chunk | size | gzip |
|---|---|---|
| initial bundle | ~365 kB | ~114 kB |
| TraceLabRun (xyflow) | ~205 kB | ~66 kB |
| ToolBuilds | ~24 kB | ~6 kB |
| typical page | 2–13 kB | 1–4 kB |
