import type { Frame, Page } from "@playwright/test";

export type BrowserObservedElement = {
  index: number;
  tag: string;
  role?: string;
  text: string;
  ariaLabel?: string;
  href?: string;
  name?: string;
  inputType?: string;
  placeholder?: string;
  checked?: boolean;
  disabled: boolean;
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  documentX: number;
  documentY: number;
  frameIndex: number;
  frameUrl: string;
};

type RawBrowserObservedElement = Omit<BrowserObservedElement, "index" | "frameIndex" | "frameUrl">;

export type ObserveOptions = {
  selector?: string;
  text?: string;
  role?: string;
  label?: string;
  limit?: number;
  enabledOnly?: boolean;
  timeoutMs?: number;
  viewportOnly?: boolean;
  externalActionSafe?: boolean;
};

const observeVisibleElementsScript = String.raw`
(opts) => {
  const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
  const escapeRegExp = (value) => value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  const textMatches = (value, needle) => {
    if (!needle) return true;
    const text = normalize(value).toLowerCase();
    if (!text) return false;
    if (text === needle) return true;
    if (text.startsWith(needle + " ") || text.endsWith(" " + needle)) return true;
    if (needle.length <= 4) {
      return new RegExp("(^|[^a-z0-9])" + escapeRegExp(needle) + "([^a-z0-9]|$)", "i").test(text);
    }
    return text.includes(needle);
  };
  const rootSelector =
    opts.selector ||
    [
      "button",
      "a",
      "input",
      "textarea",
      "select",
      "label",
      "summary",
      "[role]",
      "[tabindex]",
      "[aria-label]",
      "[onclick]",
      "div",
      "span",
    ].join(",");
  const textNeedle = normalize(opts.text).toLowerCase();
  const roleNeedle = normalize(opts.role).toLowerCase();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  return Array.from(document.querySelectorAll(rootSelector)).flatMap((element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    if (rect.width < 4 || rect.height < 4 || style.display === "none" || style.visibility === "hidden") return [];
    if (element.closest("[hidden],[aria-hidden='true'],[inert]")) return [];
    if (opts.viewportOnly && (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth)) return [];
    const tag = element.tagName.toLowerCase();
    const ariaLabel = normalize(element.getAttribute("aria-label"));
    const role = normalize(element.getAttribute("role"));
    const ignoredDecorativeRole = role === "img" || role === "presentation" || role === "none";
    if (["svg", "path", "img", "picture", "source", "iframe"].includes(tag) && ignoredDecorativeRole) return [];
    const formControl = ["input", "textarea", "select"].includes(tag) ? element : undefined;
    const anchor = tag === "a" ? element : undefined;
    const inputText = normalize(
      formControl && "placeholder" in formControl
        ? formControl.placeholder || formControl.name || formControl.value
        : formControl?.name || "",
    );
    const text = normalize(ariaLabel || inputText || element.textContent);
    if (!text && !role) return [];
    if (!text && ignoredDecorativeRole) return [];
    if ((tag === "div" || tag === "span") && (text.length > 120 || element.children.length > 4)) return [];
    if (textNeedle && !textMatches(text + " " + ariaLabel, textNeedle)) return [];
    if (roleNeedle && role.toLowerCase() !== roleNeedle) return [];
    const disabled = ["button", "input", "select", "textarea"].includes(tag) ? Boolean(element.disabled) : false;
    const effectiveDisabled =
      disabled ||
      element.getAttribute("aria-disabled") === "true" ||
      style.pointerEvents === "none" ||
      Number.parseFloat(style.opacity || "1") < 0.45;
    return [
      {
        tag,
        role: role || undefined,
        text,
        ariaLabel: ariaLabel || undefined,
        href: anchor && "href" in anchor ? anchor.href || undefined : undefined,
        name: formControl && "name" in formControl ? formControl.name || undefined : undefined,
        inputType: formControl && "type" in formControl ? formControl.type || undefined : undefined,
        placeholder: formControl && "placeholder" in formControl ? formControl.placeholder || undefined : undefined,
        checked: formControl && "checked" in formControl ? Boolean(formControl.checked) : undefined,
        disabled: effectiveDisabled,
        enabled: !effectiveDisabled,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        centerX: Math.round(rect.x + rect.width / 2),
        centerY: Math.round(rect.y + rect.height / 2),
        documentX: Math.round(rect.x + rect.width / 2 + scrollX),
        documentY: Math.round(rect.y + rect.height / 2 + scrollY),
      },
    ];
  });
}
`;

