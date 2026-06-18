import test from "node:test";
import assert from "node:assert/strict";
import type { AgentArtifact } from "../src/types.js";
import { regradeProofArtifactsAfterFinalAnswer } from "../src/agents/baseAgentArtifacts.js";

test("regradeProofArtifactsAfterFinalAnswer accepts early screenshot proof once final claims exist", () => {
  const artifact: AgentArtifact = {
    id: "artifact_amazon",
    runId: "run_laptop",
    kind: "output",
    filename: "www-amazon-com.png",
    mimeType: "image/png",
    sizeBytes: 100,
    url: "/api/runs/run_laptop/artifacts/artifact_amazon",
    description: "Viewport screenshot captured from https://www.amazon.com/example",
    createdAt: new Date().toISOString(),
    quality: {
      status: "failed",
      reviewedAt: new Date().toISOString(),
      checks: [
        {
          name: "browser-screenshot-semantic-qa",
          ok: true,
          decision: "usable",
          reason: "Browser artifact is useful.",
          signals: [
            "Acer Nitro 16S AI Copilot+ PC Gaming Laptop",
            "AMD Ryzen AI 9 365 Processor",
            "NVIDIA GeForce RTX 5070 Ti Laptop GPU",
            "32GB DDR5",
          ],
        },
        {
          name: "proof-claim-target",
          ok: false,
          decision: "claim_target_missing",
          reason: "No final-answer claim signals yet.",
          signals: [],
        },
        {
          name: "proof-source-url-match",
          ok: true,
          decision: "source_match",
          reason: "Source matched.",
          signals: ["https://www.amazon.com/example"],
        },
      ],
    },
  };

  const regraded = regradeProofArtifactsAfterFinalAnswer({
    artifacts: [artifact],
    finalAnswer: "Лучший выбор: Acer Nitro 16S AI Copilot+ с NVIDIA GeForce RTX 5070 Ti и AMD Ryzen AI 9 365.",
    proofRequiresClaimMatch: true,
  });

  assert.equal(regraded.length, 1);
  assert.equal(artifact.quality?.status, "passed");
  const claimCheck = artifact.quality?.checks.find((check) => check.name === "proof-claim-match");
  assert.equal(claimCheck?.ok, true);
  assert.equal(claimCheck?.decision, "claim_match_after_final_answer");
});
