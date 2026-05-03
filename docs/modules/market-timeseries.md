# Market Timeseries Tool

`market.timeseries` is a reusable TypeScript tool for collecting structured crypto market
time-series data.

## Purpose

Use this module when an agent needs numeric price history before analysis, forecasting,
or chart generation. It avoids building charts from search snippets or prose-only model
answers.

## Contract

Tool name: `market.timeseries`

Capabilities:

- `market-timeseries`
- `crypto-timeseries`
- `structured-market-data`

Input:

```json
{
  "symbol": "BTC",
  "coinId": "bitcoin",
  "vsCurrency": "usd",
  "days": 30
}
```

`symbol` is required unless `coinId` is provided. Common symbols such as BTC, ETH, and
SOL are mapped to CoinGecko ids. `coinId` allows callers to request a supported
CoinGecko asset that is not in the local symbol map.

Output:

- human-readable summary;
- normalized points with `date`, `timestamp`, `price`, optional `marketCap`, and optional
  `volume`;
- a generated `text/csv` artifact containing the same data.

## Portability

The module depends only on the standard `fetch` API and the shared tool/artifact
contracts. It can be moved into another TypeScript project by copying:

- `src/tools/marketTimeseriesTool.ts`;
- `src/tools/tool.ts`;
- the `ArtifactCreateInput` type or equivalent artifact contract.

Set `COINGECKO_BASE_URL` to use a proxy or compatible endpoint.

## Limitations

- Current provider: CoinGecko market chart endpoint.
- Current asset class: crypto.
- Current granularity: whatever CoinGecko returns for the requested `days`.
- Planned work: provider fallback, OHLCV candles, equities/FX, and source-specific QA.
