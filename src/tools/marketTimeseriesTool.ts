/**
 * Phase 13 follow-up: the in-process MarketTimeseriesTool class
 * has been removed in favour of the dockerized
 * market-timeseries-service. This file now exports only the
 * result-data shape and its type guard, which the runtime still
 * uses to recognise market.timeseries artifacts in tool results.
 */
import { ArtifactCreateInput } from "../types.js";

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

export function isMarketTimeseriesData(data: unknown): data is MarketTimeseriesData {
  return (
    Boolean(data) &&
    typeof data === "object" &&
    (data as { source?: unknown }).source === "coingecko" &&
    Array.isArray((data as { points?: unknown }).points) &&
    Boolean((data as { artifact?: unknown }).artifact)
  );
}
