import { describe, expect, it } from "vitest";
import type { AgentArtifact, AgentRunRecord, ConversationThreadMessage } from "@/api/types";
import {
  artifactsForMessage,
  hydrateMarkdownArtifactLinks,
  unreferencedArtifacts,
} from "./conversationArtifacts";

const artifact: AgentArtifact = {
  id: "artifact-1",
  runId: "run-1",
  kind: "output",
  filename: "coinmarketcap-com.png",
  mimeType: "image/png",
  sizeBytes: 1234,
  url: "/api/runs/run-1/artifacts/artifact-1",
  createdAt: new Date(0).toISOString(),
};

const run: AgentRunRecord = {
  id: "run-1",
  task: "task",
  status: "completed",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  events: [],
  result: {
    complexity: { mode: "direct", reason: "test fixture", domains: [], riskLevel: "low" },
    finalAnswer: "answer",
    subtasks: [],
    workerResults: [],
    reviews: [],
    artifacts: [artifact],
  },
};

const message: ConversationThreadMessage = {
  id: "message-1",
  threadId: "thread-1",
  runId: "run-1",
  role: "assistant",
  content: "![Proof](coinmarketcap-com.png)",
  createdAt: new Date(0).toISOString(),
};

describe("conversationArtifacts", () => {
  it("hydrates bare markdown artifact filenames to run artifact URLs", () => {
    expect(hydrateMarkdownArtifactLinks(message.content, [artifact])).toBe(
      "![Proof](/api/runs/run-1/artifacts/artifact-1)",
    );
  });

  it("finds artifacts for a message run", () => {
    expect(artifactsForMessage(message, [run])).toEqual([artifact]);
  });

  it("returns no artifacts when a message has no linked run", () => {
    expect(artifactsForMessage({ ...message, runId: undefined }, [run])).toEqual([]);
  });

  it("does not duplicate artifacts already referenced by markdown", () => {
    const hydrated = hydrateMarkdownArtifactLinks(message.content, [artifact]);
    expect(unreferencedArtifacts(hydrated, [artifact])).toEqual([]);
  });
});
