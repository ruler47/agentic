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
  expectedSignals?: string[];
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

const blockerPatterns: Array<{ pattern: RegExp; label: string; hard?: boolean }> = [
  { pattern: /\bloading\b/i, label: "loading", hard: false },
  { pattern: /\bcookie(?:s)?\b/i, label: "cookies" },
  { pattern: /\bconsent\b/i, label: "consent" },
  { pattern: /\bprivacy\s+(?:preferences|settings|policy)\b/i, label: "privacy policy" },
  { pattern: /\bmanage\s+options\b/i, label: "manage options" },
  { pattern: /\bdo\s+not\s+consent\b/i, label: "do not consent" },
  { pattern: /\bfrom\s+meta\b/i, label: "from meta" },
  { pattern: /\bsign\s*in\b/i, label: "sign in" },
  { pattern: /\blog\s*in\b/i, label: "login" },
  { pattern: /\baccess\s+denied\b/i, label: "access denied" },
  { pattern: /\bforbidden\b/i, label: "forbidden" },
  { pattern: /\bnot\s+available\b/i, label: "not available", hard: false },
  { pattern: /\bpage\s+unavailable\b/i, label: "page unavailable", hard: false },
  { pattern: /\benable\s+javascript\b/i, label: "enable javascript" },
  { pattern: /\bchecking\s+your\s+browser\b/i, label: "checking browser" },
  { pattern: /\bverify\s+(?:you|yourself|real|human)\b/i, label: "verify human" },
  { pattern: /\bverify\s+(?:that\s+)?you\s+are\s+(?:not\s+)?(?:a\s+)?(?:robot|human)\b/i, label: "verify human" },
  { pattern: /\bjust\s+a\s+moment\b/i, label: "just a moment" },
  { pattern: /\btry\s+again\s+later\b/i, label: "try again later", hard: false },
  { pattern: /\bsecurity\s+verification\b/i, label: "security verification" },
  { pattern: /\bcomplete\s+(?:the\s+)?(?:security\s+)?check\b/i, label: "security check" },
  { pattern: /\bpress\s+and\s+hold\b/i, label: "press and hold" },
  { pattern: /\bclick\s+the\s+button\s+below\s+to\s+continue\b/i, label: "continue interstitial" },
  { pattern: /\bcontinue\s+(?:shopping|to\s+(?:site|shop|store|website))\b/i, label: "continue interstitial" },
  { pattern: /\bwe\s+need\s+to\s+verify\b/i, label: "verification interstitial" },
  { pattern: /\bcaptcha\b/i, label: "captcha" },
  { pattern: /\bне\s+удалось\b/i, label: "не удалось", hard: false },
  { pattern: /\bзагрузка\b/i, label: "загрузка", hard: false },
  { pattern: /\bвойдите\b/i, label: "войдите" },
  { pattern: /\bдоступ\s+запрещ/i, label: "доступ запрещен" },
  { pattern: /\bстраница\s+недоступ/i, label: "страница недоступна", hard: false },
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
  const blockerMatches = blockerPatterns.filter(({ pattern }) => pattern.test(evidenceText));
  const blockerSignals = [...new Set(blockerMatches.map(({ label }) => label))];
  const expectedSignals = extractExpectedSignals(input.task, input.expectedSignals);
  const evidenceTokens = new Set(tokenize(evidenceText));
  const matchedSignals = expectedSignals.filter((signal) =>
    evidenceTokens.has(signal) ||
    evidenceText.includes(signal) ||
    signalTokensMatchEvidence(signal, evidenceText, evidenceTokens),
  );

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

  const hasHardBlocker = blockerMatches.some((match) => match.hard !== false);

  if (blockerSignals.length > 0 && (hasHardBlocker || matchedSignals.length < 2 || evidenceText.length < 280)) {
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

function extractExpectedSignals(task: string, explicitSignals: string[] = []): string[] {
  const tokens = tokenize(task).filter((token) => !stopWords.has(token));
  const handles = [...task.matchAll(/[@#]([a-zA-Z0-9_.-]{3,})/g)].map((match) => normalize(match[1] ?? ""));
  const hosts = [...task.matchAll(/https?:\/\/([^/\s)]+)/g)].flatMap((match) => tokenize(match[1] ?? ""));
  const explicit = explicitSignals
    .map(normalizeExpectedSignal)
    .filter((signal) => signal.length >= 4 || /\d/.test(signal));
  return [...new Set([...explicit, ...handles, ...hosts, ...tokens])]
    .filter((token) => token.length >= 4 || /\d/.test(token))
    .slice(0, 32);
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/[^a-z0-9а-яё_.-]+/i)
    .map((token) => token.replace(/^[_\-.]+|[_\-.]+$/g, ""))
    .filter((token) => token.length >= 4);
}

function signalTokensMatchEvidence(signal: string, evidenceText: string, evidenceTokens: Set<string>): boolean {
  const tokens = tokenize(signal).filter((token) => !stopWords.has(token));
  if (tokens.length < 2) return false;
  const requiredMatches = tokens.length <= 3 ? tokens.length : Math.max(3, tokens.length - 1);
  const matched = tokens.filter((token) => evidenceTokens.has(token) || evidenceText.includes(token)).length;
  return matched >= requiredMatches;
}

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFKC");
}

function normalizeExpectedSignal(value: string): string {
  return normalize(value)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "");
}
