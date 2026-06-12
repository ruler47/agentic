import { describe, expect, it } from "vitest";

import { nextTraceGraphZoom } from "@/features/trace/TraceGraph";

describe("nextTraceGraphZoom", () => {
  it("increments zoom inside the supported range", () => {
    expect(nextTraceGraphZoom(1, 0.15)).toBe(1.15);
    expect(nextTraceGraphZoom(1, -0.15)).toBe(0.85);
  });

  it("clamps zoom to readable graph bounds", () => {
    expect(nextTraceGraphZoom(1.75, 0.15)).toBe(1.8);
    expect(nextTraceGraphZoom(0.55, -0.15)).toBe(0.5);
  });
});
