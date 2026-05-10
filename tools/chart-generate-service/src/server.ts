import { createServer, IncomingMessage, ServerResponse } from "node:http";
import {
  asksForChart,
  buildMultiLineChartSvg,
  extractTimeSeriesSets,
} from "./chartArtifact.ts";

const PORT = Number(process.env.PORT ?? 8080);
const VERSION = "1.0.0";

const description = {
  name: "chart.generate",
  version: VERSION,
  displayName: "Chart Generate",
  description: "Generates an SVG line-chart artifact from time-series text or JSON.",
  capabilities: ["chart-generation", "artifact-generation", "data-visualization"],
  startupMode: "on-demand" as const,
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

async function handleRun(rawInput: unknown) {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  const task = typeof input.task === "string" ? input.task : "";
  const text = typeof input.text === "string" ? input.text : "";
  if (!task || !text) return { ok: false, content: "chart.generate requires task and text inputs." };
  if (!asksForChart(task)) return { ok: false, content: "The task does not request a chart artifact." };

  const series = extractTimeSeriesSets(`${task}\n\n${text}`);
  const points = series.reduce((total, item) => total + item.points.length, 0);
  if (series.length === 0 || points < 2) {
    return { ok: false, content: "No parsable time series with at least two points was found." };
  }

  const filename = typeof input.filename === "string" ? input.filename : chartFilename(series);
  const title = typeof input.title === "string" ? input.title : chartTitle(series);
  const svg = buildMultiLineChartSvg(series, title);
  return {
    ok: true,
    content: `Generated ${filename} from ${points} time-series points across ${series.length} series.`,
    data: {
      artifact: {
        filename,
        mimeType: "image/svg+xml",
        contentBase64: Buffer.from(svg, "utf8").toString("base64"),
        description: `Generated SVG line chart from ${points} time-series points across ${series.length} series.`,
      },
      points,
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
      return send(res, 200, { ok: true, detail: "chart.generate is on-demand." });
    }
    send(res, 404, { error: `Unknown route ${method} ${url}` });
  } catch (error) {
    send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, () => console.log(`chart.generate service listening on port ${PORT}`));
