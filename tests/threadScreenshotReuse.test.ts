import test from "node:test";
import assert from "node:assert/strict";
import { __testing__ } from "../src/agents/universalAgent.js";

const { pickReusableThreadScreenshot } = __testing__;

const png = (id: string, filename: string) => ({
  id,
  filename,
  mimeType: "image/png",
  url: `/api/runs/run/artifacts/${id}`,
}) as any;

test("pickReusableThreadScreenshot returns undefined when thread has no PNG artifacts", () => {
  const out = pickReusableThreadScreenshot([], "Send me a screenshot of bitcoin price", []);
  assert.equal(out, undefined);
});

test("pickReusableThreadScreenshot ignores non-PNG artifacts", () => {
  const csv = { id: "a", filename: "bitcoin.csv", mimeType: "text/csv", url: "/x" } as any;
  const pdf = { id: "b", filename: "report.pdf", mimeType: "application/pdf", url: "/y" } as any;
  const out = pickReusableThreadScreenshot([csv, pdf], "Send a bitcoin screenshot", []);
  assert.equal(out, undefined);
});

test("pickReusableThreadScreenshot prefers a PNG whose filename matches task tokens", () => {
  const a = png("a", "discovery-1-coinmarketcap-com-bitcoin-screenshot.png");
  const b = png("b", "discovery-2-coingecko-com-bitcoin-screenshot.png");
  const c = png("c", "unrelated-cat-photo.png");
  const out = pickReusableThreadScreenshot([c, a, b], "А пришли скриншот цены биткоина как доказательство", []);
  assert.ok(out, "expected a match");
  assert.match(out!.filename!, /bitcoin/);
});

test("pickReusableThreadScreenshot prefers a PNG whose filename matches an intent token", () => {
  const a = png("a", "weather-overview.png");
  const b = png("b", "market-snapshot.png");
  const out = pickReusableThreadScreenshot([a, b], "Show me proof.", ["market-research"]);
  assert.equal(out?.id, "b");
});

test("pickReusableThreadScreenshot falls back to the latest PNG when nothing matches by token", () => {
  const a = png("a", "first-shot.png");
  const b = png("b", "later-shot.png");
  const out = pickReusableThreadScreenshot([a, b], "show me the picture", []);
  assert.equal(out?.id, "b");
});

test("pickReusableThreadScreenshot accepts a .png filename even when mimeType is generic", () => {
  const generic = { id: "x", filename: "snap.png", mimeType: "application/octet-stream", url: "/x" } as any;
  const out = pickReusableThreadScreenshot([generic], "screenshot", []);
  assert.equal(out?.id, "x");
});
