import test from "node:test";
import assert from "node:assert/strict";
import { __testing__ } from "../src/agents/universalAgent.js";

const {
  guardSearchQueryAgainstUngroundedSpecifics,
  guardDeclaredToolInputAgainstUngroundedSpecifics,
  getExplicitToolInputString,
  buildRuntimeDateGroundingText,
  buildExternalActionBlockerFinalAnswer,
  selectBestUrlsForArtifact,
  parseForbiddenTokensFromReviewNotes,
  geoBiasScore,
  getAllWorkerArtifacts,
  getApprovedArtifacts,
  improveDeclaredToolInput,
  isShallowLandingUrl,
  isLowValueProofUrl,
  findUngroundedSpecificsInText,
  containsPlaceholderProof,
  buildInternalProjectKnowledgeFastPathSubtasks,
  buildLocalUtilityToolchainFastPathSubtasks,
  buildExternalActionFastPathSubtasks,
  buildExternalActionSearchQuery,
  hasActionableExternalActionDiscoveryEvidence,
  hasPreparedExternalActionBoundary,
  hasBlockedExternalActionPreparationBoundary,
  detectExternalActionPreparationBlocker,
  hardGateReview,
  rankExternalActionCandidateUrls,
  extractExternalActionCandidateLinksFromBrowserData,
  extractHttpUrls,
  isExternalActionIneligibleUrl,
  buildFallbackResearchSubtasks,
  buildClassificationContext,
  buildCompactSynthesisFallback,
  isContextWindowError,
  isRecoverableWorkerModelError,
  hasCollectedToolEvidence,
  buildWorkerModelFailureFallbackOutput,
  isWorkerModelFailureFallback,
  subtaskExpectsInteractiveBrowserProof,
  shouldCollectBrowserDiscovery,
  buildSearchQueries,
  extractSearchDomains,
  buildMarketAwareSearchQuery,
  inferMarketSearchHints,
  assessSearchEvidenceForReuse,
  inferLocalUtilityToolchainPlan,
  isLocalUtilityToolchainSubtask,
} = __testing__;

test("explicit web.search tool input preserves the user search intent", () => {
  const subtask = {
    id: "current-fact-with-proof",
    title: "Find current fact and capture proof evidence",
    role: "research evidence worker",
    prompt:
      "User question: Какая сейчас цена биткоина в USD?\n" +
      "Search the web for the current answer to that user question.",
    expectedOutput: "A concise current answer with source name and source URL.",
    reviewCriteria: [],
    requiredTools: ["web-search"],
    toolInputs: {
      "web.search": {
        query: "Какая сейчас цена биткоина в USD?",
        limit: 5,
      },
    },
  };

  assert.equal(getExplicitToolInputString(subtask, "web.search", "query"), "Какая сейчас цена биткоина в USD?");
});

test("market-aware search query carries profile location and currency hints", () => {
  const context = [
    "Task: найди лучший компактный ноутбук до 2500 долларов",
    "Instance and requester context:",
    "Group description: You are a family assistant. The family lives in Spain, Marbella.",
    "Runtime: current_date=2026-06-04; time_zone=Europe/Madrid",
  ].join("\n");
  const primary = "найди лучший компактный ноутбук до 2500 долларов";

  assert.deepEqual(inferMarketSearchHints(context), ["Spain", "Marbella", "USD"]);
  assert.equal(
    buildMarketAwareSearchQuery(primary, context),
    "найди лучший компактный ноутбук до 2500 долларов Spain Marbella USD",
  );
});

test("market hints ignore currency-normalization words", () => {
  const context = "Find a laptop in Spain with USD budget converted to EUR for Marbella.";
  assert.deepEqual(inferMarketSearchHints(context), ["Spain", "USD", "EUR"]);
});

test("buildSearchQueries keeps primary and market-aware queries separate", () => {
  const queries = buildSearchQueries(
    {
      id: "research",
      title: "Find purchase options",
      role: "researcher",
      prompt: "найди лучший компактный ноутбук до 2500 долларов",
      expectedOutput: "",
      reviewCriteria: [],
      requiredTools: ["web-search"],
    },
    "Group description: The family lives in Spain, Marbella.",
  );

  assert.equal(queries.length, 2);
  assert.match(queries[1]!, /Spain/);
  assert.match(queries[1]!, /USD/);
});

test("buildSearchQueries preserves explicit source domains as site-filtered queries", () => {
  const queries = buildSearchQueries(
    {
      id: "search",
      title: "Search for high-performance laptops in Spain under $2500",
      role: "researcher",
      prompt:
        "Search for the best high-performance laptops available in Spain (use .es domains like amazon.es, pccomponentes.com, mediamarkt.es) suitable for programming, local LLMs, and gaming.",
      expectedOutput: "",
      reviewCriteria: [],
      requiredTools: ["web-search"],
    },
    "Group description: The family lives in Spain, Marbella.",
  );

  assert.ok(queries.some((query) => query.includes("site:amazon.es")));
  assert.ok(queries.some((query) => query.includes("site:pccomponentes.com")));
  assert.ok(queries.some((query) => query.includes("site:mediamarkt.es")));
});

test("domain-aware search ignores email fragments and tool pseudo-domains", () => {
  const context = [
    "Client: Ivan Test <ivan.test@example.com>",
    "Available tools: web.search, web.read, browser.operate, external.action.prepare",
    "Preferred real providers: booksy.com, fresha.com",
  ].join("\n");

  assert.deepEqual(extractSearchDomains(context), ["booksy.com", "fresha.com"]);
});

test("search evidence quality marks market-mismatched sources as partial", () => {
  const quality = assessSearchEvidenceForReuse(
    [
      "Results:",
      "- 11 лучших бюджетных игровых ноутбуков — https://www.kp.ru/expert/elektronika/luchshie-byudzhetnye-igrovye-noutbuki/",
      "цены до 60000 рублей",
    ].join("\n"),
    "best compact laptop under 2500 USD Spain Marbella",
  );

  assert.equal(quality.qaStatus, "partial");
  assert.ok(quality.confidence < 0.6);
  assert.match(quality.limitations.join("\n"), /Spain|Marbella|USD|currency/i);
});

test("URL host fallback does not self-match against search result snippets", () => {
  const evidenceText = [
    "1. Bitcoin price today",
    "https://www.coindesk.com/ru/price/bitcoin",
    "Realtime Bitcoin market data.",
    "2. Metal Baffle Ceiling - SPIRO",
    "https://spiro.co.il/en/2018/12/23/metal-baffle-ceiling-lmd-l-608-2/",
    "This page is about ceilings, not Bitcoin.",
  ].join("\n");

  const selected = selectBestUrlsForArtifact(
    evidenceText,
    4,
    ["market-research"],
    [],
    [],
    "User question: Какая сейчас цена биткоина в USD?",
  );

  assert.deepEqual(selected, []);
});

test("URL host fallback prefers concrete detail pages over listing pages for product evidence", () => {
  const evidenceText = [
    "Search results:",
    "- Amazon category — https://www.amazon.es/-/en/Laptops-Discounts-Computers/s?rh=n%3A938008031",
    "- PCComponentes product — https://www.pccomponentes.com/lenovo-legion-pro-5i-16irx9.html",
    "- Amazon used laptops — https://www.amazon.es/-/en/Laptops-Used-Computers/s?rh=n%3A938008031",
  ].join("\n");

  const selected = selectBestUrlsForArtifact(
    evidenceText,
    2,
    ["product-comparison"],
    [],
    [],
    "Compare laptops from amazon.es and pccomponentes.com with proof screenshots.",
  );

  assert.equal(selected[0], "https://www.pccomponentes.com/lenovo-legion-pro-5i-16irx9.html");
});

