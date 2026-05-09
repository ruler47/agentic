import { chromium, Page, type BrowserContext, type BrowserContextOptions } from "@playwright/test";
import { ArtifactCreateInput } from "../types.js";
import { Tool, ToolInput, ToolResult } from "./tool.js";

const DEFAULT_SCREENSHOT_MAX_HEIGHT = 1600;
const MAX_SCREENSHOT_MAX_HEIGHT = 3000;

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
      maxHeight: { type: "number", minimum: 200, maximum: 3000 },
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
      const text = command.selector
        ? await page.locator(command.selector).first().innerText({ timeout: 5000 })
        : await page.locator("body").innerText({ timeout: 5000 });
      const maxLength = clampNumber(command.maxLength ?? 4000, 1, 20000);
      const label = command.label?.trim() || command.selector || "page";
      extractedText.push({ label, text: text.slice(0, maxLength) });
      return `Extracted ${Math.min(text.length, maxLength)} characters from ${label}.`;
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
      const buffer = await captureBoundedScreenshot(page, {
        fullPage: command.fullPage,
        maxHeight: command.maxHeight,
      });
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
    const buffer = await captureBoundedScreenshot(page, { fullPage: false });
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
  timeoutMs = 1000,
): Promise<string[]> {
  const clicked: string[] = [];
  const defaultSelectors = [
    "#onetrust-accept-btn-handler",
    "[data-testid='cookie-accept']",
    "[data-testid='accept-cookies']",
    "button:has-text('Accept')",
    "button:has-text('Agree')",
    "button:has-text('Allow all')",
    "button:has-text('Принять')",
    "button:has-text('Согласен')",
    "button:has-text('Aceptar')",
    "button:has-text('Aceptar todo')",
  ];
  const defaultTexts = [
    "Accept all",
    "Accept",
    "I agree",
    "Agree",
    "Allow all",
    "Принять все",
    "Принять",
    "Согласен",
    "Aceptar todo",
    "Aceptar",
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
    const maxHeight = typeof input.maxHeight === "number" ? input.maxHeight : undefined;
    const label = typeof input.label === "string" ? input.label : "proof";
    return parseBrowserOperateInput({
      ...input,
      commands: [
        { type: "navigate", url: input.url },
        { type: "dismissDialogs", optional: true },
        { type: "extractText", maxLength: 6000 },
        { type: "screenshot", label, filename, fullPage, maxHeight },
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
          maxHeight: parseOptionalNumber(item.maxHeight),
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

async function captureBoundedScreenshot(
  page: Page,
  options: { fullPage?: boolean; maxHeight?: number },
): Promise<Buffer> {
  const fullPage = options.fullPage ?? false;
  if (!fullPage) {
    return page.screenshot({ type: "png", fullPage: false });
  }

  const maxHeight = clampNumber(options.maxHeight ?? DEFAULT_SCREENSHOT_MAX_HEIGHT, 200, MAX_SCREENSHOT_MAX_HEIGHT);
  const viewport = page.viewportSize() ?? { width: 1440, height: 1000 };
  const pageSize = await page
    .evaluate(() => ({
      width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, window.innerWidth),
      height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, window.innerHeight),
    }))
    .catch(() => viewport);

  if (pageSize.height <= maxHeight) {
    return page.screenshot({ type: "png", fullPage: true });
  }

  const boundedHeight = Math.max(1, Math.min(pageSize.height, maxHeight));
  if (viewport.height !== boundedHeight) {
    await page.setViewportSize({ width: viewport.width, height: boundedHeight });
  }
  try {
    return await page.screenshot({ type: "png", fullPage: false });
  } finally {
    if (viewport.height !== boundedHeight) {
      await page.setViewportSize(viewport).catch(() => undefined);
    }
  }
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
