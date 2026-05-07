import { describe, expect, it, vi } from "vitest";
import { formatDuration, formatRelative, runDurationMs, truncate } from "@/lib/format";

describe("formatDuration", () => {
  it("returns ms for sub-second durations", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(420)).toBe("420 ms");
    expect(formatDuration(999)).toBe("999 ms");
  });
  it("returns seconds for sub-minute durations", () => {
    expect(formatDuration(1500)).toBe("1.5 s");
    expect(formatDuration(59_999)).toBe("60.0 s");
  });
  it("returns minutes+seconds beyond a minute", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(125_500)).toBe("2m 5s");
  });
  it("returns dash for invalid input", () => {
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-50)).toBe("—");
  });
});

describe("truncate", () => {
  it("returns input unchanged when shorter than limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });
  it("appends ellipsis when over limit", () => {
    expect(truncate("hello world", 8)).toBe("hello w…");
  });
  it("handles undefined / null", () => {
    expect(truncate(undefined, 10)).toBe("");
    expect(truncate(null, 10)).toBe("");
  });
});

describe("runDurationMs", () => {
  it("uses now() for live runs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T12:00:10Z"));
    const ms = runDurationMs({
      createdAt: "2026-05-07T12:00:00Z",
      updatedAt: "2026-05-07T12:00:01Z",
      status: "running",
    });
    expect(ms).toBe(10_000);
    vi.useRealTimers();
  });
  it("uses updatedAt for terminal runs", () => {
    const ms = runDurationMs({
      createdAt: "2026-05-07T12:00:00Z",
      updatedAt: "2026-05-07T12:00:05Z",
      status: "completed",
    });
    expect(ms).toBe(5_000);
  });
});

describe("formatRelative", () => {
  it("returns 'just now' for very recent timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T12:00:00Z"));
    expect(formatRelative("2026-05-07T11:59:58Z")).toBe("just now");
    vi.useRealTimers();
  });
  it("returns minutes ago for medium-distance timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T12:00:00Z"));
    expect(formatRelative("2026-05-07T11:55:00Z")).toBe("5m ago");
    vi.useRealTimers();
  });
  it("returns dash for missing input", () => {
    expect(formatRelative(undefined)).toBe("—");
    expect(formatRelative("not-a-date")).toBe("—");
  });
});
