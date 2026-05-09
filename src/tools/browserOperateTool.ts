import { chromium, Page, type BrowserContext, type BrowserContextOptions } from "@playwright/test";
import { ArtifactCreateInput } from "../types.js";
import { Tool, ToolInput, ToolResult } from "./tool.js";

export type BrowserOperateCommand =
  | { type: "navigate"; url: string; waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeoutMs?: number }
  | { type: "click"; selector?: string; selectors?: string[]; text?: string; timeoutMs?: number; optional?: boolean }
  | { type: "dismissDialogs"; selectors?: string[]; texts?: string[]; timeoutMs?: number }
  | { type: "fill" | "type"; selector: string; text: string; timeoutMs?: number }
  | { type: "selectOption"; selector: string; value?: string; label?: string; index?: number; timeoutMs?: number }
  | { type: "check" | "uncheck"; selector: string; timeoutMs?: number }
  | { type: "press"; selector?: string; key: string; timeoutMs?: number }
  | { type: "waitForSelector"; selector: string; timeoutMs?: number }
  | { type: "waitForText"; text: string; timeoutMs?: number }
  | { type: "wait"; ms: number }
  | { type: "scroll"; selector?: string; x?: number; y?: number }
  | { type: "extractText"; selector?: string; label?: string; maxLength?: number }
  | { type: "extractLinks"; selector?: string; label?: string; limit?: number }
  | { type: "assertText"; selector?: string; text: string; timeoutMs?: number }
  | { type: "assertUrl"; includes?: string; regex?: string }
  | {
      type: "screenshot";
      label?: string;
      fullPage?: boolean;
      filename?: string;
      /**
       * Phase 12 follow-up: hard cap on screenshot height in pixels. The
       * universal-agent-generated discovery commands set this to ~3200 px so
       * artifact viewers can render a single screen-height image without
       * scrolling for ages. When `fullPage` is true and the document is
       * taller than `maxHeight`, the screenshot is clipped to the top
       * `maxHeight` pixels of the page. Default 4000 (operator can pass
       * `null`/0 to disable for a deliberate full-page capture).
       */
      maxHeight?: number;
    };

export type BrowserOperateInput = {
  commands: BrowserOperateCommand[];
  viewport?: { width?: number; height?: number };
  userAgent?: string;
  extraHttpHeaders?: Record<string, string>;
  storageState?: BrowserContextOptions["storageState"];
  defaultTimeoutMs?: number;
  maxCommands?: number;
};

export type BrowserOperateStep = {
  index: number;
  type: string;
  status: "completed" | "failed";
  summary: string;
  durationMs: number;
};

export type BrowserOperateData = {
  finalUrl?: string;
  title?: string;
  extractedText: Array<{ label: string; text: string }>;
  extractedLinks: Array<{ label: string; links: Array<{ text: string; href: string }> }>;
  screenshots: ArtifactCreateInput[];
  steps: BrowserOperateStep[];
  storageState?: unknown;
};