test("worker model timeout becomes a degraded evidence handoff", () => {
  const evidence = {
    text: "External tool evidence collected for this subtask:\nSource A says the booking page exists.",
    evidence: ["Source A: https://example.com/book"],
    records: [],
    artifacts: [
      {
        id: "artifact_1",
        runId: "run_1",
        filename: "proof.png",
        mimeType: "image/png",
        sizeBytes: 123,
        url: "/api/artifacts/artifact_1/download",
        kind: "output" as const,
        createdAt: "2026-06-04T00:00:00.000Z",
      },
    ],
  };

  const error = new Error("LLM request failed for all model candidates: qwen: LLM request timed out after 45000ms");
  assert.equal(isRecoverableWorkerModelError(error), true);
  assert.equal(hasCollectedToolEvidence(evidence), true);

  const output = buildWorkerModelFailureFallbackOutput(
    {
      id: "research",
      title: "Research booking option",
      role: "researcher",
      prompt: "Find a booking page.",
      expectedOutput: "Evidence-backed result.",
      reviewCriteria: [],
    },
    evidence,
    error,
  );

  assert.equal(isWorkerModelFailureFallback({ subtask: {
    id: "research",
    title: "Research booking option",
    role: "researcher",
    prompt: "Find a booking page.",
    expectedOutput: "Evidence-backed result.",
    reviewCriteria: [],
  }, output }), true);
  assert.match(output, /runtime:model-synthesis-degraded/);
  assert.match(output, /https:\/\/example\.com\/book/);
  assert.match(output, /proof\.png/);
});

test("interactive form subtasks require browser-session proof", () => {
  assert.equal(
    subtaskExpectsInteractiveBrowserProof({
      id: "prepare-booking",
      title: "Prepare booking draft",
      role: "operator",
      prompt: "Fill the appointment form and capture a screenshot before submission.",
      expectedOutput: "Filled form proof.",
      reviewCriteria: ["Form fields are correctly filled."],
      requiredTools: ["browser-operate", "browser-screenshot"],
      requiredArtifacts: [
        {
          kind: "screenshot",
          capability: "browser-screenshot",
          description: "Screenshot of the filled booking form.",
        },
      ],
      toolInputs: {
        "browser.operate": {
          commands: [
            { type: "navigate", url: "https://example.com/book" },
            { type: "fill", selector: "input[name='name']", value: "Ivan Test" },
            { type: "screenshot", label: "filled-form" },
          ],
        },
      },
    }),
    true,
  );

  assert.equal(
    subtaskExpectsInteractiveBrowserProof({
      id: "research",
      title: "Capture source page",
      role: "researcher",
      prompt: "Capture a proof screenshot of the source page.",
      expectedOutput: "Screenshot proof.",
      reviewCriteria: [],
      requiredArtifacts: [
        {
          kind: "screenshot",
          capability: "browser-screenshot",
          description: "Screenshot of source page.",
        },
      ],
    }),
    false,
  );
});

// Bug 2: pre-call ungrounded-gate on search query.
test("guardSearchQueryAgainstUngroundedSpecifics strips planner-injected hallucinated specifics", () => {
  const query = "best laptop RTX 4080 with 12GB VRAM under 2500 USD for LLM development";
  const userTask = "найди мне лучший ноутбук с бюджетом в 2500 долларов для LLM-разработки в Испании";
  const cleaned = guardSearchQueryAgainstUngroundedSpecifics(query, userTask);
  assert.ok(!/RTX\s*4080/i.test(cleaned), `RTX 4080 should be stripped: ${cleaned}`);
  // Generic terms remain.
  assert.ok(/laptop/i.test(cleaned));
  assert.ok(/LLM/i.test(cleaned));
});

test("guardSearchQueryAgainstUngroundedSpecifics keeps the query untouched when nothing is ungrounded", () => {
  const query = "best laptop for LLM development under 2500 USD in Spain";
  const userTask = "best laptop for LLM development under 2500 USD in Spain";
  assert.equal(guardSearchQueryAgainstUngroundedSpecifics(query, userTask), query);
});

test("ungrounded specifics ignore source name followed by day-of-month prose", () => {
  const output =
    "Текущая цена Ethereum составляет $1,734.73 USD согласно данным CoinMarketCap на 4 июня 2026 г.";
  const evidence =
    "CoinMarketCap Ethereum price ETH USD $1,734.73 2026 June";
  assert.deepEqual(findUngroundedSpecificsInText(output, evidence), []);
});

test("ungrounded specifics ignore protocol status codes", () => {
  const output = "The HTTP request was successful with Status 200.";
  const evidence = "HTTP 200\n{\"userId\":1,\"id\":1}";
  assert.deepEqual(findUngroundedSpecificsInText(output, evidence), []);
});

test("ungrounded specifics ignore numbered structural evidence labels", () => {
  const output = [
    "Evidence 1: Booksy result says online appointment is available.",
    "Evidence 2: Fresha result lists Marbella barbers.",
    "Step 3: compare providers.",
  ].join("\n");
  const evidence = "Booksy result online appointment available. Fresha result Marbella barbers.";

  assert.deepEqual(findUngroundedSpecificsInText(output, evidence), []);
});

test("runtime date grounding text grounds current date prose without broad evidence", () => {
  const evidence = buildRuntimeDateGroundingText(new Date("2026-06-05T12:00:00.000Z"));

  assert.deepEqual(findUngroundedSpecificsInText("The run started on Friday, June 5, 2026.", evidence), []);
});

test("jsonplaceholder API URLs are not stripped as fake proof placeholders", () => {
  assert.equal(containsPlaceholderProof("GET https://jsonplaceholder.typicode.com/todos/1"), false);
  assert.equal(containsPlaceholderProof("Screenshot saved as https://screenshot-capture.placeholder/image.png"), true);
});

test("internal project knowledge questions do not use external web research", () => {
  const subtasks = buildInternalProjectKnowledgeFastPathSubtasks(
    "Ответь одним коротким предложением: что такое preinstalled toolbelt в этой платформе?",
  );

  assert.equal(subtasks?.length, 1);
  assert.deepEqual(subtasks?.[0]?.requiredTools, []);
  assert.match(subtasks?.[0]?.prompt ?? "", /Use only the Agentic project context/);
  assert.match(subtasks?.[0]?.prompt ?? "", /web\.search, web\.read, browser\.operate/);
  assert.doesNotMatch(JSON.stringify(subtasks?.[0]?.toolInputs ?? {}), /web\.search|web-search/);
});

