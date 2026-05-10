import test from "node:test";
import assert from "node:assert/strict";
import {
  dockerToolPackageManifest,
  dockerToolProjectScaffold,
  genericToolPackageManifest,
} from "../src/tools/toolBuildProviders.js";

test("dockerToolPackageManifest builds an oci-image manifest", () => {
  const manifest = dockerToolPackageManifest({
    toolName: "weather.lookup",
    version: "1.2.3",
    description: "Lookup weather for a place.",
    capabilities: ["weather", "geolocation"],
    startupMode: "on-demand",
    modulePath: "tools/weather-lookup-service/src/server.ts",
  });
  assert.equal(manifest.name, "weather.lookup");
  assert.equal(manifest.package.type, "oci-image");
  assert.equal(manifest.package.ref, "agentic-tool-weather-lookup:1.2.3");
  assert.deepEqual(manifest.capabilities, ["weather", "geolocation"]);
});

test("dockerToolPackageManifest honours custom imageRef", () => {
  const manifest = dockerToolPackageManifest({
    toolName: "x.y",
    version: "9.0.0",
    description: "x",
    capabilities: ["x"],
    startupMode: "on-demand",
    modulePath: "tools/x-y-service/src/server.ts",
    imageRef: "registry.example/x-y:9.0.0",
  });
  assert.equal(manifest.package.ref, "registry.example/x-y:9.0.0");
});

test("genericToolPackageManifest still produces local-path packages (untouched)", () => {
  const manifest = genericToolPackageManifest({
    toolName: "legacy.thing",
    version: "1.0.0",
    description: "legacy",
    capabilities: ["legacy"],
    startupMode: "on-demand",
    modulePath: "src/tools/generated/legacy-thing.ts",
  });
  assert.equal(manifest.package.type, "local-path");
  assert.equal(manifest.package.ref, "src/tools/generated/legacy-thing.ts");
});

test("dockerToolProjectScaffold emits Dockerfile + package.json + server.ts + README", () => {
  const files = dockerToolProjectScaffold({
    toolName: "weather.lookup",
    version: "1.0.0",
    description: "lookup weather",
    capabilities: ["weather"],
    startupMode: "on-demand",
    requiredConfigurationKeys: ["WEATHER_API_KEY"],
  });
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    "tools/weather-lookup-service/Dockerfile",
    "tools/weather-lookup-service/README.md",
    "tools/weather-lookup-service/package.json",
    "tools/weather-lookup-service/src/server.ts",
  ]);
  const dockerfile = files.find((f) => f.path.endsWith("Dockerfile"))!;
  assert.match(dockerfile.content, /FROM node:22-bookworm-slim/);
  assert.match(dockerfile.content, /HEALTHCHECK/);
  const pkg = JSON.parse(files.find((f) => f.path.endsWith("package.json"))!.content);
  assert.equal(pkg.name, "@agentic/weather-lookup-service");
  assert.equal(pkg.version, "1.0.0");
  const serverTs = files.find((f) => f.path.endsWith("server.ts"))!;
  assert.match(serverTs.content, /\/describe/);
  assert.match(serverTs.content, /\/health/);
  assert.match(serverTs.content, /\/run/);
  assert.match(serverTs.content, /\/service\/start/);
  assert.match(serverTs.content, /WEATHER_API_KEY/);
});