export async function observeVisibleElements(page: Page, options: ObserveOptions = {}): Promise<BrowserObservedElement[]> {
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 80), 200));
  const frames = page.frames();
  const raw = (
    await Promise.all(
      frames.map(async (frame, frameIndex) => {
        const offset = await getFrameOffset(frame);
        const frameElements = await frame
          .evaluate(`(${observeVisibleElementsScript})(${JSON.stringify(options)})`)
          .catch((error) => {
            if (frame === page.mainFrame()) throw error;
            return [];
          }) as RawBrowserObservedElement[];
        return frameElements.map((element: RawBrowserObservedElement) => ({
          ...element,
          x: element.x + offset.x,
          y: element.y + offset.y,
          centerX: element.centerX + offset.x,
          centerY: element.centerY + offset.y,
          documentX: element.documentX + offset.x,
          documentY: element.documentY + offset.y,
          frameIndex,
          frameUrl: frame.url(),
        }));
      }),
    )
  ).flat();

  const seen = new Set<string>();
  const needle = (options.text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const viewport = page.viewportSize();
  const score = (element: Omit<BrowserObservedElement, "index">) => {
    const text = element.text.toLowerCase();
    const exact = needle && text === needle ? 0 : 1;
    const controlPriority = ["button", "input", "select", "textarea"].includes(element.tag) ? 0 : element.tag === "a" ? 1 : Boolean(element.role) ? 2 : 3;
    const offscreen =
      viewport && element.centerX >= 0 && element.centerX <= viewport.width && element.centerY >= 0 && element.centerY <= viewport.height ? 0 : 1;
    const area = element.width * element.height;
    return exact * 1_000_000 + offscreen * 250_000 + controlPriority * 50_000 + area;
  };
  return raw
    .filter((element: Omit<BrowserObservedElement, "index">) => !options.enabledOnly || element.enabled)
    .filter((element: Omit<BrowserObservedElement, "index">) => !options.externalActionSafe || !isExternalActionUnsafeCandidate(element))
    .sort((a: Omit<BrowserObservedElement, "index">, b: Omit<BrowserObservedElement, "index">) => score(a) - score(b) || a.y - b.y || a.x - b.x)
    .filter((element: Omit<BrowserObservedElement, "index">) => {
      const key = `${element.text}|${element.centerX}|${element.centerY}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map((element: Omit<BrowserObservedElement, "index">, index: number) => ({ index, ...element }));
}

function isExternalActionUnsafeCandidate(element: Omit<BrowserObservedElement, "index">): boolean {
  const text = normalizeForSafety([element.text, element.ariaLabel, element.role].filter(Boolean).join(" "));
  const href = normalizeForSafety(element.href ?? "");
  const combined = `${text} ${href}`;

  if (/\bbusiness hours\b/i.test(combined)) return false;

  return (
    /(?:^|[\/\s_-])for[-_\s]?business(?:$|[\/\s_-])/i.test(combined) ||
    /(?:^|[\/\s_-])business(?:es)?(?:$|[\/\s_-])/i.test(href) ||
    /(?:^|[\/\s_-])partners?(?:$|[\/\s_-])/i.test(href) ||
    /(?:^|[\/\s_-])software(?:$|[\/\s_-])/i.test(combined) ||
    /(?:^|[\/\s_-])pricing(?:$|[\/\s_-])/i.test(href) ||
    /(?:^|[\/\s_-])demo(?:$|[\/\s_-])/i.test(combined) ||
    /\b(?:book|request|schedule)\s+(?:a\s+)?demo\b/i.test(combined) ||
    /\b(?:list|add)\s+(?:your\s+)?business\b/i.test(combined) ||
    /\bjoin\s+as\s+(?:a\s+)?(?:provider|professional|partner)\b/i.test(combined) ||
    /\b(?:salon|booking|appointment|practice|provider|business)\s+(?:management\s+)?software\b/i.test(combined) ||
    /\b(?:pos|crm)\b/i.test(text)
  );
}

function normalizeForSafety(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

export async function clickVisibleElement(page: Page, options: ObserveOptions & { index?: number } = {}): Promise<BrowserObservedElement | undefined> {
  const deadline = Date.now() + Math.max(0, Math.min(Math.floor(options.timeoutMs ?? 1000), 60_000));
  let target: BrowserObservedElement | undefined;
  do {
    let candidates: BrowserObservedElement[];
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 1500 }).catch(() => undefined);
      candidates = await observeVisibleElements(page, { ...options, enabledOnly: options.enabledOnly ?? true });
    } catch (error) {
      if (!isTransientNavigationError(error)) throw error;
      await page.waitForTimeout(250);
      continue;
    }
    target = candidates[Math.max(0, Math.floor(options.index ?? 0))];
    if (target) break;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  if (!target) return undefined;
  const viewport = page.viewportSize();
  if (viewport && (target.centerY < 0 || target.centerY > viewport.height || target.centerX < 0 || target.centerX > viewport.width)) {
    const frame = page.frames()[target.frameIndex] ?? page.mainFrame();
    const offset = await getFrameOffset(frame);
    await frame.evaluate((y) => window.scrollTo(0, Math.max(0, y - window.innerHeight / 2)), target.documentY - offset.y);
    await page.waitForTimeout(250);
    const visible = await observeVisibleElements(page, { ...options, enabledOnly: options.enabledOnly ?? true, viewportOnly: true, text: target.text || options.text });
    target = visible[0] ?? target;
  }
  await page.mouse.click(target.centerX, target.centerY);
  await page.waitForLoadState("domcontentloaded", { timeout: 1500 }).catch(() => undefined);
  return target;
}

function isTransientNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /execution context was destroyed|most likely because of a navigation|frame was detached|navigation/i.test(message);
}

async function getFrameOffset(frame: Frame): Promise<{ x: number; y: number }> {
  if (frame.parentFrame() === null) return { x: 0, y: 0 };
  try {
    const element = await frame.frameElement();
    const box = await element.boundingBox();
    return { x: Math.round(box?.x ?? 0), y: Math.round(box?.y ?? 0) };
  } catch {
    return { x: 0, y: 0 };
  }
}
