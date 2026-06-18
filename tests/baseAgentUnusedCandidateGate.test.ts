import test from "node:test";
import assert from "node:assert/strict";

import { findUnusedScopedCandidate } from "../src/agents/baseAgentTrace.js";
import type { ToolCreationOutcome } from "../src/agents/baseAgentTypes.js";

function creationOutcome(overrides: Partial<ToolCreationOutcome>): ToolCreationOutcome {
  return {
    ok: true,
    toolName: "fixture.tool",
    toolVersion: "0.1.0",
    status: "registered",
    message: "fixture",
    scopedTool: { name: "fixture.tool", version: "0.1.0", description: "", capabilities: [], inputSchema: { type: "object", properties: {}, required: [] }, run: async () => ({ ok: true, content: "" }) },
    request: { name: "fixture.tool", request: "fixture" },
    ...overrides,
  } as ToolCreationOutcome;
}

test("host-attached initial candidates do not fail the run when unused", () => {
  const unused = findUnusedScopedCandidate({
    task: "Подготовь запись в барбершоп",
    toolCreationRequests: [
      creationOutcome({
        toolName: "external.action.reservation.https.example.com.reserve.commit",
        initialAttachment: true,
      }),
    ],
    toolEditRequests: [],
    usedScopedCandidates: new Map(),
  });
  assert.equal(unused, undefined);
});

test("agent-requested creations still trip the unused-candidate gate", () => {
  const unused = findUnusedScopedCandidate({
    task: "Подготовь запись в барбершоп",
    toolCreationRequests: [creationOutcome({ toolName: "agent.requested.tool" })],
    toolEditRequests: [],
    usedScopedCandidates: new Map(),
  });
  assert.equal(unused?.toolName, "agent.requested.tool");
});
