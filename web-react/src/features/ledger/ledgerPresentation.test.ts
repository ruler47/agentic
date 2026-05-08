import { describe, expect, it } from "vitest";
import {
  buildLedgerAttentionQueue,
  evidenceByWorkItem,
  filterLedgerItems,
  isReusableWorkItem,
  summarizeLedgerHealth,
  workStatusTone,
} from "@/features/ledger/ledgerPresentation";
import type { EvidenceRecord, RunRetrospectiveRecord, WorkLedgerItem } from "@/api/types";

const baseWork: WorkLedgerItem = {
  id: "work_1",
  kind: "search",
  status: "completed",
  workKey: "search:bitcoin price",
  title: "Bitcoin price search",
  sourceUrls: [],
  artifactIds: [],
  evidenceIds: ["ev_1"],
  createdAt: "2026-05-08T00:00:00.000Z",
  updatedAt: "2026-05-08T00:00:00.000Z",
};

const baseEvidence: EvidenceRecord = {
  id: "ev_1",
  kind: "search_result",
  title: "CoinMarketCap result",
  qaStatus: "passed",
  limitations: [],
  createdAt: "2026-05-08T00:00:00.000Z",
};

const baseRetro: RunRetrospectiveRecord = {
  id: "retro_1",
  runId: "run_1",
  status: "proposed",
  runOutcome: "completed",
  whatWorked: ["Search reused evidence"],
  whatFailed: [],
  suspectedRootCauses: [],
  duplicatedWork: ["Second branch repeated price search"],
  weakTools: [],
  weakModels: [],
  missingCapabilities: [],
  usefulEvidenceIds: ["ev_1"],
  proposedMemoryIds: [],
  proposedToolInvestigationIds: [],
  proposedPolicyChanges: [],
  proposedPromptChanges: [],
  createdAt: "2026-05-08T00:00:00.000Z",
  updatedAt: "2026-05-08T00:00:00.000Z",
};

describe("ledger presentation helpers", () => {
  it("summarizes active work, weak evidence, retrospectives, and duplicate signals", () => {
    const health = summarizeLedgerHealth({
      workItems: [baseWork, { ...baseWork, id: "work_2", status: "running", evidenceIds: [] }],
      evidence: [baseEvidence, { ...baseEvidence, id: "ev_2", qaStatus: "partial" }],
      retrospectives: [baseRetro],
    });
    expect(health.active).toBe(1);
    expect(health.reusable).toBe(1);
    expect(health.weakEvidence).toBe(1);
    expect(health.proposedRetrospectives).toBe(1);
    expect(health.duplicatedWork).toBe(1);
    expect(health.headline).toContain("active claim");
  });

  it("filters all three ledgers with the same search text", () => {
    const filtered = filterLedgerItems({
      workItems: [baseWork],
      evidence: [baseEvidence],
      retrospectives: [baseRetro],
      search: "coinmarketcap",
    });
    expect(filtered.workItems).toHaveLength(0);
    expect(filtered.evidence).toHaveLength(1);
    expect(filtered.retrospectives).toHaveLength(0);
  });

  it("maps work statuses to consistent tones", () => {
    expect(workStatusTone("completed")).toBe("ok");
    expect(workStatusTone("running")).toBe("running");
    expect(workStatusTone("stale")).toBe("warn");
    expect(workStatusTone("failed")).toBe("danger");
    expect(workStatusTone("cancelled")).toBe("muted");
  });

  it("builds an operator attention queue from failed work, weak evidence, and proposed retrospectives", () => {
    const queue = buildLedgerAttentionQueue({
      workItems: [{ ...baseWork, status: "failed", error: "Search provider blocked" }],
      evidence: [{ ...baseEvidence, id: "ev_weak", qaStatus: "partial", limitations: ["Screenshot only showed a loader"] }],
      retrospectives: [baseRetro],
    });

    expect(queue.map((item) => item.kind)).toEqual(["work", "evidence", "retrospective"]);
    expect(queue[0]?.tone).toBe("danger");
    expect(queue[1]?.summary).toContain("loader");
  });

  it("groups evidence by work item and treats linked passed evidence as reusable", () => {
    const grouped = evidenceByWorkItem([{ ...baseEvidence, workItemId: "work_1" }]);
    expect(grouped.get("work_1")).toHaveLength(1);
    expect(isReusableWorkItem({ ...baseWork, evidenceIds: [] }, grouped.get("work_1"))).toBe(true);
    expect(isReusableWorkItem({ ...baseWork, status: "running" }, grouped.get("work_1"))).toBe(false);
  });
});