export class BrowserOperateTool implements Tool {
  readonly name = "browser.operate";
  readonly version = "1.0.0";
  readonly description =
    "Runs a generic Playwright browser command sequence and returns DOM text plus screenshot artifacts.";
  readonly capabilities = [
    "browser-operate",
    "browser-automation",
    "browser-navigation",
    "dom-extraction",
    "browser-screenshot",
    "artifact-generation",
  ];
  readonly startupMode = "on-demand";
  readonly inputSchema = {
    type: "object" as const,
    required: ["commands"],
    properties: {
      commands: { type: "array", minItems: 1 },
      url: { type: "string" },
      filename: { type: "string" },
      fullPage: { type: "boolean" },
      label: { type: "string" },
      viewport: { type: "object" },
      userAgent: { type: "string" },
      extraHttpHeaders: { type: "object" },
      storageState: { type: "object" },
      defaultTimeoutMs: { type: "number", minimum: 1, maximum: 60000 },
      maxCommands: { type: "number", minimum: 1, maximum: 50 },
    },
  };
  readonly outputSchema = {
    type: "object" as const,
    required: ["ok", "content"],
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: {
        type: "object",
        properties: {
          finalUrl: { type: "string" },
          title: { type: "string" },
          extractedText: { type: "array" },
          extractedLinks: { type: "array" },
          screenshots: { type: "array" },
          steps: { type: "array" },
          storageState: { type: "object" },
        },
      },
    },
  };

  async healthcheck() {
    return { ok: true, detail: "Playwright browser operation module is importable." };
  }

  async run(input: ToolInput): Promise<ToolResult> {
    const parsed = parseBrowserOperateInput(input);
    if (!parsed.ok) return { ok: false, content: parsed.content };

    const launchOptions = process.env.CHROMIUM_PATH
      ? {
          headless: true,
          executablePath: process.env.CHROMIUM_PATH,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        }
      : { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] };

    const browser = await chromium.launch(launchOptions);
    const steps: BrowserOperateStep[] = [];
    const extractedText: BrowserOperateData["extractedText"] = [];
    const extractedLinks: BrowserOperateData["extractedLinks"] = [];
    const screenshots: ArtifactCreateInput[] = [];

    try {
      const context = await browser.newContext({
        viewport: {
          width: parsed.input.viewport?.width ?? 1440,
          height: parsed.input.viewport?.height ?? 1000,
        },
        userAgent: parsed.input.userAgent,
        extraHTTPHeaders: parsed.input.extraHttpHeaders,
        storageState: parsed.input.storageState,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(parsed.input.defaultTimeoutMs ?? 10000);

      for (const [index, command] of parsed.input.commands.entries()) {
        const startedAt = Date.now();
        try {
          const summary = await executeCommand(page, command, extractedText, extractedLinks, screenshots);
          steps.push({
            index,
            type: command.type,
            status: "completed",
            summary,
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          const summary = error instanceof Error ? error.message : "Browser command failed.";
          const diagnosticScreenshot = await captureFailureScreenshot(page, index, command.type);
          if (diagnosticScreenshot) screenshots.push(diagnosticScreenshot);
          steps.push({
            index,
            type: command.type,
            status: "failed",
            summary,
            durationMs: Date.now() - startedAt,
          });
          return {
            ok: false,
            content: `browser.operate failed at command ${index} (${command.type}): ${summary}`,
            data: await buildData(context, page, extractedText, extractedLinks, screenshots, steps),
          };
        }
      }

      const data = await buildData(context, page, extractedText, extractedLinks, screenshots, steps);
      return {
        ok: true,
        content: summarizeBrowserRun(data),
        data,
      };
    } finally {
      await browser.close();
    }
  }
}

async function executeCommand(
  page: Page,
  command: BrowserOperateCommand,
  extractedText: BrowserOperateData["extractedText"],
  extractedLinks: BrowserOperateData["extractedLinks"],
  screenshots: ArtifactCreateInput[],
): Promise<string> {
  switch (command.type) {
    case "navigate": {
      const parsed = parseHttpUrl(command.url);
      if (!parsed.ok) throw new Error(parsed.content);
      await page.goto(parsed.url, {
        waitUntil: command.waitUntil ?? "domcontentloaded",
        timeout: command.timeoutMs,
      });
      await page.waitForTimeout(500);
      return `Navigated to ${parsed.url}.`;
    }
    case "click": {
      const selector = command.selector ?? command.selectors?.[0];
      if (selector || command.selectors) {
        const clicked = await clickFirstAvailable(page, [selector, ...(command.selectors ?? [])], command.timeoutMs);
        if (clicked) return `Clicked selector ${clicked}.`;
        if (command.optional) return "No click target found; optional click skipped.";
        throw new Error(`No click target found for selectors: ${[selector, ...(command.selectors ?? [])].filter(Boolean).join(", ")}`);
      }
      if (command.text) {
        await page.getByText(command.text, { exact: false }).first().click({ timeout: command.timeoutMs });
        return `Clicked text ${command.text}.`;
      }
      throw new Error("click requires selector or text.");
    }
    case "fill":
    case "type": {
      await page.locator(command.selector).first().fill(command.text, { timeout: command.timeoutMs });
      return `Filled selector ${command.selector}.`;
    }
    case "dismissDialogs": {
      const clicked = await dismissDialogs(page, command.selectors, command.texts, command.timeoutMs);
      return clicked.length > 0 ? `Dismissed dialog target(s): ${clicked.join(", ")}.` : "No dialog targets were visible.";
    }
    case "selectOption": {
      const option = command.value !== undefined
        ? { value: command.value }
        : command.label !== undefined
          ? { label: command.label }
          : command.index !== undefined
            ? { index: command.index }
            : undefined;
      if (!option) throw new Error("selectOption requires value, label, or index.");
      await page.locator(command.selector).first().selectOption(option, { timeout: command.timeoutMs });
      return `Selected option in ${command.selector}.`;
    }
    case "check":
    case "uncheck": {
      const locator = page.locator(command.selector).first();
      if (command.type === "check") await locator.check({ timeout: command.timeoutMs });
      else await locator.uncheck({ timeout: command.timeoutMs });
      return `${command.type === "check" ? "Checked" : "Unchecked"} ${command.selector}.`;
    }
    case "press": {
      const target = command.selector ? page.locator(command.selector).first() : page.keyboard;
      await target.press(command.key, { timeout: command.timeoutMs });
      return `Pressed ${command.key}.`;
    }
    case "waitForSelector": {
      await page.locator(command.selector).first().waitFor({ timeout: command.timeoutMs });
      return `Waited for selector ${command.selector}.`;
    }
    case "waitForText": {
      await page.getByText(command.text, { exact: false }).first().waitFor({ timeout: command.timeoutMs });
      return `Waited for text ${command.text}.`;
    }
    case "wait": {
      await page.waitForTimeout(command.ms);
      return `Waited ${command.ms} ms.`;
    }
    case "scroll": {
      const x = command.x ?? 0;
      const y = command.y ?? 0;
      if (command.selector) {
        await page.locator(command.selector).first().evaluate((element, offset) => {
          element.scrollBy(offset.x, offset.y);
        }, { x, y });
        return `Scrolled ${command.selector} by ${x},${y}.`;
      }
      await page.mouse.wheel(x, y);
      return `Scrolled page by ${x},${y}.`;
    }
    case "extractText": {
      // Phase 12 follow-up: prefer semantic content roots (article, main,
      // [role=main]) so the extracted text is the actual content, not the
      // page-wide nav + cookie banner + footer that dominate the first
      // few KB of `body.innerText` and squeeze real content out of the
      // worker's `toolEvidenceChars` budget. Falls back to `body` when
      // no semantic root exists. Stripping is universal — no per-site
      // selectors.
      let text: string;
      if (command.selector) {
        text = await page.locator(command.selector).first().innerText({ timeout: 5000 });
      } else {
        text = await pickContentText(page);
      }
      const cleaned = stripWebPageBoilerplate(text);
      const maxLength = clampNumber(command.maxLength ?? 4000, 1, 20000);
      const label = command.label?.trim() || command.selector || "page";
      extractedText.push({ label, text: cleaned.slice(0, maxLength) });
      return `Extracted ${Math.min(cleaned.length, maxLength)} characters from ${label} (raw ${text.length}, cleaned ${cleaned.length}).`;
    }
    case "extractLinks": {
      const label = command.label?.trim() || command.selector || "links";
      const limit = clampNumber(command.limit ?? 20, 1, 200);
      const locator = command.selector ? page.locator(command.selector).locator("a") : page.locator("a");
      const links = await locator.evaluateAll((anchors, max) =>
        anchors.slice(0, max).map((anchor) => ({
          text: (anchor.textContent ?? "").trim(),
          href: anchor instanceof HTMLAnchorElement ? anchor.href : "",
        })),
        limit,
      );
      extractedLinks.push({ label, links: links.filter((link) => link.href) });
      return `Extracted ${links.length} link(s) from ${label}.`;
    }
    case "assertText": {
      const locator = command.selector ? page.locator(command.selector).first() : page.locator("body");
      await locator.getByText(command.text, { exact: false }).first().waitFor({ timeout: command.timeoutMs });
      return `Asserted text ${command.text}.`;
    }
    case "assertUrl": {
      const url = page.url();
      if (command.includes && !url.includes(command.includes)) {
        throw new Error(`URL "${url}" does not include "${command.includes}".`);
      }
      if (command.regex && !new RegExp(command.regex).test(url)) {
        throw new Error(`URL "${url}" does not match /${command.regex}/.`);
      }
      return `Asserted URL ${url}.`;
    }
    case "screenshot": {
      // Phase 12 follow-up: a default fullPage screenshot of a modern site
      // can be 10000+ pixels tall, which makes the artifact viewer
      // unusable. We keep fullPage=true as the default for backwards
      // compatibility with existing tool calls but clip the result to
      // `maxHeight` (default 4000 px) so the captured image fits a normal
      // operator screen. If the clipping path fails for any reason
      // (transient DOM, headless edge case, browser API drift) we fall
      // back to the original fullPage capture so the run never loses its
      // proof.
      const wantFullPage = command.fullPage ?? true;
      const rawCap = command.maxHeight === undefined ? 4000 : command.maxHeight;
      const cap = typeof rawCap === "number" && rawCap > 0 ? Math.floor(rawCap) : 0;
      const buffer = await captureScreenshotWithCap(page, wantFullPage, cap);
      const filename = command.filename ? safePngFilename(command.filename) : screenshotFilename(page.url(), command.label);
      screenshots.push({
        filename,
        mimeType: "image/png",
        content: buffer,
        description: `Browser screenshot captured from ${page.url()}.`,
      });
      return `Captured screenshot ${filename}.`;
    }
  }
}

/**
 * Phase 12 follow-up: prefer the page's main content region over the full
 * `body` so cookie banners, nav, and footer don't dominate the first KB
 * of extracted text. Tries common semantic selectors in order; falls
 * back to `body` if none exist or are empty.
 */
async function pickContentText(page: Page): Promise<string> {
  const candidates = ["article", "main", "[role='main']", "#main", "#content", ".article-content"];
  for (const selector of candidates) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) continue;
      const text = await locator.innerText({ timeout: 2000 });
      if (text && text.trim().length >= 200) {
        return text;
      }
    } catch {
      // selector might not be valid in this DOM; keep trying
    }
  }
  try {
    return await page.locator("body").innerText({ timeout: 5000 });
  } catch {
    return "";
  }
}

