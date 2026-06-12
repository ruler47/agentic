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
    {
      "type": "fillFormSemantically",
      "goal": "prepare an appointment without submitting",
      "valuesText": "Test User, test@example.com, +34 600 000 000, haircut after 17:00",
      "allowContinue": true,
      "allowPolicyConsent": false,
      "submit": false
    },
    { "type": "selectOption", "selector": "select[name=type]", "value": "flight" },
    { "type": "check", "selector": "input[name=direct]" },
    { "type": "waitForText", "text": "Results" },
    { "type": "assertText", "selector": "main", "text": "Results" },
    { "type": "assertUrl", "includes": "example.com" },
    { "type": "extractText", "selector": "main", "label": "results" },
    { "type": "extractLinks", "selector": "main", "label": "result-links" },
    { "type": "screenshot", "label": "proof", "fullPage": true }
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
  "fullPage": true
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
- `observations`
- `formFills`
- `screenshots`
- `storageState`

`observe` returns visible, actionable element candidates across the main document and
embedded frames. It filters decorative image/presentation nodes and elements hidden by
`hidden`, `aria-hidden`, or `inert` ancestors. Returned candidates include coordinates,
`frameIndex`, `frameUrl`, and safe metadata such as `href`, form `name`, `inputType`,
`placeholder`, and checkbox/radio `checked`. It intentionally does not return current
form values so traces do not duplicate personal data beyond the explicit tool input and
proof screenshot.

Screenshots are returned as artifact payloads. The agent runtime may persist them and
attach the resulting artifact URLs to the final answer.

`fillFormSemantically` is a bounded safe-preparation helper for external-action drafts.
It maps labels, placeholders, names, and nearby text to explicit task values, records a
structured form-fill report, and can click safe progress controls such as Next/Continue.
It does not submit, confirm, pay, send, or bypass account/login/CAPTCHA walls. Provider
directory search boxes such as "services or businesses" are skipped. When weak SPA
markup hides progress buttons from the form DOM, the command may use the visible action
observer as a fallback; social/account controls such as "continue with Google/Facebook/
Apple" are treated as a blocker and not clicked.

`clickVisible` accepts `externalActionSafe` for customer-side external action
preparation. In that mode, it skips provider onboarding/admin/software controls such as
`/for-business`, `/industries`, `/solutions`, `/features`, "book a demo",
pricing/software links, and "list your business" so a generic "Book" search does not
leave the customer booking flow.

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
- `dismissDialogs` is generic and bounded: it polls during its timeout for common consent
  controls that appear after navigation or after a click, then returns the clicked target
  in step telemetry.
- The tool favors direct source/result URLs supplied by the caller over brittle homepage
  form automation. Higher-level planners should avoid generic selectors on large public
  sites when a stable route/result URL is available.
- The tool can be moved to another TypeScript project with only the generic `Tool`
  interface or adapted to an npm package boundary.

## Commands

- `navigate`
- `dismissDialogs`
- `click`
- `clickVisible`
- `observe`
- `fillFormSemantically`
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
- Public appointment sites may still require an account after service/time preparation.
  The tool should expose that boundary through text, observations, screenshots, and
  step telemetry; the agent should report the blocker instead of claiming a completed
  external booking.
- Artifact QA is outside the portable browser tool. The agent runtime currently runs
  deterministic visual and semantic checks before storing browser screenshots, using the
  screenshot pixels plus browser URL/title/text/link context to reject loader/blocker or
  task-mismatched evidence.
