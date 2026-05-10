/**
 * Phase 13: dockerized browser.operate tool service.
 *
 * Port of src/tools/browserOperateTool.ts (in-process Playwright
 * tool) into a standalone HTTP service. The logic is preserved
 * one-for-one — the only differences:
 *   1. Screenshots are returned as base64 strings (`contentBase64`)
 *      because Buffer is not JSON-serializable; the runtime
 *      `parseToolResult` rehydrates them back to Buffers transparently.
 *   2. The exported entry point is a plain async `runBrowserOperate`
 *      function instead of a `Tool` class — the HTTP server wires
 *      it to the SDK dispatcher in server.ts.
 */

import { chromium, type BrowserContextOptions, type Page } from "@playwright/test";

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
  | { type: "screenshot"; label?: string; fullPage?: boolean; filename?: string; maxHeight?: number };

export type ScreenshotArtifact = {
  filename: string;
  mimeType: string;
  contentBase64: string;
  description?: string;
};

export type BrowserOperateData = {
  finalUrl?: string;
  title?: string;
  extractedText: Array<{ label: string; text: string }>;
  extractedLinks: Array<{ label: string; links: Array<{ text: string; href: string }> }>;
  screenshots: ScreenshotArtifact[];
  steps: Array<{ index: number; type: string; status: "completed" | "failed"; summary: string; durationMs: number }>;
  storageState?: unknown;
};

export type BrowserOperateResult = { ok: boolean; content: string; data?: BrowserOperateData };

export async function runBrowserOperate(rawInput: unknown): Promise<BrowserOperateResult> {
  const parsed = parseInput(rawInput);
  if (!parsed.ok) return { ok: false, content: parsed.content };

  const launchOptions = process.env.CHROMIUM_PATH
    ? {
        headless: true,
        executablePath: process.env.CHROMIUM_PATH,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      }
    : { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] };

  const browser = await chromium.launch(launchOptions);
  const steps: BrowserOperateData["steps"] = [];
  const extractedText: BrowserOperateData["extractedText"] = [];
  const extractedLinks: BrowserOperateData["extractedLinks"] = [];
  const screenshots: ScreenshotArtifact[] = [];

  try {
    const context = await browser.newContext({
      viewport: { width: parsed.input.viewport?.width ?? 1440, height: parsed.input.viewport?.height ?? 1000 },
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
        steps.push({ index, type: command.type, status: "completed", summary, durationMs: Date.now() - startedAt });
      } catch (error) {
        const summary = error instanceof Error ? error.message : "Browser command failed.";
        const diag = await captureFailureScreenshot(page, index, command.type);
        if (diag) screenshots.push(diag);
        steps.push({ index, type: command.type, status: "failed", summary, durationMs: Date.now() - startedAt });
        return {
          ok: false,
          content: `browser.operate failed at command ${index} (${command.type}): ${summary}`,
          data: await buildData(context, page, extractedText, extractedLinks, screenshots, steps),
        };
      }
    }

    const data = await buildData(context, page, extractedText, extractedLinks, screenshots, steps);
    return { ok: true, content: summarizeRun(data), data };
  } finally {
    await browser.close();
  }
}

async function executeCommand(
  page: Page,
  command: BrowserOperateCommand,
  extractedText: BrowserOperateData["extractedText"],
  extractedLinks: BrowserOperateData["extractedLinks"],
  screenshots: ScreenshotArtifact[],
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
    case "type":
      await page.locator(command.selector).first().fill(command.text, { timeout: command.timeoutMs });
      return `Filled selector ${command.selector}.`;
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
    case "waitForSelector":
      await page.locator(command.selector).first().waitFor({ timeout: command.timeoutMs });
      return `Waited for selector ${command.selector}.`;
    case "waitForText":
      await page.getByText(command.text, { exact: false }).first().waitFor({ timeout: command.timeoutMs });
      return `Waited for text ${command.text}.`;
    case "wait":
      await page.waitForTimeout(command.ms);
      return `Waited ${command.ms} ms.`;
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
      let text: string;
      if (command.selector) {
        text = await page.locator(command.selector).first().innerText({ timeout: 5000 });
      } else {
        text = await pickContentText(page);
      }
      const cleaned = stripBoilerplate(text);
      const maxLength = clamp(command.maxLength ?? 4000, 1, 20000);
      const label = command.label?.trim() || command.selector || "page";
      extractedText.push({ label, text: cleaned.slice(0, maxLength) });
      return `Extracted ${Math.min(cleaned.length, maxLength)} characters from ${label} (raw ${text.length}, cleaned ${cleaned.length}).`;
    }
    case "extractLinks": {
      const label = command.label?.trim() || command.selector || "links";
      const limit = clamp(command.limit ?? 20, 1, 200);
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
      const wantFull = command.fullPage ?? true;
      const cap = (command as { maxHeight?: number }).maxHeight ?? 4000;
      const buffer = await captureScreenshotWithCap(page, wantFull, cap);
      const filename = command.filename ? safePngFilename(command.filename) : screenshotFilename(page.url(), command.label);
      screenshots.push({
        filename,
        mimeType: "image/png",
        contentBase64: buffer.toString("base64"),
        description: `Browser screenshot captured from ${page.url()}.`,
      });
      return `Captured screenshot ${filename}.`;
    }
  }
}