/**
 * Phase 12 follow-up: trim cookie / consent / nav / subscribe / cookie-policy
 * boilerplate from extracted text. Heuristics are universal — no site-
 * specific rules. Patterns are matched on whole lines so we never break a
 * sentence that happens to mention "cookies" inline (e.g. a recipe).
 */
function stripWebPageBoilerplate(text: string): string {
  const lines = text.split(/\r?\n/);
  const drop: RegExp[] = [
    // consent
    /^\s*(?:we|this site|esta web|este sitio|wir|notre site)\s+(?:and\s+third|use(?:s|n)?|usa(?:n)?|nutzt|utilis)/i,
    /^\s*manage\s+preferences\s*$/i,
    /^\s*reject\s+all(?:\s+non[-\s]required)?\s*$/i,
    /^\s*accept\s+all(?:\s+cookies)?\s*$/i,
    /^\s*your\s+privacy\s*$/i,
    /^\s*cookie(?:s)?\s+(?:policy|preferences|notice|settings)\s*$/i,
    /^\s*privacy\s+(?:statement|policy|notice|preferences|settings)\s*$/i,
    /^\s*see\s+our\s+privacy/i,
    /^\s*(?:google\s+adsense|google\s+analytics|doubleclick)\b/i,
    // nav lists with bullet/star items
    /^[\s•·\-—]+(?:home|menu|navigation|main\s+menu)\s*$/i,
    // subscribe / paywall prompts
    /^\s*subscribe(?:\s+to\s+our\s+newsletter)?\s*$/i,
    /^\s*sign\s+up\s+for\s+(?:our\s+)?newsletter\s*$/i,
    // footer copyright
    /^\s*©\s*\d{4}/,
    /^\s*copyright\s*©/i,
    // share buttons
    /^\s*(?:share|tweet|pin\s*it|email|copy\s+link)\s*$/i,
  ];
  const cleaned: string[] = [];
  let consecutiveShortNavLines = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      // collapse runs of empty lines into single \n
      if (cleaned.length > 0 && cleaned[cleaned.length - 1] !== "") cleaned.push("");
      consecutiveShortNavLines = 0;
      continue;
    }
    if (drop.some((re) => re.test(line))) {
      consecutiveShortNavLines = 0;
      continue;
    }
    // Heuristic: a sequence of short single-word lines is almost always
    // navigation / category list. Collapse 5+ in a row by skipping them
    // (preserves the run's first 4 so a real short menu still reads OK).
    const isShortMenuLine = line.length <= 22 && !line.includes(" ") && !/[.!?:]/.test(line);
    if (isShortMenuLine) {
      consecutiveShortNavLines += 1;
      if (consecutiveShortNavLines > 4) continue;
    } else {
      consecutiveShortNavLines = 0;
    }
    cleaned.push(line);
  }
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function captureScreenshotWithCap(
  page: Page,
  wantFullPage: boolean,
  cap: number,
): Promise<Buffer> {
  if (!wantFullPage || cap <= 0) {
    return page.screenshot({ type: "png", fullPage: wantFullPage });
  }
  try {
    const dims = await page.evaluate(() => {
      const html = document.documentElement;
      const body = document.body;
      const width = Math.max(
        html?.scrollWidth ?? 0,
        html?.clientWidth ?? 0,
        body?.scrollWidth ?? 0,
        1280,
      );
      const height = Math.max(
        html?.scrollHeight ?? 0,
        html?.clientHeight ?? 0,
        body?.scrollHeight ?? 0,
        1,
      );
      return { width, height };
    });
    if (!dims || !Number.isFinite(dims.width) || !Number.isFinite(dims.height)) {
      return page.screenshot({ type: "png", fullPage: true });
    }
    if (dims.height <= cap) {
      // Page already fits the cap — full-page capture is fine and tested.
      return page.screenshot({ type: "png", fullPage: true });
    }
    return page.screenshot({
      type: "png",
      clip: {
        x: 0,
        y: 0,
        width: Math.max(1, Math.floor(dims.width)),
        height: Math.max(1, Math.floor(cap)),
      },
    });
  } catch {
    // Defensive: never let the height cap break a working capture.
    return page.screenshot({ type: "png", fullPage: true });
  }
}

