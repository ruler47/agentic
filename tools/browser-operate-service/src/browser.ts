import { chromium, type BrowserContextOptions, type Page } from "@playwright/test";
import { clickVisibleElement, observeVisibleElements, type BrowserObservedElement } from "./observe.js";

export type BrowserOperateCommand =
  | { type: "navigate"; url: string; waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeoutMs?: number }
  | { type: "click"; selector?: string; selectors?: string[]; text?: string; x?: number; y?: number; timeoutMs?: number; optional?: boolean }
  | {
      type: "clickVisible";
      selector?: string;
      text?: string;
      role?: string;
      index?: number;
      timeoutMs?: number;
      optional?: boolean;
      enabledOnly?: boolean;
      viewportOnly?: boolean;
      externalActionSafe?: boolean;
    }
  | { type: "dismissDialogs"; selectors?: string[]; texts?: string[]; timeoutMs?: number }
  | {
      type: "fillFormSemantically";
      goal?: string;
      values?: Record<string, string>;
      valuesText?: string;
      label?: string;
      allowContinue?: boolean;
      allowPolicyConsent?: boolean;
      submit?: boolean;
      maxRounds?: number;
      timeoutMs?: number;
    }
  | { type: "fill" | "type"; selector: string; text: string; timeoutMs?: number }
  | { type: "selectOption"; selector: string; value?: string; label?: string; index?: number; timeoutMs?: number }
  | { type: "check" | "uncheck"; selector: string; timeoutMs?: number }
  | { type: "press"; selector?: string; key: string; timeoutMs?: number }
  | { type: "waitForSelector"; selector: string; timeoutMs?: number }
  | { type: "waitForText"; text: string; timeoutMs?: number }
  | { type: "wait"; ms: number }
  | { type: "scroll"; selector?: string; x?: number; y?: number }
  | { type: "observe"; selector?: string; text?: string; role?: string; label?: string; limit?: number; enabledOnly?: boolean; viewportOnly?: boolean }
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
  observations: Array<{ label: string; elements: BrowserObservedElement[] }>;
  formFills: BrowserFormFillReport[];
  screenshots: ScreenshotArtifact[];
  steps: Array<{ index: number; type: string; status: "completed" | "failed"; summary: string; durationMs: number }>;
  storageState?: unknown;
};

