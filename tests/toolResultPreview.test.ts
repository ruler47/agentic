import test from "node:test";
import assert from "node:assert/strict";

import {
  extractPrimaryResultFields,
  renderData,
  renderToolResultForModel,
} from "../src/agents/baseAgentToolMessages.js";
import type { ToolResult } from "../src/tools/tool.js";

// Regression for run_1782463954352_6hoo796a: a web.read on a 403 (e.g. dns-shop.ru)
// returns result.data with undefined-valued fields (finalUrl/contentType). renderData
// did `JSON.stringify(sanitize(value)).slice(...)`, and JSON.stringify(undefined) is
// undefined, so `.slice` threw "Cannot read properties of undefined (reading 'slice')",
// crashing the whole run after the tool had already done useful work. Tool data with an
// undefined field must render to a string, never throw.
test("renderData tolerates undefined-valued fields without crashing", () => {
  const data = {
    url: "https://www.dns-shop.ru/product/x/",
    finalUrl: undefined,
    status: 403,
    contentType: undefined,
    title: "Just a moment...",
    links: undefined,
    truncated: false,
    bytesRead: 0,
  };

  let rendered = "";
  assert.doesNotThrow(() => {
    rendered = renderData(data);
  });
  assert.equal(typeof rendered, "string");
  assert.match(rendered, /status: 403/);
  // undefined field renders as an empty value, not a crash.
  assert.match(rendered, /finalUrl: /);
});

test("renderToolResultForModel handles a failed read result with undefined data fields", () => {
  const result: ToolResult = {
    ok: false,
    content: "HTTP 403 Forbidden",
    data: {
      url: "https://www.dns-shop.ru/product/x/",
      finalUrl: undefined,
      status: 403,
      contentType: undefined,
      title: "Just a moment...",
      links: undefined,
    },
  } as ToolResult;

  let preview = "";
  assert.doesNotThrow(() => {
    preview = renderToolResultForModel(result);
  });
  assert.equal(typeof preview, "string");
  assert.ok(preview.length > 0);
});

test("extractPrimaryResultFields does not crash on undefined-valued primary fields", () => {
  assert.doesNotThrow(() => {
    extractPrimaryResultFields({ a: undefined, b: 1 });
  });
});
