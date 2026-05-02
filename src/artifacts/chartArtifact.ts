export type TimeSeriesPoint = {
  label: string;
  value: number;
};

export type TimeSeries = {
  name: string;
  points: TimeSeriesPoint[];
};

export function asksForChart(task: string): boolean {
  return /\b(chart|graph|plot|diagram|visuali[sz]ation)\b|график|диаграм|картинк|изображ/i.test(task);
}

export function extractTimeSeries(text: string): TimeSeriesPoint[] {
  const series = extractTimeSeriesSets(text);
  if (series[0]?.points.length) return series[0].points;

  const points: TimeSeriesPoint[] = [];
  const datePricePattern =
    /(\d{4}-\d{2}-\d{2})["'\s,:-]+(?:price|close|value)?["'\s,:-]*\$?(-?\d+(?:\.\d+)?)/gi;
  for (const match of text.matchAll(datePricePattern)) {
    const label = match[1];
    const value = Number(match[2]);
    if (label && Number.isFinite(value)) points.push({ label, value });
  }

  return dedupePoints(points).slice(-180);
}

export function extractTimeSeriesSets(text: string): TimeSeries[] {
  const series: TimeSeries[] = [];
  const arrayKeyPattern = /"?([a-zA-Z][a-zA-Z0-9_. -]{0,63})"?\s*:\s*\[/g;

  for (const match of text.matchAll(arrayKeyPattern)) {
    if (match.index === undefined) continue;
    const arrayStart = text.indexOf("[", match.index);
    const arrayEnd = findMatchingBracket(text, arrayStart);
    if (arrayStart < 0 || arrayEnd < 0) continue;

    const points = parsePointArray(text.slice(arrayStart, arrayEnd + 1));
    if (points.length >= 2) {
      series.push({ name: normalizeSeriesName(match[1] ?? "series"), points });
    }
  }

  return dedupeSeries(series).slice(0, 6);
}

export function buildLineChartSvg(points: TimeSeriesPoint[], title: string): string {
  return buildMultiLineChartSvg([{ name: "Price", points }], title);
}

export function buildMultiLineChartSvg(series: TimeSeries[], title: string): string {
  const width = 1200;
  const height = 720;
  const padding = { top: 72, right: 52, bottom: 86, left: 88 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const normalizedSeries = series.filter((item) => item.points.length >= 2).slice(0, 6);
  const values = normalizedSeries.flatMap((item) => item.points.map((point) => point.value));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const yMin = min - range * 0.08;
  const yMax = max + range * 0.08;
  const yRange = yMax - yMin;
  const colors = ["#43d9b8", "#f4b860", "#7db7ff", "#ff6b7a", "#b38cff", "#d7f75e"];
  const renderedSeries = normalizedSeries.map((item, seriesIndex) => {
    const coordinates = item.points.map((point, index) => {
      const x = padding.left + (plotWidth * index) / Math.max(item.points.length - 1, 1);
      const y = padding.top + plotHeight - ((point.value - yMin) / yRange) * plotHeight;
      return { ...point, x, y };
    });
    const path = coordinates
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(" ");
    return {
      ...item,
      color: colors[seriesIndex % colors.length] ?? "#43d9b8",
      coordinates,
      path,
    };
  });
  const firstSeries = renderedSeries[0];
  const first = firstSeries.coordinates[0];
  const last = firstSeries.coordinates[firstSeries.coordinates.length - 1];
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const value = yMax - yRange * ratio;
    const y = padding.top + plotHeight * ratio;
    return { value, y };
  });
  const xLabels = selectLabels(firstSeries.coordinates);
  const legend = renderedSeries
    .map(
      (item, index) => `
  <circle cx="${padding.left + index * 150}" cy="62" r="6" fill="${item.color}"/>
  <text x="${padding.left + 12 + index * 150}" y="67" fill="#cfe2ec" font-family="Inter, Arial, sans-serif" font-size="15" font-weight="700">${escapeXml(item.name)}</text>`,
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(title)}</title>
  <desc id="desc">Line chart generated from ${values.length} time-series points across ${renderedSeries.length} series.</desc>
  <rect width="${width}" height="${height}" fill="#081019"/>
  <rect x="${padding.left}" y="${padding.top}" width="${plotWidth}" height="${plotHeight}" rx="12" fill="#101a25" stroke="#284457"/>
  <text x="${padding.left}" y="42" fill="#eef8f5" font-family="Inter, Arial, sans-serif" font-size="28" font-weight="700">${escapeXml(title)}</text>
  ${legend}
  ${ticks
    .map(
      (tick) => `
  <line x1="${padding.left}" y1="${tick.y.toFixed(2)}" x2="${padding.left + plotWidth}" y2="${tick.y.toFixed(2)}" stroke="#213442" />
  <text x="${padding.left - 14}" y="${(tick.y + 5).toFixed(2)}" text-anchor="end" fill="#96a8b5" font-family="Inter, Arial, sans-serif" font-size="16">${formatNumber(tick.value)}</text>`,
    )
    .join("")}
  ${xLabels
    .map(
      (point) => `
  <text x="${point.x.toFixed(2)}" y="${height - 38}" text-anchor="middle" fill="#96a8b5" font-family="Inter, Arial, sans-serif" font-size="15">${escapeXml(point.label)}</text>`,
    )
    .join("")}
  ${renderedSeries
    .map(
      (item) => `
  <path d="${item.path}" fill="none" stroke="${item.color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join("")}
  <circle cx="${first.x.toFixed(2)}" cy="${first.y.toFixed(2)}" r="7" fill="#7db7ff"/>
  <circle cx="${last.x.toFixed(2)}" cy="${last.y.toFixed(2)}" r="9" fill="#f4b860"/>
  <text x="${last.x.toFixed(2)}" y="${(last.y - 18).toFixed(2)}" text-anchor="middle" fill="#f4b860" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="700">${formatNumber(last.value)}</text>
  <text x="${padding.left}" y="${height - 16}" fill="#6f8291" font-family="Inter, Arial, sans-serif" font-size="13">Generated artifact. Source values come from agent-collected context and should be verified before important decisions.</text>
</svg>
`;
}

function parsePointArray(rawArray: string): TimeSeriesPoint[] {
  try {
    const raw = JSON.parse(rawArray) as unknown;
    if (!Array.isArray(raw)) return [];

    return dedupePoints(
      raw
        .map((item, index) => {
          if (!item || typeof item !== "object") return undefined;
          const candidate = item as Record<string, unknown>;
          const label =
            normalizeLabel(firstPresent(candidate, ["timestamp", "date", "time", "Date", "label", "name", "category", "day", "month"])) ??
            String(index + 1);
          const numericValue = firstNumericValue(candidate);
          return label && Number.isFinite(numericValue)
            ? { label, value: numericValue }
            : undefined;
        })
        .filter((point): point is TimeSeriesPoint => Boolean(point)),
    ).slice(-180);
  } catch {
    return [];
  }
}

function normalizeLabel(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;

  const timestampMs = value > 10_000_000_000 ? value : value * 1000;
  const date = new Date(timestampMs);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

function findMatchingBracket(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "[") depth += 1;
    if (text[index] === "]") depth -= 1;
    if (depth === 0) return index;
  }

  return -1;
}

function dedupeSeries(series: TimeSeries[]): TimeSeries[] {
  const seen = new Set<string>();
  return series.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}

function dedupePoints(points: TimeSeriesPoint[]): TimeSeriesPoint[] {
  const seen = new Set<string>();
  return points.filter((point) => {
    const key = `${point.label}:${point.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSeriesName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "history") return "Series";
  if (/^[a-z0-9]{2,5}$/i.test(trimmed)) return trimmed.toUpperCase();

  return trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function selectLabels(points: Array<TimeSeriesPoint & { x: number }>) {
  if (points.length <= 4) return points;

  const indexes = new Set([0, Math.floor(points.length / 3), Math.floor((points.length * 2) / 3), points.length - 1]);
  return [...indexes].map((index) => points[index]).filter((point): point is TimeSeriesPoint & { x: number } => Boolean(point));
}

function firstPresent(candidate: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (candidate[key] !== undefined && candidate[key] !== null) return candidate[key];
  }

  return undefined;
}

function firstNumericValue(candidate: Record<string, unknown>): number {
  const preferred = firstPresent(candidate, [
    "value",
    "price",
    "close",
    "y",
    "amount",
    "count",
    "total",
    "score",
    "metric",
    "Price",
    "Value",
  ]);
  const preferredNumber = typeof preferred === "number" ? preferred : Number(preferred);
  if (Number.isFinite(preferredNumber)) return preferredNumber;

  for (const [key, value] of Object.entries(candidate)) {
    if (/^(timestamp|date|time|label|name|category|day|month)$/i.test(key)) continue;
    const numericValue = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(numericValue)) return numericValue;
  }

  return Number.NaN;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: value < 10 ? 2 : 0,
    maximumFractionDigits: value < 10 ? 4 : 2,
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