export type BrowserFormFillReport = {
  label: string;
  status: "completed" | "partial" | "blocked";
  filled: Array<{ field: string; selector: string; valuePreview: string; reason: string }>;
  selected: Array<{ field: string; selector: string; valuePreview: string; reason: string }>;
  checked: Array<{ field: string; selector: string; reason: string }>;
  skipped: Array<{ field: string; reason: string }>;
  clicked: Array<{ text: string; reason: string }>;
  blockers: string[];
  beforeSubmit: string[];
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
  const observations: BrowserOperateData["observations"] = [];
  const formFills: BrowserFormFillReport[] = [];
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
        const summary = await executeCommand(page, command, extractedText, extractedLinks, observations, formFills, screenshots);
        steps.push({ index, type: command.type, status: "completed", summary, durationMs: Date.now() - startedAt });
      } catch (error) {
        const summary = error instanceof Error ? error.message : "Browser command failed.";
        const diag = await captureFailureScreenshot(page, index, command.type);
        if (diag) screenshots.push(diag);
        steps.push({ index, type: command.type, status: "failed", summary, durationMs: Date.now() - startedAt });
        return {
          ok: false,
          content: `browser.operate failed at command ${index} (${command.type}): ${summary}`,
          data: await buildData(context, page, extractedText, extractedLinks, observations, formFills, screenshots, steps),
        };
      }
    }

    const data = await buildData(context, page, extractedText, extractedLinks, observations, formFills, screenshots, steps);
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
  observations: BrowserOperateData["observations"],
  formFills: BrowserFormFillReport[],
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
      if (selector || (command.selectors && command.selectors.length > 0)) {
        const clicked = await clickFirstAvailable(page, [selector, ...(command.selectors ?? [])], command.timeoutMs);
        if (clicked) return `Clicked selector ${clicked}.`;
        if (command.optional) return "No click target found; optional click skipped.";
        throw new Error(`No click target found for selectors: ${[selector, ...(command.selectors ?? [])].filter(Boolean).join(", ")}`);
      }
      if (command.text) {
        await clickLocatorWithFallback(page.getByText(command.text, { exact: false }).first(), command.timeoutMs);
        return `Clicked text ${command.text}.`;
      }
      if (typeof command.x === "number" && typeof command.y === "number") {
        const viewport = page.viewportSize();
        if (viewport && (command.x < 0 || command.y < 0 || command.x > viewport.width || command.y > viewport.height)) {
          throw new Error(`click coordinates ${command.x},${command.y} are outside viewport ${viewport.width}x${viewport.height}.`);
        }
        await page.mouse.click(command.x, command.y);
        return `Clicked coordinates ${command.x},${command.y}.`;
      }
      throw new Error("click requires selector, text, or coordinates.");
    }
    case "clickVisible": {
      const target = await clickVisibleElement(page, command);
      if (target) return `Clicked visible ${target.tag}${target.role ? `[role=${target.role}]` : ""} "${target.text.slice(0, 80)}" at ${target.centerX},${target.centerY}.`;
      if (command.optional) return "No visible click target found; optional click skipped.";
      throw new Error(`No visible click target found${command.text ? ` for text "${command.text}"` : ""}.`);
    }
    case "fill":
    case "type":
      await page.locator(command.selector).first().fill(command.text, { timeout: command.timeoutMs });
      return `Filled selector ${command.selector}.`;
    case "dismissDialogs": {
      const clicked = await dismissDialogs(page, command.selectors, command.texts, command.timeoutMs);
      return clicked.length > 0 ? `Dismissed dialog target(s): ${clicked.join(", ")}.` : "No dialog targets were visible.";
    }
    case "fillFormSemantically": {
      const report = await fillFormSemantically(page, command);
      formFills.push(report);
      return summarizeFormFillReport(report);
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
      await waitForVisibleText(page, command.text, command.timeoutMs);
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
    case "observe": {
      const elements = await observeVisibleElements(page, command);
      const label = command.label?.trim() || command.text?.trim() || command.selector || "visible-elements";
      observations.push({ label, elements });
      return `Observed ${elements.length} visible element(s) for ${label}.`;
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
      const locator = command.selector
        ? page.locator(command.selector).evaluateAll((elements, max) => {
            const anchors = elements.flatMap((element) => {
              if (element instanceof HTMLAnchorElement) return [element];
              return Array.from(element.querySelectorAll("a"));
            });
            return anchors.slice(0, max).map((anchor) => ({
              text: (anchor.textContent ?? "").trim(),
              href: anchor.href,
            }));
          }, limit)
        : page.locator("a").evaluateAll((anchors, max) =>
            anchors.slice(0, max).map((anchor) => ({
              text: (anchor.textContent ?? "").trim(),
              href: anchor instanceof HTMLAnchorElement ? anchor.href : "",
            })),
            limit,
          );
      const links = await locator;
      extractedLinks.push({ label, links: links.filter((link) => link.href) });
      return `Extracted ${links.length} link(s) from ${label}.`;
    }
    case "assertText": {
      if (command.selector) {
        await page.locator(command.selector).first().getByText(command.text, { exact: false }).waitFor({ timeout: command.timeoutMs });
      } else {
        await waitForVisibleText(page, command.text, command.timeoutMs);
      }
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

type SemanticFormValues = {
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  date?: string;
  time?: string;
  service?: string;
  message?: string;
  address?: string;
};

type SemanticField = {
  selector: string;
  tag: string;
  type: string;
  label: string;
  value: string;
  checked: boolean;
  required: boolean;
  disabled: boolean;
  options: Array<{ value: string; label: string }>;
};

type SemanticButton = {
  selector: string;
  text: string;
  context: string;
  disabled: boolean;
};

async function fillFormSemantically(
  page: Page,
  command: Extract<BrowserOperateCommand, { type: "fillFormSemantically" }>,
): Promise<BrowserFormFillReport> {
  const label = command.label?.trim() || "semantic-form-fill";
  const values = buildSemanticFormValues(command.values, command.valuesText, command.goal);
  const report: BrowserFormFillReport = {
    label,
    status: "blocked",
    filled: [],
    selected: [],
    checked: [],
    skipped: [],
    clicked: [],
    blockers: [],
    beforeSubmit: [],
  };
  const maxRounds = clamp(command.maxRounds ?? 3, 1, 5);
  const timeoutMs = clamp(command.timeoutMs ?? 2500, 250, 15000);

  for (let round = 0; round < maxRounds; round += 1) {
    const snapshot = await inspectSemanticForm(page);
    report.beforeSubmit = mergeUnique(report.beforeSubmit, snapshot.buttons.filter((button) => isFinalSubmitControl(button, snapshot)).map((button) => button.text));
    if (snapshot.buttons.some((button) => isLoginOrAccountContinueText(button.text))) {
      break;
    }

    let changed = false;
    for (const field of snapshot.fields) {
      if (field.disabled) {
        report.skipped.push({ field: field.label || field.selector, reason: "Field is disabled." });
        continue;
      }
      const mapping = chooseSemanticFieldValue(field, values, command.allowPolicyConsent === true);
      if (!mapping) {
        continue;
      }
      if (mapping.kind === "skip") {
        report.skipped.push({ field: field.label || field.selector, reason: mapping.reason });
        continue;
      }
      if (field.value.trim() && normalizeComparable(field.value) === normalizeComparable(mapping.value)) {
        continue;
      }

      try {
        const locator = page.locator(field.selector).first();
        if (field.tag === "select") {
          const selected = await selectSemanticOption(locator, field.options, mapping.value, timeoutMs);
          if (!selected) {
            report.skipped.push({ field: field.label || field.selector, reason: `No select option matched "${mapping.value}".` });
            continue;
          }
          report.selected.push({
            field: field.label || field.selector,
            selector: field.selector,
            valuePreview: redactValuePreview(mapping.value),
            reason: mapping.reason,
          });
        } else if (field.type === "checkbox" || field.type === "radio") {
          await locator.check({ timeout: timeoutMs });
          report.checked.push({
            field: field.label || field.selector,
            selector: field.selector,
            reason: mapping.reason,
          });
        } else {
          await locator.fill(mapping.value, { timeout: timeoutMs });
          report.filled.push({
            field: field.label || field.selector,
            selector: field.selector,
            valuePreview: redactValuePreview(mapping.value),
            reason: mapping.reason,
          });
        }
        changed = true;
      } catch (error) {
        report.skipped.push({
          field: field.label || field.selector,
          reason: error instanceof Error ? error.message : "Could not fill this field.",
        });
      }
    }

    if (command.allowContinue !== false) {
      const progressSnapshot = changed ? await refreshedSemanticSnapshot(page) : snapshot;
      report.beforeSubmit = mergeUnique(
        report.beforeSubmit,
        progressSnapshot.buttons.filter((button) => isFinalSubmitControl(button, progressSnapshot)).map((button) => button.text),
      );
      if (progressSnapshot.buttons.some((button) => isLoginOrAccountContinueText(button.text))) {
        break;
      }
      const nextButton = progressSnapshot.buttons.find((button) => !button.disabled && isSafeContinueControl(button, progressSnapshot));
      if (nextButton && (changed || round === 0 || hasAnySemanticPreparation(report))) {
        try {
          await clickLocatorWithFallback(page.locator(nextButton.selector).first(), timeoutMs);
          report.clicked.push({ text: nextButton.text, reason: "Safe progress control clicked; final submit words were excluded." });
          await page.waitForTimeout(600);
          changed = true;
          continue;
        } catch (error) {
          report.skipped.push({
            field: nextButton.text,
            reason: error instanceof Error ? error.message : "Could not click safe progress control.",
          });
        }
      }
      if (!nextButton && (changed || round === 0 || hasAnySemanticPreparation(report))) {
        const observedClick = await clickObservedSafeProgressControl(page, progressSnapshot, timeoutMs);
        if (observedClick) {
          report.clicked.push({ text: observedClick, reason: "Safe visible progress control clicked through observed action layer." });
          await page.waitForTimeout(600);
          changed = true;
          continue;
        }
      }
    }

    if (!changed) break;
  }

  const finalSnapshot = await inspectSemanticForm(page);
  const observedLoginBoundaries = await observeVisibleElements(page, { limit: 80, enabledOnly: true, timeoutMs: 1000 })
    .then((elements) => elements.map((element) => element.text).filter((text) => isLoginOrAccountContinueText(text)))
    .catch(() => []);
  const remainingRequired = finalSnapshot.fields.filter((field) => {
    if (!field.required || field.disabled) return false;
    if (field.type === "checkbox" || field.type === "radio") return !field.checked;
    return !field.value.trim();
  });
  const finalSubmitButtons = finalSnapshot.buttons.filter((button) => isFinalSubmitControl(button, finalSnapshot));
  const loginBoundaryButtons = finalSnapshot.buttons.filter((button) => isLoginOrAccountContinueText(button.text));
  report.beforeSubmit = mergeUnique(report.beforeSubmit, finalSubmitButtons.map((button) => button.text));

  if (command.submit === true) {
    report.blockers.push("Final submit mode is not enabled in this preinstalled safe form-fill command.");
  }
  if (remainingRequired.length > 0) {
    report.blockers.push(`Required fields still empty: ${remainingRequired.map((field) => field.label || field.selector).join(", ")}.`);
  }
  if (finalSubmitButtons.length > 0) {
    report.blockers.push(`Stopped before final submit control(s): ${finalSubmitButtons.map((button) => button.text).join(", ")}.`);
  }
  if (loginBoundaryButtons.length > 0) {
    report.blockers.push(`Stopped before account/login control(s): ${loginBoundaryButtons.map((button) => button.text).join(", ")}.`);
  }
  if (observedLoginBoundaries.length > 0) {
    report.blockers.push(`Stopped before visible account/login boundary: ${mergeUnique([], observedLoginBoundaries).slice(0, 4).join(", ")}.`);
  }
  if (report.filled.length + report.selected.length + report.checked.length === 0) {
    report.blockers.push("No fillable fields were matched from the provided values.");
  }

  if (report.filled.length + report.selected.length + report.checked.length > 0 && remainingRequired.length === 0) {
    report.status = finalSubmitButtons.length > 0 ? "completed" : "partial";
  } else if (report.filled.length + report.selected.length + report.checked.length > 0) {
    report.status = "partial";
  } else {
    report.status = "blocked";
  }
  return report;
}

async function refreshedSemanticSnapshot(page: Page): Promise<{ fields: SemanticField[]; buttons: SemanticButton[] }> {
  await page.waitForTimeout(3000);
  return inspectSemanticForm(page);
}

async function clickObservedSafeProgressControl(
  page: Page,
  snapshot: { fields: SemanticField[]; buttons: SemanticButton[] },
  timeoutMs: number,
): Promise<string | undefined> {
  const observed = await observeVisibleElements(page, { limit: 80, enabledOnly: true, timeoutMs: Math.min(timeoutMs, 3000) }).catch(() => []);
  const candidate = observed.find((element) =>
    isSafeContinueControl({ selector: "", text: element.text, context: element.text, disabled: !element.enabled }, snapshot),
  );
  if (!candidate) return undefined;
  const clicked = await clickVisibleElement(page, {
    text: candidate.text,
    timeoutMs: Math.min(timeoutMs, 3000),
    enabledOnly: true,
    externalActionSafe: true,
  });
  return clicked?.text;
}

async function inspectSemanticForm(page: Page): Promise<{ fields: SemanticField[]; buttons: SemanticButton[] }> {
  return page.evaluate(`(() => {
    function cssEscape(value) {
      if (globalThis.CSS && typeof globalThis.CSS.escape === "function") return globalThis.CSS.escape(value);
      return String(value).replace(/["\\\\]/g, "\\\\$&");
    }
    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    }
    function textOf(element) {
      return (element && element.textContent ? element.textContent : "").replace(/\\s+/g, " ").trim();
    }
    function selectorFor(element) {
      if (element.id) return "#" + cssEscape(element.id);
      const name = element.getAttribute("name");
      if (name) return element.tagName.toLowerCase() + "[name=\\"" + cssEscape(name) + "\\"]";
      const aria = element.getAttribute("aria-label");
      if (aria) return element.tagName.toLowerCase() + "[aria-label=\\"" + cssEscape(aria) + "\\"]";
      const placeholder = element.getAttribute("placeholder");
      if (placeholder) return element.tagName.toLowerCase() + "[placeholder=\\"" + cssEscape(placeholder) + "\\"]";
      const controls = Array.from(document.querySelectorAll(element.tagName.toLowerCase()));
      const index = Math.max(0, controls.indexOf(element)) + 1;
      return element.tagName.toLowerCase() + ":nth-of-type(" + index + ")";
    }
    function labelFor(element) {
      const parts = [];
      if (element.id) {
        const explicit = document.querySelector("label[for=\\"" + cssEscape(element.id) + "\\"]");
        if (explicit) parts.push(textOf(explicit));
      }
      const wrapping = element.closest("label");
      if (wrapping) parts.push(textOf(wrapping));
      parts.push(
        element.getAttribute("aria-label") || "",
        element.getAttribute("placeholder") || "",
        element.getAttribute("name") || "",
        element.id || ""
      );
      const group = element.closest("[role='group'], .form-group, .field, .input, .control, .form-row, li, p, div");
      if (group) parts.push(textOf(group).slice(0, 160));
      return Array.from(new Set(parts.map(function(part) {
        return String(part).replace(/\\s+/g, " ").trim();
      }).filter(Boolean))).join(" | ");
    }

    const fields = Array.from(document.querySelectorAll("input, textarea, select"))
      .filter(function(element) {
        if (!isVisible(element)) return false;
        const type = (element.getAttribute("type") || element.tagName.toLowerCase()).toLowerCase();
        return !["hidden", "button", "submit", "reset", "image", "file", "password"].includes(type);
      })
      .map(function(element) {
        const tag = element.tagName.toLowerCase();
        const type = tag === "input" ? ((element.type || "text").toLowerCase()) : tag;
        const options = tag === "select"
          ? Array.from(element.options).map(function(option) {
              return { value: option.value, label: (option.textContent || option.value).trim() };
            })
          : [];
        return {
          selector: selectorFor(element),
          tag,
          type,
          label: labelFor(element),
          value: "value" in element ? String(element.value || "") : "",
          checked: "checked" in element ? Boolean(element.checked) : false,
          required: Boolean(element.required || element.getAttribute("aria-required") === "true"),
          disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
          options,
        };
      });

    const buttons = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit'], a[role='button'], [role='button']"))
      .filter(function(element) { return isVisible(element); })
      .map(function(element) {
        const contextElement = element.closest("form, [role='dialog'], section, article, li, .card, .service, .booking, .order, div");
        return {
          selector: selectorFor(element),
          text: ((element instanceof HTMLInputElement ? element.value : textOf(element)) || element.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim(),
          context: contextElement ? textOf(contextElement).slice(0, 240) : "",
          disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
        };
      })
      .filter(function(button) { return button.text; });
    return { fields, buttons };
  })()`) as Promise<{ fields: SemanticField[]; buttons: SemanticButton[] }>;
}

function buildSemanticFormValues(
  rawValues?: Record<string, string>,
  valuesText = "",
  goal = "",
): SemanticFormValues {
  const text = `${valuesText}\n${goal}`;
  const values: SemanticFormValues = {};
  const normalizedRaw = rawValues ?? {};
  for (const [key, value] of Object.entries(normalizedRaw)) {
    const normalized = key.toLowerCase().replace(/[^a-zа-я0-9]+/gi, "");
    if (!value.trim()) continue;
    if (/^(?:name|fullname|имя|фио)$/.test(normalized)) values.name = value.trim();
    else if (/^(?:firstname|first|имя)$/.test(normalized)) values.firstName = value.trim();
    else if (/^(?:lastname|surname|last|фамилия)$/.test(normalized)) values.lastName = value.trim();
    else if (/email|mail|почт/.test(normalized)) values.email = value.trim();
    else if (/phone|tel|mobile|тел|моб/.test(normalized)) values.phone = value.trim();
    else if (/date|дата|day|день/.test(normalized)) values.date = value.trim();
    else if (/time|hour|время|час/.test(normalized)) values.time = value.trim();
    else if (/service|услуг|стриж|haircut/.test(normalized)) values.service = value.trim();
    else if (/message|comment|note|сообщ|коммент|замет/.test(normalized)) values.message = value.trim();
    else if (/address|адрес/.test(normalized)) values.address = value.trim();
  }

  values.email ??= text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  values.phone ??= text.match(/(?:\+?\d[\d\s().-]{6,}\d)/)?.[0]?.replace(/\s+/g, " ").trim();
  values.time ??= text.match(/(?:after|после|с|from)\s*(\d{1,2}(?::\d{2})?)/i)?.[1] ?? text.match(/\b\d{1,2}:\d{2}\b/)?.[0];
  values.date ??= text.match(/\b(?:mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|понедельник|вторник|среда|четверг|пятница|суббота|воскресенье|пн|вт|ср|чт|пт|сб|вс)\b[^,\n.]*/i)?.[0]?.trim();
  if (!values.service && /стриж|haircut|barber/i.test(text)) values.service = /beard|бород/i.test(text) ? "haircut and beard trim" : "haircut";
  if (!values.message) {
    const preference = text.match(/(?:message|comment|notes?|сообщение|комментарий|пожелание|предпочтение)[:\s-]+([^\n]+)/i)?.[1]?.trim();
    values.message = preference ?? text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 20).slice(-1)[0];
  }
  if (!values.name) {
    const explicitName = text.match(/(?:name|имя|фио)[:\s-]+([A-ZА-ЯЁ][\p{L}'-]+(?:\s+[A-ZА-ЯЁ][\p{L}'-]+){0,3})/iu)?.[1]?.trim();
    const nearby = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^[A-ZА-ЯЁ][\p{L}'-]+(?:\s+[A-ZА-ЯЁ][\p{L}'-]+){1,3}$/u.test(line));
    values.name = explicitName ?? nearby;
  }
  const allowsTestDefaults = /\b(?:test|demo|dummy|any name|any test|любое|тест|не важно|неважно)\b/i.test(text);
  if (allowsTestDefaults) {
    values.name ??= "Test User";
    values.email ??= "test@example.com";
    values.phone ??= "+34 600 000 000";
  }
  if (values.name) {
    const parts = values.name.split(/\s+/).filter(Boolean);
    values.firstName ??= parts[0];
    values.lastName ??= parts.length > 1 ? parts.slice(1).join(" ") : undefined;
  }
  return values;
}

