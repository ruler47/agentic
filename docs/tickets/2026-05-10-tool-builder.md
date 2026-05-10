# Tool-builder pipeline — issues found in 2026-05-10 stress run

End-to-end test sequence:
1. Submit `POST /api/tool-build-requests` for `capability=web-search-duckduckgo`.
2. Wait for `registered`.
3. Inspect generated tool, run it manually, ask the agent to use it.
4. Repeat in parallel for 3 unrelated capabilities (weather / github / translate)
   to stress the parallel-build path.

The pipeline does build 4/4 tools, register them as healthy, and serve
manual `POST /api/tools/:name/run` calls in ~1s. Two issues are already
fixed in the same session; three remain open and tracked here.

---

## TB-001 — Tool builder picks wrong provider for clearly-not-document requests · **FIXED**

**Symptom.** A request to build a DuckDuckGo search tool produced a
PDF/document renderer (`web.duckduckgo` registered with capabilities
`["web-search-duckduckgo", "document-generation", "pdf-generation",
"artifact-generation"]` and a markdown→PDF input schema).

**Root cause.** `DocumentArtifactToolBuildProvider.canBuild` regex
`\b(pdf|document|report|docx|markdown|html)\b` matched the bare word
`html` inside `https://html.duckduckgo.com/html/?q=…` in the
`taskSummary`. Every web-search request mentioning an HTML endpoint
was silently misclassified as a document generator.

**Fix (commit `5820a00`).**
* Tightened the regex: now requires either an explicit `pdf|docx`
  format keyword, a `*-generation` suffix, or a verb-noun phrase
  (`generate/render/build/export/create document/report/pdf/...`).
* Re-ordered providers in `runtime-workers.module.ts` so most-specific
  shapes win first: `BrowserScreenshot → Messaging → GenericApi →
  DocumentArtifact → GenericService → Llm` (was: …Document → Generic-
  Service → GenericApi…).
* Regression: `tests/toolBuildProviderSelection.test.ts` (5 cases).

---

## TB-002 — Provider order didn't try most-specific first · **FIXED**

Bundled with TB-001 (same commit). The general "produces a document"
provider tried before the specific "calls an HTTP/REST API" provider,
so even after a tighter regex the wrong provider could still steal an
ambiguous request. Order now sorted by specificity.

---

## TB-003 — No domain-specific search provider · **OPEN, low priority**

**Symptom.** With TB-001 fixed, `web.duckduckgo` is now generated as a
`GenericApiToolBuildProvider` output: capabilities `["web-search-
duckduckgo", "api-http-json", "http-api-call"]`, schema `{url, method,
query, body, ...}`. Running it returns the raw HTML of
`https://html.duckduckgo.com/html/`, NOT a parsed `[{title, url,
snippet}]` array as the request asked for.

**Root cause.** `GenericApiToolBuildProvider` is a generic HTTP wrapper
template. It doesn't know how to parse search-engine responses, so it
delivers the bytes and lets the caller figure it out.

**Decision.** Don't fix as a new provider. The agent that consumes
this tool should chain `web.duckduckgo` → an `extractText` /
parsing step (browser.operate already does this for HTML). Adding a
"search-results-parser" provider for every site would balloon the
provider matrix. If the agent repeatedly fails to extract structure,
escalate to a per-site provider then.

**Mitigation.** Builder agent should at minimum embed a comment in the
generated tool explaining "this is a raw HTTP wrapper — parse the
response in the caller". Currently the docs markdown does say "JSON
API adapter" which implies parsing happens elsewhere; that's already
honest, just not loud enough.

---

## TB-004 — Builder doesn't reject mismatching outputs vs schema · **OPEN, medium priority**

**Symptom.** The original `web-search-duckduckgo` request listed
`requiredOutputs: ["results"]`. The PDF-document provider that
mistakenly claimed it produced an output schema with no `results`
field. The QA pass and the activate step still succeeded.

**Root cause.** The QA reviewers (`DeterministicToolCodeReviewer`,
`DeterministicToolBehaviorReviewer`, optional LLM reviewers) check
that the tool RUNS and parses, but don't verify that the
`outputSchema.properties` actually covers the request's
`requiredOutputs`.

