# Agent Runtime Module

Status date: 2026-05-18.

## Purpose

The agent runtime executes a single user task without depending on the web UI. The active
runtime is the rebuild baseline: `BaseAgent` plus the Tool Registry plus the LLM client.

Main files:

- `src/agents/baseAgent.ts` - runtime facade and LLM/tool loop.
- `src/agents/baseAgentPrompt.ts` - system prompt and tool schema construction.
- `src/agents/baseAgentToolLifecycle.ts` - `request_tool_creation` and
  `request_tool_edit` handling.
- `src/agents/baseAgentToolExecution.ts` - registered tool execution, per-run tool
  result cache, source evidence capture, and tool artifact save hooks.
- `src/agents/baseAgentFinalization.ts` - final proof/source/consistency gates,
  candidate acceptance, action proposal emission, and run result assembly.
- `src/agents/baseAgentEvidence.ts`, `src/agents/baseAgentProof.ts`, and
  `src/agents/baseAgentArtifacts.ts` - source/proof reasoning and artifact QA helpers.
- `src/llm/client.ts`
- `src/tools/tool.ts`
- `src/tools/registry.ts`
- `src/server/modules/runs/runs.service.ts`

Legacy runtime files such as `src/agents/universalAgent.ts`, recursive executor code, and
tool-build council code have been deleted from the active tree. Their ideas may return
only through the roadmap with new contracts.

## Current Execution Flow

```text
Run created
  -> RunsService resolves context and stores the run
  -> BaseAgent starts
      -> LLM receives task, context, tool schemas, and finish action
      -> LLM may call registered tools
      -> ToolRegistry executes calls with run-scoped runtime context
      -> artifacts/screenshots returned or written by tools are saved
      -> LLM finishes with final answer
  -> Base return gate validates minimum result requirements
  -> run is completed or failed
```

## Responsibilities

`BaseAgent` is responsible for:

- receiving one concrete task;
- including bounded context such as time, timezone, locale, instance, requester, channel,
  thread summary/facts/questions, group profile, input artifacts, and available tools;
- framing the task before the first model call. The frame records the intended strategy,
  ideal outcome, user success criteria, likely failure modes, evidence needs, and a
  research contract. Broad/current recommendation, comparison, and product-selection
  tasks require multiple research steps, independent source URLs, and at least one
  source read/extract call instead of a one-search/snippet answer;
- exposing tool schemas to the LLM;
- executing only registered tool calls through `ToolRegistry`;
- passing run/thread/user/instance provenance into tool calls;
- giving tools a scoped artifact writer, callback envelope, secret/configuration
  resolvers, audit hook, and logger when the host provides them;
- saving returned and directly written artifacts through the host-provided artifact
  callback;
- treating external URL evidence as proof-worthy when artifact saving is available:
  after a web/source tool returns a public URL, the agent is instructed to capture a
  screenshot or equivalent artifact before finishing, and the return gate fails the run
  if no usable proof artifact was produced;
- feeding failed proof QA back to the LLM on the next step so it can retry with an exact
  source URL, tighter selector/focus text, or a better source before finishing;
- planning proof targets from final-answer claims. When source evidence contains both
  generic page signals and concrete answer claims, proof repair ranks source URLs by
  claim matches and chooses `focusText` from the matched claim instead of a generic year
  or page heading;
- blocking premature final answers after a generated `run_scoped_candidate` was attached
  but before it was called, then giving the LLM a bounded repair turn to use that
  candidate for the original task before trying `finish` again;
- treating screenshots as proof, not primary data, for current external facts. Price,
  quote, weather, news, and similar tasks must use a search/fetch/data tool that returns
  text or structured evidence before answering; a screenshot-only answer fails the return
  gate;
- blocking shallow final answers for broad research/product-selection frames with
  `agent-research-contract-repair-requested`. The model receives a repair instruction to
  check freshness/current baseline, discover candidates, verify final claims, and call
  `web.read`/`web.extract` on candidate source URLs before finalizing. If no such reader
  exists, the repair prompt tells the model to request one instead of fabricating from
  snippets;