async function buildData(
  context: BrowserContext,
  page: Page,
  extractedText: BrowserOperateData["extractedText"],
  extractedLinks: BrowserOperateData["extractedLinks"],
  screenshots: ArtifactCreateInput[],
  steps: BrowserOperateStep[],
): Promise<BrowserOperateData> {
  return {
    finalUrl: page.url(),
    title: await page.title().catch(() => undefined),
    extractedText,
    extractedLinks,
    screenshots,
    steps,
    storageState: await context.storageState().catch(() => undefined),
  };
}

async function captureFailureScreenshot(
  page: Page,
  commandIndex: number,
  commandType: string,
): Promise<ArtifactCreateInput | undefined> {
  try {
    const url = page.url();
    if (!url || url === "about:blank") return undefined;
    const buffer = await page.screenshot({ type: "png", fullPage: true });
    const filename = screenshotFilename(url, `failure-command-${commandIndex}-${commandType}`);
    return {
      filename,
      mimeType: "image/png",
      content: buffer,
      description: `Diagnostic browser screenshot after command ${commandIndex} (${commandType}) failed at ${url}.`,
    };
  } catch {
    return undefined;
  }
}

async function clickFirstAvailable(
  page: Page,
  selectors: Array<string | undefined>,
  timeoutMs = 1000,
): Promise<string | undefined> {
  for (const selector of selectors.filter((item): item is string => Boolean(item))) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) === 0) continue;
      await locator.click({ timeout: timeoutMs });
      return selector;
    } catch {
      // Try the next candidate. Browser pages often vary cookie/dialog selectors.
    }
  }
  return undefined;
}

