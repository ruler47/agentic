# Tools as Services (Phase 13)

The agentic runtime treats tools as **independent mini-apps** running
in their own Docker containers, sitting next to `app`, `postgres`,
`redis`, etc. in the same `docker-compose` network. The runtime
talks to them over HTTP using a fixed envelope; the tools talk back
to the runtime over HTTP using a callback API authenticated with a
short-lived JWT-style token.

This replaces the legacy in-process model, where tools were TS
modules loaded into the runtime process. Existing in-process tools
keep working — Phase 13 ships the new architecture **dormant by
default** behind per-tool feature flags so the migration is
zero-risk.

## Architecture

```
┌─────────────────────────────────────┐
│  Agentic runtime (app container)    │
│                                     │
│  Tool Registry  ─┐                  │
│  Worker LLM ─────┤── HTTP ──────────┼──┐
│  Improvement     │                  │  │
│  Coordinator ────┤                  │  │
└──────────────────┼──────────────────┘  │
                   │                     ▼
                   │      ┌────────────────────┐
                   ├──────┤ browser-operate    │
                   │      │  POST /run         │
                   │      │  GET  /describe    │
                   │      │  GET  /health      │
                   │      │  callback → app    │
                   │      └────────────────────┘
                   │      ┌────────────────────┐
                   ├──────┤ chart-generate     │
                   │      └────────────────────┘
                   │      ┌────────────────────┐
                   ├──────┤ market-timeseries  │
                   │      └────────────────────┘
                   │      ┌────────────────────┐
                   └──────┤ telegram-bot       │
                          │ (always-on)        │
                          └────────────────────┘
```

## Tool service contract

Every tool service exposes the same five endpoints, defined in
`src/tools/toolServiceContract.ts`:

| Endpoint               | Method | Purpose                                    |
|------------------------|--------|--------------------------------------------|
| `/describe`            | GET    | Tool metadata (name, version, capabilities)|
| `/health`              | GET    | Service health (status, version, detail)   |
| `/run`                 | POST   | Execute one tool invocation                |
| `/service/start`       | POST   | Start always-on service mode               |
| `/service/stop`        | POST   | Stop always-on service mode                |

The runtime is the only client; tools never need to expose these to
the public internet.

### `/run` body

```json
{
  "input": <tool-specific JSON>,
  "context": {
    "instanceId": "instance-local",
    "runId": "run_X",
    "spanId": "tool-call-Y",
    "toolName": "browser.operate",
    "now": "2026-05-10T12:00:00Z",
    "configuration": { "...": "operator-resolved values" },
    "secrets": { "...": "secret-store values" },
    "callback": {
      "baseUrl": "http://app:3000/api/tools/callbacks",
      "token": "<short-lived bearer>",
      "scope": ["artifacts.save", "ledger.claim", "memory.search", "events.emit"]
    }
  }
}
```

### `/run` response

```json
{
  "ok": true,
  "content": "human-readable summary",
  "data": {
    "<tool-specific>": "..."
  },
  "artifacts": [
    {
      "filename": "shot.png",
      "mimeType": "image/png",
      "contentBase64": "..."
    }
  ]
}
```

Inline artifacts use `contentBase64` strings (Buffer is not
JSON-serializable). The runtime's `parseToolResult` rehydrates
`contentBase64` → `Buffer` in `content` automatically before
artifact consumers see the data.

## Callback API (tool → runtime)

Tools call back into the runtime via
`POST /api/tools/callbacks/<action>` with the bearer token from
`context.callback.token`.

| Action               | Path                              | Scope            |
|----------------------|-----------------------------------|------------------|
| Save artifact        | `/api/tools/callbacks/artifacts`  | `artifacts.save` |
| Claim ledger work    | `/api/tools/callbacks/ledger/claim` | `ledger.claim` |
| Search shared memory | `/api/tools/callbacks/memory/search` | `memory.search`|
| Emit run event       | `/api/tools/callbacks/events`     | `events.emit`    |

The token (`ToolCallbackTokenIssuer` in
`src/tools/toolCallbackToken.ts`) carries `{runId, toolName, scope, exp}`
and is signed with HMAC-SHA256 over a per-process secret
(`TOOL_CALLBACK_SECRET`, auto-generated when unset). Default TTL is
30 minutes; the runtime issues a fresh token on every `/run` call.

## Authoring a tool

Drop `@agentic/tool-sdk` (under `tools/sdk/`) into your project:

```ts
import { createToolService } from "@agentic/tool-sdk";

const dispatch = createToolService({
  description: {
    name: "weather.lookup",
    version: "1.0.0",
    description: "Look up current weather for a city.",
    capabilities: ["weather"],
  },
  async run(input, context, { callback }) {
    const proof = await callback.saveArtifact({
      filename: "weather.json",
      mimeType: "application/json",
      content: JSON.stringify({ ... }),
    });
    return { ok: true, content: "fetched weather", data: { artifact: proof } };
  },
});
```

Wrap that in any HTTP framework (Express, Fastify, raw `http`),
publish a Docker image, and add a `docker-compose.yml` service
entry. The SDK README under `tools/sdk/README.md` has a fuller
template.

## Built-in tools

Every built-in tool ships in two flavours:

| Tool                | In-process class      | Docker service                 | Flag (env on `app`)         |
|---------------------|-----------------------|--------------------------------|-----------------------------|
| `browser.operate`   | `BrowserOperateTool`  | `tools/browser-operate-service/`   | `BROWSER_OPERATE_RUNNER=docker`   |
| `chart.generate`    | `ChartGenerateTool`   | `tools/chart-generate-service/`    | `CHART_GENERATE_RUNNER=docker`    |
| `market.timeseries` | `MarketTimeseriesTool`| `tools/market-timeseries-service/` | `MARKET_TIMESERIES_RUNNER=docker` |
| `telegram.bot`      | `TelegramBotServiceTool` | `tools/telegram-bot-service/`   | `TELEGRAM_BOT_RUNNER=docker`      |

Default = in-process for all four, so a fresh `docker compose up`
keeps working without the new tool services. Set the env flag on
the `app` service to route traffic through the docker container.

`web.search` and `file.read` / `file.write` stay in-process by
design — `web.search` is already a thin client to a separate
SearXNG container, and the file tools need direct access to the
`workspace` volume; HTTP overhead would be wasteful.

## Versioning, stats, import/export

- **Versions**: `GET /api/tools/generated-modules/:name/versions`
  lists every version the runtime has seen with `active`,
  `changeSummary`, and per-version aggregates.
  `POST /api/tools/generated-modules/:name/activate-version`
  switches the active version (the supervisor picks up the new
  image on the next call).
- **Stats**: `GET /api/tools/:name/stats` returns derived metrics
  (`totalRuns`, `successCount`, `failureCount`, `successRate`,
  `lastSuccessAt`, `lastFailureAt`, plus per-version aggregates)
  built on top of the metadata store's existing
  `successCount`/`failureCount` counters.
- **Export**: `GET /api/tools/:name/export` returns the package
  manifest as JSON with a sensible filename.
- **Import**: `POST /api/tools/package-manifests` accepts the same
  manifest body to register a tool blueprint on a target instance.
  The OCI image is shipped separately
  (`docker save <image> | docker load` or a registry push/pull).

## Improvement workflow

When the agent fails using a tool, it can request a structured
rebuild via `ToolBuildRequestInput.improvementSpec`:

```ts
{
  symptom: "Screenshot is blank because cookie banner blocks page",
  expectedBehavior: "Auto-accept cookie banner before screenshot",
  failureExamples: [
    { runId: "run_X", artifactIds: ["art_Y"], notes: "OneTrust banner on tomshardware.com" }
  ],
  acceptanceTest: "Calling browser.operate against tomshardware.com captures 5 distinct headlines."
}
```

The builder LLM (`LlmToolBuildProvider`) reads the spec via
`improvementSpecToPromptSection()` and is instructed to:
1. Address the symptom directly in the new version.
2. Add a regression test that covers the failure example(s).
3. Document the fix in `changeSummary` so promotion review can see
   what changed.

If the new version passes QA, `toolPromotionCoordinator` activates
it; the supervisor restarts the docker container with the new image
on the next `/run` call. The old version stays in the registry and
can be reactivated via `activate-version` if the new one regresses.

## Tool builder generates Docker output

When the tool-builder agent creates a brand-new tool (not a
rebuild), it can emit a complete Docker tool service project via
`dockerToolPackageManifest()` and `dockerToolProjectScaffold()` in
`src/tools/toolBuildProviders.ts`. The scaffold writes:
- `tools/<name>-service/Dockerfile`
- `tools/<name>-service/package.json`
- `tools/<name>-service/src/server.ts` (canonical envelope; the LLM
  fills the `runHandler` body)
- `tools/<name>-service/README.md`

The manifest references the OCI image
`agentic-tool-<dashed-name>:<version>`, which the local Docker
daemon serves to the `OciImageToolPackageRunner`. No external
registry is required for the default in-compose deployment.

## Migration plan

The shift to docker tools is a **one-flag-at-a-time** rollout:

1. Build the docker images: `docker compose build browser-operate chart-generate market-timeseries telegram-bot`
2. Set `BROWSER_OPERATE_RUNNER=docker` on the `app` service env
3. Restart `app`; verify a laptop test still produces screenshots
4. Repeat for `chart`, `market`, `telegram`
5. (Phase G+) flip the default in-code to docker, deprecate the
   in-process tools, eventually delete the legacy classes

The tool-builder agent shifts to OCI-image output by setting
`TOOL_OCI_RUNNER=enabled` (read by `OciImageToolPackageRunner`) on
the `app` service. Existing local-path generated tools continue to
load via `LocalPathToolPackageRunner`.

## Files of interest

- `src/tools/toolServiceContract.ts` — wire types
- `src/tools/toolCallbackToken.ts` — JWT-style token issuer
- `src/server/modules/tool-callbacks/` — callback Nest module
- `src/tools/httpToolAdapter.ts` — generic HTTP adapter for tools
- `src/tools/browserOperateHttpTool.ts` — browser-specific adapter
- `src/tools/toolBuildProviders.ts` — `dockerToolPackageManifest`,
  `dockerToolProjectScaffold`
- `src/tools/toolBuildBlueprint.ts` — `improvementSpecToPromptSection`
- `tools/sdk/` — `@agentic/tool-sdk` (typed callback client + server template)
- `tools/browser-operate-service/`
- `tools/chart-generate-service/`
- `tools/market-timeseries-service/`
- `tools/telegram-bot-service/`
