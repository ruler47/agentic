import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { ToolRegistryAdminService } from "../src/server/modules/tools/tool-registry-admin.service.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import type { AgentEvent } from "../src/types.js";

class FakeAudit {
  async record() {}
  async list() {
    return [];
  }
}

test("ToolRegistryAdminService exposes completed run-scoped candidate evidence", async () => {
  const metadata = new InMemoryToolMetadataStore();
  const runs = new InMemoryRunStore();
  const name = "generated.test.candidate-evidence";
  await metadata.registerGenerated({
    name,
    version: "0.1.0",
    description: "Active baseline.",
    capabilities: ["candidate-evidence"],
  });
  await metadata.registerGenerated({
    name,
    version: "0.1.1",
    description: "Candidate.",
    capabilities: ["candidate-evidence"],
  });
  const run = await runs.create("Use candidate version");
  await runs.markRunning(run.id);
  await runs.appendEvent(run.id, candidateEvent(run.id, name, "0.1.1"));
  await runs.complete(run.id, {
    finalAnswer: "Candidate worked.",
    complexity: { mode: "direct", reason: "test", domains: [], riskLevel: "low" },
    subtasks: [],
    workerResults: [],
    reviews: [],
  });

  const service = new ToolRegistryAdminService(
    undefined,
    metadata,
    undefined,
    undefined,
    undefined,
    new FakeAudit() as never,
    undefined,
    undefined,
    runs,
  );
  const candidate = (await service.listVersions(name)).find((version) => version.version === "0.1.1");
  assert.equal(candidate?.runScopedCandidateEvidence?.successCount, 1);
  assert.equal(candidate?.runScopedCandidateEvidence?.latestSuccess?.runId, run.id);
});

function candidateEvent(runId: string, toolName: string, toolVersion: string): AgentEvent {
  const timestamp = new Date().toISOString();
  return {
    id: "event_candidate_review",
    spanId: `${runId}:candidate-review`,
    type: "tool-candidate-manual-review-required",
    actor: toolName,
    activity: "tool",
    status: "completed",
    title: "Run-scoped tool candidate needs manual review",
    timestamp,
    completedAt: timestamp,
    payload: { toolName, toolVersion, promotionPolicy: "manual" },
  };
}
