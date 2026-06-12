# Core Toolbelt Roadmap

Status date: 2026-06-02.

This is the active product roadmap after the tool-builder/external-action stress phase.
The immediate goal is to make agents useful with a stable, generic toolbelt before adding
more builder complexity.

## Decision

Pause new Tool Creation V1 and external-action feature expansion until the base agent can
reliably solve real tasks with preinstalled, versioned, portable tools.

This is not a return to hardcoded private pipelines. Core tools are first-party portable
tool packages with the same manifest, schema, version, settings, secret-handle, runner,
artifact, health, and trace contracts as generated tools. The platform imports and
registers them; agents see only enabled active tools through the registry.

The builder remains important, but it becomes the later extension mechanism. First it
must learn from a clean reference toolbelt instead of generating every critical capability
while the runtime is still moving.

## Complexity Audit

Measured active areas on 2026-06-02:

- Selected active runtime/UI/tool areas: about 54,577 TypeScript/TSX lines.
- Builder/tools creation area: about 15,966 lines.
- External-action/approval area: about 7,693 lines.
- Base agent area: about 5,818 lines.
- Tool runtime/service area: about 2,501 lines.

The project has removed a large amount of legacy recursive/council/tool-build code, but
the replacement implementation still overweights tool building and external actions.
Builder plus external-action code is now more than four times the size of the base agent
area. That creates three risks:

- The agent cannot improve because most work goes into making tools build themselves.
- UX becomes hard to test because approvals, preparation, commit, profile hydration,
  executors, and generated candidates interact before the core task flow is stable.
- Deterministic glue starts encoding private behavior, especially around external action
  planning, instead of letting generic tools and agents handle the domain.

## Keep

These parts are foundational and should remain active:

- Tool registry metadata, version activation, enabled/disabled visibility, and manual
  runs.
- Source-bundle/local HTTP/OCI runner contracts.
- Artifact storage, previews, downloads, QA metadata, and trace/event capture.
- Secrets/settings stores and tool-scoped secret handles.
- Conversation threads, run persistence, channel provenance, and durable run events.
- Basic tool service lifecycle for always-on tools.
- BaseAgent tool calling, task framing, proof expectations, and final-answer gates.

## Freeze

These should receive only bug fixes needed to keep the app running:

- Tool Creation V1 package authoring strategies.
- Tool edit/version builder workflows.
- LLM-backed builder experiments.
- API-doc crawling, npm discovery, multi-call QA expansion.
- External-action generated executor creation.
- New approval modes or new external-action UX states.

## Quarantine

These areas should be treated as candidates for simplification or replacement:

- `src/agents/externalActionPlanning.ts`: too much deterministic action inference lives
  in the agent layer. It should shrink to a generic policy boundary: detect possible
  state-changing action, require enough data/proof/approval, and let tools handle forms.
- Approval UI flows: useful but too complex for the current phase. Keep one clear manual
  approval path and one later automode path, but avoid adding states until the action
  tool contract is stable.
- Tool builder compatibility fields and legacy-kind branches: keep for existing data only
  until core tools replace the need for most generated baseline capabilities.
- Historical docs that still describe deleted recursive/council/build queues as active.

## Later Delete Candidates

Delete only after tests prove no active path needs them:

- Builder templates whose only purpose is echo/demo compatibility.
- Fixture-only external-action surfaces that are not used by tests or manual exams.
- Legacy documentation sections that conflict with this roadmap.
- UI routes/cards for disabled feature families when the feature is intentionally frozen.
- Generated test tools and stale package metadata that are not part of the current
  registry state.

## Phase 0: Stabilize The Baseline

Goal: one local command sequence starts the platform, durable runs stay visible, and the
UI can exercise agent/tool paths without tool-builder work.

Deliverables:

- Document the exact local startup/check commands.
- Verify Postgres, artifact storage fallback, run persistence, tool registry loading, and
  trace UI.
- Ensure disabled/missing tool packages do not appear in the agent catalog.
- Keep `npm run verify` green.

Manual exam:

- Start the stack.
- Create one direct-answer run.
- Create one run that uses an enabled core tool and returns a proof artifact.
- Restart the app and confirm the runs remain visible.

## Phase 1: Core Tool Package Contract

Goal: define the stable contract for first-party core tools before writing more tools.

Deliverables:

- One manifest shape for preinstalled, imported, generated, source-bundle, and OCI tools.
- One registration path that records name, version, schemas, docs, capabilities, settings,
  secret handles, runtime type, health, and active/enabled state.
- One manual run path and one agent-call path.
- One trace contract: input, output, artifacts, errors, runtime version, and elapsed time.

Manual exam:

- Import/register a core package.
- Activate/deactivate versions.
- Run the exact same package manually and through an agent run.
- Confirm trace shows the version and full input/output.

## Phase 2: Preinstalled Core Toolbelt

Goal: provide enough generic tools for useful agent work without relying on builder output.

