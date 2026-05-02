import {
  buildMultiLineChartSvg,
  extractTimeSeriesSets,
  asksForChart,
} from "../artifacts/chartArtifact.js";
import { ArtifactCreateInput } from "../types.js";
import { Tool, ToolInput, ToolResult } from "./tool.js";

type ChartToolData = {
  artifact: ArtifactCreateInput;
  points: number;
};

export class ChartGenerateTool implements Tool {
  readonly name = "chart.generate";
  readonly version = "1.0.0";
  readonly description = "Generates an SVG line-chart artifact from time-series text or JSON.";
  readonly capabilities = ["chart-generation", "artifact-generation", "data-visualization"];
  readonly startupMode = "on-demand";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      task: { type: "string", minLength: 1 },
      text: { type: "string", minLength: 1 },
      title: { type: "string" },
      filename: { type: "string" },
    },
    required: ["task", "text"],
  };
  readonly outputSchema = {
    type: "object" as const,
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: {
        type: "object",
        properties: {
          artifact: { type: "object" },
          points: { type: "number" },
        },
      },
    },
    required: ["ok", "content"],
  };

  async healthcheck() {
    return {
      ok: true,
      detail: "SVG chart generation is available in-process.",
    };
  }

  async run(input: ToolInput): Promise<ToolResult> {
    const task = typeof input.task === "string" ? input.task : "";
    const text = typeof input.text === "string" ? input.text : "";

    if (!task || !text) {
      return { ok: false, content: "chart.generate requires task and text inputs." };
    }
    if (!asksForChart(task)) {
      return { ok: false, content: "The task does not request a chart artifact." };
    }

    const series = extractTimeSeriesSets(`${task}\n\n${text}`);
    const pointCount = series.reduce((total, item) => total + item.points.length, 0);
    if (series.length === 0 || pointCount < 2) {
      return { ok: false, content: "No parsable time series with at least two points was found." };
    }

    const filename = typeof input.filename === "string" ? input.filename : chartFilename(series);
    const title = typeof input.title === "string" ? input.title : chartTitle(series);
    const artifact: ArtifactCreateInput = {
      filename,
      mimeType: "image/svg+xml",
      content: buildMultiLineChartSvg(series, title),
      description: `Generated SVG line chart from ${pointCount} time-series points across ${series.length} series.`,
    };
    const data: ChartToolData = { artifact, points: pointCount };

    return {
      ok: true,
      content: `Generated ${filename} from ${pointCount} time-series points across ${series.length} series.`,
      data,
    };
  }
}

function chartTitle(series: Array<{ name: string }>): string {
  const names = series.map((item) => item.name).filter(Boolean);
  if (names.length === 0) return "Time-Series Chart";
  if (names.length === 1) return `${names[0]} Chart`;
  if (names.length === 2) return `${names[0]} and ${names[1]} Chart`;

  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]} Chart`;
}

function chartFilename(series: Array<{ name: string }>): string {
  const slug = series
    .map((item) => item.name)
    .filter((name) => name && name !== "Series")
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `${slug || "time-series"}-chart.svg`;
}

export function isChartToolData(data: unknown): data is ChartToolData {
  return (
    Boolean(data) &&
    typeof data === "object" &&
    Boolean((data as { artifact?: unknown }).artifact) &&
    typeof (data as { points?: unknown }).points === "number"
  );
}
