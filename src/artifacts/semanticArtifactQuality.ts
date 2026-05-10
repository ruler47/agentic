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
  blockerSignals: string[];
  evidenceTextLength: number;
};

const blockerPatterns = [
  /\bloading\b/i,
  /\bfrom\s+meta\b/i,
  /\bsign\s*in\b/i,
  /\blog\s*in\b/i,
  /\baccess\s+denied\b/i,
  /\bforbidden\b/i,
  /\bnot\s+available\b/i,
  /\bpage\s+unavailable\b/i,
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

  if (!visual.ok) {
    // Phase 13 follow-up: a "visually near-empty" screenshot of a
    // legitimately minimalist page (example.com, a styled 404, a
    // small landing page) should NOT be treated as failed evidence
    // when the browser also returned real extracted text from that
    // page. Pixel-level emptiness is a heuristic for "nothing
    // rendered"; if 100+ chars of clean text came back, the page
    // DID render — it's just visually sparse. Only fail when both
    // the pixels AND the text say "no content".
    const looksNearEmptyButHasText =
      /near-empty/i.test(visual.reason) &&
      evidenceText.length >= 100 &&
      blockerSignals.length === 0;
    if (!looksNearEmptyButHasText) {
      return {
        ok: false,
        decision: "visually_invalid",
        reason: visual.reason,
        visual,
        expectedSignals,
        matchedSignals,
        blockerSignals,
        evidenceTextLength: evidenceText.length,
      };
    }
  }

  if (blockerSignals.length > 0 && (matchedSignals.length < 2 || evidenceText.length < 280)) {
    return {
      ok: false,
      decision: "blocked_or_loader",
      reason:
        "Browser artifact evidence looks blocked, login-only, still loading, or otherwise not useful enough to prove the requested task.",
      visual,
      expectedSignals,
      matchedSignals,
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
    blockerSignals,
    evidenceTextLength: evidenceText.length,
  };
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
