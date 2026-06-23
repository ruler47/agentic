import test from "node:test";
import assert from "node:assert/strict";

import {
  proofLinkFromArtifact,
  resolveProofPlan,
} from "../src/agents/proofPolicy.js";
import { taskForbidsScreenshotProof, taskLooksLikeApiRequestTask } from "../src/agents/baseAgentEvidence.js";
import { frameTask } from "../src/agents/taskFrame.js";
import type { AgentArtifact } from "../src/types.js";

test("resolveProofPlan requires source evidence for current source-backed lookup", () => {
  const plan = resolveProofPlan({
    taskFrame: frameTask("какая сейчас цена биткоина?"),
    requiredArtifacts: { screenshot: false },
    sourceUrls: ["https://coinmarketcap.com/currencies/bitcoin/"],
    proofEvidence: [{
      sourceUrl: "https://coinmarketcap.com/currencies/bitcoin/",
      signals: ["Bitcoin", "$77,000"],
    }],
    artifacts: [],
    artifactSavingAvailable: true,
  });

  assert.equal(plan.required, true);
  assert.deepEqual(plan.preferredModes.slice(0, 1), ["source_evidence"]);
  assert.ok(plan.acceptableModes.includes("screenshot"));
  assert.ok(plan.sourceIds?.[0]?.startsWith("source:"));
  assert.ok(plan.targetClaimIds?.some((id) => id.startsWith("claim:")));
});

test("resolveProofPlan removes screenshot proof modes when the task forbids screenshots", () => {
  const task = "Какая сейчас цена биткоина? Скриншот не нужен.";
  assert.equal(taskForbidsScreenshotProof(task), true);

  const plan = resolveProofPlan({
    taskFrame: frameTask(task),
    requiredArtifacts: { screenshot: false },
    sourceUrls: ["https://coinmarketcap.com/currencies/bitcoin/"],
    proofEvidence: [{
      sourceUrl: "https://coinmarketcap.com/currencies/bitcoin/",
      signals: ["Bitcoin", "$77,000"],
    }],
    artifacts: [],
    artifactSavingAvailable: true,
    forbidsScreenshotProof: taskForbidsScreenshotProof(task),
  });

  assert.equal(plan.required, true);
  assert.equal(plan.preferredModes.includes("screenshot"), false);
  assert.equal(plan.acceptableModes.includes("screenshot"), false);
  assert.ok(plan.preferredModes.includes("source_evidence"));
});

test("taskForbidsScreenshotProof supports reversed English and Russian wording", () => {
  assert.equal(taskForbidsScreenshotProof("Screenshot not needed, just cite the API."), true);
  assert.equal(taskForbidsScreenshotProof("Скрин не требуется, дай ссылку."), true);
});

test("taskLooksLikeApiRequestTask does not classify plain web screenshot URLs as API calls", () => {
  assert.equal(taskLooksLikeApiRequestTask("Сделай скриншот https://example.com"), false);
  assert.equal(taskLooksLikeApiRequestTask("Сделай GET https://example.com/api/todo и скажи title"), true);
});

test("resolveProofPlan requires structured proof for explicit API requests", () => {
  const plan = resolveProofPlan({
    taskFrame: frameTask("Сделай GET https://jsonplaceholder.typicode.com/todos/1 и скажи title."),
    requiredArtifacts: { screenshot: false },
    sourceUrls: ["https://jsonplaceholder.typicode.com/todos/1", "https://nel.heroku.com/reports"],
    proofEvidence: [{
      sourceUrl: "https://jsonplaceholder.typicode.com/todos/1",
      signals: ["HTTP 200", "delectus aut autem"],
    }],
    artifacts: [],
    artifactSavingAvailable: true,
    requiresStructuredApiProof: true,
  });

  assert.equal(plan.required, true);
  assert.deepEqual(plan.preferredModes, ["api_response"]);
  assert.ok(plan.acceptableModes.includes("api_response"));
  assert.equal(plan.sourceIds?.length, 1);
  assert.match(plan.sourceIds?.[0] ?? "", /jsonplaceholder-typicode-com-todos-1/);
});

test("resolveProofPlan treats generated files as local utility proof", () => {
  const plan = resolveProofPlan({
    taskFrame: frameTask("Преобразуй JSON в CSV и сохрани файл people.csv"),
    requiredArtifacts: { screenshot: false },
    sourceUrls: [],
    proofEvidence: [],
    artifacts: [artifact({ filename: "people.csv", mimeType: "text/csv" })],
    artifactSavingAvailable: true,
  });

  assert.equal(plan.required, true);
  assert.deepEqual(plan.preferredModes, ["generated_file"]);
  assert.deepEqual(plan.acceptableModes, ["generated_file", "api_response"]);
});

test("resolveProofPlan routes external actions to pre-submit proof", () => {
  const plan = resolveProofPlan({
    taskFrame: frameTask("Найди барбершоп и подготовь запись, но не отправляй без подтверждения"),
    requiredArtifacts: { screenshot: false },
    sourceUrls: ["https://booksy.com/en-us/example"],
    proofEvidence: [],
    artifacts: [],
    artifactSavingAvailable: true,
  });

  assert.equal(plan.required, true);
  assert.equal(plan.preferredModes[0], "external_action_pre_submit");
  assert.ok(plan.acceptableModes.includes("screenshot"));
});

test("proofLinkFromArtifact maps artifact QA to proof status and source id", () => {
  const link = proofLinkFromArtifact({
    artifact: artifact({
      filename: "coinmarketcap-com.png",
      mimeType: "image/png",
      description: "Viewport screenshot captured from https://coinmarketcap.com/currencies/bitcoin/",
      qualityStatus: "failed",
      signals: ["https://coinmarketcap.com/currencies/bitcoin/", "Bitcoin"],
    }),
  });

  assert.equal(link.mode, "screenshot");
  assert.equal(link.status, "failed");
  assert.equal(link.sourceUrl, "https://coinmarketcap.com/currencies/bitcoin/");
  assert.ok(link.sourceId?.startsWith("source:"));
  assert.ok(link.claimId?.startsWith("claim:"));
});

function artifact(input: {
  filename: string;
  mimeType: string;
  description?: string;
  qualityStatus?: "passed" | "warning" | "failed";
  signals?: string[];
}): AgentArtifact {
  return {
    id: `artifact_${input.filename.replace(/[^a-z0-9]+/gi, "_")}`,
    runId: "run_proof_policy",
    kind: "output",
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: 12,
    url: `/api/runs/run_proof_policy/artifacts/${input.filename}`,
    description: input.description,
    createdAt: new Date(0).toISOString(),
    quality: input.qualityStatus
      ? {
          status: input.qualityStatus,
          reviewedAt: new Date(0).toISOString(),
          checks: [{
            name: "proof-test",
            ok: input.qualityStatus !== "failed",
            decision: input.qualityStatus,
            reason: "test fixture",
            signals: input.signals,
          }],
        }
      : undefined,
  };
}
