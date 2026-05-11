import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLineChartSvg,
  extractTimeSeries,
} from "../src/artifacts/chartArtifact.js";

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