async function pickContentText(page: Page): Promise<string> {
  const candidates = ["article", "main", "[role='main']", "#main", "#content", ".article-content"];
  for (const selector of candidates) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) continue;
      const text = await locator.innerText({ timeout: 2000 });
      if (text && text.trim().length >= 200) return text;
    } catch {
      /* skip */
    }
  }
  try {
    return await page.locator("body").innerText({ timeout: 5000 });
  } catch {
    return "";
  }
}

function stripBoilerplate(text: string): string {
  const lines = text.split(/\r?\n/);
  const drop: RegExp[] = [
    /^\s*(?:we|this site|esta web|este sitio|wir|notre site)\s+(?:and\s+third|use(?:s|n)?|usa(?:n)?|nutzt|utilis)/i,
    /^\s*manage\s+preferences\s*$/i,
    /^\s*reject\s+all(?:\s+non[-\s]required)?\s*$/i,
    /^\s*accept\s+all(?:\s+cookies)?\s*$/i,
    /^\s*your\s+privacy\s*$/i,
    /^\s*cookie(?:s)?\s+(?:policy|preferences|notice|settings)\s*$/i,
    /^\s*privacy\s+(?:statement|policy|notice|preferences|settings)\s*$/i,
    /^\s*see\s+our\s+privacy/i,
    /^\s*(?:google\s+adsense|google\s+analytics|doubleclick)\b/i,
    /^[\s•·\-—]+(?:home|menu|navigation|main\s+menu)\s*$/i,
    /^\s*subscribe(?:\s+to\s+our\s+newsletter)?\s*$/i,
    /^\s*sign\s+up\s+for\s+(?:our\s+)?newsletter\s*$/i,
    /^\s*©\s*\d{4}/,
    /^\s*copyright\s*©/i,
    /^\s*(?:share|tweet|pin\s*it|email|copy\s+link)\s*$/i,
  ];
  const cleaned: string[] = [];
  let consecutiveShortNavLines = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (cleaned.length > 0 && cleaned[cleaned.length - 1] !== "") cleaned.push("");
      consecutiveShortNavLines = 0;
      continue;
    }
    if (drop.some((re) => re.test(line))) {
      consecutiveShortNavLines = 0;
      continue;
    }
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

async function captureScreenshotWithCap(page: Page, wantFull: boolean, cap: number): Promise<Buffer> {
  if (!wantFull || cap <= 0) {
    return page.screenshot({ type: "png", fullPage: wantFull });
  }
  try {
    const dims = await page.evaluate(() => {
      const html = document.documentElement;
      const body = document.body;
      const width = Math.max(html?.scrollWidth ?? 0, html?.clientWidth ?? 0, body?.scrollWidth ?? 0, 1280);
      const height = Math.max(html?.scrollHeight ?? 0, html?.clientHeight ?? 0, body?.scrollHeight ?? 0, 1);
      return { width, height };
    });
    if (!dims || !Number.isFinite(dims.width) || !Number.isFinite(dims.height)) {
      return page.screenshot({ type: "png", fullPage: true });
    }
    if (dims.height <= cap) return page.screenshot({ type: "png", fullPage: true });
    return page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: Math.max(1, Math.floor(dims.width)), height: Math.max(1, Math.floor(cap)) },
    });
  } catch {
    return page.screenshot({ type: "png", fullPage: true });
  }
}