function chooseSemanticFieldValue(
  field: SemanticField,
  values: SemanticFormValues,
  allowPolicyConsent: boolean,
): { kind: "value"; value: string; reason: string } | { kind: "skip"; reason: string } | undefined {
  const label = normalizeComparable([field.label, field.type].join(" "));
  if (isProviderDirectorySearchField(label)) {
    return { kind: "skip", reason: "Global provider/directory search field is not part of the external action form." };
  }
  if (field.type === "checkbox" || field.type === "radio") {
    if (/(privacy|terms|policy|gdpr|consent|agree|услов|политик|соглас|privacidad|terminos|términos)/i.test(label)) {
      return allowPolicyConsent
        ? { kind: "value", value: "true", reason: "Legal/policy consent was explicitly allowed." }
        : { kind: "skip", reason: "Legal/policy consent requires explicit approval." };
    }
    return undefined;
  }
  const checks: Array<[RegExp, keyof SemanticFormValues, string]> = [
    [/(?:email|e-mail|mail|correo|почт)/i, "email", "Matched email field."],
    [/(?:phone|tel|mobile|móvil|telefono|teléfono|whatsapp|тел|моб)/i, "phone", "Matched phone field."],
    [/(?:first\s*name|given\s*name|nombre\b|имя\b)/i, "firstName", "Matched first-name field."],
    [/(?:last\s*name|surname|family\s*name|apellido|фамил)/i, "lastName", "Matched last-name field."],
    [/(?:full\s*name|\bname\b|nombre\s+completo|фио|имя.*фамил)/i, "name", "Matched full-name field."],
    [/(?:date|fecha|day|дата|день)/i, "date", "Matched date field."],
    [/(?:time|hora|hour|время|час)/i, "time", "Matched time field."],
    [/(?:service|servicio|услуг|procedure|treatment|стриж|haircut)/i, "service", "Matched service field."],
    [/(?:message|comment|note|notes|comentario|mensaje|сообщ|коммент|замет|observaciones)/i, "message", "Matched message/comment field."],
    [/(?:address|direccion|dirección|адрес)/i, "address", "Matched address field."],
  ];
  for (const [pattern, key, reason] of checks) {
    const value = values[key];
    if (pattern.test(label) && value) return { kind: "value", value, reason };
  }
  if (field.required && (field.tag === "textarea" || field.type === "text") && values.message) {
    return { kind: "value", value: values.message, reason: "Required generic text field filled with available message/preference text." };
  }
  return undefined;
}

