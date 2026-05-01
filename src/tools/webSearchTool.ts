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
  readonly description = "Searches the web through a SearXNG-compatible JSON endpoint.";
  readonly capabilities = ["web-search", "research", "current-information"];

  constructor(private readonly baseUrl = process.env.SEARXNG_BASE_URL ?? "http://searxng:8080") {}

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

    const response = await fetch(url, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      return { ok: false, content: `Search failed with HTTP ${response.status}.` };
    }

    const data = (await response.json()) as SearxngResponse;
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
