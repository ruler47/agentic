# Core Toolbelt Reset Roadmap

## Decision

The previous Tool Builder and tool-rework queue are removed from the active product path.
The platform now starts from a stable preinstalled toolbelt and keeps the registry,
schemas, metadata, service lifecycle, and artifact contracts as the public tool boundary.

## Active Base

- `web.search` for web discovery.
- `web.read` for reading pages/resources after discovery.
- `browser.operate` for browser navigation, visible UI observation/clicks across pages
  and embedded frames, extraction, form preparation, screenshots, and external-action
  proof capture.
- `browser.screenshot` for focused proof screenshots on top of `browser.operate`.
- `http.request` for generic API requests.
- `file.read` and `file.write` for local artifact/file work.
- `document.extract` for PDF/DOCX/HTML/text/JSON extraction.
- `data.transform` for deterministic JSON/CSV/text transformation.
- `external.action.prepare` for external-action drafts without submit.
- `external.action.commit` for final commit after approval and an attached executor.
- `channel.telegram` as a first-party always-on messaging bridge.

These tools are registered through `createCoreToolbelt()` and exposed through the same
registry surface future generated tools must use.

Historical `chart.generate`, `market.timeseries`, and `telegram.bot` code can remain as
reference modules while the platform stabilizes, but they are not part of the active
preinstalled toolbelt.

## Current Verification Status

Last checked locally during the reset window on 2026-06-05 through 2026-06-12.

- API smoke passed for `web.search`, `web.read`, `browser.operate`,
  `browser.screenshot`, `http.request`, `file.read`, `file.write`, `document.extract`,
  `data.transform`, `external.action.prepare`, and `external.action.commit`.
- `browser.operate` and `browser.screenshot` were verified against the local
  dockerized browser-operate service through `http://127.0.0.1:18080`.
- `channel.telegram` is reachable through `http://127.0.0.1:18081` and correctly
  reports `failed`/`degraded` when the service is not started. A full Telegram
  start/poll/send smoke still requires a configured bot token and channel context.
- Built-in tools are now synchronized into the versioned metadata table
  (`tool_module_versions`) so the UI can show active versions consistently.
- The React `/tools` page was manually opened through the in-app browser and shows the
  core toolbelt, health badges, schemas, and manual run surface.
- Real agent runs currently verified:
  - `run_1780572493296_codgolq6`: current Ethereum price task used web discovery plus
    browser proof screenshots and returned a completed answer with downloadable proof
    artifacts.
  - `run_1780572930777_sk9unn6r`: explicit `https://example.com` task used
    `browser.operate` to navigate, read, and capture a screenshot artifact.
  - `run_1780575790132_nvmny5ew`: explicit HTTP API task used a deterministic
    `http.request` fast path, called `GET https://jsonplaceholder.typicode.com/todos/2`,
    recorded tool input/output in trace/evidence, passed review on the first attempt, and
    rendered correctly in the React Run Workspace.
  - `run_1780578293347_3ddtqaph`: explicit local utility task used a deterministic
    `document.extract` -> `data.transform` -> `file.write` fast path, did not call
    `web.search` or browser tools, wrote `workspace/reports/core-toolbelt-paid-orders.txt`,
    recorded three work claims/evidence records, and rendered correctly in the React Run
    Workspace.
- Runtime fixes from those runs:
  - Explicit HTTP/API/JSON URL tasks route to `http.request` before `web.read`, do not
    infer unsafe semantic `POST` methods from prose, and no longer request proof
    screenshots unless the user actually asked for one.
  - Explicit local document/data/file tasks route to declared core tools before the
    general planner. The runtime suppresses web search/browser discovery for those
    local-only toolchains so inline HTML/JSON/file work cannot drift into irrelevant web
    research.
  - `jsonplaceholder.typicode.com` is treated as a valid API host, not a fake
    placeholder proof marker.
  - HTTP status codes such as `Status 200` are treated as protocol results, not
    ungrounded product/model specifics.
  - Run stores now treat `completed`, `failed`, and `cancelled` as terminal so late
    events from interrupted work cannot resurrect a failed run.
  - `RUN_IDLE_TIMEOUT_MS` bounds runs that stop making observable progress, and
    `LEARNING_TIMEOUT_MS` makes post-run learning best-effort instead of blocking user
    completion.