function hasAnySemanticPreparation(report: BrowserFormFillReport): boolean {
  return report.filled.length + report.selected.length + report.checked.length + report.clicked.length > 0;
}

function isProviderDirectorySearchField(label: string): boolean {
  return /(?:services?\s+or\s+businesses|servicios?\s+o\s+negocios|businesses?\s+or\s+services?|buscar\s+servicios?\s+o\s+negocios|find\s+services?\s+or\s+businesses)/i.test(
    label,
  );
}

async function selectSemanticOption(
  locator: ReturnType<Page["locator"]>,
  options: Array<{ value: string; label: string }>,
  wanted: string,
  timeoutMs: number,
): Promise<boolean> {
  const normalizedWanted = normalizeComparable(wanted);
  const exact = options.find((option) => normalizeComparable(option.label) === normalizedWanted || normalizeComparable(option.value) === normalizedWanted);
  const fuzzy = exact ?? options.find((option) => normalizeComparable(option.label).includes(normalizedWanted) || normalizedWanted.includes(normalizeComparable(option.label)));
  if (!fuzzy) return false;
  if (fuzzy.value) await locator.selectOption({ value: fuzzy.value }, { timeout: timeoutMs });
  else await locator.selectOption({ label: fuzzy.label }, { timeout: timeoutMs });
  return true;
}

