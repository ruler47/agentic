import test from "node:test";
import assert from "node:assert/strict";
import { MarketTimeseriesTool, isMarketTimeseriesData } from "../src/tools/marketTimeseriesTool.js";

test("MarketTimeseriesTool fetches CoinGecko data and returns a CSV artifact", async () => {
  const fetchCalls: string[] = [];
  const tool = new MarketTimeseriesTool("https://market.test/api/v3", async (input) => {
    fetchCalls.push(String(input));
    return new Response(
      JSON.stringify({
        prices: [
          [1777670400000, 100],
          [1777756800000, 112.5],
        ],
        market_caps: [
          [1777670400000, 1000],
          [1777756800000, 1125],
        ],
        total_volumes: [
          [1777670400000, 10],
          [1777756800000, 12],
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const result = await tool.run({ symbol: "BTC", vsCurrency: "usd", days: 7 });

  assert.equal(result.ok, true);
  assert.match(fetchCalls[0] ?? "", /coins\/bitcoin\/market_chart/);
  assert.match(fetchCalls[0] ?? "", /vs_currency=usd/);
  assert.match(fetchCalls[0] ?? "", /days=7/);
  assert.equal(isMarketTimeseriesData(result.data), true);
  assert.match(result.content, /Fetched 2 bitcoin\/USD market points/);
  const data = result.data as { artifact: { filename: string; mimeType: string; content: string } };
  assert.equal(data.artifact.filename, "bitcoin-usd-7d-timeseries.csv");
  assert.equal(data.artifact.mimeType, "text/csv");
  assert.match(data.artifact.content, /date,timestamp,symbol,price,market_cap,volume/);
  assert.match(data.artifact.content, /BTC,112.5,1125,12/);
});

test("MarketTimeseriesTool rejects unsupported symbols without a coin id", async () => {
  const tool = new MarketTimeseriesTool("https://market.test/api/v3", async () => {
    throw new Error("fetch should not be called");
  });

  const result = await tool.run({ symbol: "UNKNOWN" });

  assert.equal(result.ok, false);
  assert.match(result.content, /Unsupported market symbol/);
});

test("MarketTimeseriesTool preserves provider failures as structured failures", async () => {
  const tool = new MarketTimeseriesTool("https://market.test/api/v3", async () => new Response("nope", { status: 429 }));

  const result = await tool.run({ symbol: "SOL", days: 30 });

  assert.equal(result.ok, false);
  assert.match(result.content, /HTTP 429/);
});
