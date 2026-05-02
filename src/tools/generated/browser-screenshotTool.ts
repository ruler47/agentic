import { chromium } from "@playwright/test";
import { Tool, ToolInput, ToolResult } from "../tool.js";

type ScreenshotData = {
  artifact: {
    filename: string;
    mimeType: "image/png";
    contentBase64: string;
    description: string;
  };
  url: string;
};

export const tool: Tool = {
  name: "generated.browser.screenshot",
  version: "1.0.0",
  description: "Captures a browser screenshot and returns it as an artifact payload.",
  capabilities: ["browser-screenshot", "browser-screenshot", "artifact-generation"],
  startupMode: "on-demand",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1 },
      filename: { type: "string" },
      fullPage: { type: "boolean" }
    },
    required: ["url"]
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: { type: "object", properties: { artifact: { type: "object" }, url: { type: "string" } } }
    },
    required: ["ok", "content"]
  },
  async healthcheck() {
    return { ok: true, detail: "Browser screenshot tool module is importable." };
  },
  async run(input: ToolInput): Promise<ToolResult> {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!url) return { ok: false, content: "browser screenshot requires a url input." };

    const parsed = parseHttpUrl(url);
    if (!parsed.ok) return { ok: false, content: parsed.error };

    const filename = typeof input.filename === "string" && input.filename.trim()
      ? safeFilename(input.filename)
      : screenshotFilename(parsed.url);
    const fullPage = typeof input.fullPage === "boolean" ? input.fullPage : true;
    const launchOptions = process.env.CHROMIUM_PATH
      ? { headless: true, executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] }
      : { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] };

    let browser;
    try {
      browser = await chromium.launch(launchOptions);
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto(parsed.url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(1000);
      const buffer = await page.screenshot({ type: "png", fullPage });
      const data: ScreenshotData = {
        artifact: {
          filename,
          mimeType: "image/png",
          contentBase64: buffer.toString("base64"),
          description: "Browser screenshot captured from " + parsed.url
        },
        url: parsed.url
      };

      return {
        ok: true,
        content: "Captured browser screenshot for " + parsed.url + ".",
        data
      };
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : "Browser screenshot failed."
      };
    } finally {
      await browser?.close();
    }
  }
};

export default tool;

function parseHttpUrl(value: string): { ok: true; url: string } | { ok: false; error: string } {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "Only http and https URLs are supported." };
    }
    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false, error: "Invalid URL." };
  }
}

function screenshotFilename(url: string): string {
  const parsed = new URL(url);
  const slug = [parsed.hostname, parsed.pathname]
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return (slug || "browser-page") + "-screenshot.png";
}

function safeFilename(value: string): string {
  const trimmed = value.trim().replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120);
  return trimmed.endsWith(".png") ? trimmed : trimmed + ".png";
}