async function buildData(
  context: { storageState(): Promise<unknown> },
  page: Page,
  extractedText: BrowserOperateData["extractedText"],
  extractedLinks: BrowserOperateData["extractedLinks"],
  screenshots: ScreenshotArtifact[],
  steps: BrowserOperateData["steps"],
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
): Promise<ScreenshotArtifact | undefined> {
  try {
    const url = page.url();
    if (!url || url === "about:blank") return undefined;
    const buffer = await page.screenshot({ type: "png", fullPage: true });
    const filename = screenshotFilename(url, `failure-command-${commandIndex}-${commandType}`);
    return {
      filename,
      mimeType: "image/png",
      contentBase64: buffer.toString("base64"),
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
      /* try next */
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
  const defaultSelectors = [
    "#onetrust-accept-btn-handler",
    "#onetrust-pc-btn-handler",
    "button.onetrust-close-btn-handler",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "#CybotCookiebotDialogBodyLevelButtonAccept",
    "[aria-label='Accept all']",
    "[aria-label='Accept All']",
    "[aria-label='Allow all']",
    "[aria-label='Принять']",
    "[aria-label='Aceptar']",
    "[aria-label='Aceptar todo']",
    "#didomi-notice-agree-button",
    ".cky-btn-accept",
    "#cookieyes-accept-all",
    "[data-testid='cookie-accept']",
    "[data-testid='accept-cookies']",
    "[data-testid='consent-accept']",
    "[data-cookieconsent='accept']",
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
    "Accept all cookies", "Accept all", "Accept", "Allow all", "I agree", "Agree", "Got it",
    "Принять все", "Принять", "Согласен", "Aceptar todo", "Aceptar todas", "Aceptar",
    "Akzeptieren", "Alle akzeptieren", "Tout accepter", "Accepter", "Accetta tutto", "Accetta",
    "Aceitar tudo", "Aceitar",
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
      /* skip */
    }
  }

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
      /* skip */
    }
  }

  if (clicked.length > 0) {
    try { await page.waitForLoadState("networkidle", { timeout: 1500 }); } catch { /* skip */ }
    try { await page.waitForTimeout(250); } catch { /* skip */ }
  }

  return clicked;
}

function summarizeRun(data: BrowserOperateData): string {
  const completed = data.steps.filter((s) => s.status === "completed").length;
  return [
    `Executed ${completed}/${data.steps.length} browser command(s).`,
    data.finalUrl ? `Final URL: ${data.finalUrl}` : undefined,
    data.title ? `Title: ${data.title}` : undefined,
    data.extractedText.length > 0 ? `Extracted text blocks: ${data.extractedText.length}` : undefined,
    data.extractedLinks.length > 0 ? `Extracted link groups: ${data.extractedLinks.length}` : undefined,
    data.screenshots.length > 0 ? `Screenshots: ${data.screenshots.map((s) => s.filename).join(", ")}` : undefined,
  ].filter(Boolean).join("\n");
}

type ParsedInput = {
  commands: BrowserOperateCommand[];
  viewport?: { width?: number; height?: number };
  userAgent?: string;
  extraHttpHeaders?: Record<string, string>;
  storageState?: BrowserContextOptions["storageState"];
  defaultTimeoutMs?: number;
  maxCommands: number;
};