**Decision.** Add a deterministic check `verifyOutputCoversRequired`
to `DeterministicToolCodeReviewer`: every `request.requiredOutputs[]`
name must appear in `output.outputSchema.properties` (case-insensitive
match against `properties` keys + their `title`s). Failure → reviewer
returns `needs_revision`. Cheap, deterministic, catches "wrong
provider" mismatches that survived TB-001/TB-002.

**Status.** Not implemented in this session — separate ticket.

---

## TB-005 — Agent ignores user's explicit tool-restriction directive · **OPEN, high priority**

**Symptom.** Task body was: *"Used web.duckduckgo to find … . Don't
use web.search."* The plan still scheduled work that called
`web.search` first, then `browser.operate` — never `web.duckduckgo`.
Synthesizer wrote in the final answer:

> *"Process Note: The previous research attempt was flagged as
> non-compliant because it utilized `web.search` instead of the
> strictly requested `web.duckduckgo`."*

So the LLM is aware of the violation post-hoc but the planner /
worker pipeline didn't honour the constraint at planning time.

**Root cause.** Planning prompt doesn't extract user-imposed tool
constraints into `toolPolicy.deniedToolNames` /
`toolPolicy.preferredToolNames`. The discovery loop has hardcoded
`webSearch = this.tools.findByCapability("web-search")[0]` — that
returns the built-in `web.search` first, regardless of any user
preference. `web.duckduckgo` has capability `web-search-duckduckgo`,
not `web-search`, so it's not even a candidate.

**Decision.** Two-step fix:
1. **Planning prompt change**: extract tool-constraints from task
   body. Phrases like "don't use X", "use only X", "Use X to do Y"
   should populate the AgentStrategyDecision.toolPolicy with allowed
   / denied tool names. Soft directive — LLM-driven but emitted into
   structured policy that the worker respects.
2. **Capability prefix matching**: When the agent looks up a
   capability like `web-search`, it should also consider tools with
   `web-search-*` prefixes. So a user-built `web.duckduckgo` (cap
   `web-search-duckduckgo`) becomes a candidate when the agent needs
   `web-search`.

Both are sizeable; ticket left open. Step 1 alone addresses the user-
visible issue; step 2 addresses generic discoverability.

---

## TB-006 — Generated tools are HTTP wrappers without domain inputs · **OPEN, low priority**

**Symptom.** All 4 tools generated in this session (web.duckduckgo,
weather.current, github.repo, text.translate) have the same generic
input schema `{url, method, query, body, headers, secretHandle, ...}`.
The agent has to know "for github.repo, call
`https://api.github.com/repos/{owner}/{repo}` with method=GET" — that
information is in the docs markdown, but not in the input schema.

**Root cause.** Same as TB-003 — GenericApi provider builds a
universal HTTP shape. The request's `requiredInputs: ["owner",
"repo"]` is ignored at schema-generation time.

**Decision.** Builder should generate a domain-specific input wrapper
on top of the HTTP wrapper: `{owner, repo}` → internally formats the
URL `…/repos/{owner}/{repo}` and calls the wrapper. This is in
practice what the LLM provider would generate; non-LLM providers
don't.

**Status.** Open. Workaround: enable `LlmToolBuildProvider` in the
provider list so the LLM tailors the schema to the actual domain. The
GenericApi fallback is acceptable as a "raw HTTP escape hatch" but
shouldn't be the default for well-described requests.

---

## Stress test summary

| Metric | Value |
|---|---|
| Parallel build requests | 3 (weather / github / translate) |
| Wall time to all `registered` | ~3 minutes |
| All tools healthy after register | yes (4/4 with `web.duckduckgo`) |
| Manual run latency | ~1 second / call |
| QA failures | 0 |
| Provider re-classification needed | 0 (after TB-001/002 fix) |

The pipeline is functionally stable for the build-and-register part.
The gaps are between request semantics and what providers deliver
(TB-003, TB-004, TB-006), and between user intent and tool selection
in the consuming agent (TB-005).
