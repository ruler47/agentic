import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryToolBuildRequestStore } from "../src/tools/toolBuildRequestStore.js";
import {
  blueprintToPromptSection,
  createToolBuildBlueprint,
  extractRawSecretCandidates,
  validateToolBuilderResponseAgainstBlueprint,
} from "../src/tools/toolBuildBlueprint.js";

test("ToolBuildBlueprint extracts API docs, operations, auth, fields, and fixtures", async () => {
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "api.risk.score",
    displayName: "Risk Score",
    reason: [
      "Build a reusable API client from docs https://docs.example.com/risk.",
      "GET https://risk.example.com/v1/entities/{entityId}/score?token=supported",
      "Header: x-api-key: <secret>",
      "Response fields: `riskScore`, `sources[].share`, `sources[].label`.",
      "```json",
      '{ "riskScore": 87, "sources": [{ "label": "pep", "share": 73 }] }',
      "```",
    ].join("\n"),
    requiredInputs: ["entityId"],
    requiredOutputs: ["riskScore", "sources"],
    credentialHandles: ["secret.risk.apiKey"],
  });

  const blueprint = createToolBuildBlueprint(request);

  assert.equal(blueprint.kind, "api");
  assert.ok(blueprint.documentation.urls.includes("https://docs.example.com/risk"));
  assert.equal(blueprint.operations.length, 1);
  assert.equal(blueprint.operations[0]?.method, "GET");
  assert.equal(blueprint.operations[0]?.url, "https://risk.example.com/v1/entities/{entityId}/score?token=supported");
  assert.ok(blueprint.operations[0]?.requestFields.includes("entityId"));
  assert.ok(blueprint.operations[0]?.responseFields.includes("riskScore"));
  assert.ok(blueprint.credentials.authHeaders.includes("x-api-key"));
  assert.deepEqual(blueprint.credentials.handles, ["secret.risk.apiKey"]);
  assert.equal(blueprint.fixtures[0]?.name, "json-fixture-1");
  assert.match(blueprintToPromptSection(blueprint), /Tool Build Blueprint/);
});

test("ToolBuildBlueprint detects always-on lifecycle settings and repair context", async () => {
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "provider.messages",
    reason: "Create a polling listener service with webhookPath and allowed users.",
    startupMode: "always-on",
    credentialNotes: "token: 8701832328:AAF1SV1mdl9QSRliMBjPhP-fX2Z-Icly0AQ",
  });

  const blueprint = createToolBuildBlueprint(request, {
    attempt: 2,
    previousQaReport: {
      ok: false,
      summary: "previous service did not split long responses",
      checks: ["missing lifecycle test", "no outbox chunking"],
    },
  });

  assert.equal(blueprint.kind, "service");
  assert.equal(blueprint.runtime.startupMode, "always-on");
  assert.ok(blueprint.runtime.settingsKeys.includes("webhookPath"));
  assert.ok(blueprint.runtime.lifecycle.includes("startService under supervisor"));
  assert.equal(blueprint.repair?.attempt, 2);
  assert.equal(blueprint.fixtures.at(-1)?.name, "previous-qa-regression");
  assert.deepEqual(extractRawSecretCandidates(request), ["8701832328:AAF1SV1mdl9QSRliMBjPhP-fX2Z-Icly0AQ"]);
});

test("ToolBuildBlueprint validation rejects ignored docs, missing handles, and raw secret leaks", async () => {
  const store = new InMemoryToolBuildRequestStore();
  const request = await store.create({
    capability: "api.risk.score",
    reason: [
      "GET https://risk.example.com/v1/entities/{entityId}/score",
      "api key: RAWSECRET1234567890RAWSECRET1234567890",
      "```json",
      '{ "riskScore": 87 }',
      "```",
    ].join("\n"),
    credentialHandles: ["secret.risk.apiKey"],
  });
  const blueprint = createToolBuildBlueprint(request);

  assert.throws(
    () =>
      validateToolBuilderResponseAgainstBlueprint(
        {
          docsMarkdown: "placeholder",
          files: [
            { path: request.contract.modulePath, content: "const key = 'RAWSECRET1234567890RAWSECRET1234567890';" },
            { path: request.contract.testPath, content: "test('placeholder', () => {})" },
          ],
        },
        blueprint,
      ),
    /raw credential/,
  );

  assert.throws(
    () =>
      validateToolBuilderResponseAgainstBlueprint(
        {
          docsMarkdown: "uses secret.risk.apiKey but ignores the provider",
          files: [
            { path: request.contract.modulePath, content: "requiredSecretHandles: ['secret.risk.apiKey']" },
            { path: request.contract.testPath, content: "test('placeholder', () => {})" },
          ],
        },
        blueprint,
      ),
    /documented operation/,
  );
});
