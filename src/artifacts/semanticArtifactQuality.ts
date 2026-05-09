import { ArtifactCreateInput } from "../types.js";
import { inspectScreenshotArtifact, VisualArtifactQualityReport } from "./visualArtifactQuality.js";

export type BrowserArtifactEvidence = {
  finalUrl?: string;
  title?: string;
  extractedText?: Array<{ label?: string; text?: string }>;
  extractedLinks?: Array<{ label?: string; links?: Array<{ text?: string; href?: string }> }>;
};

export type SemanticArtifactQualityInput = {
  artifact: ArtifactCreateInput;
  task: string;
  browser?: BrowserArtifactEvidence;
  toolContent?: string;
};

export type SemanticArtifactQualityReport = {
  ok: boolean;
  decision: "usable" | "visually_invalid" | "blocked_or_loader" | "semantic_mismatch" | "semantically_unverified";
  reason: string;
  visual: VisualArtifactQualityReport;
  expectedSignals: string[];
  matchedSignals: string[];
  expectedEvidenceTypes: ArtifactEvidenceIntent[];
  observedEvidenceTypes: ObservedArtifactEvidenceType[];
  blockerSignals: string[];
  evidenceTextLength: number;
};

export type ArtifactEvidenceIntent =
  | "translation"
  | "flight_search"
  | "product_purchase"
  | "market_research"
  | "profile_or_identity"
  | "general_web_proof";

export type ObservedArtifactEvidenceType =
  | "translation_utility"
  | "flight_search_utility"
  | "market_research_report"
  | "product_listing"
  | "profile_page"
  | "search_results"
  | "unknown";

const blockerPatterns = [
  /\bloading\b/i,
  /\bfrom\s+meta\b/i,
  /\bsign\s*in\b/i,
  /\blog\s*in\b/i,
  /\baccess\s+denied\b/i,
  /\bforbidden\b/i,
  /\bnot\s+available\b/i,
  /\bpage\s+unavailable\b/i,
  /\b404\b/i,
  /\bnot\s+found\b/i,
  /\bpage\s+not\s+found\b/i,
  /\bpage\s+does\s+not\s+exist\b/i,
  /\benable\s+javascript\b/i,
  /\bchecking\s+your\s+browser\b/i,
  /\bverify\s+(?:you|yourself|real|human)\b/i,
  /\bjust\s+a\s+moment\b/i,
  /\btry\s+again\s+later\b/i,
  /\bне\s+удалось\b/i,
  /\bзагрузка\b/i,
  /\bвойдите\b/i,
  /\bдоступ\s+запрещ/i,
  /\bстраница\s+недоступ/i,
  /\bстраница\s+не\s+найдена\b/i,
  /\bстраница\s+не\s+существует\b/i,
  /\besta\s+p[aá]gina\s+no\s+existe\b/i,
  /\bno\s+pudimos\s+encontrar\s+esta\s+p[aá]gina\b/i,
];

const stopWords = new Set([
  "about",
  "agent",
  "artifact",
  "browser",
  "capture",
  "check",
  "could",
  "data",
  "evidence",
  "find",
  "from",
  "give",
  "image",
  "make",
  "need",
  "page",
  "photo",
  "proof",
  "real",
  "report",
  "result",
  "screen",
  "screenshot",
  "search",
  "show",
  "source",
  "task",
  "that",
  "this",
  "with",
  "your",
  "артефакт",
  "браузер",
  "выдай",
  "дай",
  "доказательство",
  "задача",
  "картинка",
  "найди",
  "нужно",
  "ответ",
  "покажи",
  "получи",
  "результат",
  "сделай",
  "скрин",
  "скриншот",
  "страница",
  "фото",
]);

