import test from "node:test";
import assert from "node:assert/strict";
import { improvementSpecToPromptSection } from "../src/tools/toolBuildBlueprint.js";

test("improvementSpecToPromptSection: empty spec yields empty string", () => {
  assert.equal(improvementSpecToPromptSection(undefined), "");
});

test("improvementSpecToPromptSection: minimal spec includes symptom + expected behavior", () => {
  const out = improvementSpecToPromptSection({
    symptom: "Screenshot is blank because cookie banner blocks page",
    expectedBehavior: "Auto-accept cookie banner before screenshot",
  });
  assert.match(out, /Improvement Spec/);
  assert.match(out, /Symptom: Screenshot is blank/);
  assert.match(out, /Expected behavior: Auto-accept/);
  assert.match(out, /Builder must:/);
});

test("improvementSpecToPromptSection: full spec includes failure examples + acceptance test", () => {
  const out = improvementSpecToPromptSection({
    symptom: "Foo",
    expectedBehavior: "Bar",
    failureExamples: [
      { runId: "run_X", artifactIds: ["art_1", "art_2"], notes: "OneTrust banner" },
      { runId: "run_Y", notes: "Sourcepoint banner" },
    ],
    acceptanceTest: "Calling browser.operate against tomshardware.com captures 5 headlines.",
  });
  assert.match(out, /Failure examples:/);
  assert.match(out, /run run_X.*art_1.*OneTrust/s);
  assert.match(out, /run run_Y.*Sourcepoint/s);
  assert.match(out, /Acceptance test:.*tomshardware/);
});
