import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { extractPageAvailability } from "../src/tools/pageAvailability.js";

test("schema.org OutOfStock is read as out_of_stock", () => {
  const html = `<html><head><script type="application/ld+json">{"@type":"Product","offers":{"availability":"https://schema.org/OutOfStock"}}</script></head><body>Add to Bag</body></html>`;
  assert.equal(extractPageAvailability(html, "text/html").status, "out_of_stock");
});

test("disabled add-to-cart control is out_of_stock even with an Add to Bag label", () => {
  const html = `<html><body><button disabled="disabled" data-autom="add-to-cart">Add to Bag</button> $7,299</body></html>`;
  assert.equal(extractPageAvailability(html, "text/html").status, "out_of_stock");
});

test("visible 'no longer available' phrase is out_of_stock", () => {
  const html = `<html><body><p>the product you're looking for is no longer available on apple.com.</p></body></html>`;
  assert.equal(extractPageAvailability(html, "text/html").status, "out_of_stock");
});

test("Russian 'нет в наличии' is out_of_stock", () => {
  const html = `<html><body><div>Apple Mac Studio M3 Ultra — нет в наличии</div></body></html>`;
  assert.equal(extractPageAvailability(html, "text/html").status, "out_of_stock");
});

test("schema.org InStock is in_stock", () => {
  const html = `<html><head><script type="application/ld+json">{"offers":{"availability":"https://schema.org/InStock","price":"7299.00"}}</script></head><body>Add to Cart</body></html>`;
  assert.equal(extractPageAvailability(html, "text/html").status, "in_stock");
});

test("add-to-cart + price with no negative signal is in_stock", () => {
  const html = `<html><body><button>Add to Cart</button><span class="price">$7,299.00</span></body></html>`;
  assert.equal(extractPageAvailability(html, "text/html").status, "in_stock");
});

test("plain page with no commerce signal is unknown", () => {
  const html = `<html><body><article>An essay about the history of computing.</article></body></html>`;
  assert.equal(extractPageAvailability(html, "text/html").status, "unknown");
});

test("non-html content is unknown", () => {
  assert.equal(extractPageAvailability("some bytes", "image/png").status, "unknown");
});

// The live page the agent wrongly presented as "В наличии" in run_1782477247590: it carries
// schema.org OutOfStock + a disabled Add to Bag + a "no longer available" redirect notice.
test("real Apple refurb g1cejll page is out_of_stock (regression fixture)", () => {
  let html: string;
  try {
    html = readFileSync("/tmp/refurb.html", "utf8");
  } catch {
    return; // fixture only present right after the live capture; skip otherwise.
  }
  assert.equal(extractPageAvailability(html, "text/html").status, "out_of_stock");
});