export function inspectBrowserScreenshotEvidence(input: SemanticArtifactQualityInput): SemanticArtifactQualityReport {
  const visual = inspectScreenshotArtifact(input.artifact);
  const evidenceText = buildEvidenceText(input);
  const blockerSignals = blockerPatterns
    .filter((pattern) => pattern.test(evidenceText))
    .map((pattern) => pattern.source.replace(/\\b|\\s\+|\(\?:|\)|\?|\[|\]/g, "").slice(0, 42));
  const expectedSignals = extractExpectedSignals(input.task);
  const evidenceTokens = new Set(tokenize(evidenceText));
  const matchedSignals = expectedSignals.filter((signal) => evidenceTokens.has(signal) || evidenceText.includes(signal));
  const expectedEvidenceTypes = classifyArtifactIntent(input.task);
  const observedEvidenceTypes = classifyObservedEvidence(evidenceText);
  const evidenceContractMismatchReason = detectEvidenceContractMismatch(expectedEvidenceTypes, observedEvidenceTypes);

  if (!visual.ok) {
    return {
      ok: false,
      decision: "visually_invalid",
      reason: visual.reason,
      visual,
      expectedSignals,
      matchedSignals,
      expectedEvidenceTypes,
      observedEvidenceTypes,
      blockerSignals,
      evidenceTextLength: evidenceText.length,
    };
  }

  if (blockerSignals.length > 0 && (hasHardBlockerEvidence(evidenceText) || matchedSignals.length < 2 || evidenceText.length < 280)) {
    return {
      ok: false,
      decision: "blocked_or_loader",
      reason:
        "Browser artifact evidence looks blocked, login-only, still loading, or otherwise not useful enough to prove the requested task.",
      visual,
      expectedSignals,
      matchedSignals,
      expectedEvidenceTypes,
      observedEvidenceTypes,
      blockerSignals,
      evidenceTextLength: evidenceText.length,
    };
  }

  if (evidenceContractMismatchReason) {
    return {
      ok: false,
      decision: "semantic_mismatch",
      reason: evidenceContractMismatchReason,
      visual,
      expectedSignals,
      matchedSignals,
      expectedEvidenceTypes,
      observedEvidenceTypes,
      blockerSignals,
      evidenceTextLength: evidenceText.length,
    };
  }

  if (expectedSignals.length >= 3 && evidenceText.length >= 120 && matchedSignals.length === 0) {
    return {
      ok: false,
      decision: "semantic_mismatch",
      reason:
        "Browser artifact evidence does not contain any meaningful task-specific signals, so the screenshot is likely unrelated to the requested proof.",
      visual,
      expectedSignals,
      matchedSignals,
      expectedEvidenceTypes,
      observedEvidenceTypes,
      blockerSignals,
      evidenceTextLength: evidenceText.length,
    };
  }

  if (evidenceText.length < 40 && expectedSignals.length >= 3) {
    return {
      ok: true,
      decision: "semantically_unverified",
      reason:
        "Screenshot passed visual QA, but there was not enough browser text/URL evidence for a semantic relevance decision.",
      visual,
      expectedSignals,
      matchedSignals,
      expectedEvidenceTypes,
      observedEvidenceTypes,
      blockerSignals,
      evidenceTextLength: evidenceText.length,
    };
  }

  return {
    ok: true,
    decision: "usable",
    reason: "Browser artifact has enough visual and contextual evidence to be treated as potentially useful proof.",
    visual,
    expectedSignals,
    matchedSignals,
    expectedEvidenceTypes,
    observedEvidenceTypes,
    blockerSignals,
    evidenceTextLength: evidenceText.length,
  };
}

function hasHardBlockerEvidence(evidenceText: string): boolean {
  return (
    /\b404\b/i.test(evidenceText) ||
    /\bnot\s+found\b/i.test(evidenceText) ||
    /\bpage\s+(?:not\s+found|does\s+not\s+exist)\b/i.test(evidenceText) ||
    /\besta\s+p[aá]gina\s+no\s+existe\b/i.test(evidenceText) ||
    /\bno\s+pudimos\s+encontrar\s+esta\s+p[aá]gina\b/i.test(evidenceText) ||
    /\bстраница\s+(?:не\s+найдена|не\s+существует)\b/i.test(evidenceText)
  );
}

