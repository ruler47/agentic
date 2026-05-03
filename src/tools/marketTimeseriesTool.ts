import { ArtifactCreateInput } from "../types.js";
import { Tool, ToolInput, ToolResult } from "./tool.js";

export type MarketTimeseriesPoint = {
  date: string;
  timestamp: number;
  price: number;
  marketCap?: number;
  volume?: number;
};

export type MarketTimeseriesData = {
  source: "coingecko";
  symbol: string;
  coinId: string;
  vsCurrency: string;
  days: number;
  points: MarketTimeseriesPoint[];
  artifact: ArtifactCreateInput;
};

type CoinGeckoMarketChartResponse = {
  prices?: Array<[number, number]>;
  market_caps?: Array<[number, number]>;
  total_volumes?: Array<[number, number]>;
};

const coinIds: Record<string, string> = {
  btc: "bitcoin",
  bitcoin: "bitcoin",
  биткоин: "bitcoin",
  eth: "ethereum",
  ether: "ethereum",
  ethereum: "ethereum",
  эфир: "ethereum",
  sol: "solana",
  solana: "solana",
  солана: "solana",
  bnb: "binancecoin",
  xrp: "ripple",
  ada: "cardano",
  doge: "dogecoin",
  avax: "avalanche-2",
  dot: "polkadot",
  ton: "the-open-network",
};

export class MarketTimeseriesTool implements Tool {
  readonly name = "market.timeseries";
  readonly version = "1.0.0";
  readonly description = "Fetches structured crypto market time-series data and returns a CSV artifact.";
  readonly capabilities = ["market-timeseries", "crypto-timeseries", "structured-market-data"];
  readonly startupMode = "on-demand";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", minLength: 1 },
      coinId: { type: "string" },
      vsCurrency: { type: "string", default: "usd" },
      days: { type: "number", minimum: 1, maximum: 3650 },
    },
    required: ["symbol"],
  };
  readonly outputSchema = {
    type: "object" as const,
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: {
        type: "object",
        properties: {
          source: { type: "string" },
          symbol: { type: "string" },
          coinId: { type: "string" },
          vsCurrency: { type: "string" },
          days: { type: "number" },
          points: { type: "array" },
          artifact: { type: "object" },
        },
      },
    },
    required: ["ok", "content"],
  };

  constructor(
    private readonly baseUrl = process.env.COINGECKO_BASE_URL ?? "https://api.coingecko.com/api/v3",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async healthcheck() {
    try {
      const response = await this.fetcher(buildProviderUrl(this.baseUrl, "ping"));
      return {
        ok: response.ok,
        detail: response.ok ? "CoinGecko market data endpoint is reachable." : `CoinGecko returned HTTP ${response.status}.`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "Market data healthcheck failed.",
      };
    }
  }

  async run(input: ToolInput): Promise<ToolResult> {
    const symbol = typeof input.symbol === "string" ? input.symbol.trim() : "";
    const explicitCoinId = typeof input.coinId === "string" ? input.coinId.trim() : "";
    const coinId = explicitCoinId || resolveCoinId(symbol);
    const vsCurrency = normalizeCurrency(input.vsCurrency);
    const days = normalizeDays(input.days);

    if (!symbol && !explicitCoinId) {
      return { ok: false, content: "market.timeseries requires symbol or coinId." };
    }
    if (!coinId) {
      return {
        ok: false,
        content: `Unsupported market symbol "${symbol}". Provide a CoinGecko coinId to fetch this asset.`,
      };
    }

    const url = buildProviderUrl(this.baseUrl, `coins/${encodeURIComponent(coinId)}/market_chart`);
    url.searchParams.set("vs_currency", vsCurrency);
    url.searchParams.set("days", String(days));

    const response = await this.fetcher(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      return { ok: false, content: `Market data request failed with HTTP ${response.status}.` };
    }

    const payload = (await response.json()) as CoinGeckoMarketChartResponse;
    const points = normalizeMarketPoints(payload);
    if (points.length < 2) {
      return {
        ok: false,
        content: `Market data for ${coinId}/${vsCurrency} did not contain at least two price points.`,
      };
    }

    const canonicalSymbol = symbol || coinId;
    const csv = toCsv(points, canonicalSymbol);
    const artifact: ArtifactCreateInput = {
      filename: `${safeFilePart(coinId)}-${vsCurrency}-${days}d-timeseries.csv`,
      mimeType: "text/csv",
      content: csv,
      description: `Structured ${coinId}/${vsCurrency} market time-series from CoinGecko across ${points.length} points.`,
    };
    const data: MarketTimeseriesData = {
      source: "coingecko",
      symbol: canonicalSymbol,
      coinId,
      vsCurrency,
      days,
      points,
      artifact,
    };
    const first = points[0];
    const last = points[points.length - 1];
    const change = first && last ? ((last.price - first.price) / first.price) * 100 : 0;

    return {
      ok: true,
      content: [
        `Fetched ${points.length} ${coinId}/${vsCurrency.toUpperCase()} market points from CoinGecko for the last ${days} day(s).`,
        `First close: ${formatNumber(first?.price)} on ${first?.date}.`,
        `Latest close: ${formatNumber(last?.price)} on ${last?.date}.`,
        `Period change: ${formatNumber(change)}%.`,
      ].join("\n"),
      data,
    };
  }
}

export function isMarketTimeseriesData(data: unknown): data is MarketTimeseriesData {
  return (
    Boolean(data) &&
    typeof data === "object" &&
    (data as { source?: unknown }).source === "coingecko" &&
    Array.isArray((data as { points?: unknown }).points) &&
    Boolean((data as { artifact?: unknown }).artifact)
  );
}

function resolveCoinId(symbol: string): string | undefined {
  return coinIds[symbol.trim().toLowerCase()];
}

function buildProviderUrl(baseUrl: string, path: string): URL {
  return new URL(`${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
}

function normalizeCurrency(value: unknown): string {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "usd";
  return /^[a-z]{3,8}$/.test(candidate) ? candidate : "usd";
}

function normalizeDays(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 30;
  return Math.min(3650, Math.max(1, Math.floor(numeric)));
}

function normalizeMarketPoints(payload: CoinGeckoMarketChartResponse): MarketTimeseriesPoint[] {
  const marketCaps = new Map((payload.market_caps ?? []).map(([timestamp, value]) => [timestamp, value]));
  const volumes = new Map((payload.total_volumes ?? []).map(([timestamp, value]) => [timestamp, value]));
  return (payload.prices ?? [])
    .filter((point): point is [number, number] => Array.isArray(point) && point.length >= 2)
    .map(([timestamp, price]) => ({
      date: new Date(timestamp).toISOString().slice(0, 10),
      timestamp,
      price,
      marketCap: marketCaps.get(timestamp),
      volume: volumes.get(timestamp),
    }))
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.price));
}

function toCsv(points: MarketTimeseriesPoint[], symbol: string): string {
  return [
    "date,timestamp,symbol,price,market_cap,volume",
    ...points.map((point) =>
      [
        point.date,
        String(point.timestamp),
        symbol,
        String(point.price),
        point.marketCap === undefined ? "" : String(point.marketCap),
        point.volume === undefined ? "" : String(point.volume),
      ].join(","),
    ),
  ].join("\n");
}

function safeFilePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "market";
}

function formatNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "n/a";
  return Number(value.toFixed(4)).toLocaleString("en-US", { maximumFractionDigits: 4 });
}
