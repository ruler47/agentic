/**
 * Phase 13 — dockerized market.timeseries tool service.
 * CoinGecko time-series fetcher; returns a CSV artifact.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
const VERSION = "1.0.0";
const COINGECKO_BASE = process.env.COINGECKO_BASE_URL ?? "https://api.coingecko.com/api/v3";

const description = {
  name: "market.timeseries",
  version: VERSION,
  displayName: "Market Time-Series",
  description: "Fetches structured crypto market time-series data and returns a CSV artifact.",
  capabilities: ["market-timeseries", "crypto-timeseries", "structured-market-data"],
  startupMode: "on-demand" as const,
};

const coinIds: Record<string, string> = {
  btc: "bitcoin", bitcoin: "bitcoin", биткоин: "bitcoin",
  eth: "ethereum", ether: "ethereum", ethereum: "ethereum", эфир: "ethereum",
  sol: "solana", solana: "solana", солана: "solana",
  bnb: "binancecoin", xrp: "ripple", ada: "cardano", doge: "dogecoin",
  avax: "avalanche-2", dot: "polkadot", ton: "the-open-network",
};

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}
function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function resolveCoinId(symbol: string): string | undefined {
  return coinIds[symbol.trim().toLowerCase()];
}
function buildProviderUrl(base: string, path: string): URL {
  return new URL(`${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
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

type CGResp = { prices?: Array<[number, number]>; market_caps?: Array<[number, number]>; total_volumes?: Array<[number, number]> };
type Point = { date: string; timestamp: number; price: number; marketCap?: number; volume?: number };

function normalizePoints(payload: CGResp): Point[] {
  const caps = new Map((payload.market_caps ?? []).map(([t, v]) => [t, v]));
  const vols = new Map((payload.total_volumes ?? []).map(([t, v]) => [t, v]));
  return (payload.prices ?? [])
    .filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2)
    .map(([t, price]) => ({
      date: new Date(t).toISOString().slice(0, 10),
      timestamp: t, price,
      marketCap: caps.get(t),
      volume: vols.get(t),
    }))
    .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.price));
}

function toCsv(points: Point[], symbol: string): string {
  return [
    "date,timestamp,symbol,price,market_cap,volume",
    ...points.map((p) => [
      p.date, String(p.timestamp), symbol, String(p.price),
      p.marketCap === undefined ? "" : String(p.marketCap),
      p.volume === undefined ? "" : String(p.volume),
    ].join(",")),
  ].join("\n");
}
function safeFilePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "market";
}
function fmt(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "n/a";
  return Number(v.toFixed(4)).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

async function handleRun(rawInput: unknown) {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  const symbol = typeof input.symbol === "string" ? input.symbol.trim() : "";
  const explicit = typeof input.coinId === "string" ? input.coinId.trim() : "";
  const coinId = explicit || resolveCoinId(symbol);
  const vs = normalizeCurrency(input.vsCurrency);
  const days = normalizeDays(input.days);

  if (!symbol && !explicit) return { ok: false, content: "market.timeseries requires symbol or coinId." };
  if (!coinId) return { ok: false, content: `Unsupported market symbol "${symbol}". Provide a CoinGecko coinId to fetch this asset.` };

  const url = buildProviderUrl(COINGECKO_BASE, `coins/${encodeURIComponent(coinId)}/market_chart`);
  url.searchParams.set("vs_currency", vs);
  url.searchParams.set("days", String(days));

  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) return { ok: false, content: `Market data request failed with HTTP ${response.status}.` };

  const payload = (await response.json()) as CGResp;
  const points = normalizePoints(payload);
  if (points.length < 2) {
    return { ok: false, content: `Market data for ${coinId}/${vs} did not contain at least two price points.` };
  }
  const canonical = symbol || coinId;
  const csv = toCsv(points, canonical);
  const first = points[0];
  const last = points[points.length - 1];
  const change = first && last ? ((last.price - first.price) / first.price) * 100 : 0;
  return {
    ok: true,
    content: [
      `Fetched ${points.length} ${coinId}/${vs.toUpperCase()} market points from CoinGecko for the last ${days} day(s).`,
      `First close: ${fmt(first?.price)} on ${first?.date}.`,
      `Latest close: ${fmt(last?.price)} on ${last?.date}.`,
      `Period change: ${fmt(change)}%.`,
    ].join("\n"),
    data: {
      source: "coingecko",
      symbol: canonical,
      coinId,
      vsCurrency: vs,
      days,
      points,
      artifact: {
        filename: `${safeFilePart(coinId)}-${vs}-${days}d-timeseries.csv`,
        mimeType: "text/csv",
        contentBase64: Buffer.from(csv, "utf8").toString("base64"),
        description: `Structured ${coinId}/${vs} market time-series from CoinGecko across ${points.length} points.`,
      },
    },
  };
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "";
  const method = (req.method ?? "GET").toUpperCase();
  try {
    if (method === "GET" && url === "/describe") return send(res, 200, description);
    if (method === "GET" && url === "/health") return send(res, 200, { status: "ok", version: VERSION });
    if (method === "POST" && url === "/run") {
      const body = (await readJsonBody(req)) as { input?: unknown };
      return send(res, 200, await handleRun(body?.input));
    }
    if (method === "POST" && (url === "/service/start" || url === "/service/stop")) {
      return send(res, 200, { ok: true, detail: "market.timeseries is on-demand." });
    }
    send(res, 404, { error: `Unknown route ${method} ${url}` });
  } catch (error) {
    send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});
server.listen(PORT, () => console.log(`market.timeseries service listening on port ${PORT}`));
