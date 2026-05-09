# Browser Operate Tool

`browser.operate` is a reusable TypeScript tool for deterministic browser automation.
It is intentionally independent from the agent runtime, runs, traces, UI, and project
domain logic.

## Contract

Capabilities:

- `browser-operate`
- `browser-automation`
- `browser-navigation`
- `dom-extraction`
- `browser-screenshot`
- `artifact-generation`

Input:

```json
{
  "commands": [
    { "type": "navigate", "url": "https://example.com" },
    { "type": "dismissDialogs", "texts": ["Accept cookies"] },
    { "type": "click", "selector": "button" },
    { "type": "fill", "selector": "input[name=q]", "text": "query" },
    { "type": "selectOption", "selector": "select[name=type]", "value": "flight" },
    { "type": "check", "selector": "input[name=direct]" },
    { "type": "waitForText", "text": "Results" },
    { "type": "assertText", "selector": "main", "text": "Results" },
    { "type": "assertUrl", "includes": "example.com" },
    { "type": "extractText", "selector": "main", "label": "results" },
    { "type": "extractLinks", "selector": "main", "label": "result-links" },
    { "type": "screenshot", "label": "proof", "fullPage": true, "maxHeight": 1600 }
  ],
  "storageState": {
    "cookies": [],
    "origins": []
  },
  "defaultTimeoutMs": 10000,
  "viewport": { "width": 1440, "height": 1000 }
}
```

For screenshot-style compatibility, callers may also pass a compact input without
`commands`:

```json
{
  "url": "https://example.com/results",
  "label": "proof",
  "filename": "example-results.png",
  "fullPage": true,
  "maxHeight": 1600
}
```

The tool expands this into a neutral command sequence: navigate, dismiss common dialogs,
extract visible text, and capture a screenshot. This keeps legacy screenshot callers
working while preserving the command-based contract for richer workflows.

Output data:

- `finalUrl`
- `title`
- `steps`
- `extractedText`
- `extractedLinks`
- `screenshots`
- `storageState`

Screenshots are returned as artifact payloads. The agent runtime may persist them and
attach the resulting artifact URLs to the final answer.

Screenshot capture is bounded by default. `screenshot` commands capture the visible
viewport unless `fullPage: true` is explicitly requested. Even then, the tool caps the
image height to a monitor-sized slice (`maxHeight` defaults to 1600px and is clamped to
3000px) so proof artifacts do not become long infinite-scroll pages when the useful
evidence is above the fold.

If a command fails after the page has opened, the tool attempts to capture a diagnostic
screenshot before returning `ok: false`. The caller can persist that screenshot as proof
of a blocker such as CAPTCHA, login wall, unavailable content, or a broken selector.

## Design Rules

- The tool executes commands; it does not decide what to do.
- The tool does not know about flights, crypto, dossiers, or any product-specific flow.
- The tool validates commands before executing them.
- The tool supports returned Playwright storage state, so a caller can preserve cookies
  and localStorage between separate invocations without the tool knowing where state is
  stored.
- The tool returns structured step telemetry for review and debugging.
- The tool favors direct source/result URLs supplied by the caller over brittle homepage
  form automation. Higher-level planners should avoid generic selectors on large public
  sites when a stable route/result URL is available.
- The tool can be moved to another TypeScript project with only the generic `Tool`
  interface or adapted to an npm package boundary.

## Commands

- `navigate`
- `dismissDialogs`
- `click`
- `fill` / `type`
- `selectOption`
- `check` / `uncheck`
- `press`
- `waitForSelector`
- `waitForText`
- `wait`
- `scroll`
- `extractText`
- `extractLinks`
- `assertText`
- `assertUrl`
- `screenshot`

## Current Limitations

- The tool returns `storageState`; persistence is left to the caller so the module remains
  portable.
- `dismissDialogs` uses generic selectors/texts. Site-specific login, CAPTCHA, payment,
  or MFA flows still need a caller-provided command sequence or a specialized higher-level
  module.
- Artifact QA is outside the portable browser tool. The agent runtime currently runs
  deterministic visual and semantic checks before storing browser screenshots. The
  semantic gate classifies the task's expected evidence contract (for example product
  proof, flight-search proof, translation proof, profile proof, or general web proof) and
  compares it with observed URL/title/text/link evidence. This keeps the browser module
  generic while still rejecting loader/blocker pages and task-mismatched proof artifacts.