test("explicit local document/data/file tasks build a deterministic core-toolchain plan", () => {
  const task =
    "Use document.extract, data.transform, and file.write on inline HTML " +
    "'<html><body><script type=\"application/json\">[" +
    "{\"name\":\"Ana\",\"status\":\"paid\",\"total\":120}," +
    "{\"name\":\"Bo\",\"status\":\"open\",\"total\":20}," +
    "{\"name\":\"Cy\",\"status\":\"paid\",\"total\":75}" +
    "]</script></body></html>'. Filter paid rows, sort by total desc, template name: total, and write reports/core-toolbelt-paid-orders.txt";

  const subtasks = buildLocalUtilityToolchainFastPathSubtasks(task, () => true);
  assert.equal(subtasks?.length, 1);
  assert.deepEqual(subtasks?.[0]?.requiredTools, ["document.extract", "data.transform", "file.write"]);
  assert.equal(isLocalUtilityToolchainSubtask(subtasks![0] as never), true);
  assert.equal(subtasks?.[0]?.toolInputs?.["file.write"] && typeof subtasks[0].toolInputs["file.write"], "object");
  assert.deepEqual(subtasks?.[0]?.toolInputs?.["file.write"], {
    path: "reports/core-toolbelt-paid-orders.txt",
    content: "Ana: 120\nCy: 75",
  });
  assert.deepEqual((subtasks?.[0]?.toolInputs?.["data.transform"] as { operations: unknown[] }).operations, [
    { type: "filter", path: "status", equals: "paid" },
    { type: "sort", path: "total", direction: "desc" },
    { type: "template", template: "{name}: {total}" },
  ]);
});

test("local toolchain fast path does not plan when required core tools are missing", () => {
  const task = "Use data.transform and file.write for [{\"name\":\"Ana\",\"status\":\"paid\",\"total\":120}] and write reports/out.txt";
  const subtasks = buildLocalUtilityToolchainFastPathSubtasks(task, (toolName) => toolName !== "file.write");
  assert.equal(subtasks, undefined);
  assert.ok(inferLocalUtilityToolchainPlan(task));
});

test("fallback research plan uses available core tools and optional screenshot proof", () => {
  const withScreenshot = buildFallbackResearchSubtasks("найди лучший ноутбук до 2500", (toolName) =>
    ["web.search", "web.read", "browser.screenshot"].includes(toolName),
  );

  assert.equal(withScreenshot.length, 3);
  assert.deepEqual(withScreenshot[0]?.requiredTools, ["web-search", "web-read"]);
  assert.deepEqual(withScreenshot[1]?.dependsOn, ["research-evidence"]);
  assert.deepEqual(withScreenshot[1]?.requiredTools, ["browser-screenshot"]);
  assert.equal(withScreenshot[1]?.requiredArtifacts?.[0]?.required, false);
  assert.deepEqual(withScreenshot[2]?.dependsOn, ["research-evidence", "proof-screenshot"]);

  const withoutScreenshot = buildFallbackResearchSubtasks("найди лучший ноутбук до 2500", (toolName) =>
    ["web.search", "web.read"].includes(toolName),
  );

  assert.deepEqual(withoutScreenshot[1]?.requiredTools, []);
  assert.deepEqual(withoutScreenshot[1]?.requiredArtifacts, []);
});

test("external action fast path plans discovery, browser preparation, approval draft, and report", () => {
  const task =
    "Найди хороший барбершоп в Марбелье и подготовь запись на стрижку после 17:00. Dimitrii Test +34617789419 test@example.com. Не отправляй финальную запись без подтверждения.";
  const subtasks = buildExternalActionFastPathSubtasks(task, (toolName) =>
    ["web.search", "web.read", "browser.operate", "external.action.prepare"].includes(toolName),
  );

  assert.ok(subtasks);
  assert.equal(subtasks.length, 4);
  assert.equal(subtasks[0]?.id, "external-action-source-discovery");
  assert.equal(subtasks[1]?.id, "external-action-browser-preparation");
  assert.deepEqual(subtasks[1]?.dependsOn, ["external-action-source-discovery"]);
  assert.deepEqual(subtasks[1]?.requiredTools, ["browser-operate"]);
  assert.equal(subtasks[1]?.requiredArtifacts?.[0]?.required, true);
  assert.match(subtasks[1]?.requiredArtifacts?.[0]?.description ?? "", /pre-submit|blocker/i);
  assert.ok(subtasks[2]?.requiredTools?.includes("external-action-prepare"));

  const query = buildExternalActionSearchQuery(task);
  assert.match(query, /barbershop/i);
  assert.match(query, /Марбелье/i);
  assert.match(query, /online booking/i);
  assert.doesNotMatch(query, /617789419|test@example\.com|Dimitrii/i);
  assert.match(buildExternalActionSearchQuery(task, "Group description: The family lives in Spain, Marbella."), /Marbella/i);
  assert.doesNotMatch(subtasks[0]?.prompt ?? "", /test@example\.com|617789419|proof-скриншот/i);
});

test("interactive browser input keeps action commands when URL is rewritten from evidence", () => {
  const subtask = {
    id: "external-action-browser-preparation",
    title: "Prepare the external action in the browser without final submit",
    role: "browser action preparer",
    prompt: "Use the best concrete provider/action URL from upstream evidence.",
    expectedOutput: "Prepared browser state with pre-submit proof.",
    reviewCriteria: ["Do not submit externally."],
    requiredTools: ["browser-operate"],
    toolInputs: {},
    requiredArtifacts: [],
  };
  const input = {
    commands: [
      { type: "navigate", url: "URL_FROM_UPSTREAM_DISCOVERY" },
      { type: "dismissDialogs" },
      { type: "clickVisible", text: "Book", optional: true },
      { type: "observe", label: "prepared-visible-controls" },
      { type: "screenshot", label: "external-action-pre-submit-proof", fullPage: false },
    ],
  };
  const result = improveDeclaredToolInput("browser.operate", input, subtask, [
    "Social result: https://www.instagram.com/alohabarber.shop/?hl=en",
    "Instagram profile for a barber shop.",
    "Best result: https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella",
    "Book online appointments for Memento Barbershop in Marbella.",
  ]) as typeof input;

  assert.equal(
    result.commands[0]?.url,
    "https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella",
  );
  assert.deepEqual(result.commands.map((command) => command.type), [
    "navigate",
    "dismissDialogs",
    "clickVisible",
    "observe",
    "screenshot",
  ]);
});

test("interactive browser input prefers provider action pages over booking-platform listings", () => {
  const subtask = {
    id: "external-action-browser-preparation",
    title: "Prepare the external action in the browser without final submit",
    role: "browser action preparer",
    prompt: "Use the best concrete provider/action URL from upstream evidence.",
    expectedOutput: "Prepared browser state with pre-submit proof.",
    reviewCriteria: ["Do not submit externally."],
    requiredTools: ["browser-operate"],
    toolInputs: {},
    requiredArtifacts: [],
  };
  const input = {
    commands: [
      { type: "navigate", url: "URL_FROM_UPSTREAM_DISCOVERY" },
      { type: "clickVisible", text: "Book", optional: true },
      { type: "screenshot", label: "external-action-pre-submit-proof", fullPage: false },
    ],
  };
  const result = improveDeclaredToolInput("browser.operate", input, subtask, [
    "Directory result: https://www.fresha.com/lp/en/bt/barbershops/in/es-marbella-andalusia",
    "Book online with the best Barbers near you in Marbella. Compare providers.",
    "Provider result: https://booksy.com/es-es/34152_groomers-ballers_barberia_29260_marbella",
    "Groomers & Ballers - Marbella - Book Online - Prices, Reviews, Photos. Open appointments online 24/7.",
  ]) as typeof input;

  assert.equal(result.commands[0]?.url, "https://booksy.com/es-es/34152_groomers-ballers_barberia_29260_marbella");
});

