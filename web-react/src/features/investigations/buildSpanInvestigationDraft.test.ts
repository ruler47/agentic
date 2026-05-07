import { describe, expect, it } from "vitest";

import {
  buildSpanInvestigationDraft,
  type ToolMetaLite,
} from "@/features/investigations/buildSpanInvestigationDraft";
import type { AgentRunRecord } from "@/api/types";
import type { TraceNode } from "@/features/trace/buildTraceNodes";

const RUN: AgentRunRecord = {
  id: "run-1",
  task: "Capture proof",
  status: "failed",
  createdAt: "2026-05-07T12:00:00Z",
  updatedAt: "2026-05-07T12:00:30Z",
  events: [],
};

function makeNode(overrides: Partial<TraceNode> & { spanId: string; actor: string }): TraceNode {
  return {
    spanId: overrides.spanId,
    actor: overrides.actor,
    title: overrides.title ?? "Span",
    activity: overrides.activity ?? "tool",
    status: overrides.status ?? "failed",
    detail: overrides.detail ?? "loader page detected",
    payload: overrides.payload,
    firstTimestamp: "2026-05-07T12:00:01Z",
    lastTimestamp: "2026-05-07T12:00:01Z",
    dependencySpanIds: [],
    startedAt: "2026-05-07T12:00:01Z",
    parentSpanId: overrides.parentSpanId,
    parentTitle: overrides.parentTitle,
  };
}

describe("buildSpanInvestigationDraft", () => {
  it("matches a registered tool by exact actor name", () => {
    const tools: ToolMetaLite[] = [
      { name: "browser.operate", displayName: "Browser operate" },
    ];
    const node = makeNode({
      spanId: "span-1",
      actor: "browser.operate",
      title: "browser.operate failed: should not capture a screenshot",
      detail: "loader page; screenshot artifact rejected",
    });
    const draft = buildSpanInvestigationDraft({ run: RUN, node, installedTools: tools });
    expect(draft.matchedToolName).toBe("browser.operate");
    expect(draft.matchedToolDisplayName).toBe("Browser operate");
    expect(draft.warnings).toHaveLength(0);
  });

  it("never auto-retargets a different tool from fuzzy text — text 'screenshot' must NOT pull in browser-screenshot", () => {
    // Even when the title screams "screenshot" and a screenshot tool exists,
    // we keep the matched tool tied to actor exact match.
    const tools: ToolMetaLite[] = [
      { name: "browser.operate", capabilities: ["browser-operate"] },
      { name: "browser.screenshot", capabilities: ["browser-screenshot"] },
    ];
    const node = makeNode({
      spanId: "span-bo",
      actor: "browser.operate",
      title: "browser.operate failed: should not capture a screenshot",
      detail: "Browser screenshot artifact returned a loader page",
    });
    const draft = buildSpanInvestigationDraft({ run: RUN, node, installedTools: tools });
    expect(draft.matchedToolName).toBe("browser.operate");
    expect(draft.matchedToolName).not.toBe("browser.screenshot");
  });

  it("falls back to manual draft with a warning when no installed tool matches", () => {
    const node = makeNode({ spanId: "span-x", actor: "tool.unknown" });
    const draft = buildSpanInvestigationDraft({ run: RUN, node, installedTools: [] });
    expect(draft.matchedToolName).toBeUndefined();
    expect(draft.warnings.length).toBeGreaterThan(0);
    expect(draft.warnings[0]).toMatch(/manual ticket/i);
    expect(draft.contextBundle.notes?.[0]).toMatch(/manual ticket/i);
  });

  it("matches via payload.toolName when actor is an agent role label", () => {
    const tools: ToolMetaLite[] = [
      { name: "channel.telegram.bot" },
    ];
    const node = makeNode({
      spanId: "span-p",
      actor: "coordinator",
      payload: { toolName: "channel.telegram.bot" },
    });
    const draft = buildSpanInvestigationDraft({ run: RUN, node, installedTools: tools });
    expect(draft.matchedToolName).toBe("channel.telegram.bot");
    expect(draft.warnings).toHaveLength(0);
  });

  it("propagates run task and node detail into the context bundle", () => {
    const node = makeNode({
      spanId: "span-d",
      actor: "browser.operate",
      detail: "loader text",
    });
    const draft = buildSpanInvestigationDraft({
      run: RUN,
      node,
      installedTools: [{ name: "browser.operate" }],
    });
    expect(draft.contextBundle.taskPrompt).toBe(RUN.task);
    expect(draft.contextBundle.outputSummary).toContain("loader text");
    expect(draft.contextBundle.error).toBeTruthy(); // status=failed → error captured
  });

  it("collects related artifact refs from payload.artifacts", () => {
    const node = makeNode({
      spanId: "span-art",
      actor: "browser.operate",
      payload: {
        artifacts: [
          { id: "art-1", filename: "loader.png", mimeType: "image/png", url: "/artifacts/art-1" },
        ],
      },
    });
    const draft = buildSpanInvestigationDraft({
      run: RUN,
      node,
      installedTools: [{ name: "browser.operate" }],
    });
    expect(draft.artifactIds).toEqual(["art-1"]);
    expect(draft.contextBundle.relatedArtifactRefs?.[0]?.filename).toBe("loader.png");
  });
});