async function dismissDialogs(
  page: Page,
  selectors: string[] = [],
  texts: string[] = [],
  timeoutMs = 1500,
): Promise<string[]> {
  const clicked: string[] = [];

  // Phase 12 follow-up: aggressively accept cookie / GDPR / regional
  // consent banners across the most common consent platforms (OneTrust,
  // Cookiebot, TrustArc, Quantcast, Didomi, Sourcepoint, Cookieyes,
  // …) and locales. Without acceptance, modern news / retail sites
  // either show the banner OVER the content (blurring screenshots) or
  // block scripts that load product data, leaving evidence stuck in
  // the cookie wall. The list is host-neutral — every selector is
  // generic to a consent SDK or a multilingual button label.
  const defaultSelectors = [
    // OneTrust (Forbes, BBC, NYT, …)
    "#onetrust-accept-btn-handler",
    "#onetrust-pc-btn-handler",
    ".onetrust-close-btn-handler",
    "button.onetrust-close-btn-handler",
    // Cookiebot
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "#CybotCookiebotDialogBodyLevelButtonAccept",
    // Sourcepoint / quantcast
    "[aria-label='Accept all']",
    "[aria-label='Accept All']",
    "[aria-label='Allow all']",
    "[aria-label='Принять']",
    "[aria-label='Aceptar']",
    "[aria-label='Aceptar todo']",
    // Didomi / Cookieyes / generic
    "#didomi-notice-agree-button",
    ".cky-btn-accept",
    "#cookieyes-accept-all",
    "[data-testid='cookie-accept']",
    "[data-testid='accept-cookies']",
    "[data-testid='consent-accept']",
    "[data-cookieconsent='accept']",
    // Generic role-based
    "button:has-text('Accept all cookies')",
    "button:has-text('Accept All Cookies')",
    "button:has-text('Accept all')",
    "button:has-text('Accept')",
    "button:has-text('Agree')",
    "button:has-text('I agree')",
    "button:has-text('Allow all')",
    "button:has-text('Got it')",
    "button:has-text('OK')",
    "button:has-text('Принять')",
    "button:has-text('Согласен')",
    "button:has-text('Принять все')",
    "button:has-text('Aceptar')",
    "button:has-text('Aceptar todo')",
    "button:has-text('Aceptar todas')",
    "button:has-text('Akzeptieren')",
    "button:has-text('Alle akzeptieren')",
    "button:has-text('Accepter')",
    "button:has-text('Tout accepter')",
    "button:has-text('Accetta')",
    "button:has-text('Accetta tutto')",
    "button:has-text('Concordo')",
    "button:has-text('Aceitar')",
    "button:has-text('Aceitar tudo')",
  ];
  const defaultTexts = [
    "Accept all cookies",
    "Accept all",
    "Accept",
    "Allow all",
    "I agree",
    "Agree",
    "Got it",
    "Принять все",
    "Принять",
    "Согласен",
    "Aceptar todo",
    "Aceptar todas",
    "Aceptar",
    "Akzeptieren",
    "Alle akzeptieren",
    "Tout accepter",
    "Accepter",
    "Accetta tutto",
    "Accetta",
    "Aceitar tudo",
    "Aceitar",
  ];

  const selectorHit = await clickFirstAvailable(page, [...selectors, ...defaultSelectors], timeoutMs);
  if (selectorHit) clicked.push(selectorHit);

  for (const text of [...texts, ...defaultTexts]) {
    try {
      const locator = page.getByText(text, { exact: false }).first();
      if ((await locator.count()) === 0) continue;
      await locator.click({ timeout: timeoutMs });
      clicked.push(`text:${text}`);
      break;
    } catch {
      // Dialog may not exist or may already be gone.
    }
  }

  // Cookie banners are sometimes hosted in iframes (Sourcepoint, OneTrust
  // strict mode, Quantcast). Try to descend into each frame and click the
  // common accept buttons there too.
  for (const frame of page.frames().slice(1)) {
    try {
      const iframeAccept = await frame.locator(
        "button:has-text('Accept all'), button:has-text('Accept All'), button:has-text('Aceptar todo'), button:has-text('Принять все'), [aria-label='Accept all'], [aria-label='Accept All']",
      );
      if ((await iframeAccept.count()) > 0) {
        await iframeAccept.first().click({ timeout: timeoutMs });
        clicked.push(`iframe:${frame.url().slice(0, 80)}`);
      }
    } catch {
      // Frame may detach mid-click; safe to ignore.
    }
  }

  // Give the page a moment to settle after the consent action so the
  // subsequent `extractText` / `screenshot` sees the unblocked content.
  if (clicked.length > 0) {
    try {
      await page.waitForLoadState("networkidle", { timeout: 1500 });
    } catch {
      // Some sites never reach networkidle (analytics polling); ignore.
    }
    try {
      await page.waitForTimeout(250);
    } catch {
      // ignore
    }
  }

  return clicked;
}