Core tools:

- `web.search`: current web search with source URL/title/snippet evidence.
- `web.read`: page fetch/extract/readability with source metadata and failure reasons.
- `browser.screenshot`: viewport proof screenshots with focus/quality checks.
- `browser.operate`: generic browser navigation, form fill, extraction, and screenshots.
- `file.read`: read uploaded/user-provided files through artifact handles.
- `file.write`: create reports, JSON/CSV/text artifacts.
- `document.extract`: PDF/doc/text extraction.
- `data.table`: small CSV/JSON table transform/filter/sort/join helper.
- `http.request`: generic HTTP/API call with schemas, headers through secret handles,
  and redacted traces.
- `channel.telegram`: always-on channel adapter through the same service lifecycle.

These are not domain tools. They are generic substrate tools.

Manual exams:

- Current fact with proof: price/weather/news style request with source and screenshot.
- Broad research: compare options using search + read + proof artifacts.
- Uploaded document: ask a question over an uploaded file.
- Generic API: call a public API through `http.request`.
- Telegram conversation: ask, follow up, and receive artifacts when possible.

## Phase 3: Agent Runtime Over The Toolbelt

Goal: improve the agent itself using stable tools.

Deliverables:

- Better task framing for broad, ambiguous, and action-oriented requests.
- Tool-selection prompt that receives only enabled active tool summaries.
- Evidence ledger behavior: reuse fresh artifacts in follow-ups instead of repeating work.
- Final answer gate that rejects empty/truncated/internal-debug outputs.
- Proof policy: always attach source/artifact proof when feasible, explain when not.

Manual exams:

- Ask a vague research task and verify the agent plans, reads sources, compares, and
  returns a complete recommendation.
- Ask a follow-up in the same conversation and verify it reuses previous context.
- Ask for a file/report artifact and verify it appears in UI and channel output.

## Phase 4: External Actions As Generic Browser/API Work

Goal: support online booking, appointment, order, message, or API write flows without
domain-specific code.

Deliverables:

- External action policy stays in platform core: detect state-changing boundaries,
  require approval where configured, require pre-submit proof, require post-submit
  confirmation/report.
- Execution belongs to generic tools: mostly `browser.operate` and `http.request`.
- Approval UI shows one clear proposal: target, action, data to submit, pre-submit proof,
  risk, and the single next button.
- Automode is allowed only when the task explicitly permits it and all required data,
  proof, and confirmation strategy are available.

Manual exams:

- Find a bookable place, prepare a form, stop before submit, and show proof.
  PASSED 2026-06-13 (live, Marbella barbershop): run reaches `waiting_approval`
  in ~50s with a clean proposal card (real target name, the provider URL the
  answer cited), approve triggers preparation that captures a QA-checked proof
  screenshot and commit candidates, and the no-submit boundary blocks final
  commit controls in prepareOnly mode.
- Approve once, submit, and return confirmation or explicit provider failure.
  PASSED 2026-06-13 (live, local safe fixture): approve fills the provider
  form from task-collected inputs (time/email; contact split into
  name/email/phone), captures proof, and commit executes the generic
  external.action.commit tool to `committed` with confirmation evidence
  from the fixture page. Infra note: the commit tool launches its own
  playwright-core browser — the host needs `chromium-headless-shell`
  in the ms-playwright cache (install via the tool package's
  node_modules/.bin/playwright-core).
- Try the same flow in automode on a safe fixture or test provider.

## Phase 5: Reintroduce Tool Builder

Goal: make the builder create tools that match the core package contract and are compared
against the curated core tools.

Deliverables:

- Builder request form becomes human-simple: name, task, docs/files, optional credentials,
  activation policy.
- Builder derives QA from docs/examples when possible.
- Builder has a bounded repair loop after QA failure.
- Generated package must pass the same manual/agent/trace/artifact contract as core tools.
- New generated versions remain disabled unless activation policy and QA allow otherwise.

Manual exams:

- Create a simple API client from docs.
- Create a document/parser tool from a package dependency.
- Create an always-on channel adapter.
- Request an edit from user-level desired behavior, not implementation-level instructions.

## Phase 6: Prune And Simplify

Goal: remove code that the core toolbelt makes unnecessary.

Rules:

- Do not delete a path just because it looks old; first identify the active endpoint,
  UI route, test, database record, or runtime path using it.
- Prefer replacing complex product paths with the same generic tool contract.
- Keep migration/read compatibility only when real persisted data needs it.
- Every deletion must have a test proving the supported path still works.

Initial targets:

- Shrink external-action planning to policy-only logic.
- Move browser/form specifics into `browser.operate` capabilities and tests.
- Remove fixture-only or demo-only builder templates when equivalent core tools exist.
- Collapse approval UI into a smaller state machine after the generic action contract is
  stable.
- Split or delete files that approach the 800-line limit as part of each touched area.

