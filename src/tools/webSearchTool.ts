import { Tool, ToolInput, ToolResult } from "./tool.js";

type SearxngResult = {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
};

type SearxngResponse = {
  results?: SearxngResult[];
};

export class WebSearchTool implements Tool {
  readonly name = "web.search";
  readonly version = "1.0.0";
  readonly description = "Searches the web through a SearXNG-compatible JSON endpoint.";
  readonly capabilities = ["web-search", "research", "current-information"];
  readonly startupMode = "always-on";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "number", minimum: 1, maximum: 10 },
    },
    required: ["query"],
  };
  readonly outputSchema = {
    type: "object" as const,
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: { type: "array" },
    },
    required: ["ok", "content"],
  };

  constructor(private readonly baseUrl = process.env.SEARXNG_BASE_URL ?? "http://searxng:8080") {}

  async healthcheck() {
    try {
      const url = new URL("/", this.baseUrl);
      const response = await fetch(url, { headers: { accept: "text/html,application/json" } });
      return {
        ok: response.ok,
        detail: response.ok ? "SearXNG is reachable." : `SearXNG returned HTTP ${response.status}.`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "SearXNG healthcheck failed.",
      };
    }
  }

  async run(input: ToolInput): Promise<ToolResult> {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    const limit = typeof input.limit === "number" ? input.limit : 5;

    if (!query) {
      return { ok: false, content: "Missing search query." };
    }

    const url = new URL("/search", this.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("language", "en");

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: "application/json" },
      });
    } catch (error) {
      return {
        ok: false,
        content: `Search provider is unreachable: ${error instanceof Error ? error.message : "request failed"}.`,
        data: [],
      };
    }

    if (!response.ok) {
      return { ok: false, content: `Search failed with HTTP ${response.status}.` };
    }

    let data: SearxngResponse;
    try {
      data = (await response.json()) as SearxngResponse;
    } catch (error) {
      return {
        ok: false,
        content: `Search provider returned invalid JSON: ${error instanceof Error ? error.message : "parse failed"}.`,
        data: [],
      };
    }
    const results = (data.results ?? []).slice(0, limit);

    if (results.length === 0) {
      return { ok: true, content: "No search results found.", data: [] };
    }

    return {
      ok: true,
      content: results
        .map((result, index) => {
          const title = result.title ?? "Untitled";
          const link = result.url ?? "No URL";
          const snippet = result.content ?? "No snippet.";
          return `${index + 1}. ${title}\n${link}\n${snippet}`;
        })
        .join("\n\n"),
      data: results,
    };
  }
}

export function shouldUseWebSearch(text: string): boolean {
  return [
    "research",
    "current",
    "latest",
    "find",
    "найди",
    "актуаль",
    "исслед",
    "город",
    "community",
    "airport",
    "it sector",
    "crypto",
  ].some((marker) => text.toLowerCase().includes(marker));
}
