import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Tool, ToolInput, ToolResult } from "./tool.js";
import { htmlToText } from "./webReadTool.js";

export class DocumentExtractTool implements Tool {
  readonly name = "document.extract";
  readonly version = "1.0.0";
  readonly description = "Extracts text and metadata from text, HTML, JSON, CSV, PDF, and DOCX inputs.";
  readonly capabilities = ["document-extract", "pdf-extract", "docx-extract", "html-extraction", "text-extraction"];
  readonly startupMode = "always-on" as const;
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      contentBase64: { type: "string" },
      url: { type: "string" },
      mimeType: { type: "string" },
      maxChars: { type: "number", minimum: 1000, maximum: 1_000_000, default: 200_000 },
    },
  };
  readonly outputSchema = {
    type: "object" as const,
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: { type: "object" },
    },
    required: ["ok", "content"],
  };

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async healthcheck() {
    return { ok: true, detail: "document.extract is available." };
  }

  async run(input: ToolInput): Promise<ToolResult> {
    const maxChars = boundedNumber(input.maxChars, 200_000, 1000, 1_000_000);
    const source = await this.loadSource(input);
    if (!source.ok) return source;

    const mimeType = detectMimeType(input.mimeType, source.path, source.buffer, source.contentType);
    try {
      const extracted = await extractByMime(source.buffer, mimeType);
      const text = extracted.text.slice(0, maxChars);
      return {
        ok: true,
        content: text,
        data: {
          mimeType,
          source: source.description,
          chars: extracted.text.length,
          truncated: extracted.text.length > maxChars,
          metadata: extracted.metadata,
        },
      };
    } catch (error) {
      return {
        ok: false,
        content: `document.extract failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async loadSource(input: ToolInput): Promise<
    | { ok: true; buffer: Buffer; description: string; path?: string; contentType?: string }
    | { ok: false; content: string }
  > {
    if (typeof input.content === "string") {
      return { ok: true, buffer: Buffer.from(input.content, "utf8"), description: "inline content" };
    }
    if (typeof input.contentBase64 === "string") {
      return { ok: true, buffer: Buffer.from(input.contentBase64, "base64"), description: "inline base64 content" };
    }
    if (typeof input.url === "string" && input.url.trim()) {
      const url = new URL(input.url.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { ok: false, content: "Only http and https URLs are supported." };
      }
      const response = await this.fetchImpl(url, { headers: { accept: "*/*" } });
      if (!response.ok) return { ok: false, content: `Fetch failed with HTTP ${response.status}.` };
      return {
        ok: true,
        buffer: Buffer.from(await response.arrayBuffer()),
        description: url.toString(),
        contentType: response.headers.get("content-type") ?? undefined,
      };
    }
    if (typeof input.path === "string" && input.path.trim()) {
      const path = resolve(process.env.FILE_TOOL_ROOT ?? "workspace", input.path.trim());
      return { ok: true, buffer: await readFile(path), description: input.path.trim(), path };
    }
    return { ok: false, content: "Provide content, contentBase64, url, or path." };
  }
}

async function extractByMime(buffer: Buffer, mimeType: string): Promise<{ text: string; metadata: Record<string, unknown> }> {
  if (mimeType.includes("pdf")) {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const [textResult, infoResult] = await Promise.all([parser.getText(), parser.getInfo().catch(() => undefined)]);
      return {
        text: textResult.text ?? "",
        metadata: {
          pages: textResult.pages?.length,
          info: infoResult,
        },
      };
    } finally {
      await parser.destroy();
    }
  }
  if (mimeType.includes("wordprocessingml") || mimeType.includes("docx")) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value, metadata: { messages: result.messages } };
  }
  const text = buffer.toString("utf8");
  if (mimeType.includes("html")) return { text: htmlToText(text), metadata: {} };
  if (mimeType.includes("json")) {
    try {
      return { text: JSON.stringify(JSON.parse(text), null, 2), metadata: {} };
    } catch {
      return { text, metadata: { warning: "Invalid JSON; returned raw text." } };
    }
  }
  return { text, metadata: {} };
}

function detectMimeType(
  explicit: unknown,
  path: string | undefined,
  buffer: Buffer,
  contentType: string | undefined,
): string {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim().toLowerCase();
  if (contentType) return contentType.split(";")[0]?.trim().toLowerCase() ?? "text/plain";
  const lowerPath = path?.toLowerCase() ?? "";
  if (lowerPath.endsWith(".pdf") || buffer.subarray(0, 4).toString("utf8") === "%PDF") return "application/pdf";
  if (lowerPath.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lowerPath.endsWith(".html") || lowerPath.endsWith(".htm")) return "text/html";
  if (lowerPath.endsWith(".json")) return "application/json";
  if (lowerPath.endsWith(".csv")) return "text/csv";
  return "text/plain";
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
