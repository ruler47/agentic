import test from "node:test";
import assert from "node:assert/strict";

import {
  classifySourceType,
  normalizeSourceUrl,
  sourceQualityScore,
  sourceUrlExclusionReason,
} from "../src/agents/sourceQuality.js";
import { readStatusFromToolResult, RunSourceRegistry } from "../src/agents/sourceRegistry.js";

test("source URL normalization strips tracking, secrets, hash, and host noise", () => {
  assert.equal(
    normalizeSourceUrl("HTTPS://www.Example.com/path/?utm_source=google&b=2&a=1&token=secret#section"),
    "https://example.com/path?a=1&b=2",
  );
  assert.equal(normalizeSourceUrl("file:///tmp/source.html"), undefined);
});

test("source classifier and score prefer primary/docs/product sources over social/roundups", () => {
  assert.equal(classifySourceType({ url: "https://developer.example.com/api/reference" }), "official_docs");
  assert.equal(classifySourceType({ url: "https://shop.example.com/products/laptop-1" }), "pricing");
  assert.equal(classifySourceType({ url: "https://reddit.com/r/laptops/comments/1" }), "social");
  assert.ok(
    sourceQualityScore({ sourceType: "official_docs", readStatus: "passed", url: "https://developer.example.com/api" }) >
      sourceQualityScore({ sourceType: "social", readStatus: "passed", url: "https://reddit.com/r/example" }),
  );
});

test("source exclusion detects technical assets and search result pages", () => {
  assert.equal(
    sourceUrlExclusionReason("https://www.cnet.com/_next/static/fonts/inter.woff2?cache=1"),
    "technical asset",
  );
  assert.equal(
    sourceUrlExclusionReason("https://www.youtube.com/results?search_query=best+laptop"),
    "search results page",
  );
  assert.equal(sourceUrlExclusionReason("https://www.notebookcheck.net/Lenovo-Legion-review.123.html"), undefined);
});

test("run source registry ignores low-value discovered URLs", () => {
  const registry = new RunSourceRegistry();
  const records = registry.recordDiscovery({
    urls: [
      "https://www.cnet.com/_next/static/fonts/inter.woff2",
      "https://www.youtube.com/results?search_query=best+laptop",
      "https://www.notebookcheck.net/Lenovo-Legion-review.123.html",
    ],
    toolName: "web.search",
    eventId: "search-1",
    query: "best laptop local llm gaming",
  });

  assert.equal(records.length, 1);
  assert.equal(records[0]?.normalizedUrl, "https://notebookcheck.net/Lenovo-Legion-review.123.html");
});

test("run source registry skips duplicate successful reads by normalized URL", () => {
  const registry = new RunSourceRegistry();
  const first = registry.recordRead({
    url: "https://www.example.com/article?utm_source=feed#intro",
    toolName: "web.read",
    eventId: "read-1",
    status: "passed",
    result: { ok: true, content: "Article content about the finalist." },
  });

  assert.ok(first);
  const skipped = registry.shouldSkipRead({ url: "https://example.com/article/" });

  assert.ok(skipped);
  assert.equal(skipped.record.sourceId, first.sourceId);
  assert.match(skipped.reason, /already read successfully/i);
});

test("run source registry blocks repeated failed reads unless strategy materially changes", () => {
  const registry = new RunSourceRegistry();
  registry.recordRead({
    url: "https://example.com/blocked",
    toolName: "web.read",
    eventId: "read-1",
    status: "blocked",
    reason: "Cloudflare security verification",
  });

  assert.match(registry.shouldSkipRead({ url: "https://example.com/blocked?utm_medium=x" })?.reason ?? "", /already blocked/i);
  assert.equal(
    registry.shouldSkipRead({ url: "https://example.com/blocked", selector: "main article" }),
    undefined,
  );
});

test("read status classifies provider blocks separately from normal failures", () => {
  assert.equal(readStatusFromToolResult({ ok: true, content: "ok" }), "passed");
  assert.equal(
    readStatusFromToolResult({ ok: false, content: "Performing security verification by Cloudflare" }),
    "blocked",
  );
  assert.equal(readStatusFromToolResult({ ok: false, content: "socket hang up" }), "failed");
});