- blocking source-backed final answers whose concrete claim signals are not present in
  collected non-screenshot source evidence. The generic source-grounding gate emits
  `agent-source-grounding-repair-requested` and asks the model to gather/read supporting
  sources or remove/soften unsupported names, versions, specs, dates, prices, and similar
  externally checkable claims. If the step/tool budget is exhausted but the draft has user
  value, the run preserves the answer with a visible source-grounding note;
- requiring claim-based proof for those broad frames: screenshot QA receives final-answer
  claim signals, and source URL match alone is not enough when the screenshot does not
  show the recommended candidate or claim;
- reusing identical tool calls inside the same run instead of executing duplicate calls
  against the same tool/input pair;
- enforcing max steps, max tool calls, LLM timeout, per-tool timeout, and cancellation;
- emitting trace events for start, prepared context, LLM decisions, tool start/completion,
  artifact save, return-gate check, completion, and failure;
- failing if a required artifact action was requested but no artifact was produced;
- failing if external URL evidence was used and the run could save artifacts but no
  proof artifact was created, unless the task explicitly asked for no proof/screenshot or
  the run is an external-action preparation whose filled-form/commit proof belongs to the
  approval lifecycle;
- failing if the final answer is empty, looks like raw unexecuted tool-call JSON, exceeds
  budget, or hides tool/artifact failures;
- creating an `ExternalActionProposal` when the task asks for a reservation, purchase,
  outbound message, write API call, or similar external state-changing action. Explicit
  “do not submit without confirmation” wording now means create a proposal and require
  approval before the commit boundary, not suppress the proposal. Pure availability
  lookups such as “find a place that can be booked online” stay informational, but the
  same lookup becomes an action-preparation request when the task also supplies
  contact/identity data, date/time or service constraints, and asks for
  approval/proof/filled-form preparation or says to use/take/select the best known
  target. Continuation runs may use compact thread summary/facts/questions for this
  framing so follow-up contact details inherit the original external-action intent;
- returning a final answer and artifact list to the run store.

The server is responsible for:

- resolving instance/user/channel/thread provenance;
- storing runs and events;
- handling cancellation/restart/resume actions at the run level;
- wiring the artifact store;
- wiring audit events;
- exposing proposed external actions through `/api/action-proposals` and recording
  approve/reject decisions as trace and audit evidence. Approved proposals expose
  `POST /api/action-proposals/:id/commit`; proposals now persist a `commitExecutor`
  contract with executor kind, readiness, risk, missing requirements, and expected proof.
  The endpoint records `external-action-commit-blocked` from that contract until a ready
  generated executor is attached. Ready generated executors must name a registered tool
  with `external-action-commit*` capability and a typed `toolInput`; then the endpoint
  executes the tool through `ToolRegistry` and records `external-action-committed` or
  `external-action-commit-failed` with the confirmation payload. Missing executors can be
  planned/built through `POST /api/action-proposals/:id/build-executor`, which records a
  linked executor build request, reuses an existing matching commit tool when possible,
  or starts the normal Tool Creation pipeline for a disabled candidate;
- exposing the result through API, SSE, and React UI.

## Public Runtime Contract

The concrete TypeScript shape can evolve, but the runtime contract should keep these
boundaries:

```ts
const result = await agent.run(task, {
  instanceId,
  requesterUserId,
  channel,
  threadId,
  parentRunId,
  threadContext,
  inputArtifacts,
  saveArtifact: async (artifact) => artifactStore.saveGenerated(runId, artifact),
  resolveSecret: async (ref) => secretStore.resolve(ref),
  resolveConfiguration: async (toolName, key) =>
    runtimeSettings.resolve(toolName, key),
  onToolCreationRequested: async (request) =>
    toolsService.createToolPackage({
      ...request,
      source: "agent",
      sourceRunId: runId,
    }),
  onToolEditRequested: async (request) =>
    toolsService.createToolVersion(request.name, {
      ...request,
      source: "agent",
      sourceRunId: runId,
    }),
  toolCatalog: [
    {
      name: "browser.screenshot",
      version: "0.1.0",
      source: "generated",
      status: "available",
      capabilities: ["browser-screenshot"],
      inputSchema,
      outputSchema,
      versions: [{ version: "0.1.0", active: true, status: "available" }],
    },
  ],
  onEvent: (event) => {
    // Persist, stream, or render event.
  },
  abortSignal,
});
```