function parseInput(raw: unknown): { ok: true; input: ParsedInput } | { ok: false; content: string } {
  if (!raw || typeof raw !== "object") return { ok: false, content: "input must be an object." };
  const input = raw as Record<string, unknown>;

  if (!Array.isArray(input.commands) && typeof input.url === "string") {
    const filename = typeof input.filename === "string" ? input.filename : undefined;
    const fullPage = typeof input.fullPage === "boolean" ? input.fullPage : undefined;
    const label = typeof input.label === "string" ? input.label : "proof";
    return parseInput({
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

  const maxCommands = typeof input.maxCommands === "number" ? clamp(input.maxCommands, 1, 50) : 25;
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
      storageState: input.storageState as BrowserContextOptions["storageState"] | undefined,
      defaultTimeoutMs: typeof input.defaultTimeoutMs === "number" ? clamp(input.defaultTimeoutMs, 1, 60000) : undefined,
      maxCommands,
    },
  };
}

function parseCommand(value: unknown): { ok: true; command: BrowserOperateCommand } | { ok: false; content: string } {
  if (!value || typeof value !== "object") return { ok: false, content: "command must be an object." };
  const item = value as Record<string, unknown>;
  const type = typeof item.type === "string" ? item.type : "";
  const num = (k: unknown) => typeof k === "number" && Number.isFinite(k) ? k : undefined;
  const str = (k: unknown) => typeof k === "string" ? k : undefined;
  const arr = (k: unknown): string[] => Array.isArray(k) ? k.filter((x): x is string => typeof x === "string") : [];

  switch (type) {
    case "navigate":
      return typeof item.url === "string"
        ? { ok: true, command: { type, url: item.url, waitUntil: ["load", "domcontentloaded", "networkidle"].includes(item.waitUntil as string) ? item.waitUntil as never : undefined, timeoutMs: num(item.timeoutMs) } }
        : { ok: false, content: "navigate requires url." };
    case "click": {
      const selectors = arr(item.selectors);
      if (typeof item.selector !== "string" && typeof item.text !== "string" && selectors.length === 0) {
        return { ok: false, content: "click requires selector, selectors, or text." };
      }
      return { ok: true, command: { type, selector: str(item.selector), selectors, text: str(item.text), timeoutMs: num(item.timeoutMs), optional: typeof item.optional === "boolean" ? item.optional : undefined } };
    }
    case "dismissDialogs":
      return { ok: true, command: { type, selectors: arr(item.selectors), texts: arr(item.texts), timeoutMs: num(item.timeoutMs) } };
    case "fill":
    case "type":
      return typeof item.selector === "string" && typeof item.text === "string"
        ? { ok: true, command: { type, selector: item.selector, text: item.text, timeoutMs: num(item.timeoutMs) } }
        : { ok: false, content: `${type} requires selector and text.` };
    case "selectOption":
      return typeof item.selector === "string"
        ? { ok: true, command: { type, selector: item.selector, value: str(item.value), label: str(item.label), index: num(item.index), timeoutMs: num(item.timeoutMs) } }
        : { ok: false, content: "selectOption requires selector." };
    case "check":
    case "uncheck":
      return typeof item.selector === "string"
        ? { ok: true, command: { type, selector: item.selector, timeoutMs: num(item.timeoutMs) } }
        : { ok: false, content: `${type} requires selector.` };
    case "press":
      return typeof item.key === "string"
        ? { ok: true, command: { type, selector: str(item.selector), key: item.key, timeoutMs: num(item.timeoutMs) } }
        : { ok: false, content: "press requires key." };
    case "waitForSelector":
      return typeof item.selector === "string"
        ? { ok: true, command: { type, selector: item.selector, timeoutMs: num(item.timeoutMs) } }
        : { ok: false, content: "waitForSelector requires selector." };
    case "waitForText":
      return typeof item.text === "string"
        ? { ok: true, command: { type, text: item.text, timeoutMs: num(item.timeoutMs) } }
        : { ok: false, content: "waitForText requires text." };
    case "wait":
      return typeof item.ms === "number"
        ? { ok: true, command: { type, ms: clamp(item.ms, 0, 30000) } }
        : { ok: false, content: "wait requires ms." };
    case "scroll":
      return { ok: true, command: { type, selector: str(item.selector), x: num(item.x), y: num(item.y) } };
    case "extractText":
      return { ok: true, command: { type, selector: str(item.selector), label: str(item.label), maxLength: num(item.maxLength) } };
    case "extractLinks":
      return { ok: true, command: { type, selector: str(item.selector), label: str(item.label), limit: num(item.limit) } };
    case "assertText":
      return typeof item.text === "string"
        ? { ok: true, command: { type, selector: str(item.selector), text: item.text, timeoutMs: num(item.timeoutMs) } }
        : { ok: false, content: "assertText requires text." };
    case "assertUrl":
      return typeof item.includes === "string" || typeof item.regex === "string"
        ? { ok: true, command: { type, includes: str(item.includes), regex: str(item.regex) } }
        : { ok: false, content: "assertUrl requires includes or regex." };
    case "screenshot":
      return { ok: true, command: { type, label: str(item.label), fullPage: typeof item.fullPage === "boolean" ? item.fullPage : undefined, filename: str(item.filename), maxHeight: num(item.maxHeight) } };
    default:
      return { ok: false, content: `unsupported command type "${type}".` };
  }
}

function parseViewport(value: unknown): { width?: number; height?: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  return {
    width: typeof item.width === "number" ? clamp(item.width, 320, 3840) : undefined,
    height: typeof item.height === "number" ? clamp(item.height, 240, 2160) : undefined,
  };
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
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

function clamp(value: number, min: number, max: number): number {
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