function isSafeContinueControl(button: SemanticButton, snapshot: { fields: SemanticField[]; buttons: SemanticButton[] }): boolean {
  const text = button.text;
  const normalized = normalizeComparable(text);
  if (!normalized || isFinalSubmitControl(button, snapshot)) return false;
  if (isLoginOrAccountContinueText(text)) return false;
  return /\b(?:next|continue|continuar|siguiente|seguir|proceed|review|details|datos|choose|select|seleccionar|elegir)\b/i.test(normalized);
}

function isLoginOrAccountContinueText(text: string): boolean {
  return /\b(?:continue|continuar)\s+(?:with|con)\s+(?:facebook|google|apple|email|correo|e-?mail|phone|tel[eé]fono)|\b(?:sign\s*in|log\s*in|login|create\s+account|create\s+an\s+account|crea\s+una\s+cuenta|crear\s+cuenta|inicia(?:r)?\s+sesi[oó]n|registrarse)\b/i.test(
    text,
  );
}

function isFinalSubmitControl(button: SemanticButton, snapshot: { fields: SemanticField[]; buttons: SemanticButton[] }): boolean {
  const normalized = normalizeComparable(button.text);
  if (!normalized) return false;
  if (/\b(?:submit|send|confirm|pay|purchase|order|checkout|finish|complete|finalize|finalise|confirmar|pagar|enviar|comprar|finalizar|terminar|pedir)\b/i.test(normalized)) {
    return true;
  }
  if (!/\b(?:book\s*now|reserve\s*now|booking|reservar)\b/i.test(normalized)) {
    return false;
  }

  const hasCustomerDataField = snapshot.fields.some((field) =>
    /(?:email|e-mail|mail|correo|phone|tel|mobile|móvil|telefono|teléfono|whatsapp|name|nombre|apellido|privacy|terms|policy|consent|agree|имя|фио|фамил|почт|тел|соглас|политик)/i.test(
      field.label,
    ),
  );
  const context = normalizeComparable(button.context);
  const confirmationContext =
    /(?:confirm|confirmation|payment|checkout|privacy|terms|policy|total|contact|customer|cliente|datos|pagar|confirmar|finalizar|terminar|контакт|оплат|подтвержд|персональн|данн)/i.test(
      context,
    );
  return hasCustomerDataField || confirmationContext;
}

