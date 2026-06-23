import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import type { AgentArtifact } from "../src/types.js";
import { buildArtifactQuality, regradeProofArtifactsAfterFinalAnswer } from "../src/agents/baseAgentArtifacts.js";

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

test("buildArtifactQuality fails interstitial screenshots even when URL and claim match", () => {
  const png = new PNG({ width: 500, height: 320 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 250;
    png.data[i + 1] = 250;
    png.data[i + 2] = 250;
    png.data[i + 3] = 255;
  }
  for (let y = 24; y < 290; y += 26) {
    drawRect(png, 24, y, 410, 10, 25, 35, 45);
    drawRect(png, 24, y + 13, 300, 6, 90, 100, 110);
  }

  const quality = buildArtifactQuality({
    task: "Подбери 2-3 варианта ноутбуков для локальных LLM и игр до 2500 долларов.",
    toolName: "browser.screenshot",
    input: {
      url: "https://www.amazon.com/ASUS-2025-ROG-Strix-G16/dp/B0F8JZB2ZS",
      filename: "asus_rog_strix_g16_proof_v2.png",
      fullPage: false,
    },
    result: {
      ok: true,
      content: "Executed browser commands and captured screenshot.",
      data: {
        finalUrl: "https://www.amazon.com/ASUS-2025-ROG-Strix-G16/dp/B0F8JZB2ZS",
        title: "Amazon.com",
        extractedText: [
          {
            label: "visible-page",
            text: "Click the button below to continue shopping\nContinue shopping\nConditions of Use Privacy Policy",
          },
        ],
      },
    },
    artifact: {
      filename: "asus_rog_strix_g16_proof_v2.png",
      mimeType: "image/png",
      content: PNG.sync.write(png),
      description: "Browser screenshot captured from https://www.amazon.com/ASUS-2025-ROG-Strix-G16/dp/B0F8JZB2ZS.",
    },
    proofSourceUrls: ["https://www.amazon.com/ASUS-2025-ROG-Strix-G16/dp/B0F8JZB2ZS"],
    proofEvidence: [],
    proofClaimSignals: ["ASUS ROG Strix G16"],
    proofRequiresClaimMatch: true,
  });

  assert.equal(quality?.status, "failed");
  assert.ok(quality?.checks.some((check) => check.name === "browser-screenshot-semantic-qa" && !check.ok));
  assert.ok(quality?.checks.some((check) => check.name === "proof-source-url-match" && check.ok));
  assert.ok(quality?.checks.some((check) => check.name === "proof-claim-match" && check.ok));
});

function drawRect(png: PNG, x: number, y: number, width: number, height: number, r: number, g: number, b: number) {
  for (let row = y; row < Math.min(png.height, y + height); row += 1) {
    for (let column = x; column < Math.min(png.width, x + width); column += 1) {
      const offset = (png.width * row + column) << 2;
      png.data[offset] = r;
      png.data[offset + 1] = g;
      png.data[offset + 2] = b;
      png.data[offset + 3] = 255;
    }
  }
}