Tool creation and tool editing are now part of the active base contract through
`request_tool_creation` and `request_tool_edit` meta-actions. They are not normal runtime
tools: BaseAgent exposes them alongside `finish` so the LLM can ask for a missing
capability, or for a new version of an existing generated tool that is relevant but
insufficient. RunsService handles both callbacks by creating linked Tool Creation V1
runs with source `agent`. For agent-requested builds, RunsService forwards the original
run task as `sourceTask`; the builder can infer blocking behavior QA examples from
explicit input/output text, README package examples, simple text-transform tasks, or
LLM-authored QA criteria before a candidate is attached.
The first generated `web.read` capability now follows that path: Tool Creation V1 can
write a source-bundle page reader for known URLs, QA it with behavior examples, register
it, and expose it to agents as `web-read` / `web-extract` once manually verified. Broad
research/product-selection frames now count successful `web.read`/`web.extract` calls as
part of the research contract, so agents must read at least one source page after
`web.search` finds candidate URLs before returning a final recommendation.
Operator-created tools still start disabled and need operator promotion before general
agent use. Agent-requested creations and edits register as candidate versions, then load back into the same run as pinned
`run_scoped_candidate` tools, so the agent can finish the original task with the new or
improved capability. If the model tries to finish before calling that candidate,
BaseAgent blocks the attempted final answer, emits
`agent-candidate-use-repair-requested`, and asks the model to call the candidate first.
If that candidate is actually called and the run passes the return gate, RunsService
accepts it as agent-verified evidence, marks the version `available`, activates it,
reloads the registry, and future agents see the active version. If the candidate is
still not used after bounded repair attempts, the base return gate fails the run. If a
later agent asks for a similar edit while an inactive QA-passing candidate already
exists, RunsService reuses that candidate for the run instead of building another copy.
Creation requests also avoid accidental downgrades: the LLM's
common default `0.1.0` candidate version is treated as non-binding when newer package
versions already exist for the same generated tool family, so the host can attach the
best healthy/latest candidate instead of reverting to an older implementation.

RunsService now builds the prompt/tool catalog from the metadata store before each run.
The catalog is limited to callable `available` active tools, then enriched with source,
active version, status, capabilities, startup mode, input/output schema keys, examples,
required configuration/secret handles, run success/failure counters, health, change
summary, and compact version history. Candidate versions in the normal catalog are
context only; the only exception is the candidate created or reused for the current
agent-requested creation/edit, which is injected into that run's callable schemas with
`visibility=run_scoped_candidate`.

There is a second, operator-test-only exception. If the run text explicitly asks to use a
specific disabled generated tool, RunsService can match it by name, description, or
capability tokens and attach the active healthy version as a `run_scoped_candidate`.
This lets an operator test a disabled tool in a normal agent run without exposing it to
all agents. The candidate is still subject to the same bounded “must call before finish”
repair gate, but it carries `promotionPolicy=manual`; a successful run records manual
review evidence instead of automatically marking the version `available`.

## Tool Contract

The agent does not import tool implementations directly. It sees registered tools through
their metadata:

- stable name;
- version;
- description;
- capabilities;
- input schema;
- output schema;
- startup mode;
- status;
- docs/examples;
- required configuration keys;
- required secret handles.

Tool calls go through:

```ts
await registry.execute(toolName, input, context);
```

Before a run starts, the server builds a tool policy and enriched tool catalog from the
metadata catalog. Only tools whose active status is `available` are offered to
`BaseAgent`. `loaded`, `disabled`, and `failed` tools can still be inspected and manually
run from the Tools page, but they are omitted from the LLM callable schemas and from the
prompt's available-tool list.

The base tool runtime context now carries:

- `runId`, `instanceId`, `requesterUserId`, `threadId`, and a per-call `spanId`;
- `caller: "base-agent"` for agent-originated calls;
- a narrow artifact writer backed by the normal artifact store;
- secret and configuration resolvers backed by handles/settings;
- callback metadata for future external service callbacks;
- an audit hook and logger with sanitized metadata.

Tools should not receive database clients, filesystem access, or internal app objects
unless that capability is explicitly part of their versioned contract.

## Artifacts

Tools may return artifacts in several supported shapes:

- `data.artifacts[]`;
- `data.screenshots[]`;
- `data.artifact`;
- binary `content` as `Buffer`;
- serialized `{ type: "Buffer", data: [...] }`;
- base64 image fields where the tool contract defines them.

