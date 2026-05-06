import test from "node:test";
import assert from "node:assert/strict";
import { createMetadataToolActivationRunner } from "../src/tools/toolActivationRunner.js";
import { InMemoryToolBuildRequestStore } from "../src/tools/toolBuildRequestStore.js";

test("metadata activation runner deletes failed initial generated metadata on rollback", async () => {
  const calls: string[] = [];
  const requestStore = new InMemoryToolBuildRequestStore();
  const request = await requestStore.create({
    capability: "initial-runtime-tool",
    reason: "Initial generated tool activation failed.",
  });

  const runner = createMetadataToolActivationRunner({
    metadataStore: {
      async activateVersion() {
        throw new Error("unexpected activateVersion");
      },
      async deleteGenerated(name) {
        calls.push(`delete:${name}`);
        return true;
      },
    },
    async reloadGeneratedTools() {
      calls.push("reload");
    },
  });

  const report = await runner.rollback?.(
    request,
    {
      modulePath: "src/tools/generated/initial-runtime-toolTool.ts",
      testPath: "tests/generated/initial-runtime-toolTool.test.ts",
      summary: "Generated initial tool.",
    },
    "generated.initial.runtimeTool",
    { ok: false, summary: "activation failed", checks: ["runtime missing"] },
  );

  assert.equal(report?.ok, true);
  assert.match(report?.summary ?? "", /removed from metadata/);
  assert.deepEqual(calls, ["delete:generated.initial.runtimeTool", "reload"]);
  assert.ok(report?.checks.some((check) => check.includes("removed failed initial generated metadata")));
});

test("metadata activation runner restores replaced version on rollback", async () => {
  const calls: string[] = [];
  const requestStore = new InMemoryToolBuildRequestStore();
  const request = await requestStore.create({
    capability: "versioned-runtime-tool",
    reason: "Replacement activation failed.",
    replacesVersion: "1.2.0",
  });

  const runner = createMetadataToolActivationRunner({
    metadataStore: {
      async activateVersion(name, version) {
        calls.push(`activate:${name}:${version}`);
        return {} as never;
      },
      async deleteGenerated() {
        throw new Error("unexpected deleteGenerated");
      },
    },
    async reloadGeneratedTools() {
      calls.push("reload");
    },
  });

  const report = await runner.rollback?.(
    request,
    {
      modulePath: "src/tools/generated/versioned-runtime-tool-v1-3-0Tool.ts",
      testPath: "tests/generated/versioned-runtime-tool-v1-3-0Tool.test.ts",
      summary: "Generated replacement tool.",
    },
    "generated.versioned.runtimeTool",
    { ok: false, summary: "activation failed", checks: ["runtime missing"] },
  );

  assert.equal(report?.ok, true);
  assert.match(report?.summary ?? "", /Previous version 1\.2\.0 restored/);
  assert.deepEqual(calls, ["activate:generated.versioned.runtimeTool:1.2.0", "reload"]);
  assert.ok(report?.checks.some((check) => check.includes("reactivated previous version 1.2.0")));
});
