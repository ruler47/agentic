import { describe, expect, it } from "vitest";

import type { ToolModuleMetadata } from "@/api/types";
import type { ToolVersionSummary } from "@/api/tools";

import {
  candidateRunLinks,
  candidateReviewStatus,
  collectCandidateReviewItems,
} from "./CandidateReviewQueue";

describe("CandidateReviewQueue presentation", () => {
  it("keeps decided active versions visible as activated history only when lifecycle recorded a decision", () => {
    const active = version({
      active: true,
      lifecycleEvents: [
        lifecycle("created", "2026-05-20T08:00:00.000Z"),
        lifecycle("activated", "2026-05-20T09:00:00.000Z", "run_decision"),
      ],
    });
    const staleBuiltinActive = version({ version: "0.1.0", active: true, lifecycleEvents: [] });

    expect(candidateReviewStatus(active, "0.1.2")).toBe("activated");
    expect(
      collectCandidateReviewItems([
        tool({
          version: "0.1.2",
          versions: [active, staleBuiltinActive] as unknown as ToolModuleMetadata["versions"],
        }),
      ]).map((item) => `${item.version.version}:${item.status}`),
    ).toEqual(["0.1.2:activated"]);
  });

  it("links a candidate to origin trace, evidence run, evidence trace, and decision trace", () => {
    const candidate = version({
      active: false,
      lifecycleEvents: [
        lifecycle("created", "2026-05-20T08:00:00.000Z", "run_origin"),
        lifecycle("activated", "2026-05-20T09:00:00.000Z", "run_decision"),
      ],
      runScopedCandidateEvidence: {
        successCount: 1,
        failureCount: 0,
        latestSuccess: {
          runId: "run_evidence",
          ranAt: "2026-05-20T08:30:00.000Z",
        },
        requiredForActivation: true,
      },
    });

    const [item] = collectCandidateReviewItems([
      tool({ versions: [candidate] as unknown as ToolModuleMetadata["versions"] }),
    ]);

    expect(candidateRunLinks(item)).toEqual([
      { label: "origin trace", to: "/trace/run_origin" },
      { label: "evidence run", to: "/run/run_evidence" },
      { label: "evidence trace", to: "/trace/run_evidence" },
      { label: "decision trace", to: "/trace/run_decision" },
    ]);
  });
});

function tool(overrides: Partial<ToolModuleMetadata> = {}): ToolModuleMetadata {
  return {
    name: "demo.tool",
    version: "0.1.0",
    description: "Demo generated tool.",
    capabilities: ["demo"],
    startupMode: "on-demand",
    source: "generated",
    status: "available",
    requiredConfigurationKeys: [],
    requiredSecretHandles: [],
    examples: [],
    successCount: 0,
    failureCount: 0,
    updatedAt: "2026-05-20T09:00:00.000Z",
    ...overrides,
  };
}

function version(overrides: Partial<ToolVersionSummary> = {}): ToolVersionSummary {
  return {
    version: "0.1.2",
    active: false,
    status: "available",
    description: "Candidate.",
    capabilities: ["demo"],
    reviewStatus: "candidate",
    successCount: 0,
    failureCount: 0,
    updatedAt: "2026-05-20T09:00:00.000Z",
    ...overrides,
  };
}

function lifecycle(
  type: NonNullable<ToolVersionSummary["lifecycleEvents"]>[number]["type"],
  createdAt: string,
  runId?: string,
): NonNullable<ToolVersionSummary["lifecycleEvents"]>[number] {
  return {
    id: `${type}-${createdAt}`,
    type,
    status: "success",
    summary: type,
    actorId: "operator",
    actorType: "user",
    runId,
    traceRunId: runId,
    createdAt,
  };
}