- Browser automation fixes from the barbershop/appointment smoke:
  - `browser.operate` `observe` now prioritizes viewport-visible form controls/buttons,
    filters hidden/decorative DOM candidates, and returns safe element metadata
    (`href`, `name`, `inputType`, `placeholder`, `checked`) so agents can inspect forms
    without relying on raw DOM text.
  - `browser.operate` `clickVisible` now supports external-action-safe clicks for
    customer-side preparation. Those clicks skip provider business/admin/software CTAs
    such as `/for-business`, "book a demo", or "list your business" even when they match
    generic text like "Book".
  - Browser artifact QA rejection now feeds URL retry evidence. If the first external
    action page is rejected as provider/business/admin/software proof, the revision
    excludes that URL and can try the next actionable provider candidate in the same run.
  - Rejected browser pages can expose concrete action/provider links from their extracted
    links as retry candidates, while the rejected directory/provider-business branch
    remains excluded.
  - No-tool internal project subtasks now stay no-tool: `requiredTools: []` prevents the
    runtime from inferring `web.search`, `external.action.prepare`, or screenshot calls
    from explanatory prompt text.
  - Internal Agentic project questions such as "what is the preinstalled toolbelt in this
    platform?" are answered from Agentic project context and do not search unrelated
    external product docs.
  - `synthesis-completed` trace events now include a short `detail` preview of the final
    answer so Trace Lab does not render completed synthesis nodes as blank.
  - `dismissDialogs` now waits within its timeout for consent banners that appear after
    navigation or after a click. This fixed Booksy-style late cookie banners blocking the
    next action.
  - `run_1780672223211_9vge1cuh`: an agent barbershop preparation smoke found Memento
    Barbershop on Booksy, navigated with `browser.operate`, captured a QA-passed blocker
    screenshot, created an `external.action.prepare` no-submit boundary, and completed
    with a report that booking could not proceed because Booksy required email/login
    before the final booking form.
  - `run_1780673954275_2pgic7yk`: an internal platform question about the preinstalled
    toolbelt completed with zero tool calls and a filled synthesis trace detail.
  - `run_1780688217090_4ixi8fka`: an external-action smoke against a barbershop-style
    booking task completed with an honest blocker report instead of hallucinating that a
    form was ready. The run used `browser.operate`, captured a proof artifact, and
    reported the login/account boundary as the reason the booking could not continue.

Full verification passed on 2026-06-12 after stale reset-era tests were updated to the
current contracts: `npm run verify` completed typecheck, test types, 531 tests, and
build successfully.

## Next Phases

1. Finish toolbelt-to-agent verification.
   - Add real agent tasks for `file.read`, `file.write`, `document.extract`, and
     `data.transform`, not just direct tool API smoke tests.
   - Confirm trace inputs/outputs show the exact tool versions used for every core tool.
   - Confirm agents receive only available/enabled tools and skip failed service tools.

2. Stabilize external action execution.
   - Use `browser.operate` for preparation/proof and `external.action.prepare` /
     `external.action.commit` for the approval boundary.
   - Treat runtime `external.action.prepare` evidence plus upstream browser
     preparation/proof as the review source of truth for approval drafts, so LLM
     restatements do not block a valid no-submit boundary.
   - Keep final submit unavailable until required fields, proof, executor, and explicit
     approval are all present.
   - Reduce operator steps to one approval for normal approval mode, and zero approvals
     in automode when policy and data are sufficient.

3. Improve agent behavior on top of the stable toolbelt.
   - Better task framing for broad research.
   - Better proof policy: use screenshots/files/links when available, but finish the answer
     even when preferred proof is unavailable.
   - Better continuation/thread context reuse.
   - Better external-action approval/commit UX.

4. Redesign the builder as a separate product layer.
   - Input: user goal, docs/files/URLs, credential handles, desired startup mode, QA
     expectations, and package constraints.
   - Output: portable package/service manifest plus executable code outside Agentic source.
   - Gates: source safety, schema validation, package-local build/test, behavior QA, service
     health, secret redaction, artifact proof.
   - Promotion: register package metadata into the same registry used by the core toolbelt.
   - Rollback: versioned activation with no hidden mutation of existing tools.

5. Only after the new builder is stable, allow agents to request missing tools.
   - The agent should create an explicit capability gap record.
   - The builder should produce a candidate.
   - The original run may retry only after a promoted candidate is available.

## Non-Goals For The Reset

- No automatic builder queue in normal runs.
- No task-specific hardcoded tools.
- No generated source written into tracked app source.
- No hidden rework wait status for normal user runs.