function classifyArtifactIntent(task: string): ArtifactEvidenceIntent[] {
  const normalizedTask = normalize(task);
  const intents: ArtifactEvidenceIntent[] = [];

  if (/\b(?:translate|translation|translator|перевод|переведи|перевести|traduce|traducir|traducci[oó]n|traductor)\b/.test(normalizedTask)) {
    intents.push("translation");
  }
  if (/\b(?:flight|flights|airfare|airport|ticket|tickets|рейс|рейсы|авиа|билет|билеты|самолет|самол[её]т|перел[её]т)\b/.test(normalizedTask)) {
    intents.push("flight_search");
  }
  if (
    /(?:buy|bought|purchase|order|price|available|listing|model|product|купить|покупк|цена|стоимость|доступн|модель|товар|заказать)/.test(
      normalizedTask,
    )
  ) {
    intents.push("product_purchase");
  }
  if (/\b(?:market\s+research|market\s+size|рынок|исследовани[ея]\s+рынка|forecast|отчет\s+рынка|отч[её]т\s+рынка)\b/.test(normalizedTask)) {
    intents.push("market_research");
  }
  if (/\b(?:profile|account|identity|instagram|twitch|twitter|x\.com|лицо|профиль|аккаунт|личност|персон)\b|[@#][a-z0-9_.-]{3,}/i.test(task)) {
    intents.push("profile_or_identity");
  }

  return intents.length ? uniqueValues(intents) : ["general_web_proof"];
}

function classifyObservedEvidence(evidenceText: string): ObservedArtifactEvidenceType[] {
  const normalizedEvidence = normalize(evidenceText);
  const observed: ObservedArtifactEvidenceType[] = [];

  if (/\btranslate\.[a-z0-9.-]+\b|\bgoogle\s+translate\b|\btraductor\s+de\s+google\b|\btranslation\s+utility\b/.test(normalizedEvidence)) {
    observed.push("translation_utility");
  }
  if (/\bgoogle\.[^\s/]+\/travel\/flights\b|\bgoogle\s+flights\b|\btravel\s+flights\b|\bflight\s+search\b/.test(normalizedEvidence)) {
    observed.push("flight_search_utility");
  }
  if (/\b(?:market\s+research|market\s+forecast|market\s+size|industry\s+report|research\s+report|marketdataforecast|bonafide\s*research|skyquest|metaror|исследовани[ея]\s+рынка)\b/.test(normalizedEvidence)) {
    observed.push("market_research_report");
  }
  if (/\b(?:add\s+to\s+cart|buy\s+now|in\s+stock|out\s+of\s+stock|price|€|\$|£|amazon|ebay|магазин|купить|в\s+наличии|цена)\b/.test(normalizedEvidence)) {
    observed.push("product_listing");
  }
  if (/\b(?:profile|followers|following|posts|instagram|twitch|github|linkedin|аккаунт|профиль|подписчик)\b/.test(normalizedEvidence)) {
    observed.push("profile_page");
  }
  if (/\b(?:search\s+results|all\s+results|people\s+also\s+ask|resultados\s+de\s+b[uú]squeda|результаты\s+поиска)\b/.test(normalizedEvidence)) {
    observed.push("search_results");
  }

  return observed.length ? uniqueValues(observed) : ["unknown"];
}

function detectEvidenceContractMismatch(
  expectedEvidenceTypes: ArtifactEvidenceIntent[],
  observedEvidenceTypes: ObservedArtifactEvidenceType[],
): string | undefined {
  const expected = new Set(expectedEvidenceTypes);
  const observed = new Set(observedEvidenceTypes);

  if (observed.has("translation_utility") && !expected.has("translation")) {
    return "Browser artifact evidence is a translation utility page, but the task did not ask for translation evidence.";
  }
  if (observed.has("flight_search_utility") && !expected.has("flight_search")) {
    return "Browser artifact evidence is a flight-search utility page, but the task did not ask for flight or ticket evidence.";
  }
  if (observed.has("market_research_report") && expected.has("product_purchase") && !expected.has("market_research")) {
    return "Browser artifact evidence is a market-research/report page, but the task needs concrete product, price, or purchase proof.";
  }
  if (observed.has("search_results") && expected.has("product_purchase") && !observed.has("product_listing")) {
    return "Browser artifact evidence is only a search-results page, but the task needs concrete product, price, or purchase proof.";
  }
}

function buildEvidenceText(input: SemanticArtifactQualityInput): string {
  const browser = input.browser;
  const parts = [
    input.artifact.filename,
    input.artifact.description,
    input.toolContent,
    browser?.finalUrl,
    browser?.title,
    ...(browser?.extractedText ?? []).flatMap((block) => [block.label, block.text]),
    ...(browser?.extractedLinks ?? []).flatMap((group) => [
      group.label,
      ...(group.links ?? []).flatMap((link) => [link.text, link.href]),
    ]),
  ];

  return normalize(parts.filter((item): item is string => Boolean(item)).join("\n"));
}

function extractExpectedSignals(task: string): string[] {
  const tokens = tokenize(task).filter((token) => !stopWords.has(token));
  const handles = [...task.matchAll(/[@#]([a-zA-Z0-9_.-]{3,})/g)].map((match) => normalize(match[1] ?? ""));
  const hosts = [...task.matchAll(/https?:\/\/([^/\s)]+)/g)].flatMap((match) => tokenize(match[1] ?? ""));
  return [...new Set([...handles, ...hosts, ...tokens])].filter((token) => token.length >= 4).slice(0, 24);
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/[^a-z0-9а-яё_.-]+/i)
    .map((token) => token.replace(/^[_\-.]+|[_\-.]+$/g, ""))
    .filter((token) => token.length >= 4);
}

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFKC");
}

function uniqueValues<T>(values: T[]): T[] {
  return [...new Set(values)];
}
