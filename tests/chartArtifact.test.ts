import test from "node:test";
import assert from "node:assert/strict";
import {
  asksForChart,
  buildLineChartSvg,
  extractTimeSeriesSets,
  extractTimeSeries,
} from "../src/artifacts/chartArtifact.js";
import { ChartGenerateTool, isChartToolData } from "../src/tools/chartGenerateTool.js";

test("chart artifact helper extracts history arrays and renders SVG", () => {
  const text = `
  \`\`\`json
  {
    "current_price": 145.2,
    "history": [
      {"timestamp": "2026-04-29", "price": 140.1},
      {"timestamp": "2026-04-30", "price": 142.7},
      {"timestamp": "2026-05-01", "price": 145.2}
    ]
  }
  \`\`\``;

  const points = extractTimeSeries(text);
  const svg = buildLineChartSvg(points, "Price Movement");

  assert.equal(points.length, 3);
  assert.equal(points[2].value, 145.2);
  assert.match(svg, /<svg/);
  assert.match(svg, /Price Movement/);
});

test("ChartGenerateTool creates an SVG artifact only when requested", async () => {
  const tool = new ChartGenerateTool();
  const text = `{"history":[{"timestamp":"2026-04-30","price":142},{"timestamp":"2026-05-01","price":145}]}`;
  const ignored = await tool.run({ task: "just tell me the price", text });
  const generated = await tool.run({ task: "покажи график метрики", text });
  const generatedFromTask = await tool.run({
    task: `покажи график ${text}`,
    text: "same data is in task",
  });

  assert.equal(tool.name, "chart.generate");
  assert.equal(tool.capabilities.includes("chart-generation"), true);
  assert.equal(asksForChart("покажи график по метрикам"), true);
  assert.equal(ignored.ok, false);
  assert.equal(generated.ok, true);
  assert.equal(isChartToolData(generated.data), true);
  assert.equal(isChartToolData(generated.data) && generated.data.artifact.filename, "time-series-chart.svg");
  assert.equal(isChartToolData(generatedFromTask.data) && generatedFromTask.data.artifact.mimeType, "image/svg+xml");
});

test("ChartGenerateTool supports arbitrary keyed time-series arrays", async () => {
  const tool = new ChartGenerateTool();
  const text = JSON.stringify({
    alphaRevenue: [
      { timestamp: 1713571200, price: 64250.5 },
      { timestamp: 1713574800, price: 64310.2 },
    ],
    betaUsers: [
      { day: "Monday", users: 3100 },
      { day: "Tuesday", users: 3120 },
    ],
  });
  const series = extractTimeSeriesSets(text);
  const generated = await tool.run({ task: "покажи график по этим данным", text });

  assert.deepEqual(series.map((item) => item.name), ["Alpha Revenue", "Beta Users"]);
  assert.equal(series[0].points[0].label, "2024-04-20");
  assert.equal(series[1].points[0].value, 3100);
  assert.equal(generated.ok, true);
  assert.equal(isChartToolData(generated.data) && generated.data.points, 4);
  assert.equal(isChartToolData(generated.data) && generated.data.artifact.filename, "alpha-revenue-beta-users-chart.svg");
  assert.match(
    String(isChartToolData(generated.data) && generated.data.artifact.content),
    /Alpha Revenue and Beta Users Chart/,
  );
});