function summarizeBrowserRun(data: BrowserOperateData): string {
  const completed = data.steps.filter((step) => step.status === "completed").length;
  return [
    `Executed ${completed}/${data.steps.length} browser command(s).`,
    data.finalUrl ? `Final URL: ${data.finalUrl}` : undefined,
    data.title ? `Title: ${data.title}` : undefined,
    data.extractedText.length > 0 ? `Extracted text blocks: ${data.extractedText.length}` : undefined,
    data.extractedLinks.length > 0 ? `Extracted link groups: ${data.extractedLinks.length}` : undefined,
    data.screenshots.length > 0 ? `Screenshots: ${data.screenshots.map((item) => item.filename).join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function parseBrowserOperateInput(input: ToolInput): { ok: true; input: BrowserOperateInput } | { ok: false; content: string } {
  if (!Array.isArray(input.commands) && typeof input.url === "string") {
    const filename = typeof input.filename === "string" ? input.filename : undefined;
    const fullPage = typeof input.fullPage === "boolean" ? input.fullPage : undefined;
    const label = typeof input.label === "string" ? input.label : "proof";
    return parseBrowserOperateInput({
      ...input,
      commands: [
        { type: "navigate", url: input.url },
        { type: "dismissDialogs", optional: true },
        { type: "extractText", maxLength: 6000 },
        { type: "screenshot", label, filename, fullPage },
      ],
    });
  }

  if (!Array.isArray(input.commands) || input.commands.length === 0) {
    return { ok: false, content: "browser.operate requires a non-empty commands array." };
  }

  const maxCommands = typeof input.maxCommands === "number" ? clampNumber(input.maxCommands, 1, 50) : 25;
  if (input.commands.length > maxCommands) {
    return { ok: false, content: `browser.operate received ${input.commands.length} commands, max is ${maxCommands}.` };
  }

  const commands: BrowserOperateCommand[] = [];
  for (const [index, item] of input.commands.entries()) {
    const parsed = parseCommand(item);
    if (!parsed.ok) return { ok: false, content: `Invalid command ${index}: ${parsed.content}` };
    commands.push(parsed.command);
  }

  return {
    ok: true,
    input: {
      commands,
      viewport: parseViewport(input.viewport),
      userAgent: typeof input.userAgent === "string" ? input.userAgent : undefined,
      extraHttpHeaders: parseStringRecord(input.extraHttpHeaders),
      storageState: parseStorageState(input.storageState),
      defaultTimeoutMs: typeof input.defaultTimeoutMs === "number" ? clampNumber(input.defaultTimeoutMs, 1, 60000) : undefined,
      maxCommands,
    },
  };
}

function parseCommand(value: unknown): { ok: true; command: BrowserOperateCommand } | { ok: false; content: string } {
  if (!value || typeof value !== "object") return { ok: false, content: "command must be an object." };
  const item = value as Record<string, unknown>;
  const type = typeof item.type === "string" ? item.type : "";

  switch (type) {
    case "navigate":
      return typeof item.url === "string"
        ? {
            ok: true,
            command: {
              type,
              url: item.url,
              waitUntil: parseWaitUntil(item.waitUntil),
              timeoutMs: parseOptionalNumber(item.timeoutMs),
            },
          }
        : { ok: false, content: "navigate requires url." };
    case "click":
      if (typeof item.selector !== "string" && typeof item.text !== "string") {
        const selectors = parseStringArray(item.selectors);
        if (selectors.length === 0) return { ok: false, content: "click requires selector, selectors, or text." };
      }
      return {
        ok: true,
        command: {
          type,
          selector: asString(item.selector),
          selectors: parseStringArray(item.selectors),
          text: asString(item.text),
          timeoutMs: parseOptionalNumber(item.timeoutMs),
          optional: typeof item.optional === "boolean" ? item.optional : undefined,
        },
      };
    case "dismissDialogs":
      return {
        ok: true,
        command: {
          type,
          selectors: parseStringArray(item.selectors),
          texts: parseStringArray(item.texts),
          timeoutMs: parseOptionalNumber(item.timeoutMs),
        },
      };
    case "fill":
    case "type":
      return typeof item.selector === "string" && typeof item.text === "string"
        ? { ok: true, command: { type, selector: item.selector, text: item.text, timeoutMs: parseOptionalNumber(item.timeoutMs) } }
        : { ok: false, content: `${type} requires selector and text.` };
    case "selectOption":
      return typeof item.selector === "string"
        ? {
            ok: true,
            command: {
              type,
              selector: item.selector,
              value: asString(item.value),
              label: asString(item.label),
              index: parseOptionalNumber(item.index),
              timeoutMs: parseOptionalNumber(item.timeoutMs),
            },
          }
        : { ok: false, content: "selectOption requires selector." };
    case "check":
    case "uncheck":
      return typeof item.selector === "string"
        ? { ok: true, command: { type, selector: item.selector, timeoutMs: parseOptionalNumber(item.timeoutMs) } }
        : { ok: false, content: `${type} requires selector.` };
    case "press":
      return typeof item.key === "string"
        ? { ok: true, command: { type, selector: asString(item.selector), key: item.key, timeoutMs: parseOptionalNumber(item.timeoutMs) } }
        : { ok: false, content: "press requires key." };
    case "waitForSelector":
      return typeof item.selector === "string"
        ? { ok: true, command: { type, selector: item.selector, timeoutMs: parseOptionalNumber(item.timeoutMs) } }
        : { ok: false, content: "waitForSelector requires selector." };
    case "waitForText":
      return typeof item.text === "string"
        ? { ok: true, command: { type, text: item.text, timeoutMs: parseOptionalNumber(item.timeoutMs) } }
        : { ok: false, content: "waitForText requires text." };
    case "wait":
      return typeof item.ms === "number"
        ? { ok: true, command: { type, ms: clampNumber(item.ms, 0, 30000) } }
        : { ok: false, content: "wait requires ms." };
    case "scroll":
      return {
        ok: true,
        command: {
          type,
          selector: asString(item.selector),
          x: parseOptionalNumber(item.x),
          y: parseOptionalNumber(item.y),
        },
      };
    case "extractText":
      return {
        ok: true,
        command: {
          type,
          selector: asString(item.selector),
          label: asString(item.label),
          maxLength: parseOptionalNumber(item.maxLength),
        },
      };
    case "extractLinks":
      return {
        ok: true,
        command: {
          type,
          selector: asString(item.selector),
          label: asString(item.label),
          limit: parseOptionalNumber(item.limit),
        },
      };
    case "assertText":
      return typeof item.text === "string"
        ? {
            ok: true,
            command: {
              type,
              selector: asString(item.selector),
              text: item.text,
              timeoutMs: parseOptionalNumber(item.timeoutMs),
            },
          }
        : { ok: false, content: "assertText requires text." };
    case "assertUrl":
      return typeof item.includes === "string" || typeof item.regex === "string"
        ? { ok: true, command: { type, includes: asString(item.includes), regex: asString(item.regex) } }
        : { ok: false, content: "assertUrl requires includes or regex." };
    case "screenshot":
      return {
        ok: true,
        command: {
          type,
          label: asString(item.label),
          fullPage: typeof item.fullPage === "boolean" ? item.fullPage : undefined,
          filename: asString(item.filename),
        },
      };
    default:
      return { ok: false, content: `unsupported command type "${type}".` };
  }
}

function parseViewport(value: unknown): BrowserOperateInput["viewport"] {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  return {
    width: typeof item.width === "number" ? clampNumber(item.width, 320, 3840) : undefined,
    height: typeof item.height === "number" ? clampNumber(item.height, 240, 2160) : undefined,
  };
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseStorageState(value: unknown): BrowserContextOptions["storageState"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as BrowserContextOptions["storageState"];
}

function parseHttpUrl(value: string): { ok: true; url: string } | { ok: false; content: string } {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, content: "Only http and https URLs are supported." };
    }
    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false, content: "Invalid URL." };
  }
}

function parseWaitUntil(value: unknown): "load" | "domcontentloaded" | "networkidle" | undefined {
  return value === "load" || value === "domcontentloaded" || value === "networkidle" ? value : undefined;
}

function parseOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function screenshotFilename(url: string, label?: string): string {
  const parsed = new URL(url || "about:blank");
  const slug = [label, parsed.hostname, parsed.pathname]
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);

  return `${slug || "browser-page"}-screenshot.png`;
}

function safePngFilename(value: string): string {
  const trimmed = value.trim().replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120);
  return trimmed.endsWith(".png") ? trimmed : `${trimmed}.png`;
}

export function isBrowserOperateData(data: unknown): data is BrowserOperateData {
  return (
    Boolean(data) &&
    typeof data === "object" &&
    Array.isArray((data as { steps?: unknown }).steps) &&
    Array.isArray((data as { extractedText?: unknown }).extractedText) &&
    Array.isArray((data as { screenshots?: unknown }).screenshots)
  );
}
