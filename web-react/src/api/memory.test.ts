import { describe, expect, it } from "vitest";

import { normalizeMemoryReviewQueue } from "@/api/memory";
import type { SkillMemoryEntry } from "@/api/types";

describe("memory review queue API normalization", () => {
  it("joins server reviews to their memory records", () => {
    const memory: SkillMemoryEntry = {
      id: "memory-1",
      title: "Default city",
      tags: ["planning"],
      summary: "Use Malaga when location is omitted.",
      reusableProcedure: "Read the group profile before asking for a city.",
      scope: "group",
      scopeId: "group-local",
      status: "proposed",
      confidence: 0.8,
      sensitivity: "normal",
      evidence: ["operator seed"],
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z",
    };

    expect(
      normalizeMemoryReviewQueue({
        memories: [memory],
        reviews: [
          {
            memoryId: memory.id,
            status: "needs_review",
            recommendedAction: "Inspect evidence before accepting.",
            findings: [
              {
                code: "missing_source",
                severity: "warning",
                message: "No source run/thread is attached.",
              },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        memory,
        status: "needs_review",
        recommendedAction: "Inspect evidence before accepting.",
        findings: [
          {
            code: "missing_source",
            severity: "warning",
            message: "No source run/thread is attached.",
          },
        ],
        warnings: ["No source run/thread is attached."],
      },
    ]);
  });
});
