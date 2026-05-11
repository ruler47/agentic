import test from "node:test";
import assert from "node:assert/strict";
import { __testing__ } from "../src/agents/universalAgent.js";

const { formatScreenshotReuseDirective } = __testing__ as {
  formatScreenshotReuseDirective: (task: string, artifacts: any[] | undefined) => string | undefined;
};

const png = (id: string, filename: string) =>
  ({ id, filename, mimeType: "image/png", url: `/x/${id}` }) as any;

test("directive is silent when task does not ask for a screenshot/proof", () => {
  const out = formatScreenshotReuseDirective("какая цена биткоина", [png("a", "snap.png")]);
  assert.equal(out, undefined);
});

test("directive is silent when thread has no PNG artifacts", () => {
  const csv = { id: "c", filename: "data.csv", mimeType: "text/csv", url: "/c" } as any;
  const out = formatScreenshotReuseDirective("send me a screenshot proof", [csv]);
  assert.equal(out, undefined);
});

test("directive fires for English screenshot/proof phrasing with PNG artifacts", () => {
  const out = formatScreenshotReuseDirective(
    "Send me a screenshot as proof of the bitcoin price",
    [png("a", "btc-coingecko.png"), png("b", "btc-coinmarketcap.png")],
  );
  assert.ok(out, "expected directive");
  assert.match(out!, /Screenshot reuse directive/);
  assert.match(out!, /Do NOT plan a fresh/);
  assert.match(out!, /btc-coingecko\.png/);
  assert.match(out!, /btc-coinmarketcap\.png/);
});

test("directive fires for Russian скриншот/доказательство phrasing", () => {
  const out = formatScreenshotReuseDirective(
    "А пришли скриншот как доказательство",
    [png("a", "btc.png")],
  );
  assert.ok(out, "expected directive for Russian phrasing");
  assert.match(out!, /reusable PNG artifact/);
});

test("directive fires for Russian пруф phrasing", () => {
  const out = formatScreenshotReuseDirective("дай пруф", [png("a", "x.png")]);
  assert.ok(out);
});

test("directive ignores non-PNG image siblings even if other artifacts exist", () => {
  const jpg = { id: "j", filename: "scan.jpg", mimeType: "image/jpeg", url: "/j" } as any;
  const csv = { id: "c", filename: "data.csv", mimeType: "text/csv", url: "/c" } as any;
  const out = formatScreenshotReuseDirective("show me a screenshot", [jpg, csv]);
  assert.equal(out, undefined);
});

test("directive accepts a .png filename even with generic mimeType", () => {
  const generic = { id: "g", filename: "screenshot.png", mimeType: "application/octet-stream", url: "/g" } as any;
  const out = formatScreenshotReuseDirective("дай скриншот", [generic]);
  assert.ok(out);
  assert.match(out!, /screenshot\.png/);
});
