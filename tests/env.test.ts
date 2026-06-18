import assert from "node:assert/strict";
import test from "node:test";
import { readEnv } from "../src/server/config/env.js";

test("readEnv enables preinstalled core tools by default", () => {
  const previous = process.env.BUILTIN_TOOLS;
  delete process.env.BUILTIN_TOOLS;
  try {
    assert.equal(readEnv().builtinToolsEnabled, true);
  } finally {
    restoreEnv("BUILTIN_TOOLS", previous);
  }
});

test("readEnv can disable preinstalled core tools for focused tests", () => {
  const previous = process.env.BUILTIN_TOOLS;
  process.env.BUILTIN_TOOLS = "disabled";
  try {
    assert.equal(readEnv().builtinToolsEnabled, false);
  } finally {
    restoreEnv("BUILTIN_TOOLS", previous);
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
