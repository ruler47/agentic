import assert from "node:assert/strict";
import test from "node:test";

import { applyToolIntegrationEditConstraints } from "../src/server/modules/tools/tool-integration-edit-constraints.js";
import type { ToolIntegrationContract } from "../src/tools/toolIntegrationContract.js";

test("tool edit constraints remove inherited targets forbidden by current context", () => {
  const contract = contractWithTargets([
    ["ethereum", "https://eth.example.test/api", ["eth"]],
    ["arbitrum", "https://arb.stage1.example.test/api", ["arb", "stage1"]],
  ]);

  const constrained = applyToolIntegrationEditConstraints(contract, [
    "Do not use stage1 unless it is explicitly present in supplied documentation.",
  ]);

  assert.deepEqual(constrained?.targets?.map((target) => target.id), ["ethereum"]);
  assert.match(constrained?.notes?.at(-1) ?? "", /Removed inherited integration endpoint/);
});

test("tool edit constraints preserve inherited targets without negative context", () => {
  const contract = contractWithTargets([
    ["ethereum", "https://eth.example.test/api", ["eth"]],
    ["arbitrum", "https://arb.stage1.example.test/api", ["arb", "stage1"]],
  ]);

  const constrained = applyToolIntegrationEditConstraints(contract, [
    "Use stored tool context and preserve generic target selection.",
  ]);

  assert.deepEqual(constrained?.targets?.map((target) => target.id), ["ethereum", "arbitrum"]);
});

function contractWithTargets(targets: Array<[string, string, string[]]>): ToolIntegrationContract {
  return {
    schemaVersion: "agentic.tool-integration.v1",
    mode: "run-on-demand",
    protocol: "http-api",
    baseUrl: "https://eth.example.test/api",
    targets: targets.map(([id, baseUrl, aliases]) => ({ id, baseUrl, aliases })),
    operations: [{ name: "getAddress", direction: "query", method: "GET", path: "/address/{address}" }],
  };
}
