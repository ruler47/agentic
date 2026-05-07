import { describe, expect, it } from "vitest";

import {
  canCreateRetryRun,
  isAutoRetryWait,
  retryRunLabel,
} from "@/features/tool-builds/reworkWaitPresentation";
import type { ToolReworkWaitRecord } from "@/api/types";

function makeWait(overrides: Partial<ToolReworkWaitRecord> = {}): ToolReworkWaitRecord {
  return {
    id: "wait-1",
    runId: "run-1",
    status: "promoted",
    reason: "operator-created wait",
    createdAt: "2026-05-07T12:00:00.000Z",
    updatedAt: "2026-05-07T12:00:00.000Z",
    ...overrides,
  };
}

describe("rework wait presentation", () => {
  it("labels auto retry waits from their coordinator reason", () => {
    const wait = makeWait({
      reason: "Auto retry after tool rework promotion: created retry run.",
      retryRunId: "run-retry",
    });

    expect(isAutoRetryWait(wait)).toBe(true);
    expect(retryRunLabel(wait)).toBe("Auto retry run");
  });

  it("keeps explicit retry run labels for manual retry runs", () => {
    const wait = makeWait({ retryRunId: "run-retry" });

    expect(isAutoRetryWait(wait)).toBe(false);
    expect(retryRunLabel(wait)).toBe("Retry run");
  });

  it("only offers retry creation for promoted waits without an existing retry run", () => {
    expect(canCreateRetryRun(makeWait())).toBe(true);
    expect(canCreateRetryRun(makeWait({ retryRunId: "run-retry" }))).toBe(false);
    expect(canCreateRetryRun(makeWait({ status: "waiting" }))).toBe(false);
  });
});
