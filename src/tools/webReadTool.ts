import { Tool, ToolInput, ToolResult } from "./tool.js";

export class WebReadTool implements Tool {
  readonly name = "web.read";
  readonly version = "1.0.0";
  readonly description = "Reads a web page or HTTP resource and returns text, metadata, links, and optional raw content.";
  readonly capabilities = ["web-read", "page-reading", "research", "current-information", "html-extraction"];
  readonly startupMode = "always-on" as const;
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      url: { type: "string", minLength: 1 },
      format: { type: "string", enum: ["text", "html", "json"], default: "text" },
      maxBytes: { type: "number", minimum: 1000, maximum: 2_000_000, default: 250_000 },
      headers: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["url"],
  };
  readonly outputSchema = {
    type: "object" as const,
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: {
        type: "object",
        properties: {
          url: { type: "string" },
          finalUrl: { type: "string" },
          status: { type: "number" },
          contentType: { type: "string" },
          title: { type: "string" },
          links: { type: "array" },
          truncated: { type: "boolean" },
        },
      },
    },
    required: ["ok", "content"],
  };

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async healthcheck() {
    return { ok: true, detail: "web.read is available." };
  }

  async run(input: ToolInput): Promise<ToolResult> {
    const rawUrl = stringInput(input.url);
    if (!rawUrl) return { ok: false, content: "Missing URL." };

    const url = normalizeHttpUrl(rawUrl);
    if (!url.ok) return { ok: false, content: url.content };

    const maxBytes = boundedNumber(input.maxBytes, 250_000, 1_000, 2_000_000);
    const format = input.format === "html" || input.format === "json" ? input.format : "text";
    const headers = recordOfStrings(input.headers);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.fetchImpl(url.url, {
        headers: {
          "user-agent": "AgenticCoreToolbelt/1.0 (+https://local.agentic)",
          accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*",
          ...headers,
        },
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") ?? "";
      const bytes = Buffer.from(await response.arrayBuffer());
      const truncated = bytes.byteLength > maxBytes;
      const body = bytes.subarray(0, maxBytes).toString("utf8");
      const title = contentType.includes("html") ? extractTitle(body) : undefined;
      const links = contentType.includes("html") ? extractLinks(body, response.url).slice(0, 80) : [];
      const text = renderBody(body, contentType, format);

      return {
        ok: response.ok,
        content: response.ok
          ? text
          : `HTTP ${response.status} ${response.statusText}\n\n${text.slice(0, 2000)}`,
        data: {
          url: url.url,
          finalUrl: response.url,
          status: response.status,
          contentType,
          title,
          links,
          truncated,
          bytesRead: Math.min(bytes.byteLength, maxBytes),
        },
      };
    } catch (error) {
      return {
        ok: false,
        content: `web.read failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function renderBody(body: string, contentType: string, format: string): string {
  if (format === "html") return body;
  if (format === "json" || contentType.includes("application/json")) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  return contentType.includes("html") ? htmlToText(body) : body;
}

function normalizeHttpUrl(rawUrl: string): { ok: true; url: string } | { ok: false; content: string } {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, content: "Only http and https URLs are supported." };
    }
    return { ok: true, url: url.toString() };
  } catch {
    return { ok: false, content: "Invalid URL." };
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToText(match[1] ?? "").slice(0, 300) : undefined;
}

function extractLinks(html: string, baseUrl: string): Array<{ text: string; href: string }> {
  const links: Array<{ text: string; href: string }> = [];
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html))) {
    try {
      links.push({
        href: new URL(match[1] ?? "", baseUrl).toString(),
        text: htmlToText(match[2] ?? "").slice(0, 200),
      });
    } catch {
      // Ignore invalid relative links.
    }
  }
  return links;
}

function stringInput(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string") out[key] = nested;
  }
  return out;
}
