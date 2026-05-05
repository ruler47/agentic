import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeToolPackageManifest,
  serializeToolPackageManifest,
} from "../src/tools/toolPackage.js";

test("tool package manifest normalizes portable out-of-tree tool metadata", () => {
  const manifest = normalizeToolPackageManifest({
    schemaVersion: "agentic.tool-package.v1",
    name: "generated.telegram.bot",
    displayName: "Telegram Bot",
    version: "1.2.0",
    description: "Portable always-on messaging adapter.",
    capabilities: ["always-on-messaging", "telegram-bot"],
    startupMode: "always-on",
    package: {
      type: "oci-image",
      ref: "registry.local/agentic/telegram-bot:1.2.0",
    },
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {} },
    requiredSecretHandles: ["secret.telegram.bot"],
    qa: {
      summary: "QA passed.",
      checks: ["unit tests", "service smoke"],
    },
  });

  assert.equal(manifest.name, "generated.telegram.bot");
  assert.equal(manifest.startupMode, "always-on");
  assert.equal(manifest.package.type, "oci-image");
  assert.deepEqual(manifest.requiredSecretHandles, ["secret.telegram.bot"]);
  assert.match(serializeToolPackageManifest(manifest), /agentic.tool-package.v1/);
});

test("tool package manifest rejects unsafe or incomplete packages", () => {
  assert.throws(
    () =>
      normalizeToolPackageManifest({
        schemaVersion: "agentic.tool-package.v1",
        name: "Bad Tool",
        version: "1",
        description: "bad",
        capabilities: [],
        startupMode: "always-on",
        package: { type: "oci-image", ref: "registry.local/tool:latest" },
      }),
    /stable lowercase tool identifier/,
  );

  assert.throws(
    () =>
      normalizeToolPackageManifest({
        schemaVersion: "agentic.tool-package.v1",
        name: "generated.good",
        version: "1.0.0",
        description: "missing package",
        capabilities: ["demo"],
        startupMode: "daemon",
        package: { type: "local-path", ref: "tools/demo" },
      }),
    /startupMode/,
  );
});