function summarizeFormFillReport(report: BrowserFormFillReport): string {
  const changed = report.filled.length + report.selected.length + report.checked.length;
  const blockers = report.blockers.length > 0 ? ` Blockers: ${report.blockers.join(" ")}` : "";
  return `Semantic form fill ${report.label}: ${report.status}, ${changed} field/control change(s), ${report.clicked.length} safe progress click(s).${blockers}`;
}

function redactValuePreview(value: string): string {
  if (/@/.test(value)) return value.replace(/^(.).+(@.+)$/, "$1***$2");
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 7) return value.replace(/\d(?=\D*\d{2})/g, "*");
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function normalizeComparable(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function mergeUnique<T>(left: T[], right: T[]): T[] {
  return Array.from(new Set([...left, ...right]));
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
  observations: BrowserOperateData["observations"],
  formFills: BrowserFormFillReport[],
  screenshots: ScreenshotArtifact[],
  steps: BrowserOperateData["steps"],
): Promise<BrowserOperateData> {
  return {
    finalUrl: page.url(),
    title: await page.title().catch(() => undefined),
    extractedText,
    extractedLinks,
    observations,
    formFills,
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
      await clickLocatorWithFallback(locator, timeoutMs);
      return selector;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

async function clickLocatorWithFallback(
  locator: ReturnType<Page["locator"]>,
  timeoutMs = 1000,
): Promise<void> {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs });
  } catch {
    /* click may still work */
  }
  try {
    await locator.click({ timeout: timeoutMs });
    return;
  } catch (error) {
    try {
      await locator.evaluate((element) => {
        if (element instanceof HTMLElement) element.click();
        else element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }, undefined, { timeout: timeoutMs });
      return;
    } catch {
      throw error;
    }
  }
}

