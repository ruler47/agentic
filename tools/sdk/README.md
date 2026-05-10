# @agentic/tool-sdk

Shared SDK for authoring **tool services** that the agentic runtime
invokes over HTTP. A tool service is a self-contained mini-app:
- Speaks a small, fixed HTTP envelope (`POST /run`, `GET /describe`, `GET /health`, `POST /service/start`, `POST /service/stop`)
- Lives in its own Docker container
- Calls back into the runtime for shared concerns (artifacts, work-ledger, memory, run events) using a short-lived bearer token the runtime supplied in the call context

## Minimal example

```ts
import { createToolService, ToolDispatch } from "@agentic/tool-sdk";
import express from "express";

const dispatch: ToolDispatch = createToolService({
  description: {
    name: "my.tool",
    version: "1.0.0",
    description: "Echoes input back to the caller.",
    capabilities: ["demo"],
  },
  async run(input, context, { callback }) {
    return {
      ok: true,
      data: { received: input },
      content: `Echoed ${JSON.stringify(input)} for run ${context.runId ?? "(none)"}.`,
    };
  },
});

const app = express();
app.use(express.json());
app.get("/describe", (_, res) => res.json(dispatch.describe()));
app.get("/health", async (_, res) => res.json(await dispatch.health()));
app.post("/run", async (req, res) => res.json(await dispatch.run(req.body)));
app.post("/service/start", async (req, res) => res.json(await dispatch.startService(req.body)));
app.post("/service/stop", async (req, res) => res.json(await dispatch.stopService(req.body)));

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`my.tool listening on ${port}`));
```

## Callback example

When a tool needs to persist an artifact:

```ts
async run(input, context, { callback }) {
  const proof = await callback.saveArtifact({
    filename: "evidence.png",
    mimeType: "image/png",
    contentBase64: theBase64Encoded,
    description: "Browser screenshot",
  });
  return {
    ok: true,
    data: { artifact: proof },
    content: `Saved artifact ${proof.url}`,
  };
}
```

The runtime issues a short-lived JWT-style token scoped to one
`(runId, toolName)` and includes it in `context.callback.token`. The
SDK forwards that token automatically; tool authors do not handle
it.