test("interactive browser placeholder navigation falls back to official provider homepages", () => {
  const subtask = {
    id: "external-action-browser-preparation",
    title: "Prepare the external action in the browser without final submit",
    role: "browser action preparer",
    prompt: "Use the best concrete provider/action URL from upstream evidence and prepare appointment booking proof.",
    expectedOutput: "Prepared browser state or blocker screenshot.",
    reviewCriteria: ["Do not submit externally."],
    requiredTools: ["browser-operate"],
    toolInputs: {},
    requiredArtifacts: [{ kind: "screenshot" as const, capability: "browser-screenshot", description: "Proof screenshot.", required: true }],
  };
  const input = {
    commands: [
      { type: "navigate", url: "URL_FROM_UPSTREAM_DISCOVERY" },
      { type: "extractText", label: "page", maxLength: 1000 },
      { type: "screenshot", label: "proof" },
    ],
  };
  const result = improveDeclaredToolInput("browser.operate", input, subtask, [
    "1. Legendary Barber Club | Marbella",
    "https://legendarybarberclub.com/",
    "Premium barbershop in Marbella. Book your appointment today.",
    "2. ATELIER MARBELLA",
    "https://www.ateliermarbella.com/",
    "Official barbershop website with services and booking.",
  ]) as typeof input;

  assert.notEqual(result.commands[0]?.url, "URL_FROM_UPSTREAM_DISCOVERY");
  assert.match(result.commands[0]?.url ?? "", /^https:\/\/(?:legendarybarberclub\.com|www\.ateliermarbella\.com)\//);
});

test("interactive browser input does not repeat a rejected action URL when no alternative exists", () => {
  const subtask = {
    id: "external-action-browser-preparation",
    title: "Prepare the external action in the browser without final submit",
    role: "browser action preparer",
    prompt: "Use the best concrete provider/action URL from upstream evidence.",
    expectedOutput: "Prepared browser state with pre-submit proof.",
    reviewCriteria: ["Do not submit externally."],
    requiredTools: ["browser-operate"],
    toolInputs: {},
    requiredArtifacts: [],
  };
  const input = {
    commands: [
      { type: "navigate", url: "URL_FROM_UPSTREAM_DISCOVERY" },
      { type: "clickVisible", text: "Book", optional: true },
      { type: "screenshot", label: "external-action-pre-submit-proof", fullPage: false },
    ],
  };
  const result = improveDeclaredToolInput("browser.operate", input, subtask, [
    "Rejected browser URL: https://www.fresha.com/lp/en/bt/barbershops/in/es-marbella-andalusia",
    "Rejected screenshot artifact proof.png: Browser artifact is on a provider business/admin/software landing page.",
    "Directory result: https://www.fresha.com/lp/en/bt/barbershops/in/es-marbella-andalusia",
    "Book online with the best Barbers near you in Marbella. Compare providers.",
  ]) as typeof input;

  assert.equal(result.commands[0]?.url, "URL_FROM_UPSTREAM_DISCOVERY");
});

test("external action URL ranking rejects provider business landing pages", () => {
  const urls = [
    "https://www.fresha.com/for-business",
    "https://www.setmore.com/industries/barber-shops",
    "https://www.fresha.com/lp/en/bt/barbershops/in/es-marbella-andalusia",
    "https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella",
  ];
  const ranked = rankExternalActionCandidateUrls(
    urls,
    [
      "Fresha for business salon booking software: https://www.fresha.com/for-business",
      "Setmore barber shop industry software landing: https://www.setmore.com/industries/barber-shops",
      "Directory result: https://www.fresha.com/lp/en/bt/barbershops/in/es-marbella-andalusia",
      "Provider result: https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella",
      "Memento Barbershop Book Online appointments in Marbella.",
    ].join("\n"),
    "Prepare booking appointment proof before submit.",
  );

  assert.equal(isExternalActionIneligibleUrl("https://www.fresha.com/for-business"), true);
  assert.equal(isExternalActionIneligibleUrl("https://www.setmore.com/industries/barber-shops"), true);
  assert.equal(ranked[0], "https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella");
  assert.equal(ranked.includes("https://www.fresha.com/for-business"), false);
  assert.equal(ranked.includes("https://www.setmore.com/industries/barber-shops"), false);
});

test("external action URL ranking prefers booking provider pages over editorial listicles", () => {
  const evidence = [
    "1. Top Barbers in Marbella for Perfect Grooming",
    "https://marbelladreamvillas.com/barbers-marbella/",
    "Discover the best barbers Marbella offers for a fresh haircut, beard trim, or shave. Explore top barbershops and book your appointment today!",
    "",
    "2. Memento Barbershop | Barbería en Marbella - Marbella - Book Online ...",
    "https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella",
    "Check out Memento Barbershop in Marbella - explore pricing, reviews, and open appointments online 24/7!",
  ].join("\n");
  const ranked = rankExternalActionCandidateUrls(
    [
      "https://marbelladreamvillas.com/barbers-marbella/",
      "https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella",
    ],
    evidence,
    "barbershop online booking appointment",
  );

  assert.equal(ranked[0], "https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella");
  assert.equal(ranked.includes("https://marbelladreamvillas.com/barbers-marbella/"), false);
});

test("external action URL ranking keeps official provider homepages with booking signals", () => {
  const evidence = [
    "| Rank | Provider Name | URL | Why |",
    "| 1 | Original Barbershop Marbella | [https://barbershoporiginal.com/](https://barbershoporiginal.com/) | Best Candidate. The snippet explicitly mentions \"Записаться онлайн\" and a direct booking interface on the official site. |",
    "| 2 | Lifestyle guide | [https://marbelladreamvillas.com/barbers-marbella/](https://marbelladreamvillas.com/barbers-marbella/) | Top barbers guide. |",
  ].join("\n");
  const ranked = rankExternalActionCandidateUrls(
    ["https://barbershoporiginal.com/", "https://marbelladreamvillas.com/barbers-marbella/"],
    evidence,
    "Prepare barbershop appointment booking form before final submit.",
  );

  assert.equal(ranked[0], "https://barbershoporiginal.com/");
  assert.equal(ranked.includes("https://marbelladreamvillas.com/barbers-marbella/"), false);
});

test("external action URL ranking treats marketplace listings as fallback when direct action pages exist", () => {
  const evidence = [
    "Directory result: https://www.fresha.com/lp/en/bt/barbershops/in/es-marbella-andalusia",
    "Book online with the best Barbers near you in Marbella. Compare providers and appointments.",
    "Provider result: https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella",
    "Memento Barbershop in Marbella - Book Online, prices, reviews, open appointments online.",
    "Editorial result: https://marbelladreamvillas.com/barbers-marbella/",
    "Explore top barbershops and recommendations in Marbella.",
  ].join("\n");
  const ranked = rankExternalActionCandidateUrls(
    [
      "https://www.fresha.com/lp/en/bt/barbershops/in/es-marbella-andalusia",
      "https://marbelladreamvillas.com/barbers-marbella/",
      "https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella",
    ],
    evidence,
    "Prepare barbershop appointment booking form before final submit.",
  );

  assert.deepEqual(ranked, [
    "https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella",
  ]);
});

test("external action URL ranking excludes browser URLs rejected by artifact QA", () => {
  const fresha = "https://www.fresha.com/lp/en/bt/barbershops/in/es-marbella-andalusia";
  const booksy = "https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella";
  const evidence = [
    `Rejected browser URL: ${fresha}`,
    "Rejected screenshot artifact proof.png: Browser artifact is on a provider business/admin/software landing page.",
    `1. Fresha barbers Marbella ${fresha} Book online with the best Barbers near you in Marbella.`,
    `2. Book Online Memento Barbershop ${booksy} Book Online - Prices, Reviews, Photos.`,
  ].join("\n");

  assert.deepEqual(
    rankExternalActionCandidateUrls([fresha, booksy], evidence, "Prepare appointment booking"),
    [booksy],
  );
});

test("external action URL ranking excludes rejected redirected listing branches", () => {
  const rejectedFinal = "https://www.fresha.com/lp/en/bt/barbershops/in/es-marbella-andalusia";
  const freshaSearchResult = "https://www.fresha.com/lp/en/bt/barbershops/in/es-marbella/marbella-center";
  const booksy = "https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella";
  const evidence = [
    `Rejected browser URL: ${rejectedFinal}`,
    "Rejected screenshot artifact proof.png: Browser artifact is on a provider business/admin/software landing page.",
    `1. Fresha barbers Marbella ${freshaSearchResult} Book online with the best Barbers near you in Marbella.`,
    `2. Book Online Memento Barbershop ${booksy} Book Online - Prices, Reviews, Photos.`,
  ].join("\n");

  assert.deepEqual(
    rankExternalActionCandidateUrls([freshaSearchResult, booksy], evidence, "Prepare appointment booking"),
    [booksy],
  );
});

test("browser rejected listing exposes concrete action links for retry evidence", () => {
  const candidates = extractExternalActionCandidateLinksFromBrowserData({
    finalUrl: "https://www.fresha.com/lp/en/bt/barbershops/in/es-marbella-andalusia",
    title: "Best Barbers near me in Marbella",
    extractedText: [],
    extractedLinks: [
      {
        label: "initial-action-links",
        links: [
          { text: "For business", href: "https://www.fresha.com/for-business" },
          {
            text: "Sir Franklin Monasterios - Mijas Costa 5.0 Massage Hair cut + beard See all services",
            href: "https://www.fresha.com/a/sir-franklin-monasterios-mijas-costa-riviera-del-sol-c-viento-del-sur-s-n-c-c-atalayas-de-riviera-mbr8ha2y",
          },
          {
            text: "Search",
            href: "https://www.fresha.com/search?center=36.5,-4.8&business-type-id=5",
          },
        ],
      },
    ],
    screenshots: [],
    steps: [],
  });

  assert.deepEqual(candidates, [
    "https://www.fresha.com/a/sir-franklin-monasterios-mijas-costa-riviera-del-sol-c-viento-del-sur-s-n-c-c-atalayas-de-riviera-mbr8ha2y",
  ]);
});

test("URL extraction removes literal escaped newline tails from evidence text", () => {
  const urls = extractHttpUrls(
    "Source URL: https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella\\n    * Provider Name: Memento",
  );

  assert.deepEqual(urls, [
    "https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella",
  ]);
});

test("external action approval drafts do not trigger fresh browser discovery", () => {
  const subtask = {
    id: "external-action-approval-draft",
    title: "Create auditable external action approval draft",
    role: "approval drafter",
    prompt: "Create an external.action.prepare draft from upstream browser preparation evidence.",
    expectedOutput: "Approval-ready external action draft.",
    reviewCriteria: ["No external submission has occurred."],
    requiredTools: ["external-action-prepare"],
    requiredArtifacts: [],
  };

  assert.equal(
    shouldCollectBrowserDiscovery(
      subtask,
      "booking appointment external action approval draft based on browser evidence",
      ["service-booking"],
    ),
    false,
  );
});

test("external action discovery with actionable web evidence is not destroyed by revision", () => {
  const subtask = {
    id: "external-action-source-discovery",
    title: "Find a concrete provider page for the requested external action",
    role: "researcher",
    prompt:
      "Find concrete provider pages that can satisfy the requested external action. Prefer direct booking, appointment, reservation, checkout, or contact-form pages over directories, maps, ads, or generic listicles.",
    expectedOutput: "A ranked shortlist of concrete provider/action URLs with enough evidence to pick one page for browser preparation.",
    reviewCriteria: ["Uses fresh web evidence rather than model memory."],
    requiredTools: ["web-search"],
    requiredArtifacts: [],
  };

  const workerResult = {
    subtask,
    output:
      "Ranked shortlist:\n" +
      "1. Groomers & Ballers via Booksy - https://booksy.com/es-es/34152_groomers-ballers_barberia_29260_marbella - actionable direct booking page.\n" +
      "Availability for June 12, 2026 must be verified in browser preparation.",
    toolEvidence: [
      "Groomers & Ballers - Marbella - Book Online - Prices, Reviews, Photos\n" +
        "https://booksy.com/es-es/34152_groomers-ballers_barberia_29260_marbella\n" +
        "Rating 4.9. Explore pricing, reviews, and open appointments online 24/7.",
    ],
    artifacts: [],
  };

  assert.equal(hasActionableExternalActionDiscoveryEvidence(workerResult as never), true);
});

test("external action approval draft passes when prepare tool creates current no-submit boundary", () => {
  const workerResult = {
    subtask: {
      id: "external-action-approval-draft",
      title: "Create auditable external action approval draft",
      prompt: "Create an external.action.prepare draft from browser preparation evidence.",
      expectedOutput: "Approval-ready external action draft.",
      reviewCriteria: [],
    },
    output: "The LLM may still mention an unneeded date, but the runtime boundary is what matters.",
    toolEvidence: [
      [
        "Declared tool evidence from external.action.prepare:",
        "Prepared external action external_action_123.",
        "Target: Groomers & Ballers",
        "Action: Prepare booking.",
        "Commit boundary: Stop before final submit.",
      ].join("\n"),
    ],
    artifacts: [],
    dependencyContextSnapshot: [
      "- external-action-browser-preparation: Prepare the external action in the browser without final submit",
      "Declared tool evidence from browser.operate:",
      "Final URL: https://booksy.com/es-es/34152_groomers-ballers_barberia_29260_marbella",
      "Screenshots: external-action-pre-submit-proof.png",
    ].join("\n"),
  };

  assert.equal(hasPreparedExternalActionBoundary(workerResult as never), true);
});

test("external action approval draft passes with browser-preparation dependency summary evidence", () => {
  const workerResult = {
    subtask: {
      id: "external-action-approval-draft",
      title: "Create auditable external action approval draft",
      prompt: "Create an external.action.prepare draft from browser preparation evidence.",
      expectedOutput: "Approval-ready external action draft.",
      reviewCriteria: [],
    },
    output: [
      "Approval draft for Memento Barbershop.",
      "Target URL: https://booksy.com/es-es/m148702_memento-barbershop-barberia-en-ma_marbella",
      "Date note: Friday, June 5, 2026.",
    ].join("\n"),
    toolEvidence: [
      [
        "Declared tool evidence from external.action.prepare:",
        "Prepared external action external_action_123.",
        "Target: Create auditable external action approval draft",
        "Action: An approval-ready external action draft with target, data summary, proof status, and explicit final-submit boundary.",
        "Commit boundary: Stop before any provider-side submit, confirm, payment, send, reserve, book, delete, or state-changing control. Final external submission requires explicit approval and external.action.commit.",
        "Structured tool data:",
        "- httpStatus: prepared",
      ].join("\n"),
    ],
    artifacts: [],
    dependencyContextSnapshot: [
      "- external-action-browser-preparation: Prepare the external action in the browser without final submit",
      "review: pass - Deterministic fast-pass: worker runtime self-check confirmed non-empty output, attached evidence, and every required artifact.",
      "worker output:",
      "Based on the execution of the `browser.operate` tool, here is the result of the external action preparation.",
      "URL: `https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella`",
      "Current subtask artifact satisfies screenshot: external-action-pre-submit-proof-booksy-com-es-es-148702-memento-barbershop-barberia-en-ma-screenshot.png",
      "/api/runs/run_test/artifacts/artifact_test",
    ].join("\n"),
  };

  assert.equal(hasPreparedExternalActionBoundary(workerResult as never), true);
});

test("external action approval draft fast-pass beats unexecuted pseudo tool-call prose", () => {
  const workerResult = {
    subtask: {
      id: "external-action-approval-draft",
      title: "Create auditable external action approval draft",
      prompt: "Create an external.action.prepare draft from browser preparation evidence.",
      expectedOutput: "Approval-ready external action draft.",
      reviewCriteria: [],
      requiredArtifacts: [],
    },
    output:
      '<|tool_call>call:external.action.prepare{target:"https://booksy.com/example",commit_boundary:"before submit"}<tool_call|>',
    toolEvidence: [
      [
        "Declared tool evidence from external.action.prepare:",
        "Prepared external action external_action_123.",
        "Target: Create auditable external action approval draft",
        "Action: Prepared browser blocker with screenshot.",
        "Commit boundary: Stop before final submit.",
      ].join("\n"),
    ],
    artifacts: [],
    dependencyContextSnapshot: [
      "- external-action-browser-preparation: Prepare the external action in the browser without final submit",
      "Declared tool evidence from browser.operate:",
      "Final URL: https://booksy.com/es-es/1621_urbanos-barbershop_barberia_29260_marbella",
      "Browser artifact generated",
      "/api/runs/run_test/artifacts/artifact_test",
    ].join("\n"),
  };

  assert.equal(hardGateReview(workerResult as never)?.verdict, "pass");
});

test("external action approval draft accepts prepare boundary from dependency context", () => {
  const workerResult = {
    subtask: {
      id: "external-action-approval-draft",
      title: "Create auditable external action approval draft",
      prompt: "Create an external.action.prepare draft from browser preparation evidence.",
      expectedOutput: "Approval-ready external action draft.",
      reviewCriteria: [],
      requiredArtifacts: [],
    },
    output: "Blocked prose from the worker should not override runtime prepare evidence.",
    toolEvidence: [],
    artifacts: [],
    dependencyContextSnapshot: [
      "- external-action-browser-preparation: Prepare the external action in the browser without final submit",
      "Declared tool evidence from browser.operate:",
      "Final URL: https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella",
      "Browser artifact generated",
      "/api/runs/run_test/artifacts/artifact_test",
      "Declared tool evidence from external.action.prepare:",
      "Prepared external action external_action_123.",
      "Commit boundary: Stop before final submit.",
    ].join("\n"),
  };

  assert.equal(hasPreparedExternalActionBoundary(workerResult as never), true);
  assert.equal(hardGateReview(workerResult as never)?.verdict, "pass");
});

test("external action blocker evidence is not treated as approval-ready", () => {
  const dependencyContext = [
    "- external-action-browser-preparation: Prepare the external action in the browser without final submit",
    "Declared tool evidence from browser.operate:",
    "Final URL: https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella",
    "External action state:",
    "- blocker: login/account requirement is visible in browser evidence.",
    "Browser artifact generated",
    "/api/runs/run_test/artifacts/artifact_test",
    "external.action.prepare skipped: the provider requires login, account creation, or user authentication before a usable pre-submit state.",
  ].join("\n");
  const workerResult = {
    subtask: {
      id: "external-action-approval-draft",
      title: "Create auditable external action approval draft",
      prompt: "Create an external.action.prepare draft from browser preparation evidence.",
      expectedOutput: "Approval-ready external action draft.",
      reviewCriteria: [],
      requiredArtifacts: [],
    },
    output: "Preparation reached a login wall before approval.",
    toolEvidence: [
      "Declared tool evidence from external.action.prepare:\nPrepared external action external_action_stale.\nCommit boundary: Stop before final submit.",
    ],
    artifacts: [],
    dependencyContextSnapshot: dependencyContext,
  };

  assert.match(
    detectExternalActionPreparationBlocker(dependencyContext) ?? "",
    /provider requires login/i,
  );
  assert.equal(hasPreparedExternalActionBoundary(workerResult as never), false);
  assert.equal(hasBlockedExternalActionPreparationBoundary(workerResult as never), true);
  assert.equal(hardGateReview(workerResult as never)?.verdict, "pass");
  assert.match(hardGateReview(workerResult as never)?.notes ?? "", /blocker before approval/i);
});

test("external action blocker overrides hallucinated final preparation claims", () => {
  const workerResults = [
    {
      subtask: {
        id: "external-action-browser-preparation",
        title: "Prepare the external action in the browser without final submit",
        prompt: "Open the provider page and prepare the form without submitting.",
        expectedOutput: "Prepared form or visible blocker proof.",
        reviewCriteria: [],
        requiredArtifacts: [{ kind: "screenshot", capability: "browser-screenshot", description: "Blocker screenshot." }],
      },
      output: "Browser reached the provider but stopped at a login page.",
      toolEvidence: [
        [
          "Declared tool evidence from browser.operate:",
          "Final URL: https://booksy.com/es-es/148702_memento-barbershop-barberia-en-marbella_barberia_29260_marbella",
          "External action state:",
          "- blocker: login/account requirement is visible in browser evidence.",
          "Visible text: Empieza. Crea una cuenta o inicia sesión para reservar y gestionar tus citas. Email. Continuar.",
        ].join("\n"),
      ],
      artifacts: [
        {
          id: "artifact_login",
          kind: "output",
          filename: "booksy-login.png",
          mimeType: "image/png",
          sizeBytes: 31_711,
          url: "/api/runs/run_test/artifacts/artifact_login",
        },
      ],
    },
    {
      subtask: {
        id: "external-action-approval-draft",
        title: "Create auditable external action approval draft",
        prompt: "Create an external.action.prepare draft from browser preparation evidence.",
        expectedOutput: "Approval-ready external action draft or blocker.",
        reviewCriteria: [],
        requiredArtifacts: [],
      },
      output: "Preparation reached a login wall before approval.",
      toolEvidence: [
        "external.action.prepare skipped: the provider requires login, account creation, or user authentication before a usable pre-submit state.",
      ],
      artifacts: [],
      dependencyContextSnapshot:
        "External action state:\n- blocker: login/account requirement is visible in browser evidence.",
    },
  ];

  const answer = buildExternalActionBlockerFinalAnswer(
    "Найди барбершоп в Марбелье и подготовь запись без финальной отправки.",
    workerResults as never,
    [
      {
        id: "artifact_login",
        kind: "output",
        filename: "booksy-login.png",
        mimeType: "image/png",
        sizeBytes: 31_711,
        url: "/api/runs/run_test/artifacts/artifact_login",
      },
    ] as never,
  );

  assert.ok(answer);
  assert.match(answer ?? "", /Подготовить внешнее действие.*не удалось/i);
  assert.match(answer ?? "", /login|account|аккаунт|войти/i);
  assert.match(answer ?? "", /booksy\.com/i);
  assert.match(answer ?? "", /booksy-login\.png/i);
  assert.doesNotMatch(answer ?? "", /форма заполнена|готово к отправке/i);
});

test("classification context stays compact and excludes long runtime thread evidence", () => {
  const task = "найди мне лучший ноутбук до 2500 долларов".repeat(80);
  const context = buildClassificationContext(task, {
    instanceContext: {
      groupProfile: {
        id: "group-local",
        instanceId: "instance-local",
        name: "Family",
        description: "The family lives in Spain, Marbella. ".repeat(40),
        preferences: { notes: "Very long preference ".repeat(80) },
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      },
      requesterUser: {
        id: "user-admin",
        displayName: "Dimitrii",
        role: "admin",
        roles: ["admin"],
        identities: [],
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      },
    },
    threadContext: {
      summary: "Prior long summary ".repeat(100),
      acceptedFacts: ["Fact ".repeat(100)],
      rejectedAttempts: ["Reject ".repeat(100)],
      openQuestions: ["Question ".repeat(100)],
      relevantArtifactIds: ["artifact_1"],
      relevantArtifacts: [],
    },
    timeZone: "Europe/Madrid",
  }, new Date("2026-06-04T12:00:00.000Z"));

  assert.ok(context.length < 1_800, context);
  assert.match(context, /Task:/);
  assert.match(context, /current_date=06\/04\/2026|current_date=2026-06-04/);
  assert.doesNotMatch(context, /Accepted facts|Rejected or failed attempts|Relevant artifact IDs/);
});

test("compact synthesis fallback reports context overflow without throwing away run evidence", () => {
  assert.equal(isContextWindowError(new Error("n_keep: 6418>= n_ctx: 4096")), true);

  const answer = buildCompactSynthesisFallback(
    "найди лучший ноутбук",
    [
      {
        subtask: {
          id: "research",
          title: "Collect source evidence",
          role: "researcher",
          prompt: "search",
          expectedOutput: "evidence",
          reviewCriteria: [],
        },
        output: "Found several sources but recommendation was not fully grounded.",
        toolEvidence: [],
        artifacts: [],
      },
    ],
    [{ subtaskId: "research", verdict: "needs_revision", notes: "missing grounded model names" }],
    [{
      id: "a1",
      runId: "r",
      kind: "output",
      filename: "proof.png",
      mimeType: "image/png",
      sizeBytes: 123,
      url: "/api/runs/r/artifacts/a1",
      createdAt: "2026-06-04T00:00:00.000Z",
    }],
    new Error("Context size has been exceeded"),
  );

  assert.match(answer, /локальная модель/i);
  assert.match(answer, /proof\.png/);
  assert.match(answer, /missing grounded model names/);
});

// Bug 4: parse forbidden tokens out of review notes for the retry prompt.
test("parseForbiddenTokensFromReviewNotes extracts comma-separated tokens", () => {
  const notes =
    "Output names specifics that are NOT in tool evidence or the task: RTX 4080, ROG Zephyrus G14, $2500. The worker must ground every model number...";
  const tokens = parseForbiddenTokensFromReviewNotes(notes);
  assert.deepEqual(tokens, ["RTX 4080", "ROG Zephyrus G14", "$2500"]);
});

test("parseForbiddenTokensFromReviewNotes returns [] for non-grounding notes", () => {
  const notes = "Output describes weak or unusable browser/artifact evidence, such as a blank page.";
  assert.deepEqual(parseForbiddenTokensFromReviewNotes(notes), []);
});

// Bug 1: geo-anchor URL bias.
test("geoBiasScore boosts URLs containing the anchor token", () => {
  assert.equal(geoBiasScore("https://amazon.es/laptop", ["Spain"]), 0); // "spain" not in URL
  assert.equal(geoBiasScore("https://www.spain.shop", ["Spain"]), 1);
  assert.equal(geoBiasScore("https://amazon.es/laptop", ["es"]), 1);
  // Multiple anchors stack up to cap of 2.
  assert.equal(geoBiasScore("https://madrid-spain.shop", ["Spain", "Madrid"]), 2);
  // No anchors → no bonus.
  assert.equal(geoBiasScore("https://amazon.es", []), 0);
  // Accent-insensitive match.
  assert.equal(geoBiasScore("https://espana-tech.com", ["España"]), 1);
});

// Bug 5b: deep-walk ungrounded gate on toolInputs (browser type/text commands).
test("guardDeclaredToolInputAgainstUngroundedSpecifics strips planner-injected specifics from browser type commands", () => {
  const planned = {
    commands: [
      { type: "navigate", url: "https://www.google.com" },
      { type: "type", text: "best portable laptop for local LLM and gaming under 2500 USD RTX 4080 32GB RAM" },
      { type: "pressEnter" },
      { type: "extractText" },
    ],
  };
  const userTask = "найди мне лучший ноутбук для программирования и LLM-разработки";
  const cleaned = guardDeclaredToolInputAgainstUngroundedSpecifics(planned, userTask) as typeof planned;
  // URL is preserved (structural rewrite is improveDeclaredToolInput's job).
  assert.equal(cleaned.commands[0].url, "https://www.google.com");
  // Hallucinated GPU spec stripped from text.
  assert.ok(!/RTX\s*4080/i.test(cleaned.commands[1].text!), `text still has RTX 4080: ${cleaned.commands[1].text}`);
  // Generic vocabulary preserved.
  assert.ok(/laptop/i.test(cleaned.commands[1].text!));
});

test("guardDeclaredToolInputAgainstUngroundedSpecifics is a deep no-op when nothing is ungrounded", () => {
  const planned = {
    commands: [
      { type: "navigate", url: "https://example.com/page" },
      { type: "extractText" },
    ],
  };
  const userTask = "find me a generic page";
  const cleaned = guardDeclaredToolInputAgainstUngroundedSpecifics(planned, userTask) as typeof planned;
  assert.deepEqual(cleaned, planned);
});

// Bug 5c: improveDeclaredToolInput fallback when no pattern matches.
test("improveDeclaredToolInput rewrites homepage navigation to first non-low-value URL when patterns return empty", () => {
  const subtask = {
    id: "discovery",
    title: "Identify candidates",
    role: "researcher",
    prompt: "Search for laptops",
    expectedOutput: "list of candidates",
    reviewCriteria: [],
    requiredTools: [],
    dependencies: [],
  };
  const input = {
    commands: [
      { type: "navigate", url: "https://www.amazon.com" },
      { type: "extractText" },
    ],
  };
  const priorEvidence = [
    "Search results: https://www.tomshardware.com/laptops/best-laptops 'Best Laptops 2026'",
    "Search results: https://www.nytimes.com/wirecutter/reviews/best-laptops 'The 14 Best Laptops of 2026'",
  ];
  const result = improveDeclaredToolInput(
    "browser.operate",
    input,
    subtask as never,
    priorEvidence,
    [],
    ["product-comparison"], // no built-in pattern for this intent → fallback
  ) as typeof input;
  // Should have rewritten to the first non-low-value URL.
  const navigates = result.commands.filter((c) => (c as { type: string }).type === "navigate");
  assert.ok(navigates.length >= 1);
  const newUrl = (navigates[0] as { url: string }).url;
  assert.notEqual(newUrl, "https://www.amazon.com");
  assert.ok(/tomshardware\.com|nytimes\.com/.test(newUrl), `fallback URL should be from priorEvidence: ${newUrl}`);
});

test("isLowValueProofUrl rejects programmatic / API endpoints surfaced as search results (Bug 11/13)", () => {
  // Iter H4 regression: LLM URL ranker promoted
  // worksheets.codalab.org/rest/bundles/<id>/contents/blob/... as a Skyscanner
  // candidate. Iter H2: facebook.com/groups/... was a placeholder match. The
  // first one is a programmatic API path that should be filtered structurally.
  assert.equal(
    isLowValueProofUrl("https://worksheets.codalab.org/rest/bundles/0xd74f36/contents/blob/frequent-classes"),
    true,
  );
  assert.equal(isLowValueProofUrl("https://api.example.org/api/v1/search"), true);
  assert.equal(isLowValueProofUrl("https://example.com/"), false);
  assert.equal(isLowValueProofUrl("https://github.com/foo/bar/raw/main/file.txt"), true);
  assert.equal(isLowValueProofUrl("https://github.com/foo/bar/blob/main/README.md"), true);
  // Real user-facing pages must NOT be filtered.
  assert.equal(isLowValueProofUrl("https://www.skyscanner.com/transport/flights/lis/lax/"), false);
  assert.equal(isLowValueProofUrl("https://www.tomshardware.com/laptops/best-laptops"), false);
  assert.equal(isLowValueProofUrl("https://news.ycombinator.com/item?id=12345"), false);
});

test("isLowValueProofUrl rejects social-platform deep posts but keeps profile/landing pages (Bug 21)", () => {
  // Iter S5 regression: URL ranker promoted
  // facebook.com/groups/dullmensclub/posts/<id> as a laptop research source.
  // Iter H2: facebook.com/groups/nashvillehospitalityprofessionals/posts/<id>
  // surfaced in a Marbella restaurant query. Both are noisy single posts
  // on social hosts; reject any 2+ segment path on a known social host.
  assert.equal(
    isLowValueProofUrl("https://www.facebook.com/groups/dullmensclub/posts/1918968805426318"),
    true,
  );
  assert.equal(
    isLowValueProofUrl("https://www.facebook.com/groups/nashvillehospitalityprofessionals/posts/2604616786594759"),
    true,
  );
  assert.equal(
    isLowValueProofUrl("https://www.linkedin.com/posts/some-author_activity-1234"),
    true,
  );
  // Profile / landing pages on the same hosts are still allowed
  // (they may be the brand's own page used for verification).
  assert.equal(isLowValueProofUrl("https://www.facebook.com/some-restaurant"), false);
  assert.equal(isLowValueProofUrl("https://www.linkedin.com/in/some-doctor"), false);
});

test("isShallowLandingUrl flags root and single-segment paths", () => {
  assert.equal(isShallowLandingUrl("https://www.amazon.com"), true);
  assert.equal(isShallowLandingUrl("https://www.amazon.com/"), true);
  assert.equal(isShallowLandingUrl("https://www.amazon.com/laptops"), true); // 1 segment is still shallow
  assert.equal(isShallowLandingUrl("https://www.amazon.com/laptops/RTX-5050/dp/ABC"), false);
  // Query strings preserve depth.
  assert.equal(isShallowLandingUrl("https://www.amazon.com/?s=laptop"), false);
});

// Bug 3: artifact propagation to run-completed.
test("getAllWorkerArtifacts returns artifacts from EVERY worker, even failed reviews", () => {
  const reviewed = [
    {
      workerResult: {
        subtask: { id: "s1" } as never,
        output: "ok",
        artifacts: [
          { id: "a1", filename: "ok.png", url: "/a/1", mimeType: "image/png" } as never,
        ],
      },
      review: { subtaskId: "s1", verdict: "pass" as const, notes: "" },
      attempts: [],
      reviews: [],
    },
    {
      workerResult: {
        subtask: { id: "s2" } as never,
        output: "blocked",
        artifacts: [
          { id: "a2", filename: "blocked-page.png", url: "/a/2", mimeType: "image/png" } as never,
        ],
      },
      review: { subtaskId: "s2", verdict: "needs_revision" as const, notes: "blocker" },
      attempts: [],
      reviews: [],
    },
  ];
  const all = getAllWorkerArtifacts(reviewed as never);
  const approved = getApprovedArtifacts(reviewed as never);
  assert.equal(all.length, 2, "all artifacts collected");
  assert.equal(approved.length, 1, "only the passed worker's artifact is approved");
  assert.equal(approved[0].id, "a1");
});

// Bug F (Phase 13 follow-up): when a subtask runs twice
// (initial worker → needs_revision → revised worker) and only the
// initial attempt produced screenshots, getAllWorkerArtifacts must
// preserve them even though `workerResult` points to the (artifact-less)
// revised attempt. Without this, run-completed.payload.artifacts and
// thread.artifact_ids both lose every screenshot the run actually
// captured.
test("getAllWorkerArtifacts preserves artifacts from earlier attempts when revisions strip them", () => {
  const initialAttempt = {
    subtask: { id: "s1" } as never,
    output: "first try with screenshots",
    artifacts: [
      { id: "screenshot-a", filename: "a.png", url: "/a", mimeType: "image/png" } as never,
      { id: "screenshot-b", filename: "b.png", url: "/b", mimeType: "image/png" } as never,
    ],
  };
  const revisedAttempt = {
    subtask: { id: "s1" } as never,
    output: "revised with no new artifacts",
    artifacts: [],
  };
  const reviewed = [
    {
      workerResult: revisedAttempt,
      review: { subtaskId: "s1", verdict: "needs_revision" as const, notes: "" },
      attempts: [initialAttempt, revisedAttempt],
      reviews: [],
    },
  ];
  const all = getAllWorkerArtifacts(reviewed as never);
  assert.equal(all.length, 2, "artifacts from initial attempt survive into all-worker collection");
  assert.deepEqual(
    all.map((a) => a.id),
    ["screenshot-a", "screenshot-b"],
  );
});

test("getAllWorkerArtifacts falls back to workerResult when attempts is empty", () => {
  const reviewed = [
    {
      workerResult: {
        subtask: { id: "s1" } as never,
        output: "no revisions",
        artifacts: [
          { id: "only", filename: "only.png", url: "/x", mimeType: "image/png" } as never,
        ],
      },
      review: { subtaskId: "s1", verdict: "pass" as const, notes: "" },
      attempts: [],
      reviews: [],
    },
  ];
  const all = getAllWorkerArtifacts(reviewed as never);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "only");
});