The runtime stores artifacts through the same artifact store used by the web API. Artifact
metadata should include filename, MIME type, kind, size, preview when available, and
quality metadata when a checker exists.

For tasks that depend on current/external sources, URL evidence is treated as incomplete
until the run stores a proof artifact when artifact saving is wired. The agent can use an
available screenshot/artifact tool, or request creation of a missing `browser.screenshot`
style tool and then call the run-scoped candidate. This is intentionally generic: the
runtime does not special-case bitcoin, markets, or any domain; it only detects public
source URLs returned by tools.

For current external facts such as prices, quotes, weather, or news, a screenshot tool is
not enough by itself. `BaseAgent` requires non-screenshot data evidence first, then proof
can be captured with a screenshot. The current generated `browser.screenshot` package
captures the viewport by default (`fullPage: false`) and supports optional `focusText`
or `selector` inputs to scroll the relevant value/section into view before capture.
Screenshot proof artifacts are saved with compact quality metadata. Failed visual QA,
blocked/loader evidence, or a screenshot source URL that does not match one of the
previous data/source URLs means the artifact remains inspectable but does not satisfy
the proof requirement. That failed QA summary is included in the next model prompt when
proof is still required, so the model has a concrete reason to retry the screenshot
instead of finishing with invalid evidence. The React Run Workspace, Trace inspector
artifact gallery, and Artifacts page render artifact quality status and check details.
Visual QA treats both centered consent modals and lower-left consent panels over
blurred/low-detail content as failed proof, even if the page title/URL/text contains the
expected claim. It keeps ordinary page content with lower-left CTA buttons valid when the
page itself has enough sharp visual detail.

Source grounding runs before screenshot proof repair. A screenshot can prove that a
source page visually contained a claim, but it is not the source of truth for current or
external facts. `BaseAgent` therefore compares final-answer claim signals against
non-screenshot source evidence first, so this policy applies to any domain: products,
markets, legal/medical/financial lookups, docs, news, or arbitrary web research.
After that grounding pass, proof repair uses the same claim signals to choose the proof
target. The preferred `focusText` is a matched final-answer claim, not merely the first
number or year seen in the source page.

Inside one run, `BaseAgent` also caches successful tool outputs by tool name, tool
version, and stable JSON input. If the LLM repeats the identical call against the same
version, the cached result is returned to the model and the trace records a reused
`tool-completed` event instead of re-executing the tool. Candidate edit versions are not
allowed to reuse cached results from the previous active version; the new candidate must
execute and prove its own output.

Run-scoped generated or edited candidates are promoted only after the base return gate
passes. A run that exhausts its step budget is failed, even if a candidate tool returned
`ok`, and that candidate is not accepted globally.

## Trace Events

The active base trace is intentionally small:

- `agent-invocation-started`;
- `agent-context-prepared`;
- `agent-invocation-decision-selected`;
- `tool-started`;
- `tool-completed`;
- `artifact-created`;
- `agent-invocation-return-checked`;
- `agent-invocation-completed`;
- failure/cancellation events.

Future phases add richer invocation contracts, child-agent call frames, ledger decisions,
and retrospective events.

## Removed Legacy Behavior

The active runtime no longer exposes or depends on:

- coordinator DAG planning;
- worker/reviewer waterfalls;
- recursive mode selected by prompt markers;
- tool-build queue callbacks;
- tool-build council callbacks;
- tool investigation tickets;
- tool rework waits.

Those capabilities may return only through the roadmap:

- Phase 4: Tool Creation V1;
- Phase 5: Tool Editing And Versioning;
- Phase 6: Agent Delegation V1;
- Phase 7: Work Ledger, Evidence Ledger, Memory, And Threads.

## Test Expectations

Runtime changes should include tests for:

- direct answer run;
- one-tool run;
- multi-tool run;
- artifact save;
- required artifact failure;
- tool failure;
- cancellation terminal-state safety;
- API smoke through `POST /api/runs`.

Before reporting runtime work complete, run:

```bash
npm run typecheck
npm run test:types
npm test
npm run build
```

For UI-visible runtime behavior, also run:

```bash
npm run build --prefix web-react
docker compose up --build
```

Then perform a manual smoke run through API or the browser console.