async function waitForVisibleText(page: Page, text: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + Math.max(1, Math.min(Math.floor(timeoutMs), 60_000));
  do {
    for (const frame of page.frames()) {
      try {
        const found = await frame.evaluate((needle) => {
          const wanted = String(needle).replace(/\s+/g, " ").trim().toLowerCase();
          return Array.from(document.querySelectorAll("body *")).some((element) => {
            const content = (element.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
            if (!content.includes(wanted)) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          });
        }, text);
        if (found) return;
      } catch {
        /* frame may navigate */
      }
    }
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new Error(`Visible text not found: ${text}`);
}

async function dismissDialogs(
  page: Page,
  selectors: string[] = [],
  texts: string[] = [],
  timeoutMs = 1500,
): Promise<string[]> {
  const clicked: string[] = [];
  const deadline = Date.now() + clamp(timeoutMs, 100, 30_000);
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
  const allSelectors = [...selectors, ...defaultSelectors];
  const allTexts = [...texts, ...defaultTexts];

  do {
    const remaining = Math.max(100, Math.min(500, deadline - Date.now()));
    const selectorHit = await clickFirstAvailable(page, allSelectors, remaining);
    if (selectorHit) {
      clicked.push(selectorHit);
      break;
    }

    const textHit = await clickDialogText(page, allTexts, remaining);
    if (textHit) {
      clicked.push(textHit);
      break;
    }

    const frameHit = await clickFrameDialogTarget(page, remaining);
    if (frameHit) {
      clicked.push(frameHit);
      break;
    }

    await page.waitForTimeout(100);
  } while (Date.now() < deadline);

  for (let i = 0; i < 2 && clicked.length > 0; i += 1) {
    const extraHit = await clickFirstAvailable(page, allSelectors, 250)
      ?? await clickDialogText(page, allTexts, 250)
      ?? await clickFrameDialogTarget(page, 250);
    if (!extraHit) break;
    clicked.push(extraHit);
  }

  if (clicked.length > 0) {
    try { await page.waitForLoadState("networkidle", { timeout: 1500 }); } catch { /* skip */ }
    try { await page.waitForTimeout(250); } catch { /* skip */ }
  }

  return clicked;
}

async function clickDialogText(page: Page, texts: string[], timeoutMs: number): Promise<string | undefined> {
  for (const text of texts) {
    try {
      const locator = page.getByText(text, { exact: false }).first();
      if ((await locator.count()) === 0) continue;
      await clickLocatorWithFallback(locator, timeoutMs);
      return `text:${text}`;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

async function clickFrameDialogTarget(page: Page, timeoutMs: number): Promise<string | undefined> {
  for (const frame of page.frames().slice(1)) {
    try {
      const iframeAccept = await frame.locator(
        "button:has-text('Accept all'), button:has-text('Accept All'), button:has-text('Allow all'), button:has-text('Aceptar todo'), button:has-text('Aceptar todas'), button:has-text('Принять все'), [aria-label='Accept all'], [aria-label='Accept All'], [aria-label='Allow all']",
      );
      if ((await iframeAccept.count()) === 0) continue;
      await iframeAccept.first().click({ timeout: timeoutMs });
      return `iframe:${frame.url().slice(0, 80)}`;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

function summarizeRun(data: BrowserOperateData): string {
  const completed = data.steps.filter((s) => s.status === "completed").length;
  return [
    `Executed ${completed}/${data.steps.length} browser command(s).`,
    data.finalUrl ? `Final URL: ${data.finalUrl}` : undefined,
    data.title ? `Title: ${data.title}` : undefined,
    data.extractedText.length > 0 ? `Extracted text blocks: ${data.extractedText.length}` : undefined,
    data.extractedLinks.length > 0 ? `Extracted link groups: ${data.extractedLinks.length}` : undefined,
    data.observations.length > 0 ? `Observed element groups: ${data.observations.length}` : undefined,
    data.formFills.length > 0 ? `Form fill reports: ${data.formFills.map((report) => `${report.label}:${report.status}`).join(", ")}` : undefined,
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
  const record = (k: unknown): Record<string, string> | undefined => parseStringRecord(k);

  switch (type) {
    case "navigate":
      return typeof item.url === "string"
        ? { ok: true, command: { type, url: item.url, waitUntil: ["load", "domcontentloaded", "networkidle"].includes(item.waitUntil as string) ? item.waitUntil as never : undefined, timeoutMs: num(item.timeoutMs) } }
        : { ok: false, content: "navigate requires url." };
    case "click": {
      const selectors = arr(item.selectors);
      if (typeof item.selector !== "string" && typeof item.text !== "string" && selectors.length === 0 && (num(item.x) === undefined || num(item.y) === undefined)) {
        return { ok: false, content: "click requires selector, selectors, text, or x/y coordinates." };
      }
      return { ok: true, command: { type, selector: str(item.selector), selectors, text: str(item.text), x: num(item.x), y: num(item.y), timeoutMs: num(item.timeoutMs), optional: typeof item.optional === "boolean" ? item.optional : undefined } };
    }
    case "clickVisible":
      return typeof item.selector === "string" || typeof item.text === "string" || typeof item.role === "string"
        ? {
            ok: true,
            command: {
              type,
              selector: str(item.selector),
              text: str(item.text),
              role: str(item.role),
              index: num(item.index),
              timeoutMs: num(item.timeoutMs),
              optional: typeof item.optional === "boolean" ? item.optional : undefined,
              enabledOnly: typeof item.enabledOnly === "boolean" ? item.enabledOnly : undefined,
              viewportOnly: typeof item.viewportOnly === "boolean" ? item.viewportOnly : undefined,
              externalActionSafe: typeof item.externalActionSafe === "boolean" ? item.externalActionSafe : undefined,
            },
          }
        : { ok: false, content: "clickVisible requires selector, text, or role." };
    case "dismissDialogs":
      return { ok: true, command: { type, selectors: arr(item.selectors), texts: arr(item.texts), timeoutMs: num(item.timeoutMs) } };
    case "fillFormSemantically":
      return {
        ok: true,
        command: {
          type,
          goal: str(item.goal),
          values: record(item.values),
          valuesText: str(item.valuesText),
          label: str(item.label),
          allowContinue: typeof item.allowContinue === "boolean" ? item.allowContinue : undefined,
          allowPolicyConsent: typeof item.allowPolicyConsent === "boolean" ? item.allowPolicyConsent : undefined,
          submit: typeof item.submit === "boolean" ? item.submit : undefined,
          maxRounds: num(item.maxRounds),
          timeoutMs: num(item.timeoutMs),
        },
      };
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
    case "observe":
      return { ok: true, command: { type, selector: str(item.selector), text: str(item.text), role: str(item.role), label: str(item.label), limit: num(item.limit), enabledOnly: typeof item.enabledOnly === "boolean" ? item.enabledOnly : undefined, viewportOnly: typeof item.viewportOnly === "boolean" ? item.viewportOnly : undefined } };
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
